import { describe, expect, it } from "vitest";
import { clickTimeoutMs, DEFAULT_CLICK_TIMEOUT_MS } from "@jevitate/explore";
import { runtimeEnvProblems } from "./runtime-env.js";

describe("numeric JEVITATE_* tuning variables are refused when invalid, never silently defaulted (#213)", () => {
  it("unset or empty → the default; a positive integer is used as given", () => {
    expect(clickTimeoutMs({})).toBe(DEFAULT_CLICK_TIMEOUT_MS);
    expect(clickTimeoutMs({ JEVITATE_CLICK_TIMEOUT_MS: "" })).toBe(DEFAULT_CLICK_TIMEOUT_MS);
    expect(clickTimeoutMs({ JEVITATE_CLICK_TIMEOUT_MS: "12000" })).toBe(12_000);
  });

  it("a set-but-invalid JEVITATE_CLICK_TIMEOUT_MS throws instead of falling back to 5s", () => {
    for (const bad of ["abc", "0", "-5", "1.5"]) {
      expect(() => clickTimeoutMs({ JEVITATE_CLICK_TIMEOUT_MS: bad })).toThrow(/JEVITATE_CLICK_TIMEOUT_MS must be a positive integer/);
    }
  });

  it("the CLI's startup check reports every invalid variable, and nothing when all are valid", () => {
    expect(runtimeEnvProblems({})).toEqual([]);
    expect(runtimeEnvProblems({ JEVITATE_CLICK_TIMEOUT_MS: "8000", JEVITATE_PAGE_UNRESPONSIVE_MS: "90000" })).toEqual([]);
    const problems = runtimeEnvProblems({ JEVITATE_CLICK_TIMEOUT_MS: "5s", JEVITATE_PAGE_UNRESPONSIVE_MS: "soon" });
    expect(problems).toHaveLength(2);
    expect(problems.join("\n")).toMatch(/JEVITATE_PAGE_UNRESPONSIVE_MS/);
    expect(problems.join("\n")).toMatch(/JEVITATE_CLICK_TIMEOUT_MS/);
  });
});
