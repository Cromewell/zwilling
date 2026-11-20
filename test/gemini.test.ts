import { describe, it, expect, beforeAll, afterEach } from "vitest";
import path from "node:path";
import fs from "node:fs";
import {
  runGemini,
  listModels,
  parseModels,
  isSuccess,
  LineSplitter,
  MAX_ANSWER_BYTES,
  type Progress,
} from "../src/gemini.js";

const FAKE_BIN = path.resolve(__dirname, "fixtures/bin");
const cwd = path.resolve(__dirname, "..");

beforeAll(() => {
  fs.chmodSync(path.join(FAKE_BIN, "agy"), 0o755);
  process.env.PATH = `${FAKE_BIN}${path.delimiter}${process.env.PATH}`;
});
afterEach(() => {
  delete process.env.FAKE_AGY_MODE;
});

describe("runGemini", () => {
  it("sends the prompt via stdin and returns the answer", async () => {
    const r = await runGemini("hello there", { cwd });
    expect(isSuccess(r)).toBe(true);
    const echoed = JSON.parse(r.text);
    expect(echoed.prompt).toBe("hello there");
    expect(echoed.cwd).toBe(cwd);
  });

  it("passes read-only flags, never the auto-approve flag, and the model if set", async () => {
    const r = await runGemini("x", { cwd, model: "gemini-3.8-flash-high" });
    const { args } = JSON.parse(r.text) as { args: string[] };
    expect(args).not.toContain("--dangerously-skip-permissions");
    expect(args).toContain("--sandbox");
    const settings = JSON.parse(args[args.indexOf("--settings") + 1]);
    expect(settings.permissions.deny).toEqual(
      expect.arrayContaining(["read_file(*)", "write_file(*)", "command(*)", "mcp(*)"]),
    );
    expect(settings.permissions.allow ?? []).toEqual([]);
    expect(args[args.indexOf("--model") + 1]).toBe("gemini-3.8-flash-high");
  });

  it("omits --model when not given", async () => {
    const r = await runGemini("x", { cwd });
    expect(JSON.parse(r.text).args).not.toContain("--model");
  });

  it("handles prompts larger than the OS argument limit", async () => {
    const big = "z".repeat(400 * 1024);
    const r = await runGemini(big, { cwd });
    expect(isSuccess(r)).toBe(true);
    expect(JSON.parse(r.text).promptLength).toBe(big.length);
  });

  it("kills the process on timeout", async () => {
    process.env.FAKE_AGY_MODE = "slow";
    const t0 = Date.now();
    const r = await runGemini("x", { cwd, timeoutMs: 500 });
    expect(r.timedOut).toBe(true);
    expect(isSuccess(r)).toBe(false);
    expect(Date.now() - t0).toBeLessThan(5_000);
  });

  it("kills the process when the abort signal fires", async () => {
    process.env.FAKE_AGY_MODE = "slow";
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 300);
    const t0 = Date.now();
    const r = await runGemini("x", { cwd, timeoutMs: 30_000, signal: ac.signal });
    expect(isSuccess(r)).toBe(false);
    expect(r.timedOut).toBe(false);
    expect(Date.now() - t0).toBeLessThan(5_000);
  });

  it("reports a non-zero exit with stderr", async () => {
    process.env.FAKE_AGY_MODE = "fail";
    const r = await runGemini("x", { cwd });
    expect(isSuccess(r)).toBe(false);
    expect(r.exitCode).toBe(3);
    expect(r.stderr).toContain("not signed in");
  });

  it("reports an ERROR result status with its message", async () => {
    process.env.FAKE_AGY_MODE = "error";
    const r = await runGemini("x", { cwd });
    expect(isSuccess(r)).toBe(false);
    expect(r.status).toBe("ERROR");
    expect(r.error).toContain("invalid model");
  });

  it("truncates oversized answers", async () => {
    process.env.FAKE_AGY_MODE = "big";
    const r = await runGemini("x", { cwd });
    expect(isSuccess(r)).toBe(true);
    expect(r.truncated).toBe(true);
    expect(Buffer.byteLength(r.text)).toBeLessThanOrEqual(MAX_ANSWER_BYTES);
  });

  it("keeps the result after more than 10 MB of streamed output", async () => {
    process.env.FAKE_AGY_MODE = "huge";
    const r = await runGemini("x", { cwd, timeoutMs: 30_000 });
    expect(isSuccess(r)).toBe(true);
    expect(r.text).toBe("survived huge stream");
  });

  it("reports streamed deltas via onProgress", async () => {
    process.env.FAKE_AGY_MODE = "stream";
    const seen: Progress[] = [];
    const r = await runGemini("x", { cwd, onProgress: (p) => seen.push({ ...p }) });
    expect(isSuccess(r)).toBe(true);
    expect(seen.length).toBe(9);
    expect(seen.map((p) => p.chars)).toEqual([10, 20, 30, 40, 50, 60, 70, 80, 81]);
    expect(seen.at(-1)!.text).toBe("0123456789".repeat(8) + "\n");
  });

  it("survives a throwing onProgress callback", async () => {
    process.env.FAKE_AGY_MODE = "stream";
    const r = await runGemini("x", {
      cwd,
      onProgress: () => {
        throw new Error("boom");
      },
    });
    expect(isSuccess(r)).toBe(true);
  });

  it("uses a custom binary when given", async () => {
    const missing = await runGemini("x", { cwd, bin: "zwilling-no-such-cli" });
    expect(missing.spawnError).toMatch(/ENOENT/);
    const r = await runGemini("hi", { cwd, bin: path.join(FAKE_BIN, "agy") });
    expect(isSuccess(r)).toBe(true);
    expect(JSON.parse(r.text).prompt).toBe("hi");
  });

  it("reports a missing binary without throwing", async () => {
    const saved = process.env.PATH;
    process.env.PATH = "/nonexistent";
    try {
      const r = await runGemini("x", { cwd });
      expect(isSuccess(r)).toBe(false);
      expect(r.spawnError).toMatch(/ENOENT/);
    } finally {
      process.env.PATH = saved;
    }
  });
});

