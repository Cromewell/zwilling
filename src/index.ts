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
  MAX_ANSWER_BYTES,
  CLI_BIN,
  type RunResult,
} from "./gemini.js";
import { getRoot, loadFiles, buildPrompt, resolveSafe, fileLabel, UserError, type Attachment } from "./paths.js";
import { appendEntry, readLastEntries, LOG_REL } from "./log.js";
import { loadConfig, defaultConfig, type Config } from "./config.js";
import { gitDiff } from "./git.js";
import { REVIEW_PROMPT, REVIEW_DIFF_PROMPT, REVIEW_JSON_INSTRUCTIONS, reviewOutputShape, parseFindings } from "./review.js";
import { TASKS_DIR, TASK_NAME, listTasks, loadTask } from "./tasks.js";

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

export interface ServerOptions {
  root: string;
  /** Config from .zwilling.json + ZWILLING_* env (see config.ts). Defaults if omitted. */
  config?: Config;
  /** Default agy timeout; overrides config.limits.timeoutMs (used by tests). */
  timeoutMs?: number;
  /** CLI binary (name on PATH or absolute path); overrides config.cli. Default: agy. */
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

  const config = opts.config ?? defaultConfig();
  const defaultTimeoutMs = opts.timeoutMs ?? config.limits.timeoutMs;
  const { maxFiles, maxTotalBytes } = config.limits;
  const bin = opts.cliBin || config.cli || CLI_BIN;

  interface Consultation {
    tool: string;
    prompt: string;
    files: string[];
    diff?: string;
    /** One run per model, in parallel. `[undefined]` means agy's default. */
    models: (string | undefined)[];
    timeoutMs?: number;
    /** Parse review findings into structuredContent (gemini_review). */
    structured?: boolean;
  }

