// Tool-level tests for config, diffs, globs, structured review output, timeout_s and gemini_task.
import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../src/index.js";
import { LOG_REL } from "../src/log.js";
import { loadConfig, type Config } from "../src/config.js";

const FAKE_BIN = path.resolve(__dirname, "fixtures/bin");
let root: string;
let clients: Client[] = [];

beforeAll(() => {
  fs.chmodSync(path.join(FAKE_BIN, "agy"), 0o755);
  process.env.PATH = `${FAKE_BIN}${path.delimiter}${process.env.PATH}`;
});

const git = (...args: string[]) =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args], {
    cwd: root,
    stdio: "pipe",
  });

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "zwilling-features-")));
  fs.mkdirSync(path.join(root, "src"));
  fs.writeFileSync(path.join(root, "src/a.ts"), "const a = 1;\n");
  fs.writeFileSync(path.join(root, "src/b.ts"), "const b = 2;\n");
});

afterEach(async () => {
  delete process.env.FAKE_AGY_MODE;
  delete process.env.FAKE_AGY_RESPONSE;
  delete process.env.FAKE_AGY_DELAY_MS;
  for (const c of clients) await c.close();
  clients = [];
  fs.rmSync(root, { recursive: true, force: true });
});

/** Start a server; `fileConfig` is written to .zwilling.json and loaded the way main() does. */
async function connect(fileConfig?: object, timeoutMs = 2000, env: NodeJS.ProcessEnv = {}) {
  if (fileConfig) fs.writeFileSync(path.join(root, ".zwilling.json"), JSON.stringify(fileConfig));
  const config: Config = await loadConfig(root, env);
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await createServer({ root, config, timeoutMs }).connect(st);
  const client = new Client({ name: "test", version: "0" });
  await client.connect(ct);
  clients.push(client);
  return async (name: string, args: Record<string, unknown>) => {
    const r: any = await client.callTool({ name, arguments: args });
    // First block is the answer; a trailing `[zwilling: log entry …]` block carries the log id.
    const text = r.content[0].text as string;
    let echoed: any;
    try {
      echoed = JSON.parse(text.split("\n\n[zwilling:")[0]);
    } catch {
      /* not an echo */
    }
    return { isError: !!r.isError, text, echoed, structured: r.structuredContent };
  };
}
const logText = () => fs.readFileSync(path.join(root, LOG_REL), "utf8");
const modelArg = (args: string[]) => (args.includes("--model") ? args[args.indexOf("--model") + 1] : undefined);

describe("config-driven defaults", () => {
  it("uses model for ask_gemini and reviewModel for gemini_review", async () => {
    const call = await connect({ model: "gemini-3.8-flash-low", reviewModel: "gemini-3.8-flash-high" });
    expect(modelArg((await call("ask_gemini", { prompt: "x" })).echoed.args)).toBe("gemini-3.8-flash-low");
    expect(modelArg((await call("gemini_review", { files: ["src/a.ts"] })).echoed.args)).toBe("gemini-3.8-flash-high");
    // An explicit model wins.
    expect(modelArg((await call("gemini_review", { files: ["src/a.ts"], model: "m" })).echoed.args)).toBe("m");
    expect(logText()).toContain("· gemini_review · model: gemini-3.8-flash-high");
  });

  it("falls back to model for reviews when reviewModel is unset", async () => {
    const call = await connect({ model: "m-default" });
    expect(modelArg((await call("gemini_review", { files: ["src/a.ts"] })).echoed.args)).toBe("m-default");
  });

  it("applies limits and extra deny patterns", async () => {
    fs.writeFileSync(path.join(root, "src/c.sqlite"), "x");
    const call = await connect({ limits: { maxFiles: 1 }, deny: ["*.sqlite"] });
    const many = await call("ask_gemini", { prompt: "x", files: ["src/a.ts", "src/b.ts"] });
    expect(many.isError).toBe(true);
    const denied = await call("ask_gemini", { prompt: "x", files: ["src/c.sqlite"] });
    expect(denied.isError).toBe(true);
    expect(denied.text).toMatch(/deny pattern/);
    // Built-in denylist still applies.
    fs.writeFileSync(path.join(root, ".env"), "T=1");
    expect((await call("ask_gemini", { prompt: "x", files: [".env"] })).isError).toBe(true);
  });

  it("uses a custom review template from the config", async () => {
    fs.mkdirSync(path.join(root, ".zwilling"));
    fs.writeFileSync(path.join(root, ".zwilling/review.md"), "Review per our house rules: no any.\n");
    const call = await connect({ prompts: { review: ".zwilling/review.md" } });
    const r = await call("gemini_review", { files: ["src/a.ts"], focus: "types" });
    expect(r.echoed.prompt).toContain("Review per our house rules: no any.\nFocus on: types\n");
    expect(r.echoed.prompt).toContain('```json block of the form {"findings"');
  });

  it("reports a missing review template as a tool error", async () => {
    const call = await connect({ prompts: { review: "nope.md" } });
    const r = await call("gemini_review", { files: ["src/a.ts"] });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/not found/);
  });
});

