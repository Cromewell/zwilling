import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

/** Optional per-project config file in the project root. */
export const CONFIG_FILE = ".zwilling.json";

export const DEFAULTS = {
  maxFiles: 20,
  maxTotalKB: 500,
  timeoutMs: 120_000,
} as const;

export interface Limits {
  maxFiles: number;
  maxTotalBytes: number;
  timeoutMs: number;
}

export interface Config {
  /** Default model for ask_gemini and gemini_task (agy's default if unset). */
  model?: string;
  /** Default model for gemini_review (falls back to `model`). */
  reviewModel?: string;
  limits: Limits;
  /** Extra deny patterns. They only add to the built-in denylist (.env, *.pem, *.key, .git/). */
  deny: string[];
  prompts: {
    /** Root-relative path of a custom review prompt template. */
    review?: string;
  };
  log: {
    /** Root-relative log path (consumed by log.ts). */
    path?: string;
    enabled: boolean;
  };
  /** CLI binary to run instead of `agy` (consumed by gemini.ts). */
  cli?: string;
}

export class ConfigError extends Error {}

const nonEmpty = z.string().trim().min(1);
const limitsShape = {
  maxFiles: z.number().int().min(1).max(500),
  maxTotalKB: z.number().int().min(1).max(8192),
  timeoutMs: z.number().int().min(1000).max(3_600_000),
};

const FileSchema = z.strictObject({
  $schema: z.string().optional(),
  model: nonEmpty.optional(),
  reviewModel: nonEmpty.optional(),
  limits: z
    .strictObject({
      maxFiles: limitsShape.maxFiles.optional(),
      maxTotalKB: limitsShape.maxTotalKB.optional(),
      timeoutMs: limitsShape.timeoutMs.optional(),
    })
    .optional(),
  deny: z.array(nonEmpty).max(200).optional(),
  prompts: z.strictObject({ review: nonEmpty.optional() }).optional(),
  log: z.strictObject({ path: nonEmpty.optional(), enabled: z.boolean().optional() }).optional(),
  cli: nonEmpty.optional(),
});

type FileConfig = z.infer<typeof FileSchema>;

function formatIssues(err: z.ZodError): string {
  return err.issues.map((i) => `${i.path.length ? i.path.join(".") : "(root)"}: ${i.message}`).join("; ");
}

async function readConfigFile(root: string): Promise<FileConfig> {
  const file = path.join(root, CONFIG_FILE);
  let text: string;
  try {
    text = await fs.readFile(file, "utf8");
  } catch (err: any) {
    if (err.code === "ENOENT") return {};
    throw new ConfigError(`Could not read ${CONFIG_FILE}: ${err.message}`);
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (err: any) {
    throw new ConfigError(`Invalid ${CONFIG_FILE}: not valid JSON (${err.message})`);
  }
  const parsed = FileSchema.safeParse(json);
  if (!parsed.success) throw new ConfigError(`Invalid ${CONFIG_FILE}: ${formatIssues(parsed.error)}`);
  return parsed.data;
}

function envInt(env: NodeJS.ProcessEnv, name: string, schema: z.ZodNumber): number | undefined {
  const raw = env[name];
  if (raw === undefined || raw.trim() === "") return undefined;
  const parsed = schema.safeParse(Number(raw));
  if (!parsed.success) throw new ConfigError(`Invalid ${name}=${JSON.stringify(raw)}: ${formatIssues(parsed.error)}`);
  return parsed.data;
}

function envBool(env: NodeJS.ProcessEnv, name: string): boolean | undefined {
  const raw = env[name]?.trim().toLowerCase();
  if (raw === undefined || raw === "") return undefined;
  if (["1", "true", "on", "yes"].includes(raw)) return true;
  if (["0", "false", "off", "no"].includes(raw)) return false;
  throw new ConfigError(`Invalid ${name}=${JSON.stringify(env[name])}: expected on/off, true/false or 1/0`);
}

const envStr = (env: NodeJS.ProcessEnv, name: string) => env[name]?.trim() || undefined;

/**
 * Load `.zwilling.json` from the root (optional) and apply `ZWILLING_*` env vars on top.
 * Env wins over the file; `ZWILLING_DENY` (comma-separated) is appended to the file's `deny`.
 * Throws ConfigError with a readable message on invalid input.
 */
export async function loadConfig(root: string, env: NodeJS.ProcessEnv = process.env): Promise<Config> {
  const file = await readConfigFile(root);
  const envDeny = (env.ZWILLING_DENY ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const maxTotalKB =
    envInt(env, "ZWILLING_MAX_TOTAL_KB", limitsShape.maxTotalKB) ?? file.limits?.maxTotalKB ?? DEFAULTS.maxTotalKB;

  return {
    model: envStr(env, "ZWILLING_MODEL") ?? file.model,
    reviewModel: envStr(env, "ZWILLING_REVIEW_MODEL") ?? file.reviewModel,
    limits: {
      maxFiles: envInt(env, "ZWILLING_MAX_FILES", limitsShape.maxFiles) ?? file.limits?.maxFiles ?? DEFAULTS.maxFiles,
      maxTotalBytes: maxTotalKB * 1024,
      timeoutMs:
        envInt(env, "ZWILLING_TIMEOUT_MS", limitsShape.timeoutMs) ?? file.limits?.timeoutMs ?? DEFAULTS.timeoutMs,
    },
    deny: [...(file.deny ?? []), ...envDeny],
    prompts: { review: envStr(env, "ZWILLING_REVIEW_PROMPT") ?? file.prompts?.review },
    log: {
      path: envStr(env, "ZWILLING_LOG_PATH") ?? file.log?.path,
      enabled: envBool(env, "ZWILLING_LOG") ?? file.log?.enabled ?? true,
    },
    cli: envStr(env, "ZWILLING_CLI") ?? file.cli,
  };
}

/** Config with all defaults and no file/env input (used by tests and as a fallback). */
export function defaultConfig(): Config {
  return {
    limits: {
      maxFiles: DEFAULTS.maxFiles,
      maxTotalBytes: DEFAULTS.maxTotalKB * 1024,
      timeoutMs: DEFAULTS.timeoutMs,
    },
    deny: [],
    prompts: {},
    log: { enabled: true },
  };
}
