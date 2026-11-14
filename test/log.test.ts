import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { appendEntry, readLastEntries, formatEntry, LOG_REL } from "../src/log.js";

let root: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "zwilling-log-"));
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

describe("log", () => {
  it("formats an entry like the plan", () => {
    const text = formatEntry({
      tool: "ask_gemini",
      prompt: "Why?",
      files: ["src/auth.ts", "src/session.ts"],
      answer: "Because.",
      date: new Date(2026, 10, 13, 19, 45),
    });
    expect(text).toContain("## 2026-11-13 19:45 · ask_gemini · model: default\n");
    expect(text).toContain("**Prompt:** Why?\n**Files:** src/auth.ts, src/session.ts\n**Answer:**\nBecause.\n---\n");
  });

  it("truncates the prompt preview to 500 chars", () => {
    const text = formatEntry({ tool: "t", prompt: "p".repeat(800), files: [], answer: "a" });
    expect(text).toContain(`**Prompt:** ${"p".repeat(500)}…\n`);
  });

  it("creates the file with a header and appends entries", async () => {
    expect(await readLastEntries(root, 5)).toBeNull();
    await appendEntry(root, { tool: "ask_gemini", prompt: "one", files: [], answer: "A1" });
    await appendEntry(root, { tool: "gemini_review", model: "m", prompt: "two", files: ["x.ts"], error: "boom" });
    const file = fs.readFileSync(path.join(root, LOG_REL), "utf8");
    expect(file.startsWith("# Gemini log")).toBe(true);
    expect(file.match(/^## /gm)).toHaveLength(2);
    expect(file).toContain("**Error:**\nboom");
  });

  it("returns the last N entries even if answers contain --- and headings", async () => {
    for (let i = 1; i <= 4; i++) {
      await appendEntry(root, { tool: "ask_gemini", prompt: `q${i}`, files: [], answer: `## Heading\n---\nanswer ${i}` });
    }
    const last2 = (await readLastEntries(root, 2))!;
    expect(last2).toHaveLength(2);
    expect(last2[0]).toContain("answer 3");
    expect(last2[1]).toContain("answer 4");
    expect(await readLastEntries(root, 50)).toHaveLength(4);
  });
});
