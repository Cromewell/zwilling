import fs from "node:fs/promises";
import path from "node:path";

export const LOG_REL = path.join("docs", "ai", "GEMINI_LOG.md");
const HEADER = "# Gemini log\n\nWritten by the zwilling MCP server. One entry per call, newest last.\n\n";
/**
 * Invisible marker before each entry. Answers are free-form markdown and may contain
 * `---` or `## ` themselves, so those can't be used to split entries reliably.
 */
const MARKER = "<!-- zwilling:entry -->";
const PROMPT_PREVIEW_CHARS = 500;

export interface LogEntry {
  tool: string;
  model?: string;
  prompt: string;
  files: string[];
  answer?: string;
  error?: string;
  date?: Date;
}

const pad = (n: number) => String(n).padStart(2, "0");
function stamp(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function formatEntry(e: LogEntry): string {
  const prompt =
    e.prompt.length > PROMPT_PREVIEW_CHARS ? e.prompt.slice(0, PROMPT_PREVIEW_CHARS) + "…" : e.prompt;
  const lines = [
    MARKER,
    `## ${stamp(e.date ?? new Date())} · ${e.tool} · model: ${e.model || "default"}`,
    `**Prompt:** ${prompt}`,
    `**Files:** ${e.files.length ? e.files.join(", ") : "none"}`,
  ];
  if (e.error !== undefined) lines.push(`**Error:**`, e.error);
  else lines.push(`**Answer:**`, e.answer ?? "");
  lines.push("---", "", "");
  return lines.join("\n");
}

export async function appendEntry(root: string, e: LogEntry): Promise<void> {
  const file = path.join(root, LOG_REL);
  await fs.mkdir(path.dirname(file), { recursive: true });
  // "wx" creates the file with the header only if it doesn't exist yet.
  await fs.writeFile(file, HEADER, { flag: "wx" }).catch((err) => {
    if (err.code !== "EEXIST") throw err;
  });
  await fs.appendFile(file, formatEntry(e));
}

/** The last `n` entries, oldest first, or null if the log doesn't exist yet. */
export async function readLastEntries(root: string, n: number): Promise<string[] | null> {
  let text: string;
  try {
    text = await fs.readFile(path.join(root, LOG_REL), "utf8");
  } catch (err: any) {
    if (err.code === "ENOENT") return null;
    throw err;
  }
  const entries = text.split(MARKER).slice(1).map((s) => s.trim());
  return n > 0 ? entries.slice(-n) : [];
}
