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
  // Generous: under parallel test load, starting the fake agy can take over a second.
  await createServer({ root, timeoutMs: 10_000 }).connect(st);
  client = new Client({ name: "test", version: "0" });
  await client.connect(ct);
});

afterEach(async () => {
  delete process.env.FAKE_AGY_MODE;
  await client.close();
  fs.rmSync(root, { recursive: true, force: true });
});

/** `text` is the first content block (the answer); `entryId` comes from the trailing log-entry block. */
const call = async (name: string, args: Record<string, unknown>, c: Client = client) => {
  const r: any = await c.callTool({ name, arguments: args });
  const blocks: string[] = r.content.map((b: any) => b.text);
  const idBlock = blocks.length > 1 ? /^\[zwilling: log entry (g-\d{8}-[0-9a-f]{6})\]$/.exec(blocks[blocks.length - 1]) : null;
  return { isError: !!r.isError, text: blocks[0], blocks, entryId: idBlock?.[1] };
};
const connect = async (opts: Partial<Parameters<typeof createServer>[0]>) => {
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await createServer({ root, timeoutMs: 10_000, ...opts }).connect(st);
  const c = new Client({ name: "test-extra", version: "0" });
  await c.connect(ct);
  return c;
};
const logText = () => fs.readFileSync(path.join(root, LOG_REL), "utf8");
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

