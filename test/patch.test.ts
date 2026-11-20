import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../src/index.js";
import { LOG_REL } from "../src/log.js";
import { defaultConfig } from "../src/config.js";
import { extractPatch, patchPaths, patchPathProblem, gitApplyCheck, checkPatch } from "../src/patch.js";

const FAKE_BIN = path.resolve(__dirname, "fixtures/bin");
let root: string;

beforeAll(() => {
  fs.chmodSync(path.join(FAKE_BIN, "agy"), 0o755);
  process.env.PATH = `${FAKE_BIN}${path.delimiter}${process.env.PATH}`;
});

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "zwilling-patch-")));
  fs.mkdirSync(path.join(root, "src"));
  fs.writeFileSync(path.join(root, "src/a.ts"), "const a = 1;\nconst b = 2;\nconst c = 3;\n");
});

afterEach(() => {
  delete process.env.FAKE_AGY_MODE;
  delete process.env.FAKE_AGY_RESPONSE;
  fs.rmSync(root, { recursive: true, force: true });
});

const GOOD = [
  "diff --git a/src/a.ts b/src/a.ts",
  "--- a/src/a.ts",
  "+++ b/src/a.ts",
  "@@ -1,3 +1,3 @@",
  " const a = 1;",
  "-const b = 2;",
  "+const b = 20;",
  " const c = 3;",
  "",
].join("\n");

const NEW_FILE = ["diff --git a/src/new.ts b/src/new.ts", "--- /dev/null", "+++ b/src/new.ts", "@@ -0,0 +1 @@", "+export {};", ""].join(
  "\n",
);

const answer = (patch: string) => `Change b to 20.\n\n\`\`\`diff\n${patch}\`\`\`\n`;

describe("extractPatch", () => {
  it("takes the last diff block", () => {
    const a = `first\n\`\`\`diff\n--- a/x\n+++ b/x\n\`\`\`\nthen\n${answer(GOOD)}`;
    expect(extractPatch(a)).toBe(GOOD);
  });

  it("adds a missing new/deleted file mode line", () => {
    expect(extractPatch(answer(NEW_FILE))).toContain("diff --git a/src/new.ts b/src/new.ts\nnew file mode 100644\n--- /dev/null");
    const del = "diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ /dev/null\n@@ -1 +0,0 @@\n-x\n";
    expect(extractPatch(answer(del))).toContain("b/src/a.ts\ndeleted file mode 100644\n--- a/src/a.ts");
    expect(extractPatch(answer(GOOD))).toBe(GOOD);
  });

  it("falls back to a bare diff --git section and returns null without a diff", () => {
    expect(extractPatch(`Here you go:\n${GOOD}`)).toBe(GOOD);
    expect(extractPatch("No change needed.")).toBeNull();
    expect(extractPatch("```diff\njust prose\n```")).toBeNull();
  });
});

describe("patchPaths", () => {
  it("collects paths from headers, ignoring /dev/null and prefixes", () => {
    expect(patchPaths(GOOD)).toEqual(["src/a.ts"]);
    expect(patchPaths(NEW_FILE)).toEqual(["src/new.ts"]);
    expect(patchPaths("--- a/x.ts\t2026-01-01\n+++ b/x.ts\t2026-01-01\n")).toEqual(["x.ts"]);
    expect(patchPaths("diff --git a/o b/n\nrename from o\nrename to n\n").sort()).toEqual(["n", "o"]);
  });
});

describe("patchPathProblem", () => {
  it("accepts existing and new files inside the root", async () => {
    expect(await patchPathProblem(root, "src/a.ts", [])).toBeNull();
    expect(await patchPathProblem(root, "src/deep/new/file.ts", [])).toBeNull();
  });

  it("refuses escapes, absolute paths, blocked and denied files", async () => {
    expect(await patchPathProblem(root, "../x", [])).toMatch(/inside the project/);
    expect(await patchPathProblem(root, "/etc/passwd", [])).toMatch(/inside the project/);
    expect(await patchPathProblem(root, ".env", [])).toMatch(/\.env/);
    expect(await patchPathProblem(root, ".git/hooks/pre-commit", [])).toMatch(/\.git/);
    expect(await patchPathProblem(root, "secrets/k.txt", ["secrets/"])).not.toBeNull();
  });

  it("refuses paths through symlinks that leave the root or lead into .git", async () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "zwilling-out-"));
    try {
      fs.symlinkSync(outside, path.join(root, "out"));
      expect(await patchPathProblem(root, "out/x.ts", [])).toMatch(/symlink/);
      fs.mkdirSync(path.join(root, ".git"));
      fs.symlinkSync(path.join(root, ".git"), path.join(root, "g"));
      expect(await patchPathProblem(root, "g/config", [])).toMatch(/\.git/);
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });
});

