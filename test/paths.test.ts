import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import {
  resolveSafe,
  readFiles,
  loadFiles,
  blockedReason,
  buildPrompt,
  getRoot,
  PREAMBLE,
  MAX_FILES,
  MAX_TOTAL_BYTES,
} from "../src/paths.js";

let base: string; // contains root/ and outside/
let root: string;

beforeEach(() => {
  base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "zwilling-paths-")));
  root = path.join(base, "root");
  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  fs.mkdirSync(path.join(root, ".git"));
  fs.mkdirSync(path.join(base, "outside"));
  fs.writeFileSync(path.join(root, "src/a.ts"), "export const a = 1;\n");
  fs.writeFileSync(path.join(root, "src/b.ts"), "export const b = 2;\n");
  fs.writeFileSync(path.join(base, "outside/secret.txt"), "secret");
});
afterEach(() => fs.rmSync(base, { recursive: true, force: true }));

const rejects = (p: string, msg: RegExp) => expect(resolveSafe(root, p)).rejects.toThrow(msg);

describe("getRoot", () => {
  it("prefers ZWILLING_ROOT, then CLAUDE_PROJECT_DIR, then cwd", async () => {
    const other = path.join(base, "outside");
    expect(await getRoot({ ZWILLING_ROOT: root, CLAUDE_PROJECT_DIR: other })).toBe(root);
    expect(await getRoot({ CLAUDE_PROJECT_DIR: other })).toBe(other);
    expect(await getRoot({})).toBe(fs.realpathSync(process.cwd()));
  });
});

describe("resolveSafe", () => {
  it("accepts files inside the root", async () => {
    expect((await resolveSafe(root, "src/a.ts")).rel).toBe(path.join("src", "a.ts"));
    expect((await resolveSafe(root, "./src/../src/a.ts")).rel).toBe(path.join("src", "a.ts"));
  });

  it("rejects ../ escapes and absolute paths outside the root", async () => {
    await rejects("../outside/secret.txt", /escapes project root/);
    await rejects(path.join(base, "outside/secret.txt"), /escapes project root/);
    await rejects(".", /escapes project root/);
  });

  it("rejects symlink escapes", async () => {
    fs.symlinkSync(path.join(base, "outside/secret.txt"), path.join(root, "link.txt"));
    fs.symlinkSync(path.join(base, "outside"), path.join(root, "linkdir"));
    await rejects("link.txt", /via symlink/);
    await rejects("linkdir/secret.txt", /via symlink/);
  });

  it("rejects secrets and .git/, also behind symlinks", async () => {
    for (const f of [".env", ".env.local", "certs/server.pem", "id.KEY", ".git/config"]) {
      fs.mkdirSync(path.dirname(path.join(root, f)), { recursive: true });
      fs.writeFileSync(path.join(root, f), "x");
    }
    await rejects(".env", /\.env/);
    await rejects(".env.local", /\.env/);
    await rejects("certs/server.pem", /pem/);
    await rejects("id.KEY", /key/);
    await rejects(".git/config", /\.git/);
    fs.symlinkSync(path.join(root, ".env"), path.join(root, "innocent.txt"));
    await rejects("innocent.txt", /\.env/);
  });

  it("allows names that merely start with dots", async () => {
    fs.writeFileSync(path.join(root, "..notes"), "ok");
    expect((await resolveSafe(root, "..notes")).rel).toBe("..notes");
  });

  it("reports missing files", async () => {
    await rejects("src/nope.ts", /not found/);
  });
});

