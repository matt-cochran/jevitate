import { describe, it, expect } from "vitest";
import { safeRunPolicy, type RunPolicy } from "./run-policy.js";

describe("safeRunPolicy", () => {
  it("defaults to the safe policy: fail-closed self-heal, deterministic direction, fail-closed secret", () => {
    const p: RunPolicy = safeRunPolicy();
    expect(p).toEqual({
      selfHeal: { mode: "fail-closed" },
      direction: { direction: "deterministic" },
      secret: { secretMode: "fail-closed" },
    });
  });
});
