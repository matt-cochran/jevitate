import { describe, it, expect, vi } from "vitest";
import { JourneyRunner, PolicyEnforcementError } from "./index.js";
import type { SelfHealer } from "./self-heal.js";
import type { Recording } from "@jevitate/recording";
import { safeRunPolicy } from "@jevitate/domain";

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

// === Self-heal (Ticket #7) ===

const baseMetadata = { id: "j", name: "j", promoted: true, params: [], createdAtIso: "x" };

const healedSegment: Recording = {
  version: "1.0",
  site: "https://example.test",
  pages: [{ url: "/a", steps: [{ step: { kind: "click", target: { testId: "new-button" }, expect: { kind: "visible", target: { testId: "next" } } } }] }],
};

function journeyWithBrokenReadOnlyStep(): Recording {
  // navigate (0, ok) -> assert (1, the broken READ-ONLY step) -> assert (2, tail)
  return {
    version: "1.0",
    site: "https://example.test",
    pages: [
      {
        url: "/a",
        steps: [
          { step: { kind: "navigate", url: "/a", expect: { kind: "visible", target: { testId: "loaded" } } } },
          { step: { kind: "assert", check: { kind: "visible", target: { testId: "next" } } } },
        ],
      },
      { url: "/b", steps: [{ step: { kind: "assert", check: { kind: "urlIncludes", text: "/b" } } }] },
    ],
  };
}

function journeyWithBrokenWriteStep(): Recording {
  // navigate (0, ok) -> fill (1, the broken WRITE step) — must NEVER auto-heal
  return {
    version: "1.0",
    site: "https://example.test",
    pages: [
      {
        url: "/a",
        steps: [
          { step: { kind: "navigate", url: "/a", expect: { kind: "visible", target: { testId: "loaded" } } } },
          { step: { kind: "fill", target: { testId: "field" }, value: { redacted: true, length: 3 }, expect: { kind: "visible", target: { testId: "next" } } } },
        ],
      },
    ],
  };
}

function fakeHealer(response: Awaited<ReturnType<SelfHealer["reLearnStep"]>>): SelfHealer {
  return { reLearnStep: vi.fn(async () => response) };
}

/** run() -> failed at 1; resumeFrom -> still failed at 1 (no recovery). */
function fakeInterpreterThatFails() {
  return {
    run: vi.fn().mockResolvedValue({ outcome: "failed", at: 1, error: "boom" }),
    resumeFrom: vi.fn().mockResolvedValue({ outcome: "failed", at: 1, error: "boom" }),
  } as any;
}

/** run() -> failed at 1; resumeFrom -> completed (the splice recovered it). */
function fakeInterpreterThatFailsThenHeals() {
  return {
    run: vi.fn().mockResolvedValue({ outcome: "failed", at: 1, error: "boom" }),
    resumeFrom: vi.fn().mockResolvedValue({ outcome: "completed", vars: {} }),
  } as any;
}

describe("JourneyRunner self-heal (Ticket #7)", () => {
  it("hybrid + read-only broken step + a healer that succeeds -> outcome 'healed', run completes", async () => {
    const recording = journeyWithBrokenReadOnlyStep();
    const healer = fakeHealer({ outcome: "healed", segment: healedSegment });
    const runner = new JourneyRunner(fakeActor, fakeInterpreterThatFailsThenHeals(), undefined, undefined, healer);

    const result = await runner.run({
      journey: { metadata: baseMetadata, recording } as any,
      params: {},
      policy: { selfHeal: { mode: "hybrid" }, direction: { direction: "deterministic" }, secret: { secretMode: "fail-closed" } },
    });

    expect(result.outcome).toBe("healed");
    expect(healer.reLearnStep).toHaveBeenCalledOnce();
  });

  it("hybrid + WRITE broken step (fill) -> healer is NEVER called, quarantines (invariant #8)", async () => {
    const recording = journeyWithBrokenWriteStep();
    const healer = fakeHealer({ outcome: "healed", segment: healedSegment });
    const runner = new JourneyRunner(fakeActor, fakeInterpreterThatFails(), undefined, undefined, healer);

    const result = await runner.run({
      journey: { metadata: baseMetadata, recording } as any,
      params: {},
      policy: { selfHeal: { mode: "hybrid" }, direction: { direction: "deterministic" }, secret: { secretMode: "fail-closed" } },
    });

    expect(healer.reLearnStep).not.toHaveBeenCalled();
    expect(result.outcome).toBe("quarantined");
  });

  it("full + WRITE broken step -> still refuses (the floor is not bypassed by 'full')", async () => {
    const recording = journeyWithBrokenWriteStep();
    const healer = fakeHealer({ outcome: "healed", segment: healedSegment });
    const runner = new JourneyRunner(fakeActor, fakeInterpreterThatFails(), undefined, undefined, healer);

    const result = await runner.run({
      journey: { metadata: baseMetadata, recording } as any,
      params: {},
      policy: { selfHeal: { mode: "full" }, direction: { direction: "deterministic" }, secret: { secretMode: "fail-closed" } },
    });

    expect(healer.reLearnStep).not.toHaveBeenCalled();
    expect(result.outcome).toBe("quarantined");
  });

  it("fail-closed (default) -> healer never called even when wired and read-only", async () => {
    const recording = journeyWithBrokenReadOnlyStep();
    const healer = fakeHealer({ outcome: "healed", segment: healedSegment });
    const runner = new JourneyRunner(fakeActor, fakeInterpreterThatFails(), undefined, undefined, healer);

    const result = await runner.run({
      journey: { metadata: baseMetadata, recording } as any,
      params: {},
      policy: safeRunPolicy(),
    });

    expect(healer.reLearnStep).not.toHaveBeenCalled();
    expect(result.outcome).toBe("quarantined");
  });

  it("hybrid + read-only step + healer reports not-healed -> quarantines (no false recovery)", async () => {
    const recording = journeyWithBrokenReadOnlyStep();
    const healer = fakeHealer({ outcome: "not-healed", reason: "could not reach the postcondition" });
    const runner = new JourneyRunner(fakeActor, fakeInterpreterThatFails(), undefined, undefined, healer);

    const result = await runner.run({
      journey: { metadata: baseMetadata, recording } as any,
      params: {},
      policy: { selfHeal: { mode: "hybrid" }, direction: { direction: "deterministic" }, secret: { secretMode: "fail-closed" } },
    });

    expect(result.outcome).toBe("quarantined");
  });

  it("hybrid + read-only step healed but the resumed splice STILL fails -> quarantines, heals that index at most once (invariant #4)", async () => {
    const recording = journeyWithBrokenReadOnlyStep();
    const healer = fakeHealer({ outcome: "healed", segment: healedSegment });
    const runner = new JourneyRunner(fakeActor, fakeInterpreterThatFails(), undefined, undefined, healer);

    const result = await runner.run({
      journey: { metadata: baseMetadata, recording } as any,
      params: {},
      policy: { selfHeal: { mode: "hybrid" }, direction: { direction: "deterministic" }, secret: { secretMode: "fail-closed" } },
    });

    expect(result.outcome).toBe("quarantined");
    expect(healer.reLearnStep).toHaveBeenCalledOnce(); // never re-heals the same index in a loop
  });
});
