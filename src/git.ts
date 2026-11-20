import path from "node:path";
import { execFile } from "node:child_process";
import { UserError, blockedReason, type Attachment } from "./paths.js";

/** A single git revision: no leading `-` (no flag injection), no `..`, no whitespace or odd chars. */
const REF = /^(?![-.\/])(?!.*\.\.)(?!.*\/[.\/])(?!.*\.lock$)(?!.*[\/.]$)[A-Za-z0-9._\/@{}~^-]{1,200}$/;

/**
 * Turn a diff spec into `git diff` revision args.
 * - `staged`         → index vs HEAD (`--staged`)
 * - `working`        → working tree vs index (unstaged changes)
 * - `HEAD` / `<ref>` → working tree (incl. staged) vs that ref
 * - `<a>..<b>` / `<a>...<b>` → between two refs (`...`: since the merge base)
 */
export function diffRevArgs(spec: string): string[] {
  const s = spec.trim();
  if (s === "staged" || s === "cached") return ["--staged"];
  if (s === "working" || s === "unstaged") return [];
  const m = /^(.+?)(\.\.\.?)(.+)$/.exec(s);
  if (m) {
    const [, a, dots, b] = m;
    if (!REF.test(a) || !REF.test(b)) throw new UserError(`Invalid diff range: ${spec}`);
    return [`${a}${dots}${b}`];
  }
  if (!REF.test(s)) throw new UserError(`Invalid diff spec: ${spec} (use staged, working, HEAD, <ref> or <base>...HEAD)`);
  return [s];
}

/** Options that keep `git diff` from running repo-configured helper programs. */
const SAFE_DIFF = ["--no-color", "--no-ext-diff", "--no-textconv", "--no-renames", "--relative"];

function git(root: string, args: string[], maxBuffer: number): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      "git",
      // No pager, no optional locks, never prompt, and no fsmonitor program from the repo config.
      ["--no-pager", "-c", "core.quotePath=false", "-c", "core.fsmonitor=false", ...args],
      { cwd: root, maxBuffer, env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0" } },
      (err, stdout, stderr) => {
        if (!err) return resolve(stdout);
        if ((err as any).code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") return reject(new UserError("__too_large__"));
        if ((err as any).code === "ENOENT") return reject(new UserError("Could not run git: not found on PATH."));
        reject(new UserError(`git ${args[0]} failed: ${(stderr || err.message).trim()}`));
      },
    );
  });
}

export interface DiffResult {
  attachment: Attachment;
  bytes: number;
  /** Changed files left out of the diff because they are blocked. */
  excluded: string[];
}

/**
 * Run `git diff` for `spec` in `root`, without shell and with `--` before pathspecs.
 * Paths blocked by the denylist (built-in + config) are left out of the diff.
 */
export async function gitDiff(
  root: string,
  spec: string,
  opts: { maxBytes: number; deny?: readonly string[] },
): Promise<DiffResult> {
  const rev = diffRevArgs(spec);
  const tooLarge = () => new UserError(`Diff ${spec} is too large (max ${Math.floor(opts.maxBytes / 1024)} KB including files).`);
  let names: string[];
  try {
    names = (await git(root, ["diff", ...SAFE_DIFF, "--name-only", "-z", ...rev, "--"], 16 * 1024 * 1024))
      .split("\0")
      .filter(Boolean);
  } catch (err) {
    if (err instanceof UserError && err.message === "__too_large__") throw tooLarge();
    throw err;
  }
  const allowed: string[] = [];
  const excluded: string[] = [];
  for (const n of names) {
    const rel = n.split("/").join(path.sep);
    if (blockedReason(rel, opts.deny ?? [])) excluded.push(n);
    else allowed.push(n);
  }
  if (allowed.length === 0) {
    throw new UserError(
      names.length === 0 ? `No changes for diff ${spec}.` : `All changed files in diff ${spec} are blocked: ${excluded.join(", ")}`,
    );
  }
  let text: string;
  try {
    text = await git(
      root,
      ["diff", ...SAFE_DIFF, ...rev, "--", ...allowed.map((n) => `:(literal)${n}`)],
      opts.maxBytes + 1,
    );
  } catch (err) {
    if (err instanceof UserError && err.message === "__too_large__") throw tooLarge();
    throw err;
  }
  const bytes = Buffer.byteLength(text);
  if (bytes > opts.maxBytes) throw tooLarge();
  return { attachment: { header: `diff ${spec}`, content: text }, bytes, excluded };
}
