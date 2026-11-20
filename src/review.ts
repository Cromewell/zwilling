import { z } from "zod";

export const REVIEW_PROMPT =
  "Review these files. List concrete issues with file:line, severity, and a suggested fix. Don't rewrite whole files.";
export const REVIEW_DIFF_PROMPT =
  "Review these changes (the diff, plus any attached files for context). List concrete issues with file:line, " +
  "severity, and a suggested fix. Focus on the changed lines. Don't rewrite whole files.";

/** Appended to every review prompt so the answer can be parsed into structured findings. */
export const REVIEW_JSON_INSTRUCTIONS =
  "After your written review, end your answer with exactly one fenced ```json block of the form " +
  '{"findings":[{"file":"path","line":12,"severity":"critical|high|medium|low|info","issue":"what is wrong","fix":"suggested fix"}]}. ' +
  'Use "line": null if no line applies and "findings": [] if you found nothing.';

export const SEVERITIES = ["critical", "high", "medium", "low", "info"] as const;
export type Severity = (typeof SEVERITIES)[number];

export const findingSchema = z.object({
  file: z.string(),
  line: z.number().int().optional(),
  severity: z.enum(SEVERITIES),
  issue: z.string(),
  fix: z.string().optional(),
});
export type Finding = z.infer<typeof findingSchema>;

/** outputSchema shape for gemini_review. */
export const reviewOutputShape = {
  parsed: z.boolean().describe("False if Gemini's answer had no parsable findings block; then `findings` is empty."),
  findings: z.array(findingSchema),
};

const SEVERITY_ALIASES: Record<string, Severity> = {
  critical: "critical",
  blocker: "critical",
  severe: "critical",
  high: "high",
  major: "high",
  error: "high",
  medium: "medium",
  moderate: "medium",
  warning: "medium",
  warn: "medium",
  low: "low",
  minor: "low",
  nit: "low",
  trivial: "low",
  info: "info",
  note: "info",
  suggestion: "info",
};

function normalizeSeverity(v: unknown): Severity {
  return SEVERITY_ALIASES[String(v ?? "").trim().toLowerCase()] ?? "info";
}

function normalizeLine(v: unknown): number | undefined {
  const n = typeof v === "number" ? v : typeof v === "string" ? parseInt(v, 10) : NaN;
  return Number.isInteger(n) && n > 0 ? n : undefined;
}

function str(v: unknown): string | undefined {
  if (typeof v === "string") return v.trim() || undefined;
  if (v == null) return undefined;
  return String(v);
}

/**
 * Pull findings out of the last ```json block (or a bare trailing JSON object) in the answer.
 * Never throws; returns `{ parsed: false, findings: [] }` if nothing usable is found.
 */
export function parseFindings(answer: string): { parsed: boolean; findings: Finding[] } {
  const none = { parsed: false, findings: [] as Finding[] };
  const blocks = [...answer.matchAll(/```(?:json|JSON)?\s*\n([\s\S]*?)```/g)].map((m) => m[1]);
  const lastBrace = answer.lastIndexOf('{"findings"');
  if (lastBrace >= 0) blocks.push(answer.slice(lastBrace));
  for (const raw of blocks.reverse()) {
    let data: any;
    try {
      data = JSON.parse(raw.trim());
    } catch {
      continue;
    }
    const list = Array.isArray(data) ? data : Array.isArray(data?.findings) ? data.findings : null;
    if (!list) continue;
    const findings: Finding[] = [];
    for (const f of list) {
      if (!f || typeof f !== "object") continue;
      const issue = str(f.issue ?? f.description ?? f.message);
      if (!issue) continue;
      const line = normalizeLine(f.line);
      const fix = str(f.fix ?? f.suggestion);
      findings.push({
        file: str(f.file ?? f.path) ?? "",
        ...(line !== undefined ? { line } : {}),
        severity: normalizeSeverity(f.severity),
        issue,
        ...(fix !== undefined ? { fix } : {}),
      });
    }
    return { parsed: true, findings };
  }
  return none;
}
