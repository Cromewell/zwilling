import { describe, it, expect, beforeAll, afterEach } from "vitest";
import path from "node:path";
import fs from "node:fs";
import { runGemini, isSuccess, MAX_ANSWER_BYTES } from "../src/gemini.js";

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
