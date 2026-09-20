import { describe, it, expect, vi } from "vitest";
import { JourneyRunner, PolicyEnforcementError } from "./index.js";
import { safeRunPolicy } from "@doit/domain";

const journeyNoVars = {
  metadata: { id: "j", name: "j", promoted: true, params: [], createdAtIso: "x" },
  recording: { version: "1", site: "s", pages: [] },
} as any;

function fakeInterpreter(result: any) {
  return {
    run: vi.fn().mockResolvedValue(result),
    resumeFrom: vi.fn().mockResolvedValue({ outcome: "completed", vars: {} }),
  } as any;
}
const fakeActor = {} as any;

describe("JourneyRunner invariants", () => {
  it("#1: refuses to run with an absent policy (PolicyEnforcementError)", async () => {
    const r = new JourneyRunner(fakeActor, fakeInterpreter({ outcome: "completed", vars: {} }));
    await expect(r.run({ journey: journeyNoVars, params: {}, policy: undefined as any })).rejects.toBeInstanceOf(
      PolicyEnforcementError,
    );
  });

  it("#1: refuses a partial policy (missing secret sub-policy)", async () => {
    const r = new JourneyRunner(fakeActor, fakeInterpreter({ outcome: "completed", vars: {} }));
    await expect(
      r.run({
        journey: journeyNoVars,
        params: {},
        policy: { selfHeal: { mode: "fail-closed" }, direction: { direction: "deterministic" } } as any,
      }),
    ).rejects.toBeInstanceOf(PolicyEnforcementError);
  });

  it("#5: rejects unknown params before running any step", async () => {
    const interp = fakeInterpreter({ outcome: "completed", vars: {} });
    const r = new JourneyRunner(fakeActor, interp);
    await expect(
      r.run({ journey: journeyNoVars, params: { bogus: "x" }, policy: safeRunPolicy() }),
    ).rejects.toThrow(/unknown/);
    expect(interp.run).not.toHaveBeenCalled(); // fail-fast BEFORE execution
  });

  it("secretMode fail-closed: an awaiting_human step quarantines (no handback handler)", async () => {
    const interp = fakeInterpreter({
      outcome: "awaiting_human",
      at: 1,
      prompt: "pw",
      resume: { kind: "urlIncludes", text: "/home" },
    });
    const r = new JourneyRunner(fakeActor, interp);
    const res = await r.run({ journey: journeyNoVars, params: {}, policy: safeRunPolicy() });
    expect(res).toMatchObject({ outcome: "quarantined", at: 1 });
  });

  it("Ruling 3: maps interpreter 'completed' to runner 'ok' with output = vars", async () => {
    const interp = fakeInterpreter({ outcome: "completed", vars: { token: "abc" } });
    const r = new JourneyRunner(fakeActor, interp);
    const res = await r.run({ journey: journeyNoVars, params: {}, policy: safeRunPolicy() });
    expect(res).toEqual({ outcome: "ok", output: { token: "abc" } });
  });

  it("Ruling 3: maps interpreter 'failed' to runner 'quarantined'", async () => {
    const interp = fakeInterpreter({ outcome: "failed", at: 2, error: "boom" });
    const r = new JourneyRunner(fakeActor, interp);
    const res = await r.run({ journey: journeyNoVars, params: {}, policy: safeRunPolicy() });
    expect(res).toMatchObject({ outcome: "quarantined", at: 2 });
    expect((res as any).reason).toMatch(/failed/);
  });
});