describe("gitApplyCheck / checkPatch", () => {
  it("accepts a patch that applies and leaves the file unchanged", async () => {
    expect(await gitApplyCheck(root, GOOD)).toBeNull();
    expect(fs.readFileSync(path.join(root, "src/a.ts"), "utf8")).toContain("const b = 2;");
    expect(await gitApplyCheck(root, extractPatch(answer(NEW_FILE))!)).toBeNull();
    expect(fs.existsSync(path.join(root, "src/new.ts"))).toBe(false);
  });

  it("tolerates wrong hunk line counts (--recount)", async () => {
    expect(await gitApplyCheck(root, GOOD.replace("@@ -1,3 +1,3 @@", "@@ -1,7 +1,9 @@"))).toBeNull();
  });

  it("reports git's error for a patch that doesn't apply", async () => {
    const err = await gitApplyCheck(root, GOOD.replace(" const a = 1;", " const a = 999;"));
    expect(err).toMatch(/patch failed|does not apply/);
  });

  it("checkPatch reports missing diffs and refused paths without running git", async () => {
    expect(await checkPatch(root, "Nothing to change.", [])).toMatchObject({ patch: null, applies: false });
    const r = await checkPatch(root, answer(GOOD.replaceAll("src/a.ts", ".env")), []);
    expect(r.applies).toBe(false);
    expect(r.error).toMatch(/refused: \.env/);
  });
});

describe("gemini_patch tool", () => {
  async function connect() {
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await createServer({ root, config: defaultConfig(), timeoutMs: 10_000 }).connect(st);
    const c = new Client({ name: "test-patch", version: "0" });
    await c.connect(ct);
    return async (args: Record<string, unknown>) => {
      const r: any = await c.callTool({ name: "gemini_patch", arguments: args });
      await c.close();
      return r;
    };
  }

  it("returns the patch with a passing check, and never applies it", async () => {
    process.env.FAKE_AGY_MODE = "respond";
    process.env.FAKE_AGY_RESPONSE = answer(GOOD);
    const r = await (await connect())({ instructions: "Set b to 20", files: ["src/a.ts"] });
    expect(r.isError).toBeFalsy();
    expect(r.structuredContent).toEqual({ patch: GOOD, files: ["src/a.ts"], applies: true });
    expect(r.content[0].text).toContain("[zwilling: patch applies cleanly with git apply --check (src/a.ts); not applied]");
    expect(fs.readFileSync(path.join(root, "src/a.ts"), "utf8")).toContain("const b = 2;");
    expect(fs.readFileSync(path.join(root, LOG_REL), "utf8")).toContain("· gemini_patch ·");
  });

  it("sends the patch instructions to Gemini", async () => {
    const r = await (await connect())({ instructions: "Set b to 20", files: ["src/a.ts"] });
    const echoed = JSON.parse(r.content[0].text.split("\n\n[zwilling:")[0]);
    expect(echoed.prompt).toContain("Set b to 20");
    expect(echoed.prompt).toContain("fenced ```diff block");
  });

  it("reports a patch that doesn't apply as a normal result with applies: false", async () => {
    process.env.FAKE_AGY_MODE = "respond";
    process.env.FAKE_AGY_RESPONSE = answer(GOOD.replace(" const c = 3;", " const c = 4;"));
    const r = await (await connect())({ instructions: "x", files: ["src/a.ts"] });
    expect(r.isError).toBeFalsy();
    expect(r.structuredContent.applies).toBe(false);
    expect(r.content[0].text).toMatch(/\[zwilling: patch not usable: [\s\S]+\]/);
  });

  it("needs files, a diff or a follow_up", async () => {
    const r = await (await connect())({ instructions: "x" });
    expect(r.isError).toBe(true);
    expect(fs.existsSync(path.join(root, LOG_REL))).toBe(false);
  });
});
