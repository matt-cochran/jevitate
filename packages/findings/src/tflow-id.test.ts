import { describe, expect, it } from "vitest";
import { runFromMissionResult } from "./extract.js";
import { findingKey } from "./identity.js";

function observe(steps: unknown[]) {
  const run = runFromMissionResult("/runs/r1/adversarial-2026-09-01T10-00-00-000Z.result.json", {
    missionOutcome: "defects-found",
    exitCode: 1,
    result: {
      target: { seedUrl: "https://app.test/a", allowlist: ["https://app.test"] },
      scope: { routeGlobs: ["/a"], outOfScopeSteps: 0, departures: [], resets: 0 },
      transcript: [{ step: 1, url: "https://app.test/a" }],
      defects: [{ fingerprint: "fp1", kind: "console-error", url: "https://app.test/a", repro: { steps } }],
      hangs: [],
      advisories: [],
    },
  });
  const first = run?.observations[0];
  if (first === undefined) throw new Error("no observation");
  return first;
}

describe("findings carry the acted element's tflowId (#468)", () => {
  it("a defect whose last acted step names a tflowId carries it", () => {
    expect(observe([{ target: 'button "Send"', tflowId: "invite.send" }]).identity.tflowId).toBe("invite.send");
  });

  it("a defect whose acted step has no tflowId carries none", () => {
    expect(observe([{ target: 'button "Send"' }]).identity).not.toHaveProperty("tflowId");
  });

  it("the finding key does not depend on the tflowId", () => {
    const withId = observe([{ target: 'button "Send"', tflowId: "invite.send" }]);
    const without = observe([{ target: 'button "Send"' }]);
    expect(findingKey(withId.identity)).toBe(findingKey(without.identity));
  });
});
