import { describe, expect, test } from "vitest";
import { currentEngineInfo, withEngine } from "./engine.js";
import { readCliVersion } from "./version.js";

describe("currentEngineInfo", () => {
  test("version matches readCliVersion()", () => {
    expect(currentEngineInfo().version).toBe(readCliVersion());
  });

  test("commit is a short SHA or the honest 'unknown' — never fabricated", () => {
    const { commit } = currentEngineInfo();
    expect(commit === "unknown" || /^[0-9a-f]{4,40}$/.test(commit)).toBe(true);
  });

  test("builtAt is an ISO timestamp or the honest 'unknown' — never fabricated", () => {
    const { builtAt } = currentEngineInfo();
    expect(builtAt === "unknown" || !Number.isNaN(Date.parse(builtAt))).toBe(true);
  });

  test("in this checkout (a real git repo), commit/builtAt are resolved, not 'unknown'", () => {
    // Guards against the generator silently failing in CI/dev — this repo always has a
    // `.git`, so `git rev-parse` should succeed and the generated module should reflect it.
    const { commit, builtAt } = currentEngineInfo();
    expect(commit).not.toBe("unknown");
    expect(builtAt).not.toBe("unknown");
  });
});

describe("withEngine (#112)", () => {
  test("stamps a result with this build's identity, keeping every field", () => {
    expect(withEngine({ outcome: "ok", report: { n: 1 } })).toEqual({ outcome: "ok", report: { n: 1 }, engine: currentEngineInfo() });
  });

  test("takes an explicit identity as data", () => {
    const engine = { version: "9.9.9", commit: "abc1234", builtAt: "2026-09-24T00:00:00Z" };
    expect(withEngine({ a: 1 }, engine)).toEqual({ a: 1, engine });
  });
});
