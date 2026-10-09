import { afterEach, describe, it, expect, vi } from "vitest";
import { DEFAULT_HEAL_BUDGET, EMPTY_CHANGE_SCOPE, JourneyRunner, PolicyEnforcementError, flattenRecording, retargetRecording, type ChangeEvidence, type ChangeScope, type HealWriteGuard } from "./index.js";
import type { SelfHealer } from "./self-heal.js";
import type { Recording, RecordedStep, Step } from "@jevitate/recording";
import { FakeClock, installClock, resetClock, safeRunPolicy, type HealBudget, type RunPolicy } from "@jevitate/domain";

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
    // #398: `at` stays the 0-based flat index; the reason names the step 1-based, as a person counts it.
    expect((res as any).reason).toBe("step 3 failed: boom");
  });
});

// === #453: change-aware self-heal ===

const baseMetadata = { id: "j", name: "j", promoted: true, params: [], createdAtIso: "x" };
const hybrid = (budget?: HealBudget): RunPolicy => ({ selfHeal: { mode: "hybrid", ...(budget === undefined ? {} : { budget }) }, direction: { direction: "deterministic" }, secret: { secretMode: "fail-closed" } });
const full = (budget?: HealBudget): RunPolicy => ({ ...hybrid(budget), selfHeal: { mode: "full", ...(budget === undefined ? {} : { budget }) } });

/** navigate (0) → click "Create New" (1, the step a change renamed) → assert (2). */
function renamedButtonJourney(recordedExtra: Partial<RecordedStep> = {}): Recording {
  return {
    version: "1.0",
    site: "https://example.test",
    pages: [
      {
        url: "/a",
        steps: [
          { step: { kind: "navigate", url: "/a", expect: { kind: "visible", target: { testId: "loaded" } } } },
          { step: { kind: "click", label: "Create", target: { role: "button", name: "Create New" }, expect: { kind: "visible", target: { testId: "editor" } } }, ...recordedExtra },
          { step: { kind: "assert", check: { kind: "urlIncludes", text: "/a/new" } } },
        ],
      },
    ],
  };
}

const renameScope = (evidence: Partial<ChangeEvidence> = {}): ChangeScope => ({
  range: "HEAD~1..HEAD",
  evidence: [{ id: "e1", kind: "accessible-name", before: "Create New", after: "Create", file: "src/ui/Toolbar.tsx", line: 42, ...evidence }],
  scanned: { files: 1, hunks: 1, skipped: [] },
});

/**
 * A fake interpreter for a broken step 1: the first pass fails there (target not found); a probe of
 * step 1 alone (`runRange`) completes only when step 1's target is named `accepts`; the remainder
 * (`resumeFrom`) completes, after `rest()`.
 */
function brokenAtStep1(accepts = "Create", rest: () => Promise<void> = async () => undefined) {
  return {
    run: vi.fn().mockResolvedValue({ outcome: "failed", at: 1, error: "replay-target-not-found: button 'Create New'", reason: "replay-target-not-found" }),
    runRange: vi.fn(async (_actor: unknown, rec: Recording, from: number) => {
      const step = flattenRecording(rec)[from]!.step as { target?: { name?: string } };
      return step.target?.name === accepts
        ? { outcome: "completed", vars: {} }
        : { outcome: "failed", at: from, error: "replay-target-not-found", reason: "replay-target-not-found" };
    }),
    resumeFrom: vi.fn(async () => {
      await rest();
      return { outcome: "completed", vars: {} };
    }),
  } as any;
}

/** A write blocker that reports `blocked` from every probe. */
function writeGuard(blocked: { method: string; url: string }[] = []): HealWriteGuard {
  return { armAt: vi.fn(async () => undefined), disarm: vi.fn(async () => blocked) };
}

const notRisky = (): string | null => null;

function modelHealer(propose: SelfHealer["proposeCandidates"], actsOnPage = false): SelfHealer {
  return { actsOnPage, proposeCandidates: vi.fn(propose) };
}

/** A healer proposing a fresh (never-matching) button name on every call. */
function alwaysWrongHealer(): SelfHealer {
  let k = 0;
  return modelHealer(async ({ brokenStep }) => {
    k++;
    return { candidates: [{ step: { ...(brokenStep as Extract<Step, { kind: "click" }>), target: { role: "button", name: `Guess ${k}` } }, hypothesis: `renamed to Guess ${k}` }], usage: { modelCalls: 1 } };
  });
}

