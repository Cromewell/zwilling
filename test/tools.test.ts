import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../src/index.js";
import { LOG_REL } from "../src/log.js";
import { PREAMBLE } from "../src/paths.js";

const FAKE_BIN = path.resolve(__dirname, "fixtures/bin");
let root: string;
let client: Client;

beforeAll(() => {
  fs.chmodSync(path.join(FAKE_BIN, "agy"), 0o755);
  process.env.PATH = `${FAKE_BIN}${path.delimiter}${process.env.PATH}`;
});

beforeEach(async () => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "zwilling-tools-")));
  fs.mkdirSync(path.join(root, "src"));
  fs.writeFileSync(path.join(root, "src/a.ts"), "const a = 1;\n");
  fs.writeFileSync(path.join(root, ".env"), "TOKEN=x\n");
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await createServer({ root, timeoutMs: 500 }).connect(st);
  client = new Client({ name: "test", version: "0" });
  await client.connect(ct);
});

afterEach(async () => {
  delete process.env.FAKE_AGY_MODE;
  await client.close();
  fs.rmSync(root, { recursive: true, force: true });
});

const call = async (name: string, args: Record<string, unknown>) => {
  const r: any = await client.callTool({ name, arguments: args });
  return { isError: !!r.isError, text: r.content.map((c: any) => c.text).join("") as string };
};
const logText = () => fs.readFileSync(path.join(root, LOG_REL), "utf8");
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

describe("tools", () => {
  it("lists exactly the four tools", async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(["ask_gemini", "gemini_review", "gemini_task", "read_gemini_log"]);
  });

  it("ask_gemini inlines files, runs in the root, and logs", async () => {
    const r = await call("ask_gemini", { prompt: "Explain", files: ["src/a.ts"], model: "m1" });
    expect(r.isError).toBe(false);
    const echoed = JSON.parse(r.text);
    expect(echoed.prompt).toMatch(
      new RegExp(
        "^" +
          escapeRe(PREAMBLE + "Explain\n\nAttachment boundary id: ") +
          "([0-9a-f]{16})\\n\\n<<<zwilling:BEGIN \\1 file path=src/a\\.ts>>>\\nconst a = 1;\\n<<<zwilling:END \\1>>>$",
      ),
    );
    expect(echoed.cwd).toBe(root);
    expect(logText()).toMatch(/## .* · ask_gemini · model: m1\n\*\*Prompt:\*\* Explain\n\*\*Files:\*\* src\/a\.ts/);
  });

  it("gemini_review uses the review prompt and focus", async () => {
    const r = await call("gemini_review", { files: ["src/a.ts"], focus: "security" });
    expect(r.isError).toBe(false);
    const { prompt } = JSON.parse(r.text);
    expect(prompt.slice(PREAMBLE.length)).toMatch(/^Review these files\. List concrete issues with file:line/);
    expect(prompt).toContain("Focus on: security");
    expect(logText()).toContain("· gemini_review · model: default");
  });

  it("gemini_review passes the model through and logs it", async () => {
    const r = await call("gemini_review", { files: ["src/a.ts"], model: "gemini-3.8-flash-high" });
    const { args } = JSON.parse(r.text) as { args: string[] };
    expect(args[args.indexOf("--model") + 1]).toBe("gemini-3.8-flash-high");
    expect(logText()).toContain("· gemini_review · model: gemini-3.8-flash-high");
  });

  it("rejects path escapes and secrets as tool errors without calling agy", async () => {
    for (const files of [["../etc/passwd"], [".env"]]) {
      const r = await call("ask_gemini", { prompt: "x", files });
      expect(r.isError).toBe(true);
    }
    expect(fs.existsSync(path.join(root, LOG_REL))).toBe(false);
  });

  it("returns a tool error on timeout and logs it", async () => {
    process.env.FAKE_AGY_MODE = "slow";
    const r = await call("ask_gemini", { prompt: "x" });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/timed out/);
    expect(logText()).toContain("**Error:**");
  });

  it("sends progress heartbeats while agy runs, if the client asked for progress", async () => {
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await createServer({ root, timeoutMs: 700, progressIntervalMs: 100 }).connect(st);
    const c = new Client({ name: "test2", version: "0" });
    await c.connect(ct);
    process.env.FAKE_AGY_MODE = "slow";
    const messages: string[] = [];
    await c.callTool({ name: "ask_gemini", arguments: { prompt: "x" } }, undefined, {
      onprogress: (p) => messages.push(p.message ?? ""),
    });
    await c.close();
    expect(messages.length).toBeGreaterThanOrEqual(3);
    expect(messages[0]).toMatch(/waiting for agy/);
  });

  it("returns a tool error with stderr on non-zero exit", async () => {
    process.env.FAKE_AGY_MODE = "fail";
    const r = await call("ask_gemini", { prompt: "x" });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("exit code 3");
    expect(r.text).toContain("not signed in");
  });

  it("says when the answer was truncated", async () => {
    process.env.FAKE_AGY_MODE = "big";
    const r = await call("ask_gemini", { prompt: "x" });
    expect(r.isError).toBe(false);
    expect(r.text).toMatch(/\[zwilling: answer truncated at 100 KB\]$/);
  });

  it("read_gemini_log returns the last N entries", async () => {
    expect((await call("read_gemini_log", {})).text).toMatch(/No entries/);
    await call("ask_gemini", { prompt: "first" });
    await call("ask_gemini", { prompt: "second" });
    await call("ask_gemini", { prompt: "third" });
    const r = await call("read_gemini_log", { last_n: 2 });
    expect(r.text).not.toContain("**Prompt:** first");
    expect(r.text).toContain("**Prompt:** second");
    expect(r.text).toContain("**Prompt:** third");
  });

  it("validates input (more than 20 files)", async () => {
    const r = await call("ask_gemini", { prompt: "x", files: Array.from({ length: 21 }, (_, i) => `f${i}`) });
    expect(r.isError).toBe(true);
  });
});
