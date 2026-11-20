import { spawn } from "node:child_process";

/**
 * Default CLI binary. Gemini CLI is deprecated; Antigravity CLI (`agy`) replaces it.
 * Resolved via PATH. Override per run with RunOptions.bin (ZWILLING_CLI in the server).
 */
export const CLI_BIN = "agy";

/**
 * Per-run settings (never saved by agy). Deny rules apply in every agent mode,
 * so this is what keeps the agent read-only: no file reads or writes, no shell
 * commands, no MCP calls (incl. back into zwilling), no URL fetching.
 *
 * File reads are denied too: agy's permission rules don't support globs, so
 * `*.pem` / `*.key` couldn't be blocked selectively. Gemini only sees file
 * contents that zwilling inlined after its own path checks (paths.ts).
 * Note: agy's web search has no permission action and stays available.
 */
export const READ_ONLY_SETTINGS = JSON.stringify({
  permissions: {
    deny: [
      "read_file(*)",
      "write_file(*)",
      "command(*)",
      "mcp(*)",
      "read_url(*)",
      "execute_url(*)",
      "download_url(*)",
    ],
  },
  allowNonWorkspaceAccess: false,
  enableTerminalSandbox: true,
});

export const DEFAULT_TIMEOUT_MS = 120_000;
export const MAX_ANSWER_BYTES = 100 * 1024;
/**
 * Longest single stdout line we buffer. stdout is parsed line by line as it arrives, so
 * the total output is unbounded, but one NDJSON line (the result event carries the whole
 * answer) must fit. Longer lines are dropped.
 */
export const MAX_LINE_BYTES = 16 * 1024 * 1024;
const MAX_STDERR_CHARS = 64 * 1024;
const KILL_GRACE_MS = 2_000;
const MODELS_TIMEOUT_MS = 30_000;
const MAX_MODELS_STDOUT = 1024 * 1024;

export interface Progress {
  /** Characters of answer text received so far (from streamed deltas). */
  chars: number;
  /** Partial answer text so far, capped at MAX_ANSWER_BYTES. */
  text: string;
}

export interface RunOptions {
  cwd: string;
  model?: string;
  timeoutMs?: number;
  /** CLI binary (name on PATH or absolute path). Default: CLI_BIN. */
  bin?: string;
  /** Aborting kills the run (e.g. when the MCP client cancels the request). */
  signal?: AbortSignal;
  /** Called whenever a streamed text delta arrives. */
  onProgress?: (p: Progress) => void;
}

/** Process groups of running agy calls. agy is detached, so it must be killed explicitly. */
const activeGroups = new Set<number>();

function killGroup(pid: number, signal: NodeJS.Signals) {
  try {
    process.kill(-pid, signal);
  } catch {
    /* already gone */
  }
}

/** Kill every running agy call. Synchronous, so it is safe in a process 'exit' handler. */
export function killAllRuns(signal: NodeJS.Signals = "SIGKILL") {
  for (const pid of activeGroups) killGroup(pid, signal);
}

export interface RunResult {
  /** The answer text (possibly truncated). Empty if the run failed. */
  text: string;
  /** True if `text` was cut to MAX_ANSWER_BYTES. */
  truncated: boolean;
  /** agy's result status (SUCCESS, ERROR, ...), or undefined if no result event arrived. */
  status?: string;
  /** Error message from agy's result event, if any. */
  error?: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
  /** Set if the process could not be started at all (e.g. ENOENT: agy not installed). */
  spawnError?: string;
}

export function buildArgs(model?: string): string[] {
  const args = [
    "--input-format", "stream-json",
    "--output-format", "stream-json",
    "--disable-slash-commands",
    "--sandbox",
    "--settings", READ_ONLY_SETTINGS,
  ];
  if (model) args.push("--model", model);
  return args;
}

/** True if the run produced a usable answer. */
export function isSuccess(r: RunResult): boolean {
  return !r.spawnError && !r.timedOut && r.exitCode === 0 && r.status === "SUCCESS";
}

function truncateUtf8(s: string, maxBytes: number): { text: string; truncated: boolean } {
  const buf = Buffer.from(s, "utf8");
  if (buf.length <= maxBytes) return { text: s, truncated: false };
  // Drop a possibly split trailing multi-byte char.
  return { text: buf.subarray(0, maxBytes).toString("utf8").replace(/�$/, ""), truncated: true };
}

/**
 * Splits a chunked byte stream into lines without holding more than one line in memory.
 * A line longer than maxBytes is dropped (onLine is not called for it).
 */
export class LineSplitter {
  private buf = "";
  private bufBytes = 0;
  private overflow = false;

  constructor(
    private readonly onLine: (line: string) => void,
    private readonly maxBytes = MAX_LINE_BYTES,
  ) {}

  push(chunk: string) {
    let start = 0;
    for (let nl = chunk.indexOf("\n"); nl !== -1; nl = chunk.indexOf("\n", start)) {
      this.append(chunk.slice(start, nl));
      this.emit();
      start = nl + 1;
    }
    if (start < chunk.length) this.append(chunk.slice(start));
  }

  /** Flush a trailing line without newline. */
  end() {
    if (this.buf || this.overflow) this.emit();
  }

  private append(s: string) {
    if (this.overflow) return;
    this.bufBytes += Buffer.byteLength(s);
    if (this.bufBytes > this.maxBytes) {
      this.overflow = true;
      this.buf = "";
      return;
    }
    this.buf += s;
  }

  private emit() {
    if (!this.overflow) this.onLine(this.buf);
    this.buf = "";
    this.bufBytes = 0;
    this.overflow = false;
  }
}