  /** Shared path for all Gemini tools: gather attachments, run agy, log, respond. */
  async function consult(extra: Extra, c: Consultation): Promise<CallToolResult> {
    const timeoutMs = c.timeoutMs ?? defaultTimeoutMs;
    const notes: string[] = [];
    const attachments: Attachment[] = [];
    let loaded;
    try {
      let reservedBytes = 0;
      if (c.diff) {
        const d = await gitDiff(opts.root, c.diff, { maxBytes: maxTotalBytes, deny: config.deny });
        attachments.push(d.attachment);
        reservedBytes = d.bytes;
        if (d.excluded.length) notes.push(`left blocked files out of the diff: ${d.excluded.join(", ")}`);
      }
      const r = await loadFiles(opts.root, c.files, { maxFiles, maxTotalBytes, deny: config.deny, reservedBytes });
      loaded = r.files;
      if (r.skipped.length) notes.push(`skipped from globs/directories: ${r.skipped.join(", ")}`);
    } catch (err) {
      if (err instanceof UserError) return fail(err.message);
      throw err;
    }

    const fullPrompt = buildPrompt(c.prompt, loaded, { extra: attachments });
    const fileList = [...(c.diff ? [`(diff: ${c.diff})`] : []), ...loaded.map(fileLabel)];
    const { models } = c;
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
          timeoutMs,
          signal: extra.signal,
          onProgress: (p) => (chars[i] = p.chars),
        }).finally(() => (done += 1)),
      ),
    ).finally(stopHeartbeat);

    const outcomes = results.map((r) => {
      const success = isSuccess(r);
      return { r, success, failure: success ? undefined : describeFailure(r, timeoutMs, bin) };
    });

    // One log entry per run, written sequentially in the order the models were given.
    for (const [i, o] of outcomes.entries()) {
      try {
        await appendEntry(opts.root, {
          tool: c.tool,
          model: models[i],
          prompt: c.prompt,
          files: fileList,
          answer: o.r.text,
          error: o.failure,
        });
      } catch (err) {
        log("could not write log:", err);
      }
    }

    const noteText = (r: RunResult) =>
      [...notes, ...(r.truncated ? [`answer truncated at ${MAX_ANSWER_BYTES / 1024} KB`] : [])]
        .map((n) => `\n\n[zwilling: ${n}]`)
        .join("");

    if (models.length === 1) {
      const o = outcomes[0];
      if (!o.success) return fail(o.failure!);
      const result = ok(o.r.text + noteText(o.r));
      if (c.structured) result.structuredContent = parseFindings(o.r.text);
      return result;
    }
    const text = outcomes
      .map((o, i) => {
        const head = `## [zwilling] model: ${models[i]}`;
        return o.success ? `${head}\n\n${o.r.text}${noteText(o.r)}` : `${head} (failed)\n\n${o.failure}`;
      })
      .join("\n\n");
    // Partial failures are reported inline; only an all-failed comparison is an error.
    return outcomes.some((o) => o.success) ? ok(text) : fail(text);
  }

  /** Review base prompt: the custom template from the config, else the built-in one. */
  async function reviewBase(hasDiff: boolean): Promise<string> {
    if (!config.prompts.review) return hasDiff ? REVIEW_DIFF_PROMPT : REVIEW_PROMPT;
    const { abs } = await resolveSafe(opts.root, config.prompts.review, config.deny);
    const text = (await fs.promises.readFile(abs, "utf8")).trim();
    if (!text) throw new UserError(`Review prompt template is empty: ${config.prompts.review}`);
    return text;
  }

  const filesSchema = z
    .array(z.string().min(1))
    .max(maxFiles)
    .describe(
      `Paths relative to the project root (max ${maxFiles} files, ${Math.round(maxTotalBytes / 1024)} KB total). ` +
        "Also accepts line ranges (src/a.ts:40-120), directories (src/) and globs (src/**/*.ts); " +
        "globs and directories respect .gitignore. Contents are inlined into the prompt.",
    );

  const diffSchema = z
    .string()
    .min(1)
    .max(450)
    .optional()
    .describe(
      'Attach a git diff: "staged" (index vs HEAD), "working" (unstaged), "HEAD" (all uncommitted changes), ' +
        'a ref, or a range like "main...HEAD". Counts against the size limit.',
    );

  const timeoutSchema = z
    .number()
    .int()
    .min(10)
    .max(1800)
    .optional()
    .describe(`Timeout for this call in seconds (default ${Math.round(defaultTimeoutMs / 1000)}).`);

  const perCallTimeout = (s?: number) => (s === undefined ? undefined : s * 1000);

  const modelSchema = z
    .string()
    .min(1)
    .optional()
    .describe(
      "Model ID as listed by `agy models`; the suffix is the reasoning effort, e.g. gemini-3.8-flash-low | -medium | -high. " +
        "Omit to use the configured default (.zwilling.json, else agy's). Higher effort is slower.",
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
        diff: diffSchema,
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
        timeout_s: timeoutSchema,
      },
      annotations: { openWorldHint: true },
    },
    async ({ prompt, files, diff, model, models, timeout_s }, extra) => {
      if (model && models) return fail("Pass either `model` or `models`, not both.");
      return consult(extra, {
        tool: "ask_gemini",
        prompt,
        files: files ?? [],
        diff,
        models: models ? [...new Set(models)] : [model ?? config.model],
        timeoutMs: perCallTimeout(timeout_s),
      });
    },
  );

  server.registerTool(
    "gemini_review",
    {
      description:
        "Have Gemini review files and/or a git diff and list concrete issues (file:line, severity, suggested fix). " +
        "Returns the written review plus structured findings. Give files, a diff, or both.",
      inputSchema: {
        files: filesSchema.optional(),
        diff: diffSchema,
        focus: z.string().min(1).optional().describe('Optional focus, e.g. "security", "performance", "readability".'),
        model: modelSchema,
        timeout_s: timeoutSchema,
      },
      outputSchema: reviewOutputShape,
      annotations: { openWorldHint: true },
    },
    async ({ files, diff, focus, model, timeout_s }, extra) => {
      if (!files?.length && !diff) return fail("gemini_review needs files, a diff, or both.");
      let base: string;
      try {
        base = await reviewBase(!!diff);
      } catch (err) {
        if (err instanceof UserError) return fail(err.message);
        throw err;
      }
      const prompt = [base, focus && `Focus on: ${focus}`, REVIEW_JSON_INSTRUCTIONS].filter(Boolean).join("\n");
      return consult(extra, {
        tool: "gemini_review",
        prompt,
        files: files ?? [],
        diff,
        models: [model ?? config.reviewModel ?? config.model],
        timeoutMs: perCallTimeout(timeout_s),
        structured: true,
      });
    },
  );

  const knownTasks = listTasks(opts.root);
  server.registerTool(
    "gemini_task",
    {
      description:
        `Run a named task template from ${TASKS_DIR}/<task>.md in the project (e.g. explain, test-ideas, migration-plan), ` +
        "with optional extra instructions, files and diff. Gemini still has no tool access. " +
        (knownTasks.length ? `Tasks in this project: ${knownTasks.join(", ")}.` : "No task templates found in this project yet."),
      inputSchema: {
        task: z.string().regex(TASK_NAME).describe(`Template name, read from ${TASKS_DIR}/<task>.md (letters, digits, - and _).`),
        instructions: z.string().min(1).optional().describe("Extra instructions appended to the template."),
        files: filesSchema.optional(),
        diff: diffSchema,
        model: modelSchema,
        timeout_s: timeoutSchema,
      },
      annotations: { openWorldHint: true },
    },
    async ({ task, instructions, files, diff, model, timeout_s }, extra) => {
      let template: string;
      try {
        template = await loadTask(opts.root, task, config.deny);
      } catch (err) {
        if (err instanceof UserError) return fail(err.message);
        throw err;
      }
      return consult(extra, {
        tool: `gemini_task:${task}`,
        prompt: instructions ? `${template}\n\n## Instructions\n${instructions}` : template,
        files: files ?? [],
        diff,
        models: [model ?? config.model],
        timeoutMs: perCallTimeout(timeout_s),
      });
    },
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

async function main() {
  const root = await getRoot();
  const config = await loadConfig(root);

  // agy runs in its own process group, so it would outlive us. Kill it on any shutdown.
  process.on("exit", () => killAllRuns());
  const shutdown = () => process.exit(0);
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  process.on("SIGHUP", shutdown);
  process.stdin.on("end", shutdown); // client closed the pipe

  await createServer({ root, config }).connect(new StdioServerTransport());
  log(`running on stdio · v${VERSION} · root: ${root} · cli: ${config.cli || CLI_BIN} · timeout: ${config.limits.timeoutMs} ms`);
}

// Run only when executed directly (not when imported by tests). realpath handles npm bin symlinks.
const isMain = process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((err) => {
    log("fatal:", err);
    process.exit(1);
  });
}
