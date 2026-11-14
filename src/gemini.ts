import { spawn } from "node:child_process";

/** CLI binary. Gemini CLI is deprecated; Antigravity CLI (`agy`) replaces it. Resolved via PATH. */
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
/** Hard cap on raw stdout we buffer (stream-json repeats the answer as deltas + result). */
const MAX_STDOUT_BYTES = 10 * 1024 * 1024;
const KILL_GRACE_MS = 2_000;

export interface RunOptions {
  cwd: string;
  model?: string;
  timeoutMs?: number;
  /** Aborting kills the run (e.g. when the MCP client cancels the request). */
  signal?: AbortSignal;
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
 * Run agy non-interactively. The prompt goes over stdin as one stream-json message,
 * so it is not limited by the OS max argument length (128 KB per arg on Linux).
 * Never throws; all failures are reported in the result.
 */
export function runGemini(prompt: string, opts: RunOptions): Promise<RunResult> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  return new Promise((resolve) => {
    let stdout = "";
    let stdoutBytes = 0;
    let stderr = "";
    let timedOut = false;
    let settled = false;

    const child = spawn(CLI_BIN, buildArgs(opts.model), {
      cwd: opts.cwd,
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
    }, timeoutMs);

    const onAbort = () => stop();
    opts.signal?.addEventListener("abort", onAbort, { once: true });
    if (opts.signal?.aborted) stop();

    const finish = (exitCode: number | null, spawnError?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
      if (pid) activeGroups.delete(pid);

      let status: string | undefined;
      let error: string | undefined;
      let answer = "";
      for (const line of stdout.split("\n")) {
        if (!line.trim()) continue;
        try {
          const ev = JSON.parse(line);
          if (ev?.event === "result" && ev.result) {
            status = ev.result.status;
            error = ev.result.error || undefined;
            answer = typeof ev.result.response === "string" ? ev.result.response : "";
          }
        } catch {
          /* ignore non-JSON lines */
        }
      }
      const { text, truncated } = truncateUtf8(answer.trim(), MAX_ANSWER_BYTES);
      resolve({ text, truncated, status, error, stderr: stderr.trim(), exitCode, timedOut, spawnError });
    };

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdoutBytes += Buffer.byteLength(chunk);
      if (stdoutBytes <= MAX_STDOUT_BYTES) stdout += chunk;
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      if (stderr.length < 64 * 1024) stderr += chunk;
    });

    child.on("error", (err) => finish(null, err.message));
    child.on("close", (code) => finish(code));

    // EPIPE if the child dies before reading stdin; the close handler reports it.
    child.stdin.on("error", () => {});
    child.stdin.end(JSON.stringify({ event: "user", message: { content: prompt } }) + "\n");
  });
}