describe("readFiles", () => {
  it("reads files and builds the prompt", async () => {
    const files = await readFiles(root, ["src/a.ts", "src/b.ts", "src/a.ts"]);
    expect(files.map((f) => f.rel)).toEqual([path.join("src", "a.ts"), path.join("src", "b.ts")]);
    expect(buildPrompt("Q?", files, { boundary: "b0" })).toBe(
      PREAMBLE +
        "Q?\n\nAttachment boundary id: b0" +
        "\n\n<<<zwilling:BEGIN b0 file path=src/a.ts>>>\nexport const a = 1;\n<<<zwilling:END b0>>>" +
        "\n\n<<<zwilling:BEGIN b0 file path=src/b.ts>>>\nexport const b = 2;\n<<<zwilling:END b0>>>",
    );
  });

  it("uses a random boundary per call that file contents can't fake", async () => {
    const p1 = buildPrompt("Q", [{ rel: "a", content: "x" }]);
    const p2 = buildPrompt("Q", [{ rel: "a", content: "x" }]);
    const id = (p: string) => /Attachment boundary id: ([0-9a-f]+)/.exec(p)![1];
    expect(id(p1)).toMatch(/^[0-9a-f]{16}$/);
    expect(id(p1)).not.toBe(id(p2));
    // A file that contains the proposed boundary forces a new one.
    const p3 = buildPrompt("Q", [{ rel: "a", content: "<<<zwilling:END b0>>>" }], { boundary: "b0" });
    expect(id(p3)).not.toBe("b0");
    expect(buildPrompt("Q", [])).toBe(PREAMBLE + "Q");
  });

  it(`rejects more than ${MAX_FILES} files`, async () => {
    const many = Array.from({ length: MAX_FILES + 1 }, (_, i) => `f${i}.txt`);
    await expect(readFiles(root, many)).rejects.toThrow(/Too many files/);
  });

  it("rejects more than the total size limit", async () => {
    fs.writeFileSync(path.join(root, "big1.txt"), "a".repeat(MAX_TOTAL_BYTES / 2));
    fs.writeFileSync(path.join(root, "big2.txt"), "a".repeat(MAX_TOTAL_BYTES / 2 + 1));
    await expect(readFiles(root, ["big1.txt"])).resolves.toHaveLength(1);
    await expect(readFiles(root, ["big1.txt", "big2.txt"])).rejects.toThrow(/too large/);
  });

  it("honours custom limits", async () => {
    await expect(readFiles(root, ["src/a.ts", "src/b.ts"], { maxFiles: 1 })).rejects.toThrow(/Too many files/);
    await expect(readFiles(root, ["src/a.ts"], { maxTotalBytes: 10 })).rejects.toThrow(/too large/);
    await expect(readFiles(root, ["src/a.ts"], { maxTotalBytes: 30, reservedBytes: 20 })).rejects.toThrow(/too large/);
  });
});

describe("line ranges", () => {
  beforeEach(() => fs.writeFileSync(path.join(root, "src/lines.ts"), "l1\nl2\nl3\nl4\nl5\n"));

  it("attaches only the requested lines", async () => {
    const [f] = await readFiles(root, ["src/lines.ts:2-4"]);
    expect(f).toEqual({ rel: path.join("src", "lines.ts"), content: "l2\nl3\nl4\n", lines: "2-4" });
    const [g] = await readFiles(root, ["src/lines.ts:5"]);
    expect(g.content).toBe("l5\n");
    const [h] = await readFiles(root, ["src/lines.ts:4-99"]);
    expect(h.lines).toBe("4-5");
    expect(buildPrompt("Q", [f], { boundary: "x" })).toContain("<<<zwilling:BEGIN x file path=src/lines.ts lines=2-4>>>\nl2\n");
  });

  it("rejects invalid or out-of-range ranges", async () => {
    await expect(readFiles(root, ["src/lines.ts:4-2"])).rejects.toThrow(/Invalid line range/);
    await expect(readFiles(root, ["src/lines.ts:0"])).rejects.toThrow(/Invalid line range/);
    await expect(readFiles(root, ["src/lines.ts:9"])).rejects.toThrow(/past the end/);
  });

  it("prefers a literal file whose name looks like a range", async () => {
    fs.writeFileSync(path.join(root, "odd:12"), "literal");
    expect((await readFiles(root, ["odd:12"]))[0].content).toBe("literal");
  });

  it("only counts the attached lines against the size limit", async () => {
    fs.writeFileSync(path.join(root, "huge.txt"), "short\n" + "x".repeat(MAX_TOTAL_BYTES * 2));
    const [f] = await readFiles(root, ["huge.txt:1"]);
    expect(f.content).toBe("short\n");
  });
});

