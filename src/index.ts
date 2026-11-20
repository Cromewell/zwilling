#!/usr/bin/env node
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
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
import { appendEntry, readEntries, findEntry, resolveLogPath, ENTRY_ID_RE, LOG_REL, type ParsedEntry } from "./log.js";

// stdout carries MCP protocol messages; all diagnostics must go to stderr.
const log = (...args: unknown[]) => console.error("[zwilling]", ...args);

const REVIEW_PROMPT =
  "Review these files. List concrete issues with file:line, severity, and a suggested fix. Don't rewrite whole files.";

export interface ServerOptions {
  root: string;
  timeoutMs: number;
  /** Interval for progress heartbeats while agy runs (default 10 s). */
  progressIntervalMs?: number;
  /** Log file, relative to root (default docs/ai/GEMINI_LOG.md). Must stay inside root. */
  logPath?: string;
  /** Write the shared log (default true). */
  logEnabled?: boolean;
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

/** Prepend an earlier exchange (one level deep) to a follow-up question. */
export function withHistory(prompt: string, prior: ParsedEntry): string {
  const files = prior.files.length
    ? `\nFiles attached then (not attached again unless listed below): ${prior.files.join(", ")}`
    : "";
  return (
    `[Earlier exchange, log entry ${prior.id}]${files}\n\n` +
    `Question:\n${prior.prompt}\n\nYour answer:\n${prior.answer ?? ""}\n\n` +
    `[Follow-up question]\n${prompt}`
  );
}

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
  const logRel = opts.logPath ?? LOG_REL;
  resolveLogPath(opts.root, logRel); // fail fast on a path outside the root
  const logEnabled = opts.logEnabled !== false;
  const LOG_OFF = "The shared Gemini log is disabled in this server's configuration (e.g. ZWILLING_LOG=off).";

  /** Shared path for ask_gemini and gemini_review: read files, run agy, log, respond. */
  async function consult(
    extra: Extra,
    tool: string,
    prompt: string,
    files: string[],
    model?: string,
    followUp?: ParsedEntry,
  ): Promise<CallToolResult> {
    let loaded;
    try {
      loaded = await readFiles(opts.root, files);
    } catch (err) {
      if (err instanceof UserError) return fail(err.message);
      throw err;
    }

    const stopHeartbeat = startHeartbeat(extra, opts.progressIntervalMs ?? 10_000);
    const sent = followUp ? withHistory(prompt, followUp) : prompt;
    const r = await runGemini(buildPrompt(sent, loaded), {
      cwd: opts.root,
      model,
      timeoutMs: opts.timeoutMs,
      signal: extra.signal,
    }).finally(stopHeartbeat);
    const success = isSuccess(r);
    const failure = success ? undefined : describeFailure(r, opts.timeoutMs);

    let entryId: string | undefined;
    if (logEnabled) {
      try {
        entryId = await appendEntry(
          opts.root,
          { tool, model, prompt, files: loaded.map((f) => f.rel), followUp: followUp?.id, answer: r.text, error: failure },
          logRel,
        );
      } catch (err) {
        log("could not write log:", err);
      }
    }

    const note = r.truncated ? `\n\n[zwilling: answer truncated at ${MAX_ANSWER_BYTES / 1024} KB]` : "";
    const result = success ? ok(r.text + note) : fail(failure!);
    // Separate block, so the answer itself stays untouched.
    if (entryId) result.content.push({ type: "text", text: `[zwilling: log entry ${entryId}]` });
    return result;
  }

