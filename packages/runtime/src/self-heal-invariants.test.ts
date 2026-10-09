import { describe, expect, it, test, vi } from "vitest";
import { safeRunPolicy, type RunPolicy } from "@jevitate/domain";
import type { Assertion, Recording, RecordedStep, Step } from "@jevitate/recording";
import { JourneyRunner, type HealWriteGuard } from "./journey-runner.js";
import { assertProofUntouched, assertRecordingProofUntouched, flattenRecording, healFloor, retargetRecording, type SelfHealer } from "./self-heal.js";
import type { ChangeScope } from "./change-scope.js";

// #453 proof invariant + §9a invariant #8 write floor — a dedicated, standalone file (mirrors the
// repo's slice1-invariants.test.ts pattern). A heal is a one-for-one retarget: proof steps never
// become candidates, a candidate may change only the step's locator, and the write floor holds in
// every mode.

const baseMetadata = { id: "j", name: "j", promoted: true, params: [], createdAtIso: "x" };
const fakeActor = {} as any;
const policy = (mode: "hybrid" | "full"): RunPolicy => ({ selfHeal: { mode }, direction: { direction: "deterministic" }, secret: { secretMode: "fail-closed" } });
const seen: Assertion = { kind: "visible", target: { testId: "next" } };
const target = { role: "button", name: "Create New" };

/** Every step kind, located (where it has a locator) by `target` — the one a change renamed. */
const STEPS: Readonly<Record<Step["kind"], Step>> = {
  navigate: { kind: "navigate", url: "/create-new", expect: seen },
  click: { kind: "click", target, expect: seen },
  fill: { kind: "fill", target, value: { redacted: false, value: "x" }, expect: seen },
  waitFor: { kind: "waitFor", target, state: "visible" },
  extract: { kind: "extract", target, as: "v", expect: seen },
  select: { kind: "select", target, value: { redacted: false, value: "a" }, expect: seen },
  upload: { kind: "upload", target, file: { redacted: false, value: "f.txt" }, expect: seen },
  press: { kind: "press", key: "Enter", expect: seen },
  editText: { kind: "editText", target, anchor: { at: "end" }, action: "insertAfter", value: { redacted: false, value: "x" }, expect: seen },
  forEach: { kind: "forEach", items: target, as: "row", steps: [{ kind: "click", target, expect: seen }] },
  assert: { kind: "assert", check: { kind: "visible", target } },
  handback: { kind: "handback", prompt: "enter the code", resume: { kind: "visible", target } },
};

const scope: ChangeScope = {
  evidence: [
    { id: "e1", kind: "accessible-name", before: "Create New", after: "Create", file: "src/Toolbar.tsx", line: 42 },
    { id: "e2", kind: "route", before: "/create-new", after: "/create", file: "src/routes.ts", line: 7 },
  ],
  scanned: { files: 2, hunks: 2, skipped: [] },
};

function journeyBrokenAt(step: Step): Recording {
  return {
    version: "1.0",
    site: "https://example.test",
    pages: [{ url: "/a", steps: [{ step: { kind: "navigate", url: "/a", expect: { kind: "visible", target: { testId: "loaded" } } } }, { step }] }],
  };
}

function failingInterpreter() {
  return {
    run: vi.fn().mockResolvedValue({ outcome: "failed", at: 1, error: "boom" }),
    resumeFrom: vi.fn().mockResolvedValue({ outcome: "failed", at: 1, error: "boom" }),
  } as any;
}

const guard = (): HealWriteGuard => ({ armAt: async () => undefined, disarm: async () => [] });

function healerProposing(make: (broken: Step) => Step): SelfHealer {
  return { actsOnPage: false, proposeCandidates: vi.fn(async ({ brokenStep }) => ({ candidates: [{ step: make(brokenStep), hypothesis: "h" }], usage: { modelCalls: 1 } })) };
}

describe("proof steps never become heal candidates (AC4)", () => {
  for (const kind of ["assert", "handback", "forEach", "waitFor"] as const) {
    it(`a broken ${kind} step is never probed, even when the change explains it`, async () => {
      const interpreter = failingInterpreter();
      const runner = new JourneyRunner(fakeActor, interpreter, undefined, undefined, healerProposing((s) => s), { scope, riskOf: () => null, writeGuard: guard() });
      await runner.run({ journey: { metadata: baseMetadata, recording: journeyBrokenAt(STEPS[kind]) } as any, params: {}, policy: policy("full") });
      expect(interpreter.resumeFrom).not.toHaveBeenCalled();
    });
  }

  it("rejects a candidate that changes the step's expect as proof-field-changed", async () => {
    const healer = healerProposing((s) => ({ ...(s as Extract<Step, { kind: "click" }>), target: { role: "button", name: "Create" }, expect: { kind: "urlIncludes", text: "/" } }));
    const runner = new JourneyRunner(fakeActor, failingInterpreter(), undefined, undefined, healer, { scope: { ...scope, evidence: [{ id: "e1", kind: "label", before: "Create New" }] }, riskOf: () => null, writeGuard: guard() });
    const result = await runner.run({ journey: { metadata: baseMetadata, recording: journeyBrokenAt(STEPS.click) } as any, params: {}, policy: policy("full") });
    expect(result.heal?.attempts[0]?.rejection?.code).toBe("proof-field-changed");
  });
});

