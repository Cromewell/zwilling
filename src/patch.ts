import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { z } from "zod";
import { blockedReason } from "./paths.js";

/** Appended to every gemini_patch prompt so the answer contains one machine-readable diff. */
export const PATCH_INSTRUCTIONS =
  "Propose the change as a patch. First explain the change in a few sentences. Then end your answer with exactly one " +
  "fenced ```diff block containing a unified diff in `git diff` format: `diff --git a/<path> b/<path>`, `--- a/<path>`, " +
  "`+++ b/<path>` and @@ hunks with 3 lines of context, paths relative to the project root. Use `--- /dev/null` for new " +
  "files and `+++ /dev/null` for deleted ones. Base the hunks exactly on the attached file contents; don't invent lines. " +
  "Only touch files that are attached, unless a new file is needed. The patch will be checked, not applied.";

/** Patches above this size are not checked (they wouldn't be reviewable either). */
export const MAX_PATCH_BYTES = 1024 * 1024;

export const patchOutputShape = {
  patch: z.string().nullable().describe("The proposed unified diff, or null if the answer contained none."),
  files: z.array(z.string()).describe("Root-relative paths the patch touches."),
  applies: z
    .boolean()
    .describe("True if the patch passed the path checks and `git apply --check` against the current working tree."),
  error: z.string().optional().describe("Why the patch was not found, was refused, or does not apply."),
};

export interface PatchCheck {
  patch: string | null;
  files: string[];
  applies: boolean;
  error?: string;
  [key: string]: unknown;
}

/** The last ```diff / ```patch block of the answer, else the text from the first `diff --git` line. */
export function extractPatch(answer: string): string | null {
  const blocks = [...answer.matchAll(/^```(?:diff|patch)[^\n]*\n([\s\S]*?)^```[ \t]*$/gm)].map((m) => m[1]);
  let patch = blocks.at(-1);
  if (patch === undefined) {
    const i = answer.search(/^diff --git /m);
    if (i < 0) return null;
    patch = answer.slice(i);
  }
  patch = patch.replace(/\s+$/, "") + "\n";
  return /^(?:diff --git |--- |\+\+\+ |@@ )/m.test(patch) ? addMissingModeLines(patch) : null;
}

/**
 * git rejects a `diff --git` section for a new or deleted file without its `new file mode` /
 * `deleted file mode` line ("dev/null: No such file or directory"). Models often leave it out.
 */
function addMissingModeLines(patch: string): string {
  const lines = patch.split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].startsWith("diff --git ")) continue;
    let j = i + 1;
    let hasMode = false;
    while (j < lines.length && !lines[j].startsWith("--- ") && !lines[j].startsWith("diff --git ")) {
      if (/^(?:new|deleted) file mode /.test(lines[j])) hasMode = true;
      j++;
    }
    if (hasMode || !lines[j]?.startsWith("--- ")) continue;
    const mode =
      lines[j] === "--- /dev/null" ? "new file mode 100644" : lines[j + 1] === "+++ /dev/null" ? "deleted file mode 100644" : null;
    if (mode) lines.splice(i + 1, 0, mode);
  }
  return lines.join("\n");
}

