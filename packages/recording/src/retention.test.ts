import { describe, it, expect } from "vitest";
import { applyRetention } from "./retention.js";

describe("applyRetention", () => {
  it("prunes an automated ok run", () => {
    expect(applyRetention("ok", { source: "automated" })).toEqual({
      kind: "prune",
    });
  });

  it("keeps a failed run with reason 'failure'", () => {
    expect(applyRetention("failed", { source: "automated" })).toEqual({
      kind: "keep",
      reason: "failure",
    });
  });

  it("keeps a human demo even on an 'ok' outcome, with reason 'human'", () => {
    expect(applyRetention("ok", { source: "human" })).toEqual({
      kind: "keep",
      reason: "human",
    });
  });

  it("keeps a human demo even on a 'failed' outcome, with reason 'human' (human takes priority)", () => {
    expect(applyRetention("failed", { source: "human" })).toEqual({
      kind: "keep",
      reason: "human",
    });
  });
});
