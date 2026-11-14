import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveSafe, readFiles, buildPrompt, getRoot, PREAMBLE, MAX_FILES, MAX_TOTAL_BYTES, UserError } from "../src/paths.js";

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
    expect(buildPrompt("Q?", files)).toBe(
      PREAMBLE + "Q?\n\n--- FILE: src/a.ts ---\nexport const a = 1;\n\n\n--- FILE: src/b.ts ---\nexport const b = 2;\n",
    );
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

  it("rejects directories", async () => {
    await expect(readFiles(root, ["src"])).rejects.toThrow(UserError);
  });
});
