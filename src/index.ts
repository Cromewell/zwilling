#!/usr/bin/env node
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { CallToolResult, ServerNotification, ServerRequest } from "@modelcontextprotocol/sdk/types.js";
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import {
  runGemini,
  isSuccess,
  killAllRuns,
  DEFAULT_TIMEOUT_MS,
  MAX_ANSWER_BYTES,
  CLI_BIN,
  type RunResult,
} from "./gemini.js";
import { getRoot, readFiles, buildPrompt, UserError, MAX_FILES } from "./paths.js";
import { appendEntry, readLastEntries, LOG_REL } from "./log.js";

// stdout carries MCP protocol messages; all diagnostics must go to stderr.
const log = (...args: unknown[]) => console.error("[zwilling]", ...args);

const REVIEW_PROMPT =
  "Review these files. List concrete issues with file:line, severity, and a suggested fix. Don't rewrite whole files.";

export interface ServerOptions {
  root: string;
  timeoutMs: number;
  /** Interval for progress heartbeats while agy runs (default 10 s). */
  progressIntervalMs?: number;
}

type Extra = RequestHandlerExtra<ServerRequest, ServerNotification>;

/**
 * If the client asked for progress (sent a progressToken), send a heartbeat
 * periodically. Clients that reset their request timeout on progress (the MCP SDK
 * client's default timeout is 60 s) then won't give up while agy is still working.
 */
function startHeartbeat(extra: Extra, intervalMs: number): () => void {
  const token = extra._meta?.progressToken;
  if (token === undefined) return () => {};
  const t0 = Date.now();
  let n = 0;
  const timer = setInterval(() => {
    n += 1;
    extra
      .sendNotification({
        method: "notifications/progress",
        params: { progressToken: token, progress: n, message: `waiting for ${CLI_BIN} (${Math.round((Date.now() - t0) / 1000)} s)` },
      })
      .catch(() => {});
  }, intervalMs);
  return () => clearInterval(timer);
}

const ok = (text: string): CallToolResult => ({ content: [{ type: "text", text }] });
const fail = (text: string): CallToolResult => ({ content: [{ type: "text", text }], isError: true });

function describeFailure(r: RunResult, timeoutMs: number): string {
  if (r.spawnError) {
    return /ENOENT/.test(r.spawnError)
      ? `Could not start '${CLI_BIN}': not found on PATH. Install the Antigravity CLI and sign in (run '${CLI_BIN}' once).`
      : `Could not start '${CLI_BIN}': ${r.spawnError}`;
  }
  const parts = [
    r.timedOut
      ? `${CLI_BIN} timed out after ${Math.round(timeoutMs / 1000)} s and was killed.`
      : `${CLI_BIN} failed (exit code ${r.exitCode}, status ${r.status ?? "none"}).`,
  ];
  if (r.error) parts.push(`Error: ${r.error}`);
  if (r.stderr) parts.push(`stderr:\n${r.stderr}`);
  return parts.join("\n\n");
}

export function createServer(opts: ServerOptions): McpServer {
  const server = new McpServer({ name: "zwilling", version: "0.1.0" });

  /** Shared path for ask_gemini and gemini_review: read files, run agy, log, respond. */
  async function consult(
    extra: Extra,
    tool: string,
    prompt: string,
    files: string[],
    model?: string,
  ): Promise<CallToolResult> {
    let loaded;
    try {
      loaded = await readFiles(opts.root, files);
    } catch (err) {
      if (err instanceof UserError) return fail(err.message);
      throw err;
    }

    const stopHeartbeat = startHeartbeat(extra, opts.progressIntervalMs ?? 10_000);
    const r = await runGemini(buildPrompt(prompt, loaded), {
      cwd: opts.root,
      model,
      timeoutMs: opts.timeoutMs,
      signal: extra.signal,
    }).finally(stopHeartbeat);
    const success = isSuccess(r);
    const failure = success ? undefined : describeFailure(r, opts.timeoutMs);

    try {
      await appendEntry(opts.root, {
        tool,
        model,
        prompt,
        files: loaded.map((f) => f.rel),
        answer: r.text,
        error: failure,
      });
    } catch (err) {
      log("could not write log:", err);
    }

    if (!success) return fail(failure!);
    const note = r.truncated ? `\n\n[zwilling: answer truncated at ${MAX_ANSWER_BYTES / 1024} KB]` : "";
    return ok(r.text + note);
  }

  const filesSchema = z
    .array(z.string().min(1))
    .max(MAX_FILES)
    .describe(`Paths relative to the project root (max ${MAX_FILES}, ~500 KB total). Contents are inlined into the prompt.`);

  const modelSchema = z
    .string()
    .min(1)
    .optional()
    .describe(
      "Model ID as listed by `agy models`; the suffix is the reasoning effort, e.g. gemini-3.8-flash-low | -medium | -high. " +
        "Omit to use agy's configured default. Higher effort is slower.",
    );

  server.registerTool(
    "ask_gemini",
    {
      description:
        "Ask Gemini (via the Antigravity CLI) a question or hand it a task, optionally with files as context. " +
        "Gemini runs without tool access: it only sees the prompt and the inlined files. Good for second opinions and reading many large files at once.",
      inputSchema: {
        prompt: z.string().min(1).describe("The question or task for Gemini."),
        files: filesSchema.optional(),
        model: modelSchema,
      },
      annotations: { openWorldHint: true },
    },
    async ({ prompt, files, model }, extra) => consult(extra, "ask_gemini", prompt, files ?? [], model),
  );

  server.registerTool(
    "gemini_review",
    {
      description: "Have Gemini review files and list concrete issues (file:line, severity, suggested fix).",
      inputSchema: {
        files: filesSchema.min(1),
        focus: z.string().min(1).optional().describe('Optional focus, e.g. "security", "performance", "readability".'),
        model: modelSchema,
      },
      annotations: { openWorldHint: true },
    },
    async ({ files, focus, model }, extra) =>
      consult(extra, "gemini_review", focus ? `${REVIEW_PROMPT}\nFocus on: ${focus}` : REVIEW_PROMPT, files, model),
  );

  server.registerTool(
    "read_gemini_log",
    {
      description: `Return the last N entries of the shared Gemini log (${LOG_REL}), to recall earlier Gemini answers.`,
      inputSchema: {
        last_n: z.number().int().min(1).max(100).optional().describe("Number of entries (default 5)."),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ last_n }) => {
      const entries = await readLastEntries(opts.root, last_n ?? 5);
      if (!entries || entries.length === 0) return ok(`No entries in ${LOG_REL} yet.`);
      return ok(entries.join("\n\n"));
    },
  );

  return server;
}

function timeoutFromEnv(): number {
  const n = Number(process.env.ZWILLING_TIMEOUT_MS);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_TIMEOUT_MS;
}

async function main() {
  const root = await getRoot();
  const timeoutMs = timeoutFromEnv();

  // agy runs in its own process group, so it would outlive us. Kill it on any shutdown.
  process.on("exit", () => killAllRuns());
  const shutdown = () => process.exit(0);
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  process.on("SIGHUP", shutdown);
  process.stdin.on("end", shutdown); // client closed the pipe

  await createServer({ root, timeoutMs }).connect(new StdioServerTransport());
  log(`running on stdio · root: ${root} · timeout: ${timeoutMs} ms`);
}

// Run only when executed directly (not when imported by tests). realpath handles npm bin symlinks.
const isMain = process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((err) => {
    log("fatal:", err);
    process.exit(1);
  });
}