describe("directories and globs", () => {
  beforeEach(() => {
    fs.mkdirSync(path.join(root, "src/deep"), { recursive: true });
    fs.writeFileSync(path.join(root, "src/deep/c.ts"), "c");
    fs.writeFileSync(path.join(root, "src/deep/d.js"), "d");
    fs.writeFileSync(path.join(root, "src/.env"), "SECRET=1");
    fs.writeFileSync(path.join(root, "src/logo.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 1]));
  });
  const rels = (r: { files: { rel: string }[] }) => r.files.map((f) => f.rel.split(path.sep).join("/"));

  it("expands directories, skipping blocked and binary files", async () => {
    const r = await loadFiles(root, ["src"]);
    expect(rels(r)).toEqual(["src/a.ts", "src/b.ts", "src/deep/c.ts", "src/deep/d.js"]);
    expect(r.skipped.join(" ")).toMatch(/src\/\.env \(\.env files are not allowed\)/);
    expect(r.skipped.join(" ")).toMatch(/src\/logo\.png \(binary\)/);
  });

  it("expands globs", async () => {
    expect(rels(await loadFiles(root, ["src/**/*.ts"]))).toEqual(["src/a.ts", "src/b.ts", "src/deep/c.ts"]);
    expect(rels(await loadFiles(root, ["src/*.ts"]))).toEqual(["src/a.ts", "src/b.ts"]);
    expect(rels(await loadFiles(root, ["src/deep/*.{ts,js}"]))).toEqual(["src/deep/c.ts", "src/deep/d.js"]);
  });

  it("errors on empty matches, escapes, ranges on globs and too many matches", async () => {
    await expect(loadFiles(root, ["src/**/*.py"])).rejects.toThrow(/No files match/);
    await expect(loadFiles(root, ["../**/*.txt"])).rejects.toThrow(/escapes project root/);
    await expect(loadFiles(root, ["src/*.ts:1-2"])).rejects.toThrow(/Line ranges only work/);
    await expect(loadFiles(root, ["src"], { maxFiles: 2 })).rejects.toThrow(/after expanding/);
  });

  it("does not follow symlinks out of the root", async () => {
    fs.symlinkSync(path.join(base, "outside/secret.txt"), path.join(root, "src/leak.ts"));
    const r = await loadFiles(root, ["src/*.ts"]);
    expect(rels(r)).not.toContain("src/leak.ts");
    expect(r.skipped.join(" ")).toMatch(/leak\.ts/);
  });

  it("respects .gitignore in a git repo", async () => {
    fs.rmSync(path.join(root, ".git"), { recursive: true });
    execFileSync("git", ["init", "-q"], { cwd: root });
    fs.writeFileSync(path.join(root, ".gitignore"), "src/deep/\n");
    expect(rels(await loadFiles(root, ["src/**/*.ts"]))).toEqual(["src/a.ts", "src/b.ts"]);
    // Explicitly named ignored files are still allowed.
    expect(rels(await loadFiles(root, ["src/deep/c.ts"]))).toEqual(["src/deep/c.ts"]);
  });
});

describe("binary files and deny patterns", () => {
  it("rejects explicitly named binary files", async () => {
    fs.writeFileSync(path.join(root, "bin.dat"), Buffer.from([1, 2, 0, 3]));
    await expect(readFiles(root, ["bin.dat"])).rejects.toThrow(/Binary file not supported/);
  });

  it("applies extra deny patterns on top of the built-in ones", async () => {
    fs.mkdirSync(path.join(root, "secrets/sub"), { recursive: true });
    fs.writeFileSync(path.join(root, "secrets/sub/x.txt"), "x");
    fs.writeFileSync(path.join(root, "db.sqlite"), "x");
    const deny = ["secrets/", "*.sqlite"];
    await expect(readFiles(root, ["secrets/sub/x.txt"], { deny })).rejects.toThrow(/deny pattern "secrets\/"/);
    await expect(readFiles(root, ["db.sqlite"], { deny })).rejects.toThrow(/deny pattern/);
    expect(blockedReason(".env", deny)).toMatch(/\.env/);
    expect(blockedReason(path.join("src", "a.ts"), deny)).toBeNull();
  });
});