describe("tools", () => {
  it("lists exactly the four tools", async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      "ask_gemini",
      "gemini_review",
      "gemini_task",
      "list_gemini_models",
      "read_gemini_log",
    ]);
  });

  it("reports the version from package.json", () => {
    const pkg = JSON.parse(fs.readFileSync(path.resolve(__dirname, "../package.json"), "utf8"));
    expect(client.getServerVersion()?.version).toBe(pkg.version);
  });

  it("list_gemini_models lists the models from `agy models`", async () => {
    const r = await call("list_gemini_models", {});
    expect(r.isError).toBe(false);
    expect(r.text).toContain("- gemini-3.8-flash-high — Gemini 3.8 Flash (High)");
    expect(r.text).toContain("- gemini-3.8-flash-low — Gemini 3.8 Flash (Low)");
    expect(r.text).not.toContain("Fetching");
  });

  it("list_gemini_models reports failures and empty output as tool errors", async () => {
    try {
      process.env.FAKE_AGY_MODELS_MODE = "fail";
      let r = await call("list_gemini_models", {});
      expect(r.isError).toBe(true);
      expect(r.text).toContain("exit code 4");
      expect(r.text).toContain("not signed in");
      process.env.FAKE_AGY_MODELS_MODE = "empty";
      r = await call("list_gemini_models", {});
      expect(r.isError).toBe(true);
      expect(r.text).toMatch(/no models/);
    } finally {
      delete process.env.FAKE_AGY_MODELS_MODE;
    }
  });

  it("ask_gemini with models runs each model and returns one section per model", async () => {
    const r = await call("ask_gemini", { prompt: "Compare", models: ["m-a", "m-b"] });
    expect(r.isError).toBe(false);
    const sections = r.text.split(/^## \[zwilling\] model: /m).slice(1);
    expect(sections).toHaveLength(2);
    for (const [i, m] of ["m-a", "m-b"].entries()) {
      expect(sections[i].startsWith(`${m}\n\n`)).toBe(true);
      const { args } = JSON.parse(sections[i].slice(m.length).trim());
      expect(args[args.indexOf("--model") + 1]).toBe(m);
    }
    const log = logText();
    expect(log).toMatch(/· ask_gemini · model: m-a[\s\S]*· ask_gemini · model: m-b/);
    expect(log.split("<!-- zwilling:entry ")).toHaveLength(3);
    // One log id per model, in order, in the trailing block.
    expect(r.blocks.at(-1)).toMatch(/^\[zwilling: log entries g-\d{8}-[0-9a-f]{6}, g-\d{8}-[0-9a-f]{6}\]$/);
  });

  it("ask_gemini with models reports partial failures inline", async () => {
    const r = await call("ask_gemini", { prompt: "x", models: ["good", "bad-model"] });
    expect(r.isError).toBe(false);
    expect(r.text).toContain("## [zwilling] model: good\n");
    expect(r.text).toContain("## [zwilling] model: bad-model (failed)");
    expect(r.text).toContain("invalid model selection: bad-model");
    expect(logText()).toContain("**Error:**");
  });

  it("ask_gemini with models is an error only if all models failed", async () => {
    const r = await call("ask_gemini", { prompt: "x", models: ["bad-1", "bad-2"] });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("bad-1 (failed)");
    expect(r.text).toContain("bad-2 (failed)");
  });

  it("ask_gemini rejects model and models together, and more than 4 models", async () => {
    let r = await call("ask_gemini", { prompt: "x", model: "a", models: ["b"] });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/either `model` or `models`/);
    r = await call("ask_gemini", { prompt: "x", models: ["a", "b", "c", "d", "e"] });
    expect(r.isError).toBe(true);
    expect(fs.existsSync(path.join(root, LOG_REL))).toBe(false);
  });

  it("uses the configured CLI binary in runs and error messages", async () => {
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await createServer({ root, timeoutMs: 500, cliBin: "zwilling-no-such-cli" }).connect(st);
    const c = new Client({ name: "test3", version: "0" });
    await c.connect(ct);
    const r: any = await c.callTool({ name: "ask_gemini", arguments: { prompt: "x" } });
    const m: any = await c.callTool({ name: "list_gemini_models", arguments: {} });
    await c.close();
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain("Could not start 'zwilling-no-such-cli': not found on PATH");
    expect(m.isError).toBe(true);
    expect(m.content[0].text).toContain("zwilling-no-such-cli");
  });

  it("progress messages include the streamed character count", async () => {
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await createServer({ root, timeoutMs: 5_000, progressIntervalMs: 100 }).connect(st);
    const c = new Client({ name: "test4", version: "0" });
    await c.connect(ct);
    process.env.FAKE_AGY_MODE = "stream";
    const messages: string[] = [];
    const r: any = await c.callTool({ name: "ask_gemini", arguments: { prompt: "x" } }, undefined, {
      onprogress: (p) => messages.push(p.message ?? ""),
    });
    await c.close();
    expect(r.isError).toBeFalsy();
    expect(messages.some((m) => /waiting for agy \(\d+ s, \d+ chars received\)/.test(m))).toBe(true);
    // Never the answer text itself.
    expect(messages.join("")).not.toContain("0123456789");
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
    expect(logText()).toMatch(/## .* · ask_gemini · model: m1 · id: g-\S+\n\*\*Prompt:\*\* Explain\n\*\*Files:\*\* src\/a\.ts/);
  });

  it("appends the log entry id as a separate content block", async () => {
    const r = await call("ask_gemini", { prompt: "x" });
    expect(r.blocks).toHaveLength(2);
    expect(r.entryId).toMatch(/^g-\d{8}-[0-9a-f]{6}$/);
    expect(logText()).toContain(`<!-- zwilling:entry id=${r.entryId} -->`);
    process.env.FAKE_AGY_MODE = "fail";
    const f = await call("ask_gemini", { prompt: "y" });
    expect(f.isError).toBe(true);
    expect(f.entryId).toMatch(/^g-/);
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
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await createServer({ root, timeoutMs: 500 }).connect(st);
    const c = new Client({ name: "test-timeout", version: "0" });
    await c.connect(ct);
    process.env.FAKE_AGY_MODE = "slow";
    const r: any = await c.callTool({ name: "ask_gemini", arguments: { prompt: "x" } });
    await c.close();
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toMatch(/timed out/);
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

  it("read_gemini_log filters by id, tool and query", async () => {
    const a = await call("ask_gemini", { prompt: "about Alpha" });
    await call("gemini_review", { files: ["src/a.ts"] });
    await call("ask_gemini", { prompt: "about beta" });
    const byId = await call("read_gemini_log", { id: a.entryId });
    expect(byId.text).toContain("**Prompt:** about Alpha");
    expect(byId.text).not.toContain("about beta");
    const reviews = await call("read_gemini_log", { tool: "gemini_review" });
    expect(reviews.text).toContain("· gemini_review ·");
    expect(reviews.text).not.toContain("· ask_gemini ·");
    const q = await call("read_gemini_log", { query: "ALPHA" });
    expect(q.text).toContain("about Alpha");
    expect(q.text).not.toContain("about beta");
    expect((await call("read_gemini_log", { query: "nothing like this" })).text).toMatch(/No matching entries/);
    expect((await call("read_gemini_log", { id: "bad" })).isError).toBe(true);
  });

  it("follow_up sends the earlier question and answer along and logs the reference", async () => {
    const long = "line one\n" + "q".repeat(700);
    const first = await call("ask_gemini", { prompt: long, files: ["src/a.ts"] });
    const second = await call("ask_gemini", { prompt: "And why?", follow_up: first.entryId });
    expect(second.isError).toBe(false);
    const { prompt } = JSON.parse(second.text);
    const body = prompt.slice(PREAMBLE.length);
    expect(body).toMatch(new RegExp(`^\\[Earlier exchange, log entry ${first.entryId}\\]`));
    expect(body).toContain("Files attached then (not attached again unless listed below): src/a.ts");
    expect(body).toContain(`Question:\n${long}\n\nYour answer:\n${first.text}\n\n[Follow-up question]\nAnd why?`);
    expect(logText()).toContain(`**Follow-up of:** ${first.entryId}`);
  });

  it("follow_up rejects unknown ids and failed entries", async () => {
    const unknown = await call("ask_gemini", { prompt: "x", follow_up: "g-20260101-abcdef" });
    expect(unknown.isError).toBe(true);
    expect(unknown.text).toMatch(/No log entry with id g-20260101-abcdef/);
    process.env.FAKE_AGY_MODE = "fail";
    const failed = await call("ask_gemini", { prompt: "x" });
    delete process.env.FAKE_AGY_MODE;
    const r = await call("ask_gemini", { prompt: "y", follow_up: failed.entryId });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/has no answer/);
  });

  it("writes to a custom log path", async () => {
    const c = await connect({ logPath: "notes/gemini.md" });
    await call("ask_gemini", { prompt: "x" }, c);
    await c.close();
    expect(fs.readFileSync(path.join(root, "notes/gemini.md"), "utf8")).toContain("**Prompt:** x");
    expect(fs.existsSync(path.join(root, LOG_REL))).toBe(false);
  });

  it("rejects log paths outside the root or in .git", () => {
    expect(() => createServer({ root, timeoutMs: 500, logPath: "../outside.md" })).toThrow(/inside the project root/);
    expect(() => createServer({ root, timeoutMs: 500, logPath: "/tmp/x.md" })).toThrow(/inside the project root/);
    expect(() => createServer({ root, timeoutMs: 500, logPath: ".git/log.md" })).toThrow(/\.git/);
  });

  it("with the log disabled, writes nothing and says so", async () => {
    const c = await connect({ logEnabled: false });
    const r = await call("ask_gemini", { prompt: "x" }, c);
    expect(r.isError).toBe(false);
    expect(r.blocks).toHaveLength(1);
    expect(fs.existsSync(path.join(root, LOG_REL))).toBe(false);
    expect((await call("read_gemini_log", {}, c)).text).toMatch(/disabled/);
    const f = await call("ask_gemini", { prompt: "y", follow_up: "g-20260101-abcdef" }, c);
    expect(f.isError).toBe(true);
    expect(f.text).toMatch(/disabled/);
    await c.close();
  });

  it("parallel calls each get a whole, separate log entry", async () => {
    const rs = await Promise.all(Array.from({ length: 8 }, (_, i) => call("ask_gemini", { prompt: `p${i}` })));
    const ids = new Set(rs.map((r) => r.entryId));
    expect(ids.size).toBe(8);
    const all = await call("read_gemini_log", { last_n: 100 });
    for (let i = 0; i < 8; i++) expect(all.text).toContain(`**Prompt:** p${i}\n`);
    expect(logText().match(/^<!-- zwilling:entry id=/gm)).toHaveLength(8);
  });

  it("exposes the log as resources", async () => {
    const a = await call("ask_gemini", { prompt: "res one" });
    await call("ask_gemini", { prompt: "res two" });
    const { resources } = await client.listResources();
    const uris = resources.map((r) => r.uri);
    expect(uris).toContain("zwilling://log");
    expect(uris).toContain(`zwilling://log/${a.entryId}`);
    const whole: any = await client.readResource({ uri: "zwilling://log" });
    expect(whole.contents[0].text).toContain("res one");
    expect(whole.contents[0].text).toContain("res two");
    const one: any = await client.readResource({ uri: `zwilling://log/${a.entryId}` });
    expect(one.contents[0].text).toContain("res one");
    expect(one.contents[0].text).not.toContain("res two");
    await expect(client.readResource({ uri: "zwilling://log/g-20260101-abcdef" })).rejects.toThrow();
  });

  it("validates input (more than 20 files)", async () => {
    const r = await call("ask_gemini", { prompt: "x", files: Array.from({ length: 21 }, (_, i) => `f${i}`) });
    expect(r.isError).toBe(true);
  });
});