/** Strip git's a/ b/ prefix and a quoted form; `/dev/null` yields null. */
function cleanPath(raw: string): string | null {
  let p = raw.trim().replace(/\t.*$/, ""); // `--- a/x\t2026-…` timestamps
  if (p.startsWith('"') && p.endsWith('"')) p = p.slice(1, -1);
  if (p === "/dev/null") return null;
  return p.replace(/^[ab]\//, "");
}

/** All paths a patch touches, from ---/+++ headers, diff --git lines and rename/copy headers. */
export function patchPaths(patch: string): string[] {
  const out = new Set<string>();
  const add = (raw: string) => {
    const p = cleanPath(raw);
    if (p) out.add(p);
  };
  for (const line of patch.split("\n")) {
    let m: RegExpExecArray | null;
    if ((m = /^(?:---|\+\+\+) (.+)$/.exec(line))) add(m[1]);
    else if ((m = /^diff --git (\S+) (\S+)$/.exec(line))) {
      add(m[1]);
      add(m[2]);
    } else if ((m = /^(?:rename|copy) (?:from|to) (.+)$/.exec(line))) add(m[1]);
  }
  return [...out];
}

/**
 * Why a patch path is off-limits, or null if it's fine. Same rules as attachments: relative,
 * inside the root also after resolving symlinks of the deepest existing ancestor, not denylisted.
 */
export async function patchPathProblem(root: string, p: string, deny: readonly string[]): Promise<string | null> {
  if (path.isAbsolute(p) || p.split(/[\\/]/).includes("..")) return `${p}: path must be relative and stay inside the project`;
  const abs = path.resolve(root, p);
  const rel = path.relative(root, abs);
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) return `${p}: path escapes the project root`;
  const reason = blockedReason(rel, deny);
  if (reason) return `${p}: ${reason}`;
  // Follow symlinks on the longest existing prefix (the file itself may be new).
  let probe = abs;
  for (;;) {
    try {
      const real = await fs.realpath(probe);
      const realRel = path.relative(root, real);
      if (realRel.startsWith("..") || path.isAbsolute(realRel)) return `${p}: path escapes the project root (via symlink)`;
      const viaLink = path.join(realRel, path.relative(probe, abs));
      const linkReason = viaLink && blockedReason(viaLink, deny);
      if (linkReason) return `${p}: ${linkReason}`;
      return null;
    } catch {
      const parent = path.dirname(probe);
      if (parent === probe) return null;
      probe = parent;
    }
  }
}

/** Run `git apply --check` on the patch in `root`; resolves to git's error text, or null if it applies. */
export function gitApplyCheck(root: string, patch: string, timeoutMs = 30_000): Promise<string | null> {
  return new Promise((resolve) => {
    const child = spawn(
      "git",
      // --recount: model-written hunks often have wrong line counts in their @@ headers.
      ["--no-pager", "-c", "core.fsmonitor=false", "apply", "--check", "--recount", "--verbose", "-"],
      {
        cwd: root,
        stdio: ["pipe", "pipe", "pipe"],
        // LC_ALL=C: English messages, so the "Checking patch" lines can be filtered out.
        env: { ...process.env, LC_ALL: "C", GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0" },
      },
    );
    let stderr = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (c: string) => {
      if (stderr.length < 16 * 1024) stderr += c;
    });
    child.stdout.resume();
    child.on("error", (err: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      resolve(err.code === "ENOENT" ? "could not run git: not found on PATH" : `could not run git: ${err.message}`);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) return resolve(null);
      // --verbose also prints "Checking patch x..." lines; keep only the errors.
      const errors = stderr
        .split("\n")
        .filter((l) => l.trim() && !/^Checking patch /.test(l))
        .join("\n");
      resolve(errors || `git apply --check failed (exit code ${code})`);
    });
    child.stdin.on("error", () => {});
    child.stdin.end(patch);
  });
}

/** Extract, path-check and dry-run the patch in Gemini's answer. Never applies anything. */
export async function checkPatch(root: string, answer: string, deny: readonly string[]): Promise<PatchCheck> {
  const patch = extractPatch(answer);
  if (!patch) return { patch: null, files: [], applies: false, error: "the answer contains no ```diff block" };
  const files = patchPaths(patch);
  if (files.length === 0) return { patch, files, applies: false, error: "the diff names no files" };
  if (Buffer.byteLength(patch) > MAX_PATCH_BYTES) {
    return { patch, files, applies: false, error: `patch is larger than ${MAX_PATCH_BYTES / 1024} KB, not checked` };
  }
  const problems = (await Promise.all(files.map((f) => patchPathProblem(root, f, deny)))).filter(Boolean);
  if (problems.length) return { patch, files, applies: false, error: `refused: ${problems.join("; ")}` };
  const err = await gitApplyCheck(root, patch);
  return err ? { patch, files, applies: false, error: err } : { patch, files, applies: true };
}
