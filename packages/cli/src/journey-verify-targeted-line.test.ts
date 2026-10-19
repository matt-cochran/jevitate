import { describe, expect, it } from "vitest";
import { verifyAssertionLine, type JourneyVerifyAssertion } from "./journey-verify.js";

/**
 * #609 part B — the human `journey verify` line names the earlier postconditions a targeted proof
 * relaxed, and why a targeted proof was refused, so the evidence is readable without `--json`.
 */

const line = (a: JourneyVerifyAssertion): string => verifyAssertionLine(a);

describe("verifyAssertionLine targeted proof detail (#609)", () => {
  it("a sensitive targeted verdict names the relaxed steps inside the proved-by parenthetical", () => {
    expect(line({ site: "end-state:0", check: "valueEquals #view", verdict: "sensitive", provedBy: "swap-param:threadId", relaxedSites: ["step:3"] })).toContain("(proved by swap-param:threadId, relaxed step:3)");
  });

  it("a refused targeted proof names the reason in its own parenthetical", () => {
    expect(line({ site: "end-state:0", check: "valueEquals #view", verdict: "cascade", targetedRefusal: "step:3 is not paired with swap-param:threadId" })).toContain("(targeted proof refused: step:3 is not paired with swap-param:threadId)");
  });
});