describe("healFloor", () => {
  const floorOf = (step: Step, extra: Partial<RecordedStep> = {}) => healFloor({ step, ...extra }, () => null).floor;

  it("puts assert, handback, forEach and waitFor at the proof floor", () => {
    expect((["assert", "handback", "forEach", "waitFor"] as const).map((k) => floorOf(STEPS[k]))).toEqual(["proof", "proof", "proof", "proof"]);
  });

  it("keeps select, upload, editText and press at the write floor", () => {
    expect((["select", "upload", "editText", "press"] as const).map((k) => floorOf(STEPS[k]))).toEqual(["write", "write", "write", "write"]);
  });

  it("puts a click that expects a non-GET request at the write floor", () => {
    expect(floorOf(STEPS.click, { expectRequests: [{ kind: "responseStatus", method: "delete", pathGlob: "/api/x", status: { class: 2 } }] })).toBe("write");
  });

  it("lets a click expecting only GET requests be healed (guarded)", () => {
    expect(floorOf(STEPS.click, { expectRequests: [{ kind: "requestMade", method: "GET", pathGlob: "/api/x" }] })).toBe("healable");
  });

  it("calls a click irreversible when no risk classification is wired", () => {
    expect(healFloor({ step: STEPS.click }).floor).toBe("irreversible");
  });
});

describe("assertProofUntouched — only the locator may change, per step kind", () => {
  const cases: Array<[string, Step, Step, string | null]> = [
    ["navigate url retarget", STEPS.navigate, { ...(STEPS.navigate as Extract<Step, { kind: "navigate" }>), url: "/create" }, null],
    ["navigate expect change", STEPS.navigate, { ...(STEPS.navigate as Extract<Step, { kind: "navigate" }>), expect: { kind: "urlIncludes", text: "/" } }, "proof-field-changed"],
    ["click target retarget", STEPS.click, { ...(STEPS.click as Extract<Step, { kind: "click" }>), target: { role: "button", name: "Create" } }, null],
    ["click label change", STEPS.click, { ...STEPS.click, label: "Create" }, "proof-field-changed"],
    ["click waitFor added", STEPS.click, { ...STEPS.click, waitFor: { maxMs: 1000 } } as Step, "proof-field-changed"],
    ["fill value change", STEPS.fill, { ...(STEPS.fill as Extract<Step, { kind: "fill" }>), value: { var: "v" } }, "proof-field-changed"],
    ["extract name change", STEPS.extract, { ...(STEPS.extract as Extract<Step, { kind: "extract" }>), as: "w" }, "proof-field-changed"],
    ["click becomes press", STEPS.click, STEPS.press, "shape-changed"],
    ["waitFor retarget", STEPS.waitFor, { ...(STEPS.waitFor as Extract<Step, { kind: "waitFor" }>), target: { testId: "y" } }, "shape-changed"],
    ["assert check change", STEPS.assert, { kind: "assert", check: seen }, "shape-changed"],
  ];
  for (const [name, before, after, code] of cases) {
    it(`${name} → ${code ?? "untouched"}`, () => {
      expect(assertProofUntouched(before, after)?.code ?? null).toBe(code);
    });
  }
});

describe("assertRecordingProofUntouched", () => {
  const base = journeyBrokenAt(STEPS.click);

  it("accepts a one-for-one retarget", () => {
    expect(assertRecordingProofUntouched(base, retargetRecording(base, 1, { ...(STEPS.click as Extract<Step, { kind: "click" }>), target: { role: "button", name: "Create" } }))).toBeNull();
  });

  it("refuses an inserted step as shape-changed", () => {
    const grown: Recording = { ...base, pages: [{ ...base.pages[0]!, steps: [...base.pages[0]!.steps, { step: STEPS.assert }] }] };
    expect(assertRecordingProofUntouched(base, grown)?.code).toBe("shape-changed");
  });

  it("refuses a changed expectRequests as proof-field-changed", () => {
    const pages = base.pages.map((p) => ({ ...p, steps: p.steps.map((s, i) => (i === 1 ? { ...s, expectRequests: [{ kind: "requestMade" as const, method: "GET", pathGlob: "/x" }] } : s)) }));
    expect(assertRecordingProofUntouched(base, { ...base, pages })?.code).toBe("proof-field-changed");
  });

  it("#467 refuses a revision that renames a step's id as proof-field-changed", () => {
    const withId = (id: string): Recording => ({ ...base, pages: base.pages.map((p) => ({ ...p, steps: p.steps.map((s, i) => (i === 1 ? { ...s, stepId: id } : s)) })) });
    expect(assertRecordingProofUntouched(withId("s-before"), withId("s-after"))?.code).toBe("proof-field-changed");
  });
});

test("#8 the write floor holds in full mode: a broken select step never reaches the healer", async () => {
  const healer = healerProposing((s) => s);
  const runner = new JourneyRunner(fakeActor, failingInterpreter(), undefined, undefined, healer, { scope, riskOf: () => null, writeGuard: guard() });
  await runner.run({ journey: { metadata: baseMetadata, recording: journeyBrokenAt(STEPS.select) } as any, params: {}, policy: policy("full") });
  expect(healer.proposeCandidates).not.toHaveBeenCalled();
});

test("current default remains fail-closed: safeRunPolicy() never triggers a heal attempt", async () => {
  const runner = new JourneyRunner(fakeActor, failingInterpreter(), undefined, undefined, healerProposing((s) => s), { scope, riskOf: () => null, writeGuard: guard() });
  const result = await runner.run({ journey: { metadata: baseMetadata, recording: journeyBrokenAt(STEPS.extract) } as any, params: {}, policy: safeRunPolicy() });
  expect(result).toEqual({ outcome: "quarantined", reason: "step 2 failed: boom", at: 1 });
});

test("flattenRecording keeps each step's recorded fields beside it", () => {
  expect(flattenRecording(journeyBrokenAt(STEPS.click))[1]?.recorded).toEqual({ step: STEPS.click });
});