describe("LineSplitter", () => {
  const split = (chunks: string[], max?: number) => {
    const lines: string[] = [];
    const s = new LineSplitter((l) => lines.push(l), max);
    for (const c of chunks) s.push(c);
    s.end();
    return lines;
  };

  it("joins lines split across chunks", () => {
    expect(split(['{"a":', '1}\n{"b"', ":2}\n"])).toEqual(['{"a":1}', '{"b":2}']);
  });

  it("handles several lines in one chunk and a trailing line without newline", () => {
    expect(split(["a\nb\nc"])).toEqual(["a", "b", "c"]);
  });

  it("drops lines longer than the cap but keeps the following ones", () => {
    expect(split(["short\n", "x".repeat(30), "y".repeat(30), "\nok\n"], 50)).toEqual(["short", "ok"]);
  });
});

describe("listModels", () => {
  afterEach(() => {
    delete process.env.FAKE_AGY_MODELS_MODE;
  });

  it("parses id<TAB>name lines and skips status lines", () => {
    expect(parseModels("Fetching available models...\na-1\tA One\nb-2\n\n")).toEqual([
      { id: "a-1", name: "A One" },
      { id: "b-2", name: undefined },
    ]);
  });

  it("runs `agy models`", async () => {
    const r = await listModels({ cwd });
    expect(r.exitCode).toBe(0);
    expect(r.models.map((m) => m.id)).toEqual([
      "gemini-3.8-flash-high",
      "gemini-3.8-flash-medium",
      "gemini-3.8-flash-low",
    ]);
  });

  it("reports failures", async () => {
    process.env.FAKE_AGY_MODELS_MODE = "fail";
    const r = await listModels({ cwd });
    expect(r.exitCode).toBe(4);
    expect(r.stderr).toContain("not signed in");
  });
});
