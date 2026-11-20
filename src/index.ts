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
  listModels,
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

/** Version from package.json (src/ and dist/ both sit next to it). */
const VERSION: string = (() => {
  try {
    return JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8")).version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
})();

/** Max models in one multi-model ask_gemini call. */
export const MAX_COMPARE_MODELS = 4;

const REVIEW_PROMPT =
  "Review these files. List concrete issues with file:line, severity, and a suggested fix. Don't rewrite whole files.";

export interface ServerOptions {
  root: string;
  timeoutMs: number;
  /** CLI binary (name on PATH or absolute path). Default: agy. */
  cliBin?: string;
  /** Interval for progress heartbeats while agy runs (default 10 s). */
  progressIntervalMs?: number;
}

type Extra = RequestHandlerExtra<ServerRequest, ServerNotification>;

/**
 * If the client asked for progress (sent a progressToken), send a heartbeat
 * periodically. Clients that reset their request timeout on progress (the MCP SDK
 * client's default timeout is 60 s) then won't give up while agy is still working.
 * `status()` adds a short note (e.g. chars received); never the answer text itself.
 */
function startHeartbeat(extra: Extra, intervalMs: number, bin: string, status: () => string): () => void {
  const token = extra._meta?.progressToken;
  if (token === undefined) return () => {};
  const t0 = Date.now();
  let n = 0;
  const timer = setInterval(() => {
    n += 1;
    const secs = `${Math.round((Date.now() - t0) / 1000)} s`;
    const note = status();
    extra
      .sendNotification({
        method: "notifications/progress",
        params: { progressToken: token, progress: n, message: `waiting for ${bin} (${note ? `${secs}, ${note}` : secs})` },
      })
      .catch(() => {});
  }, intervalMs);
  return () => clearInterval(timer);
}

const ok = (text: string): CallToolResult => ({ content: [{ type: "text", text }] });
const fail = (text: string): CallToolResult => ({ content: [{ type: "text", text }], isError: true });

function describeSpawnError(bin: string, spawnError: string): string {
  return /ENOENT/.test(spawnError)
    ? `Could not start '${bin}': not found on PATH. Install the Antigravity CLI and sign in (run '${bin}' once).`
    : `Could not start '${bin}': ${spawnError}`;
}

function describeFailure(r: RunResult, timeoutMs: number, bin: string): string {
  if (r.spawnError) return describeSpawnError(bin, r.spawnError);
  const parts = [
    r.timedOut
      ? `${bin} timed out after ${Math.round(timeoutMs / 1000)} s and was killed.`
      : `${bin} failed (exit code ${r.exitCode}, status ${r.status ?? "none"}).`,
  ];
  if (r.error) parts.push(`Error: ${r.error}`);
  if (r.stderr) parts.push(`stderr:\n${r.stderr}`);
  return parts.join("\n\n");
}

export function createServer(opts: ServerOptions): McpServer {
  const server = new McpServer({ name: "zwilling", version: VERSION });
  const bin = opts.cliBin || CLI_BIN;

  /**
   * Shared path for ask_gemini and gemini_review: read files, run agy once per model
   * (in parallel), log each run, respond. `models = [undefined]` means agy's default.
   */
  async function consult(
    extra: Extra,
    tool: string,
    prompt: string,
    files: string[],
    models: (string | undefined)[],
  ): Promise<CallToolResult> {
    let loaded;
    try {
      loaded = await readFiles(opts.root, files);
    } catch (err) {
      if (err instanceof UserError) return fail(err.message);
      throw err;
    }

    const fullPrompt = buildPrompt(prompt, loaded);
    const chars = models.map(() => 0);
    let done = 0;
    const status = () => {
      const total = chars.reduce((a, b) => a + b, 0);
      const received = total > 0 ? `${total} chars received` : "";
      if (models.length === 1) return received;
      return [`${done}/${models.length} models done`, received].filter(Boolean).join(", ");
    };

    const stopHeartbeat = startHeartbeat(extra, opts.progressIntervalMs ?? 10_000, bin, status);
    const results = await Promise.all(
      models.map((model, i) =>
        runGemini(fullPrompt, {
          cwd: opts.root,
          bin,
          model,
          timeoutMs: opts.timeoutMs,
          signal: extra.signal,
          onProgress: (p) => (chars[i] = p.chars),
        }).finally(() => (done += 1)),
      ),
    ).finally(stopHeartbeat);

    const outcomes = results.map((r) => {
      const success = isSuccess(r);
      return {
        r,
        success,
        failure: success ? undefined : describeFailure(r, opts.timeoutMs, bin),
        note: r.truncated ? `\n\n[zwilling: answer truncated at ${MAX_ANSWER_BYTES / 1024} KB]` : "",
      };
    });

    // One log entry per run, written sequentially in the order the models were given.
    for (const [i, o] of outcomes.entries()) {
      try {
        await appendEntry(opts.root, {
          tool,
          model: models[i],
          prompt,
          files: loaded.map((f) => f.rel),
          answer: o.r.text,
          error: o.failure,
        });
      } catch (err) {
        log("could not write log:", err);
      }
    }

    if (models.length === 1) {
      const o = outcomes[0];
      return o.success ? ok(o.r.text + o.note) : fail(o.failure!);
    }
    const text = outcomes
      .map((o, i) => {
        const head = `## [zwilling] model: ${models[i]}`;
        return o.success ? `${head}\n\n${o.r.text}${o.note}` : `${head} (failed)\n\n${o.failure}`;
      })
      .join("\n\n");
    // Partial failures are reported inline; only an all-failed comparison is an error.
    return outcomes.some((o) => o.success) ? ok(text) : fail(text);
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
        models: z
          .array(z.string().min(1))
          .min(1)
          .max(MAX_COMPARE_MODELS)
          .optional()
          .describe(
            `Compare up to ${MAX_COMPARE_MODELS} models: the same prompt runs on each in parallel and the answers ` +
              "come back under one heading per model. Use instead of `model`, not together with it.",
          ),
      },
      annotations: { openWorldHint: true },
    },
    async ({ prompt, files, model, models }, extra) => {
      if (model && models) return fail("Pass either `model` or `models`, not both.");
      return consult(extra, "ask_gemini", prompt, files ?? [], models ? [...new Set(models)] : [model]);
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
      consult(extra, "gemini_review", focus ? `${REVIEW_PROMPT}\nFocus on: ${focus}` : REVIEW_PROMPT, files, [model]),
  );

  server.registerTool(
    "list_gemini_models",
    {
      description: `List the model IDs accepted by the \`model\` / \`models\` parameters (runs \`${bin} models\`).`,
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (_args, extra) => {
      const r = await listModels({ cwd: opts.root, bin, signal: extra.signal });
      const stderr = r.stderr ? `\n\nstderr:\n${r.stderr}` : "";
      if (r.spawnError) return fail(describeSpawnError(bin, r.spawnError));
      if (r.timedOut) return fail(`${bin} models timed out and was killed.`);
      if (r.exitCode !== 0) return fail(`${bin} models failed (exit code ${r.exitCode}).${stderr}`);
      if (r.models.length === 0) return fail(`${bin} models returned no models.${stderr}`);
      const lines = r.models.map((m) => (m.name ? `- ${m.id} — ${m.name}` : `- ${m.id}`));
      return ok(`Models available via ${bin} (pass the ID as \`model\`):\n${lines.join("\n")}`);
    },
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
  const cliBin = process.env.ZWILLING_CLI || CLI_BIN;

  // agy runs in its own process group, so it would outlive us. Kill it on any shutdown.
  process.on("exit", () => killAllRuns());
  const shutdown = () => process.exit(0);
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  process.on("SIGHUP", shutdown);
  process.stdin.on("end", shutdown); // client closed the pipe

  await createServer({ root, timeoutMs, cliBin }).connect(new StdioServerTransport());
  log(`running on stdio · v${VERSION} · root: ${root} · cli: ${cliBin} · timeout: ${timeoutMs} ms`);
}

// Run only when executed directly (not when imported by tests). realpath handles npm bin symlinks.
const isMain = process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((err) => {
    log("fatal:", err);
    process.exit(1);
  });
}