describe("files: globs, directories, line ranges", () => {
  it("expands globs and line ranges and reports skipped files", async () => {
    fs.writeFileSync(path.join(root, "src/img.png"), Buffer.from([0x89, 0, 0, 1]));
    fs.writeFileSync(path.join(root, "src/long.ts"), "1\n2\n3\n4\n");
    const call = await connect();
    const r = await call("ask_gemini", { prompt: "x", files: ["src/*.ts", "src/long.ts:2-3", "src/"] });
    expect(r.isError).toBe(false);
    expect(r.echoed.prompt).toContain("file path=src/a.ts>>>");
    expect(r.echoed.prompt).toContain("file path=src/long.ts lines=2-3>>>\n2\n3\n");
    expect(r.text).toContain("[zwilling: skipped from globs/directories: src/img.png (binary)]");
    expect(logText()).toContain("src/long.ts:2-3");
  });
});

describe("gemini_review with diff", () => {
  beforeEach(() => {
    git("init", "-q", "-b", "master");
    fs.writeFileSync(path.join(root, ".env"), "TOKEN=old\n");
    git("add", ".");
    git("commit", "-q", "-m", "init");
    git("checkout", "-q", "-b", "feature");
    fs.writeFileSync(path.join(root, "src/a.ts"), "const a = 42;\n");
    fs.writeFileSync(path.join(root, ".env"), "TOKEN=new\n");
  });

  it("attaches the working-tree diff, leaving blocked files out", async () => {
    const call = await connect();
    const r = await call("gemini_review", { diff: "HEAD" });
    expect(r.isError).toBe(false);
    expect(r.echoed.prompt).toMatch(/^.*Review these changes/m);
    expect(r.echoed.prompt).toMatch(/<<<zwilling:BEGIN [0-9a-f]+ diff HEAD>>>\ndiff --git a\/src\/a\.ts/);
    expect(r.echoed.prompt).toContain("+const a = 42;");
    expect(r.echoed.prompt).not.toContain("TOKEN");
    expect(r.text).toContain("[zwilling: left blocked files out of the diff: .env]");
    expect(logText()).toContain("**Files:** (diff: HEAD)");
  });

  it("supports staged and ref ranges", async () => {
    const call = await connect();
    expect((await call("gemini_review", { diff: "staged" })).text).toMatch(/No changes for diff staged/);
    git("add", "src/a.ts");
    expect((await call("gemini_review", { diff: "staged" })).echoed.prompt).toContain("+const a = 42;");
    git("commit", "-q", "-m", "change");
    const r = await call("gemini_review", { diff: "master...HEAD", files: ["src/b.ts"] });
    expect(r.isError).toBe(false);
    expect(r.echoed.prompt).toContain("+const a = 42;");
    expect(r.echoed.prompt).toContain("file path=src/b.ts>>>");
  });

  it("rejects flag injection and bad refs", async () => {
    const call = await connect();
    for (const diff of ["--output=/tmp/x", "-p", "HEAD;rm -rf /", "a..-b", "HEAD:src/a.ts", "a b"]) {
      const r = await call("gemini_review", { diff });
      expect(r.isError, diff).toBe(true);
      expect(r.text, diff).toMatch(/Invalid diff/);
    }
  });

  it("counts the diff against the size limit", async () => {
    fs.writeFileSync(path.join(root, "src/a.ts"), "x".repeat(3000) + "\n");
    const call = await connect({ limits: { maxTotalKB: 2 } });
    const r = await call("gemini_review", { diff: "HEAD" });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/too large/);
  });

  it("works for ask_gemini too", async () => {
    const call = await connect();
    const r = await call("ask_gemini", { prompt: "What changed?", diff: "working" });
    expect(r.echoed.prompt).toContain("+const a = 42;");
  });

  it("requires files or diff", async () => {
    const call = await connect();
    const r = await call("gemini_review", {});
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/needs files, a diff, or both/);
  });

  it("reports a non-git root as a tool error", async () => {
    fs.rmSync(path.join(root, ".git"), { recursive: true, force: true });
    const call = await connect();
    const r = await call("gemini_review", { diff: "HEAD" });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/git diff failed/);
  });
});

