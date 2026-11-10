import { describe, expect, it } from "vitest";
import { verifyAssertionLine, type JourneyVerifyAssertion } from "./journey-verify.js";

/**
 * #609 part B — the human `journey verify` line names the earlier postconditions a targeted proof
 * relaxed, and why a targeted proof was refused, so the evidence is readable without `--json`.
 */

const line = (a: JourneyVerifyAssertion): string => verifyAssertionLine(a);

describe("verifyAssertionLine targeted proof detail (#609)", () => {
  it("names independent data/action verdicts and keeps declared relaxations on the actual witness", () => {
    expect(line({ site: "end-state:0", check: "valueEquals Applied", verdict: "sensitive", obligations: [
      { kind: "data", verdict: "sensitive", provedBy: "swap-param:reply", relaxedSites: ["step:3"], declaredProof: true },
      { kind: "action", verdict: "sensitive", provedBy: "skip:3" },
    ] })).toContain("[data: sensitive by swap-param:reply, declared plan relaxed step:3; action: sensitive by skip:3]");
  });

  it("keeps a data refusal visible beside a sensitive action witness", () => {
    expect(line({ site: "end-state:0", check: "valueEquals Applied", verdict: "cascade", obligations: [
      { kind: "data", verdict: "cascade", targetedRefusal: "step:2 is not paired with swap-param:reply" },
      { kind: "action", verdict: "sensitive", provedBy: "skip:3" },
    ] })).toContain("[data: cascade, targeted proof refused: step:2 is not paired with swap-param:reply; action: sensitive by skip:3]");
  });

  it("a sensitive targeted verdict names the relaxed steps inside the proved-by parenthetical", () => {
    expect(line({ site: "end-state:0", check: "valueEquals #view", verdict: "sensitive", provedBy: "swap-param:threadId", relaxedSites: ["step:3"] })).toContain("(proved by swap-param:threadId, relaxed step:3)");
  });

  it("a refused targeted proof names the reason in its own parenthetical", () => {
    expect(line({ site: "end-state:0", check: "valueEquals #view", verdict: "cascade", targetedRefusal: "step:3 is not paired with swap-param:threadId" })).toContain("(targeted proof refused: step:3 is not paired with swap-param:threadId)");
  });
});
