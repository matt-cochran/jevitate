import { describe, expect, it } from "vitest";
import { MissionResultSchema } from "./mission-result.js";
import { RunTagError, matchesRunTags, parseRunTagSpecs, runTagsOf, validateRunTags } from "./run-tags.js";

describe("#426 run tags", () => {
  it("parses repeatable key=value specs (a value may contain '=')", () => {
    expect(parseRunTagSpecs(["feature=checkout", "release=0.8.0", "q=a=b"])).toEqual({ feature: "checkout", release: "0.8.0", q: "a=b" });
    expect(parseRunTagSpecs([])).toEqual({});
  });

  it.each([
    ["no equals", ["feature"], /key=value/],
    ["empty key", ["=x"], /must be 1-64/],
    ["bad key", ["fea ture=x"], /must be 1-64/],
    ["empty value", ["feature="], /value is empty/],
    ["control char", ["feature=a\nb"], /control character/],
    ["duplicate", ["a=1", "a=2"], /given twice/],
  ])("refuses %s", (_name, specs, msg) => {
    expect(() => parseRunTagSpecs(specs)).toThrow(RunTagError);
    expect(() => parseRunTagSpecs(specs)).toThrow(msg);
  });

  it("validates an object (MCP tags, a sweep target's tags)", () => {
    expect(validateRunTags({ a: "1" })).toEqual({ a: "1" });
    expect(() => validateRunTags({ a: 1 })).toThrow(/must be a string/);
    expect(() => validateRunTags(["a=1"])).toThrow(/must be an object/);
    expect(() => validateRunTags({ "a b": "1" })).toThrow(RunTagError);
  });

  it("matches with AND semantics and reads a result's tags tolerantly", () => {
    const tags = runTagsOf({ tags: { feature: "checkout", release: "0.8.0", junk: 3 } });
    expect(tags).toEqual({ feature: "checkout", release: "0.8.0" });
    expect(matchesRunTags(tags, {})).toBe(true);
    expect(matchesRunTags(tags, { feature: "checkout" })).toBe(true);
    expect(matchesRunTags(tags, { feature: "checkout", release: "0.7.0" })).toBe(false);
    expect(runTagsOf(null)).toEqual({});
  });

  it("the result schema accepts tags and the structured target (additive)", () => {
    const base = {
      schemaVersion: 1,
      strategy: "adversarial",
      missionOutcome: "clean",
      exitCode: 0,
      defects: [],
      hangs: [],
      recordingPaths: ["/r.json"],
      transcriptPath: "/t.json",
      resultPath: "/r.result.json",
      target: { seedUrl: "http://a/", allowlist: ["http://a"], startUrl: "http://a/", persona: "admin", strategy: "adversarial" },
      engine: { version: "0", commit: "x", builtAt: "y" },
    };
    expect(MissionResultSchema.safeParse({ ...base, tags: { feature: "checkout" } }).success).toBe(true);
    expect(MissionResultSchema.safeParse({ ...base, tags: { "bad key": "x" } }).success).toBe(false);
  });
});