interface ProcOptions {
  bin: string;
  args: string[];
  cwd: string;
  timeoutMs: number;
  signal?: AbortSignal;
  /** Written to stdin, then stdin is closed. Without it stdin is closed immediately. */
  input?: string;
  onStdout: (chunk: string) => void;
}

interface ProcResult {
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
  spawnError?: string;
}

/**
 * Spawn `bin` without a shell in its own process group, with timeout and abort handling.
 * On timeout/abort/server exit the whole group gets SIGTERM, then SIGKILL. Never throws.
 */
function runProcess(o: ProcOptions): Promise<ProcResult> {
  return new Promise((resolve) => {
    let stderr = "";
    let timedOut = false;
    let settled = false;

    const child = spawn(o.bin, o.args, {
      cwd: o.cwd,
      stdio: ["pipe", "pipe", "pipe"],
      // Own process group, so killing it also gets agy's helper processes.
      detached: true,
    });
    const pid = child.pid;
    if (pid) activeGroups.add(pid);

    const stop = () => {
      if (!pid || settled) return;
      killGroup(pid, "SIGTERM");
      setTimeout(() => killGroup(pid, "SIGKILL"), KILL_GRACE_MS).unref();
    };

    const timer = setTimeout(() => {
      timedOut = true;
      stop();
    }, o.timeoutMs);

    const onAbort = () => stop();
    o.signal?.addEventListener("abort", onAbort, { once: true });
    if (o.signal?.aborted) stop();

    const finish = (exitCode: number | null, spawnError?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      o.signal?.removeEventListener("abort", onAbort);
      if (pid) activeGroups.delete(pid);
      resolve({ stderr: stderr.trim(), exitCode, timedOut, spawnError });
    };

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", o.onStdout);
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      if (stderr.length < MAX_STDERR_CHARS) stderr += chunk;
    });

    child.on("error", (err) => finish(null, err.message));
    child.on("close", (code) => finish(code));

    // EPIPE if the child dies before reading stdin; the close handler reports it.
    child.stdin.on("error", () => {});
    child.stdin.end(o.input);
  });
}

/**
 * Run agy non-interactively. The prompt goes over stdin as one stream-json message,
 * so it is not limited by the OS max argument length (128 KB per arg on Linux).
 * stdout is parsed line by line as it arrives; only the result event and the streamed
 * text (capped) are kept. Never throws; all failures are reported in the result.
 */
export async function runGemini(prompt: string, opts: RunOptions): Promise<RunResult> {
  let status: string | undefined;
  let error: string | undefined;
  let answer = "";
  let partial = "";
  let partialBytes = 0;
  let chars = 0;

  const onLine = (line: string) => {
    if (!line.trim()) return;
    let ev: any;
    try {
      ev = JSON.parse(line);
    } catch {
      return; // ignore non-JSON lines
    }
    if (ev?.event === "result" && ev.result) {
      status = typeof ev.result.status === "string" ? ev.result.status : undefined;
      error = ev.result.error ? String(ev.result.error) : undefined;
      answer = typeof ev.result.response === "string" ? ev.result.response : "";
      return;
    }
    // agy streams the answer as {event:"step_update", step_update:{text_delta:"..."}}.
    const delta = ev?.event === "step_update" ? ev.step_update?.text_delta : undefined;
    if (typeof delta === "string" && delta) {
      chars += delta.length;
      if (partialBytes < MAX_ANSWER_BYTES) {
        partial += delta;
        partialBytes += Buffer.byteLength(delta);
      }
      try {
        opts.onProgress?.({ chars, text: partial });
      } catch {
        /* a progress callback must not break the run */
      }
    }
  };

  const lines = new LineSplitter(onLine);
  const p = await runProcess({
    bin: opts.bin || CLI_BIN,
    args: buildArgs(opts.model),
    cwd: opts.cwd,
    timeoutMs: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    signal: opts.signal,
    input: JSON.stringify({ event: "user", message: { content: prompt } }) + "\n",
    onStdout: (chunk) => lines.push(chunk),
  });
  lines.end();

  const { text, truncated } = truncateUtf8(answer.trim(), MAX_ANSWER_BYTES);
  return { text, truncated, status, error, ...p };
}

export interface ModelInfo {
  id: string;
  name?: string;
}

export interface ModelsResult {
  models: ModelInfo[];
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
  spawnError?: string;
}

/** Parse `agy models` output: one `id<TAB>display name` per line. */
export function parseModels(stdout: string): ModelInfo[] {
  const models: ModelInfo[] = [];
  for (const raw of stdout.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    const tab = line.indexOf("\t");
    const id = (tab === -1 ? line : line.slice(0, tab)).trim();
    // Model IDs have no spaces; skip status lines like "Fetching available models...".
    if (!id || /\s/.test(id)) continue;
    const name = tab === -1 ? undefined : line.slice(tab + 1).trim() || undefined;
    models.push({ id, name });
  }
  return models;
}

/** Run `<bin> models`. Never throws. */
export async function listModels(opts: {
  cwd: string;
  bin?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
}): Promise<ModelsResult> {
  let stdout = "";
  const p = await runProcess({
    bin: opts.bin || CLI_BIN,
    args: ["models"],
    cwd: opts.cwd,
    timeoutMs: opts.timeoutMs ?? MODELS_TIMEOUT_MS,
    signal: opts.signal,
    onStdout: (chunk) => {
      if (stdout.length < MAX_MODELS_STDOUT) stdout += chunk;
    },
  });
  return { models: parseModels(stdout), ...p };
}
