import { describe, it, expect } from "vitest";
import { globMatch, matchesDeny } from "../src/glob.js";
import { diffRevArgs } from "../src/git.js";
import { parseFindings } from "../src/review.js";

describe("globMatch", () => {
  it("handles *, **, ? and braces", () => {
    expect(globMatch("src/*.ts", "src/a.ts")).toBe(true);
    expect(globMatch("src/*.ts", "src/deep/a.ts")).toBe(false);
    expect(globMatch("src/**/*.ts", "src/a.ts")).toBe(true);
    expect(globMatch("src/**/*.ts", "src/x/y/a.ts")).toBe(true);
    expect(globMatch("**/*.md", "README.md")).toBe(true);
    expect(globMatch("src/?.ts", "src/a.ts")).toBe(true);
    expect(globMatch("*.{ts,js}", "a.js")).toBe(true);
    expect(globMatch("*.{ts,js}", "a.py")).toBe(false);
    expect(globMatch("a.b", "aXb")).toBe(false);
  });
});

describe("matchesDeny", () => {
  it("matches basename patterns at any depth and anchored paths with their subtrees", () => {
    expect(matchesDeny("a/b/data.sqlite", "*.sqlite")).toBe(true);
    expect(matchesDeny("a/secrets/x", "secrets")).toBe(true);
    expect(matchesDeny("secrets/x/y", "secrets/")).toBe(true);
    expect(matchesDeny("secrets/x/y", "secrets/**")).toBe(true);
    expect(matchesDeny("other/secrets/x", "/secrets/")).toBe(false);
    expect(matchesDeny("config/prod.json", "config/prod.*")).toBe(true);
    expect(matchesDeny("config/dev.json", "config/prod.*")).toBe(false);
  });
});

describe("diffRevArgs", () => {
  it("maps specs to git args", () => {
    expect(diffRevArgs("staged")).toEqual(["--staged"]);
    expect(diffRevArgs("working")).toEqual([]);
    expect(diffRevArgs("HEAD")).toEqual(["HEAD"]);
    expect(diffRevArgs("HEAD~2")).toEqual(["HEAD~2"]);
    expect(diffRevArgs("origin/main...HEAD")).toEqual(["origin/main...HEAD"]);
    expect(diffRevArgs("v1.0..v1.1")).toEqual(["v1.0..v1.1"]);
  });
  it("rejects anything that could be a flag or is not a plain ref", () => {
    for (const s of ["-p", "--output=x", "HEAD -- x", "a..-b", "$(id)", "a:b", "a/", "x.lock", "a....b"]) {
      expect(() => diffRevArgs(s), s).toThrow(/Invalid diff/);
    }
  });
});

describe("parseFindings", () => {
  it("takes the last json block and normalizes fields", () => {
    const text =
      'Example: ```json\n{"findings":[{"file":"x","severity":"low","issue":"old"}]}\n```\n' +
      'Final:\n```json\n{"findings":[{"path":"y","line":"7","severity":"WARNING","description":"d","suggestion":"s"}]}\n```';
    expect(parseFindings(text)).toEqual({
      parsed: true,
      findings: [{ file: "y", line: 7, severity: "medium", issue: "d", fix: "s" }],
    });
  });
  it("accepts a bare trailing object and an empty list", () => {
    expect(parseFindings('All good. {"findings":[]}')).toEqual({ parsed: true, findings: [] });
  });
  it("returns parsed:false when nothing usable is there", () => {
    expect(parseFindings("no json here")).toEqual({ parsed: false, findings: [] });
    expect(parseFindings("```json\n[1, 2\n```")).toEqual({ parsed: false, findings: [] });
  });
});