function run(runner: JourneyRunner, recording: Recording, policy: RunPolicy, params: Record<string, string> = {}, metadata: object = baseMetadata) {
  return runner.run({ journey: { metadata, recording } as any, params, policy });
}

describe("JourneyRunner change-aware self-heal (#453)", () => {
  afterEach(() => resetClock());

  it("heals an explained renamed-label click into healed-pending-review with a revision whose only change is the target", async () => {
    const recording = renamedButtonJourney();
    const runner = new JourneyRunner(fakeActor, brokenAtStep1(), undefined, undefined, undefined, { scope: renameScope(), riskOf: notRisky, writeGuard: writeGuard() });
    const result = await run(runner, recording, hybrid());
    expect(result).toMatchObject({ outcome: "healed-pending-review", revision: { recording: retargetRecording(recording, 1, { ...(flattenRecording(recording)[1]!.step as Extract<Step, { kind: "click" }>), target: { role: "button", name: "Create" } }) } });
  });

  it("leaves an unexplained break quarantined with an unexplained verdict naming the step", async () => {
    const runner = new JourneyRunner(fakeActor, brokenAtStep1(), undefined, undefined, undefined, { scope: renameScope({ before: "Delete", after: "Remove" }), riskOf: notRisky, writeGuard: writeGuard() });
    const result = await run(runner, renamedButtonJourney(), hybrid());
    expect(result).toMatchObject({ outcome: "quarantined", heal: { verdict: "unexplained", reason: expect.stringContaining('step 2 "Create" (click)') } });
  });

  it("treats an empty change scope as explaining nothing (Q1)", async () => {
    const runner = new JourneyRunner(fakeActor, brokenAtStep1(), undefined, undefined, alwaysWrongHealer(), { scope: EMPTY_CHANGE_SCOPE, riskOf: notRisky, writeGuard: writeGuard() });
    const result = await run(runner, renamedButtonJourney(), full());
    expect(result.heal?.verdict).toBe("unexplained");
  });

  it("ends heal-exhausted after exactly perStep.maxAttempts 2 refuted attempts, each with hypothesis, evidence and rejection", async () => {
    const budget: HealBudget = { ...DEFAULT_HEAL_BUDGET, perStep: { ...DEFAULT_HEAL_BUDGET.perStep, maxAttempts: 2 } };
    const scope = renameScope({ after: undefined }); // explains the break, implies no replacement
    const runner = new JourneyRunner(fakeActor, brokenAtStep1(), undefined, undefined, alwaysWrongHealer(), { scope, riskOf: notRisky, writeGuard: writeGuard() });
    const result = await run(runner, renamedButtonJourney(), full(budget));
    const attempt = { hypothesis: expect.stringMatching(/Guess/), evidence: [expect.objectContaining({ id: "e1" })], rejection: { code: "no-match", detail: expect.any(String) } };
    expect(result).toMatchObject({ outcome: "heal-exhausted", heal: { verdict: "exhausted", budget: { exhaustedBy: "attempts" }, attempts: [attempt, attempt] } });
  });

  it("rejects a guarded click whose probe fires a POST as write-attempted", async () => {
    const guard = writeGuard([{ method: "POST", url: "https://example.test/api/items" }]);
    const runner = new JourneyRunner(fakeActor, brokenAtStep1(), undefined, undefined, undefined, { scope: renameScope(), riskOf: notRisky, writeGuard: guard });
    const result = await run(runner, renamedButtonJourney(), hybrid());
    expect(result.heal?.attempts[0]?.rejection?.code).toBe("write-attempted");
  });

  it("never probes a click whose recorded expectRequests expects a POST", async () => {
    const interpreter = brokenAtStep1();
    const runner = new JourneyRunner(fakeActor, interpreter, undefined, undefined, undefined, { scope: renameScope(), riskOf: notRisky, writeGuard: writeGuard() });
    await run(runner, renamedButtonJourney({ expectRequests: [{ kind: "requestMade", method: "POST", pathGlob: "/api/items" }] }), hybrid());
    expect(interpreter.runRange).not.toHaveBeenCalled();
  });

  it("never heals a click the safety classification calls risky", async () => {
    const runner = new JourneyRunner(fakeActor, brokenAtStep1(), undefined, undefined, undefined, { scope: renameScope(), riskOf: () => "destructive", writeGuard: writeGuard() });
    const result = await run(runner, renamedButtonJourney(), hybrid());
    expect(result.heal?.verdict).toBe("refused-write");
  });

  it("never heals a click when no write blocker is wired", async () => {
    const runner = new JourneyRunner(fakeActor, brokenAtStep1(), undefined, undefined, undefined, { scope: renameScope(), riskOf: notRisky });
    const result = await run(runner, renamedButtonJourney(), hybrid());
    expect(result.heal?.verdict).toBe("refused-write");
  });

  it("never consults a healer that acts on the page for a guarded click", async () => {
    const healer = modelHealer(async () => ({ candidates: [], usage: { modelCalls: 1 } }), true);
    const runner = new JourneyRunner(fakeActor, brokenAtStep1(), undefined, undefined, healer, { scope: renameScope({ after: undefined }), riskOf: notRisky, writeGuard: writeGuard() });
    await run(runner, renamedButtonJourney(), hybrid());
    expect(healer.proposeCandidates).not.toHaveBeenCalled();
  });

  it("in hybrid, rejects a model candidate whose new anchor no change evidence names", async () => {
    const runner = new JourneyRunner(fakeActor, brokenAtStep1(), undefined, undefined, alwaysWrongHealer(), { scope: renameScope({ after: undefined }), riskOf: notRisky, writeGuard: writeGuard() });
    const result = await run(runner, renamedButtonJourney(), hybrid());
    expect(result.heal?.attempts[0]?.rejection?.code).toBe("not-explained-by-change");
  });

  it("stops healing when the step's wall-clock budget runs out on the clock", async () => {
    const fake = new FakeClock();
    installClock(fake);
    const healer = modelHealer(async ({ brokenStep }) => {
      await fake.advanceBy(DEFAULT_HEAL_BUDGET.perStep.maxMs);
      return { candidates: [{ step: { ...(brokenStep as Extract<Step, { kind: "click" }>), target: { role: "button", name: "Create" } }, hypothesis: "renamed" }], usage: { modelCalls: 1 } };
    });
    const runner = new JourneyRunner(fakeActor, brokenAtStep1(), undefined, undefined, healer, { scope: renameScope({ after: undefined }), riskOf: notRisky, writeGuard: writeGuard() });
    const result = await run(runner, renamedButtonJourney(), full());
    expect(result).toMatchObject({ outcome: "heal-exhausted", heal: { budget: { exhaustedBy: "wallClock" }, attempts: [] } });
  });

  it("charges only the candidate step's probe to the heal budget, not the replay of the rest of the Journey", async () => {
    const fake = new FakeClock();
    installClock(fake);
    const interpreter = brokenAtStep1("Create", () => fake.advanceBy(10 * DEFAULT_HEAL_BUDGET.perRun.maxMs));
    const runner = new JourneyRunner(fakeActor, interpreter, undefined, undefined, undefined, { scope: renameScope(), riskOf: notRisky, writeGuard: writeGuard() });
    const result = await run(runner, renamedButtonJourney(), hybrid());
    expect(result.heal?.budget.used.ms).toBe(0);
  });

  it("rejects a probe still running at the heal deadline as budget-exhausted", async () => {
    const fake = new FakeClock();
    installClock(fake);
    const interpreter = brokenAtStep1();
    interpreter.runRange = vi.fn(async () => {
      await fake.advanceBy(DEFAULT_HEAL_BUDGET.perStep.maxMs + 1);
      return { outcome: "completed", vars: {} };
    });
    const runner = new JourneyRunner(fakeActor, interpreter, undefined, undefined, undefined, { scope: renameScope(), riskOf: notRisky, writeGuard: writeGuard() });
    const result = await run(runner, renamedButtonJourney(), hybrid());
    expect(result.heal?.attempts[0]?.rejection?.code).toBe("budget-exhausted");
  });

  it("in hybrid, rejects a model candidate whose new anchor only an unrelated change's after names", async () => {
    const scope: ChangeScope = {
      evidence: [
        { id: "e1", kind: "accessible-name", before: "Create New" },
        { id: "e2", kind: "accessible-name", before: "Delete", after: "Make" },
      ],
      scanned: { files: 1, hunks: 2, skipped: [] },
    };
    const healer = modelHealer(async ({ brokenStep }) => ({ candidates: [{ step: { ...(brokenStep as Extract<Step, { kind: "click" }>), target: { role: "button", name: "Make" } }, hypothesis: "renamed to Make" }], usage: { modelCalls: 1 } }));
    const runner = new JourneyRunner(fakeActor, brokenAtStep1("Make"), undefined, undefined, healer, { scope, riskOf: notRisky, writeGuard: writeGuard() });
    const result = await run(runner, renamedButtonJourney(), hybrid());
    expect(result.heal?.attempts[0]?.rejection?.code).toBe("not-explained-by-change");
  });

  it("charges a model call when the healer throws", async () => {
    const healer = modelHealer(async () => {
      throw new Error("gateway down");
    });
    const runner = new JourneyRunner(fakeActor, brokenAtStep1(), undefined, undefined, healer, { scope: renameScope({ after: undefined }), riskOf: notRisky, writeGuard: writeGuard() });
    const result = await run(runner, renamedButtonJourney(), hybrid());
    expect(result.heal?.budget.used.modelCalls).toBe(1);
  });

  it("#399: the healer is handed the run's secret parameter values (a token in a navigate URL) to redact", async () => {
    const healer = modelHealer(async () => ({ candidates: [], usage: { modelCalls: 1 } }));
    const recording: Recording = {
      version: "1.0",
      site: "https://example.test",
      pages: [
        {
          url: "/accept",
          steps: [
            { step: { kind: "navigate", url: "/accept?token=${inviteToken}", expect: { kind: "urlIncludes", text: "/accept" } } },
            { step: { kind: "extract", target: { testId: "Create New" }, as: "v", expect: { kind: "visible", target: { testId: "x" } } } },
          ],
        },
      ],
    };
    const metadata = { ...baseMetadata, parameters: [{ name: "inviteToken", secret: true }] };
    const runner = new JourneyRunner(fakeActor, brokenAtStep1(), undefined, undefined, healer, { scope: renameScope({ kind: "test-id", after: undefined }) });
    await run(runner, recording, hybrid(), { inviteToken: "tok-399" }, metadata);
    expect(healer.proposeCandidates).toHaveBeenCalledWith(expect.objectContaining({ secrets: ["tok-399"] }));
  });

  it("fail-closed (default) never consults the healer, even with an explaining change", async () => {
    const healer = alwaysWrongHealer();
    const runner = new JourneyRunner(fakeActor, brokenAtStep1(), undefined, undefined, healer, { scope: renameScope(), riskOf: notRisky, writeGuard: writeGuard() });
    await run(runner, renamedButtonJourney(), safeRunPolicy());
    expect(healer.proposeCandidates).not.toHaveBeenCalled();
  });
});