  const entryIdSchema = z.string().regex(ENTRY_ID_RE, "expected a log entry id like g-20261113-a1b2c3");

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
        follow_up: entryIdSchema
          .optional()
          .describe(
            "Log entry id of an earlier answer (e.g. g-20261113-a1b2c3, shown after every answer). " +
              "Its question and answer are sent along as context. One level only: the earlier entry's own history is not included.",
          ),
      },
      annotations: { openWorldHint: true },
    },
    async ({ prompt, files, model, follow_up }, extra) => {
      let prior: ParsedEntry | undefined;
      if (follow_up) {
        if (!logEnabled) return fail(`${LOG_OFF} follow_up needs the log.`);
        prior = await findEntry(opts.root, follow_up, logRel);
        if (!prior) return fail(`No log entry with id ${follow_up} in ${logRel}.`);
        if (prior.answer === undefined) return fail(`Log entry ${follow_up} has no answer (the call failed).`);
      }
      return consult(extra, "ask_gemini", prompt, files ?? [], model, prior);
    },
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
      description:
        `Return entries of the shared Gemini log (${logRel}), to recall earlier Gemini answers. ` +
        "Filter by id, tool or a search text; returns the last N matches.",
      inputSchema: {
        last_n: z.number().int().min(1).max(100).optional().describe("Number of entries (default 5)."),
        id: entryIdSchema.optional().describe("Return only this entry."),
        tool: z.string().min(1).optional().describe('Only entries of this tool, e.g. "gemini_review".'),
        query: z.string().min(1).optional().describe("Only entries containing this text (case-insensitive)."),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ last_n, id, tool, query }) => {
      if (!logEnabled) return ok(LOG_OFF);
      const all = await readEntries(opts.root, logRel);
      if (!all || all.length === 0) return ok(`No entries in ${logRel} yet.`);
      let hits = all;
      if (id) hits = hits.filter((e) => e.id === id);
      if (tool) hits = hits.filter((e) => e.tool === tool);
      if (query) {
        const q = query.toLowerCase();
        hits = hits.filter((e) => e.text.toLowerCase().includes(q));
      }
      if (hits.length === 0) return ok(`No matching entries in ${logRel}.`);
      return ok(hits.slice(-(last_n ?? 5)).map((e) => e.text).join("\n\n"));
    },
  );

  const markdown = (uri: URL, text: string) => ({ contents: [{ uri: uri.href, mimeType: "text/markdown", text }] });

  server.registerResource(
    "gemini-log",
    "zwilling://log",
    { title: "Gemini log", description: `The shared Gemini log (${logRel}).`, mimeType: "text/markdown" },
    async (uri) => {
      if (!logEnabled) return markdown(uri, LOG_OFF);
      const all = await readEntries(opts.root, logRel);
      return markdown(uri, all?.length ? all.map((e) => e.text).join("\n\n") : `No entries in ${logRel} yet.`);
    },
  );

  server.registerResource(
    "gemini-log-entry",
    new ResourceTemplate("zwilling://log/{id}", {
      list: async () => {
        const all = logEnabled ? ((await readEntries(opts.root, logRel)) ?? []) : [];
        return {
          resources: all
            .filter((e) => e.id)
            .slice(-50)
            .map((e) => ({
              uri: `zwilling://log/${e.id}`,
              name: `${e.id} · ${e.tool ?? "?"}`,
              description: e.prompt.slice(0, 120),
              mimeType: "text/markdown",
            })),
        };
      },
    }),
    { title: "Gemini log entry", description: "One entry of the shared Gemini log.", mimeType: "text/markdown" },
    async (uri, { id }) => {
      if (!logEnabled) throw new Error(LOG_OFF);
      const entry = await findEntry(opts.root, String(id), logRel);
      if (!entry) throw new Error(`No log entry with id ${id}.`);
      return markdown(uri, entry.text);
    },
  );

  return server;
}

/** ZWILLING_LOG=off|0|false|no disables the log. */
export function logEnabledFromEnv(env: NodeJS.ProcessEnv = process.env): boolean {
  return !/^(off|0|false|no)$/i.test((env.ZWILLING_LOG ?? "").trim());
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

  const logPath = process.env.ZWILLING_LOG_PATH || undefined;
  const logEnabled = logEnabledFromEnv();

  await createServer({ root, timeoutMs, logPath, logEnabled }).connect(new StdioServerTransport());
  log(`running on stdio · root: ${root} · timeout: ${timeoutMs} ms · log: ${logEnabled ? (logPath ?? LOG_REL) : "off"}`);
}

// Run only when executed directly (not when imported by tests). realpath handles npm bin symlinks.
const isMain = process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((err) => {
    log("fatal:", err);
    process.exit(1);
  });
}
