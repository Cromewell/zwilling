import fs from "node:fs/promises";
import path from "node:path";

export const MAX_FILES = 20;
export const MAX_TOTAL_BYTES = 500 * 1024;

/** Error with a message meant for the tool caller. */
export class UserError extends Error {}

/**
 * Project root, symlinks resolved: $ZWILLING_ROOT, else $CLAUDE_PROJECT_DIR (set by
 * Claude Code for every MCP server it spawns), else the server's cwd.
 */
export async function getRoot(env: NodeJS.ProcessEnv = process.env): Promise<string> {
  return fs.realpath(path.resolve(env.ZWILLING_ROOT || env.CLAUDE_PROJECT_DIR || process.cwd()));
}

function isInside(root: string, p: string): boolean {
  const rel = path.relative(root, p);
  if (rel === "" || path.isAbsolute(rel)) return false;
  return rel !== ".." && !rel.startsWith(".." + path.sep);
}

/** Why a root-relative path is off-limits, or null if it's fine. */
function blockedReason(rel: string): string | null {
  const parts = rel.split(path.sep);
  const base = parts[parts.length - 1];
  if (parts.includes(".git")) return "files inside .git/ are not allowed";
  if (base === ".env" || base.startsWith(".env.")) return ".env files are not allowed";
  if (/\.(pem|key)$/i.test(base)) return "*.pem / *.key files are not allowed";
  return null;
}

/**
 * Resolve `p` against `root` and make sure it stays inside, also after following
 * symlinks. Returns the root-relative path (as given by the real location).
 */
export async function resolveSafe(root: string, p: string): Promise<{ abs: string; rel: string }> {
  const candidate = path.resolve(root, p);
  if (!isInside(root, candidate)) throw new UserError(`Path escapes project root: ${p}`);
  // Check the requested name too, so a symlink named e.g. `.env` is rejected.
  const asked = blockedReason(path.relative(root, candidate));
  if (asked) throw new UserError(`Refused ${p}: ${asked}`);

  let real: string;
  try {
    real = await fs.realpath(candidate);
  } catch {
    throw new UserError(`File not found: ${p}`);
  }
  if (!isInside(root, real)) throw new UserError(`Path escapes project root (via symlink): ${p}`);
  const rel = path.relative(root, real);
  const reason = blockedReason(rel);
  if (reason) throw new UserError(`Refused ${p}: ${reason}`);
  return { abs: real, rel };
}

export interface LoadedFile {
  rel: string;
  content: string;
}

/** Validate and read files, enforcing the count and total size limits. */
export async function readFiles(root: string, paths: string[]): Promise<LoadedFile[]> {
  if (paths.length > MAX_FILES) {
    throw new UserError(`Too many files: ${paths.length} (max ${MAX_FILES}).`);
  }
  const resolved: { abs: string; rel: string }[] = [];
  const seen = new Set<string>();
  for (const p of paths) {
    const r = await resolveSafe(root, p);
    if (seen.has(r.abs)) continue;
    seen.add(r.abs);
    resolved.push(r);
  }

  let total = 0;
  for (const r of resolved) {
    const st = await fs.stat(r.abs);
    if (!st.isFile()) throw new UserError(`Not a regular file: ${r.rel}`);
    total += st.size;
  }
  if (total > MAX_TOTAL_BYTES) {
    throw new UserError(
      `Files too large: ${Math.ceil(total / 1024)} KB in total (max ${MAX_TOTAL_BYTES / 1024} KB).`,
    );
  }

  return Promise.all(resolved.map(async (r) => ({ rel: r.rel, content: await fs.readFile(r.abs, "utf8") })));
}

/**
 * Prepended to every prompt. agy is an agent and otherwise tries to verify things with
 * tools; every attempt is denied (see READ_ONLY_SETTINGS) and the retries eat the timeout.
 */
export const PREAMBLE =
  "[Context from zwilling] You are being consulted by another AI coding agent for a second opinion. " +
  "You have no tool access in this session: file reads, shell commands, edits, web and MCP calls are blocked, so do not try any tools. " +
  "Everything you need is in this message, including any file contents below. Answer directly in a single response.\n\n";

/** `<preamble><prompt>\n\n--- FILE: path ---\n<contents>\n...` */
export function buildPrompt(prompt: string, files: LoadedFile[]): string {
  let out = PREAMBLE + prompt;
  for (const f of files) out += `\n\n--- FILE: ${f.rel} ---\n${f.content}`;
  return out;
}