// === #409: per-step outcome waits reach the run result ===

describe("JourneyRunner — #409 step waits", () => {
  const wait = (step: number, waitedMs: number, ending: "held" | "timeout" | "hang" = "held") => ({ step, waitedMs, maxMs: 240_000, ending, polls: 9 });

  it("carries the interpreter's waits on an ok result; none → no `waits` key", async () => {
    const r = new JourneyRunner(fakeActor, fakeInterpreter({ outcome: "completed", vars: {}, waits: [wait(3, 125_000)] }));
    expect(await r.run({ journey: journeyNoVars, params: {}, policy: safeRunPolicy() })).toEqual({ outcome: "ok", output: {}, waits: [wait(3, 125_000)] });
    const plain = new JourneyRunner(fakeActor, fakeInterpreter({ outcome: "completed", vars: {} }));
    expect(await plain.run({ journey: journeyNoVars, params: {}, policy: safeRunPolicy() })).toEqual({ outcome: "ok", output: {} });
  });

  it("carries a failed wait on a quarantined result", async () => {
    const r = new JourneyRunner(fakeActor, fakeInterpreter({ outcome: "failed", at: 2, error: "assert: postcondition failed: … — hang: …", waits: [wait(3, 30_000, "hang")] }));
    expect(await r.run({ journey: journeyNoVars, params: {}, policy: safeRunPolicy() })).toMatchObject({ outcome: "quarantined", at: 2, waits: [wait(3, 30_000, "hang")] });
  });
});