describe("structured review output", () => {
  it("parses findings from a json block", async () => {
    process.env.FAKE_AGY_MODE = "respond";
    process.env.FAKE_AGY_RESPONSE =
      "Two issues.\n\n```json\n" +
      JSON.stringify({
        findings: [
          { file: "src/a.ts", line: 1, severity: "High", issue: "magic number", fix: "name it" },
          { file: "src/b.ts", line: null, severity: "nit", issue: "naming" },
        ],
      }) +
      "\n```\n";
    const call = await connect();
    const r = await call("gemini_review", { files: ["src/a.ts", "src/b.ts"] });
    expect(r.isError).toBe(false);
    expect(r.text).toContain("Two issues.");
    expect(r.structured).toEqual({
      parsed: true,
      findings: [
        { file: "src/a.ts", line: 1, severity: "high", issue: "magic number", fix: "name it" },
        { file: "src/b.ts", severity: "low", issue: "naming" },
      ],
    });
  });

  it("falls back to text-only when there is no parsable block", async () => {
    process.env.FAKE_AGY_MODE = "respond";
    process.env.FAKE_AGY_RESPONSE = "Looks fine. ```json\n{broken\n```";
    const call = await connect();
    const r = await call("gemini_review", { files: ["src/a.ts"] });
    expect(r.isError).toBe(false);
    expect(r.text).toContain("Looks fine.");
    expect(r.structured).toEqual({ parsed: false, findings: [] });
  });
});

describe("timeout_s", () => {
  it("overrides the default timeout per call", async () => {
    process.env.FAKE_AGY_DELAY_MS = "800";
    const call = await connect(undefined, 300);
    expect((await call("ask_gemini", { prompt: "x" })).text).toMatch(/timed out/);
    expect((await call("ask_gemini", { prompt: "x", timeout_s: 10 })).isError).toBe(false);
  });

  it("is bounded", async () => {
    const call = await connect();
    expect((await call("ask_gemini", { prompt: "x", timeout_s: 5 })).isError).toBe(true);
    expect((await call("ask_gemini", { prompt: "x", timeout_s: 5000 })).isError).toBe(true);
  });
});

describe("gemini_task", () => {
  beforeEach(() => {
    fs.mkdirSync(path.join(root, ".zwilling/tasks"), { recursive: true });
    fs.writeFileSync(path.join(root, ".zwilling/tasks/test-ideas.md"), "List missing test cases for the attached code.\n");
    fs.writeFileSync(path.join(root, ".zwilling/tasks/explain.md"), "Explain the code.\n");
  });

  it("runs the template with instructions and files and logs it", async () => {
    const call = await connect();
    const r = await call("gemini_task", { task: "test-ideas", instructions: "Edge cases only.", files: ["src/a.ts"] });
    expect(r.isError).toBe(false);
    expect(r.echoed.prompt).toContain("List missing test cases for the attached code.\n\n## Instructions\nEdge cases only.");
    expect(r.echoed.prompt).toContain("file path=src/a.ts>>>");
    expect(logText()).toContain("· gemini_task:test-ideas ·");
  });

  it("lists the tasks in its description", async () => {
    await connect();
    const { tools } = await clients[0].listTools();
    expect(tools.find((t) => t.name === "gemini_task")!.description).toContain("explain, test-ideas");
  });

  it("lists available tasks for an unknown task and rejects path tricks", async () => {
    const call = await connect();
    const r = await call("gemini_task", { task: "nope" });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("Available tasks: explain, test-ideas.");
    for (const task of ["../x", "a/b", ".hidden", ""]) {
      expect((await call("gemini_task", { task })).isError, task).toBe(true);
    }
  });
});
