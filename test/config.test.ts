import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadConfig, defaultConfig, ConfigError, CONFIG_FILE } from "../src/config.js";

let root: string;
beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "zwilling-config-")));
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));
const writeConfig = (c: unknown) =>
  fs.writeFileSync(path.join(root, CONFIG_FILE), typeof c === "string" ? c : JSON.stringify(c));

describe("loadConfig", () => {
  it("returns defaults without file or env", async () => {
    expect(await loadConfig(root, {})).toEqual(defaultConfig());
    expect(defaultConfig().limits).toEqual({ maxFiles: 20, maxTotalBytes: 500 * 1024, timeoutMs: 120_000 });
  });

  it("reads .zwilling.json", async () => {
    writeConfig({
      model: "m",
      reviewModel: "rm",
      limits: { maxFiles: 40, maxTotalKB: 1000, timeoutMs: 240000 },
      deny: ["secrets/**"],
      prompts: { review: ".zwilling/review.md" },
      log: { path: "notes/gemini.md", enabled: false },
      cli: "/opt/agy",
    });
    expect(await loadConfig(root, {})).toEqual({
      model: "m",
      reviewModel: "rm",
      limits: { maxFiles: 40, maxTotalBytes: 1000 * 1024, timeoutMs: 240000 },
      deny: ["secrets/**"],
      prompts: { review: ".zwilling/review.md" },
      log: { path: "notes/gemini.md", enabled: false },
      cli: "/opt/agy",
    });
  });

  it("lets env override the file and appends ZWILLING_DENY", async () => {
    writeConfig({ model: "file", limits: { maxFiles: 5 }, deny: ["a"] });
    const c = await loadConfig(root, {
      ZWILLING_MODEL: "env",
      ZWILLING_REVIEW_MODEL: "env-review",
      ZWILLING_MAX_FILES: "7",
      ZWILLING_MAX_TOTAL_KB: "100",
      ZWILLING_TIMEOUT_MS: "5000",
      ZWILLING_DENY: "b, c ,",
      ZWILLING_REVIEW_PROMPT: "r.md",
      ZWILLING_LOG: "off",
      ZWILLING_LOG_PATH: "x.md",
      ZWILLING_CLI: "agy2",
    });
    expect(c).toEqual({
      model: "env",
      reviewModel: "env-review",
      limits: { maxFiles: 7, maxTotalBytes: 100 * 1024, timeoutMs: 5000 },
      deny: ["a", "b", "c"],
      prompts: { review: "r.md" },
      log: { path: "x.md", enabled: false },
      cli: "agy2",
    });
  });

  it("gives clear errors for invalid input", async () => {
    writeConfig("{ not json");
    await expect(loadConfig(root, {})).rejects.toThrow(/\.zwilling\.json: not valid JSON/);
    writeConfig({ limits: { maxFiles: 0 } });
    await expect(loadConfig(root, {})).rejects.toThrow(/Invalid \.zwilling\.json: limits\.maxFiles/);
    writeConfig({ modle: "typo" });
    await expect(loadConfig(root, {})).rejects.toThrow(ConfigError);
    writeConfig({});
    await expect(loadConfig(root, { ZWILLING_TIMEOUT_MS: "soon" })).rejects.toThrow(/ZWILLING_TIMEOUT_MS/);
    await expect(loadConfig(root, { ZWILLING_LOG: "maybe" })).rejects.toThrow(/ZWILLING_LOG/);
  });
});
