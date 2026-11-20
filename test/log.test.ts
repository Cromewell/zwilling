import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { appendEntry, readLastEntries, readEntries, findEntry, formatEntry, parseEntry, resolveLogPath, LOG_REL } from "../src/log.js";

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
      id: "g-20261113-a1b2c3",
    });
    expect(text.startsWith("<!-- zwilling:entry id=g-20261113-a1b2c3 -->\n")).toBe(true);
    expect(text).toContain("## 2026-11-13 19:45 · ask_gemini · model: default · id: g-20261113-a1b2c3\n");
    expect(text).toContain("**Prompt:** Why?\n**Files:** src/auth.ts, src/session.ts\n**Answer:**\nBecause.\n---\n");
  });

  it("truncates the prompt preview to 500 chars", () => {
    const text = formatEntry({ tool: "t", prompt: "p".repeat(800), files: [], answer: "a" });
    expect(text).toContain(`**Prompt:** ${"p".repeat(500)}…\n<details>`);
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

  it("generates ids and round-trips long, multi-line prompts and tricky answers", async () => {
    const prompt = "first line\n```ts\nconst x = 1;\n```\n" + "z".repeat(600) + "\n<!-- zwilling:entry id=g-20200101-000000 -->";
    const answer = "## Heading\n---\n<!-- zwilling:entry -->\nmore\n````\nend";
    const id = await appendEntry(root, { tool: "ask_gemini", prompt, files: ["a.ts", "b.ts"], followUp: "g-20261111-ffffff", answer });
    expect(id).toMatch(/^g-\d{8}-[0-9a-f]{6}$/);
    await appendEntry(root, { tool: "ask_gemini", prompt: "next", files: [], answer: "ok" });
    const entries = (await readEntries(root))!;
    expect(entries).toHaveLength(2);
    const e = entries[0];
    expect(e).toMatchObject({ id, tool: "ask_gemini", model: "default", prompt, promptComplete: true, files: ["a.ts", "b.ts"], followUp: "g-20261111-ffffff", answer });
    expect(entries[1]).toMatchObject({ prompt: "next", answer: "ok", promptComplete: true, files: [] });
    expect((await findEntry(root, id))?.answer).toBe(answer);
    expect(await findEntry(root, "g-20000101-000000")).toBeUndefined();
  });

  it("parses errors and empty answers", () => {
    const err = parseEntry(formatEntry({ tool: "t", prompt: "p", files: [], error: "boom\nline" }).split("\n").slice(1).join("\n").trim(), "g-1");
    expect(err.error).toBe("boom\nline");
    expect(err.answer).toBeUndefined();
    const empty = parseEntry(formatEntry({ tool: "t", prompt: "p", files: [], answer: "" }).split("\n").slice(1).join("\n").trim(), "g-1");
    expect(empty.answer).toBe("");
  });

  it("still reads old-format entries without ids", async () => {
    const old =
      "# Gemini log\n\n" +
      "<!-- zwilling:entry -->\n## 2026-11-01 10:00 · ask_gemini · model: m\n**Prompt:** two\nlines\n**Files:** x.ts\n**Answer:**\nold answer\n---\n\n" +
      `<!-- zwilling:entry -->\n## 2026-11-01 10:01 · gemini_review · model: default\n**Prompt:** ${"p".repeat(500)}…\n**Files:** none\n**Error:**\nfail\n---\n\n`;
    fs.mkdirSync(path.dirname(path.join(root, LOG_REL)), { recursive: true });
    fs.writeFileSync(path.join(root, LOG_REL), old);
    await appendEntry(root, { tool: "ask_gemini", prompt: "new", files: [], answer: "n" });
    const entries = (await readEntries(root))!;
    expect(entries).toHaveLength(3);
    expect(entries[0]).toMatchObject({ id: undefined, tool: "ask_gemini", model: "m", prompt: "two\nlines", promptComplete: true, files: ["x.ts"], answer: "old answer" });
    expect(entries[1]).toMatchObject({ tool: "gemini_review", promptComplete: false, error: "fail" });
    expect(entries[2].id).toMatch(/^g-/);
    expect(await readLastEntries(root, 2)).toHaveLength(2);
  });

  it("uses a custom path and keeps it inside the root", async () => {
    await appendEntry(root, { tool: "t", prompt: "x", files: [], answer: "a" }, "custom/log.md");
    expect(fs.existsSync(path.join(root, "custom/log.md"))).toBe(true);
    expect((await readEntries(root, "custom/log.md"))!).toHaveLength(1);
    expect(() => resolveLogPath(root, "../x.md")).toThrow();
    expect(() => resolveLogPath(root, ".git/x.md")).toThrow();
  });

  it("refuses a log directory that escapes the root through a symlink", async () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "zwilling-out-"));
    try {
      fs.symlinkSync(outside, path.join(root, "link"));
      await expect(appendEntry(root, { tool: "t", prompt: "x", files: [], answer: "a" }, "link/log.md")).rejects.toThrow(/escapes/);
      expect(fs.readdirSync(outside)).toEqual([]);
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it("serializes parallel appends", async () => {
    const big = "b".repeat(300 * 1024);
    await Promise.all(Array.from({ length: 6 }, (_, i) => appendEntry(root, { tool: "t", prompt: `p${i}`, files: [], answer: `${i}${big}` })));
    const entries = (await readEntries(root))!;
    expect(entries).toHaveLength(6);
    for (const e of entries) expect(e.answer).toBe(`${e.prompt.slice(1)}${big}`);
  });
});
