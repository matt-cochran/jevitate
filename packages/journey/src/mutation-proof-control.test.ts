import { describe, expect, it } from "vitest";
import {
  JourneySchema,
  assertionSiteKey,
  journeyAssertions,
  classifyMutation,
  mutationWait,
  nextTargetedRelaxation,
  planJourneyMutations,
  relaxedMutationReplay,
  runDeclaredTargetedProof,
  runTargetedProof,
  targetedControlReplay,
  targetedMutationReplay,
  type Journey,
  type MutationReplay,
  type TargetedProof,
} from "./index.js";

const PREFILL = { kind: "textIncludes", target: { css: "#prefill" }, text: "Prefilled" } as const;
const WAIT = { maxMs: 600_000, stallMs: 10_000 };
const CHECK = { kind: "responseStatus", method: "POST", pathGlob: "/api/draft", status: { class: 2 } } as const;

function fixture(): Journey {
  return JourneySchema.parse({
    metadata: {
      id: "draft",
      name: "Draft",
      promoted: false,
      params: [],
      createdAtIso: "2026-11-04T00:00:00Z",
      endState: [{ kind: "reloadThen", assertion: { kind: "textIncludes", target: { css: "#marker" }, text: "restored" } }],
      mutationPairs: [
        { check: "step:2", mustFailWhen: "skip:1" },
        { check: "end-state:0", mustFailWhen: "skip:1" },
      ],
    },
    recording: {
      version: "1",
      site: "https://example.test",
      pages: [
        {
          url: "/",
          steps: [
            { step: { kind: "click", target: { css: "#open" }, expect: { kind: "visible", target: { css: "#panel" } } }, expectRequests: [CHECK], responseTimeoutMs: 40_000 },
            { step: { kind: "assert", check: PREFILL, waitFor: WAIT } },
          ],
        },
      ],
    },
  });
}

const KEYS = ["step-request:1:0", "step:2"];
const skip = { kind: "skip", step: 1, id: "skip:1" } as const;
const block = { kind: "block-write", step: 1, id: "block-write:1" } as const;
const siteWait = (waits: MutationReplay["relaxedSiteWaits"], site: string) => waits?.find((w) => w.site === site);

/** A proof of the end state against skip:1 that reaches its control: the replay each step-up asks for, then the control. */
async function proveWithControl(control: { readonly diagnostics?: NonNullable<TargetedProof["controlDiagnostics"]> } = {}): Promise<{ proof: TargetedProof; controlReplay: MutationReplay }> {
  const journey = fixture();
  const plan = planJourneyMutations(journey);
  const m = plan.mutations.find((x) => x.id === "skip:1")!;
  const target = journeyAssertions(journey).find((s) => assertionSiteKey(s) === "end-state:0")!;
  let controlReplay: MutationReplay | undefined;
  const replays: { outcome: "failed"; failedSites: Parameters<typeof nextTargetedRelaxation>[4]["failedSites"] }[] = [
    { outcome: "failed", failedSites: [{ where: "step", step: 2, postcondition: true }] },
    { outcome: "failed", failedSites: [{ where: "end-state", index: 0 }] },
  ];
  const proof = await runTargetedProof(journey, plan, m, target, { outcome: "failed", failedSites: [{ where: "step-request", step: 1, checkIndex: 0 }] }, async (describeReplay, kind) => {
    if (kind === "targeted") return replays.shift()!;
    controlReplay = describeReplay(journey);
    return control.diagnostics === undefined ? { outcome: "passed", failedSites: [] } : { outcome: "failed", failedSites: [{ where: "end-state", index: 0 }], diagnostics: control.diagnostics };
  });
  return { proof, controlReplay: controlReplay! };
}

/** `fixture()`, its first step's claim waited on. */
function waitedOwnClaim(wait: { maxMs: number; stallMs: number } = WAIT): Journey {
  const journey = fixture();
  const first = journey.recording.pages[0]!.steps[0]!;
  first.step = { ...first.step, waitFor: wait } as typeof first.step;
  return journey;
}

/** The same, with its first step a fill. */
function waitedFill(): Journey {
  const journey = fixture();
  journey.recording.pages[0]!.steps[0]!.step = { kind: "fill", target: { css: "#name" }, value: { redacted: false, value: "alice" }, expect: PREFILL, waitFor: WAIT };
  return journey;
}

/** The waits a proof's control ran with, read through the proof itself. */
async function controlWaitsOf(journey: Journey, m: typeof block, relaxed: readonly string[]): Promise<MutationReplay["relaxedSiteWaits"]> {
  let waits: MutationReplay["relaxedSiteWaits"];
  const target = journeyAssertions(journey).find((s) => assertionSiteKey(s) === "end-state:0")!;
  const plan = { mutations: [m], pairs: [...relaxed, "end-state:0"].map((site) => ({ site, mutation: m.id })) };
  await runDeclaredTargetedProof(journey, plan, m, target, { check: "end-state:0", mustFailWhen: m.id, relax: [...relaxed] }, async (describeReplay, kind) => {
    if (kind === "control") waits = describeReplay(journey).relaxedSiteWaits;
    return { outcome: "failed", failedSites: [{ where: "end-state", index: 0 }] };
  });
  return waits;
}

describe("#785 a relaxed site keeps its waiting", () => {
  it("a control's relaxed assertion waits on the original check", async () => {
    expect(siteWait((await proveWithControl()).controlReplay.relaxedSiteWaits, "step:2")).toMatchObject({ kind: "page", step: 2, assertion: PREFILL });
  });
  it("a control's relaxed assertion keeps its full waitFor", async () => {
    expect(siteWait((await proveWithControl()).controlReplay.relaxedSiteWaits, "step:2")).toMatchObject({ wait: WAIT });
  });
  it("a control's relaxed request check waits on its response within the step's bound", async () => {
    expect(siteWait((await proveWithControl()).controlReplay.relaxedSiteWaits, "step-request:1:0")).toEqual({ kind: "response", site: "step-request:1:0", step: 1, check: CHECK, responseTimeoutMs: 40_000 });
  });
  it("a control's own weakened claim at the mutated step waits on the original check", async () => {
    expect(siteWait((await proveWithControl()).controlReplay.relaxedSiteWaits, "step:1")).toMatchObject({ assertion: { kind: "visible", target: { css: "#panel" } } });
  });
  it("a control's relaxed assertion can no longer fail the replay", () => {
    expect(targetedControlReplay(fixture(), skip, KEYS).journey.recording.pages[0]!.steps[1]!.step).toEqual({ kind: "assert", check: { kind: "urlIncludes", text: "" } });
  });
  it("a targeted replay keeps a later site's full waitFor, as its control does", () => {
    expect(siteWait(targetedMutationReplay(fixture(), skip, "end-state:0", KEYS).relaxedSiteWaits, "step:2")).toMatchObject({ wait: WAIT });
  });
  it("a blocked step's targeted replay and its control keep the same waits", async () => {
    const waited = waitedOwnClaim();
    expect(targetedMutationReplay(waited, block, "end-state:0", ["step:2"]).relaxedSiteWaits).toEqual(await controlWaitsOf(waited, block, ["step:2"]));
  });
  it("a value mutation's own claim keeps its full waitFor, since its write is still sent", () => {
    expect(siteWait(relaxedMutationReplay(waitedFill(), { kind: "stale-value", step: 1, id: "stale-value:1" }).relaxedSiteWaits, "step:1")).toMatchObject({ wait: WAIT });
  });
  it("a skipped step keeps no wait of its own, since nothing was started", () => {
    expect(siteWait(targetedMutationReplay(fixture(), skip, "end-state:0", KEYS).relaxedSiteWaits, "step-request:1:0")).toBeUndefined();
  });
  it("a blocked step keeps its own claim's wait, so a mutated replay waits as its control does", () => {
    expect(siteWait(targetedMutationReplay(fixture(), block, "end-state:0", KEYS).relaxedSiteWaits, "step:1")).toMatchObject({ kind: "page" });
  });
  it("the stored Journey is left unchanged", () => {
    const journey = fixture();
    targetedControlReplay(journey, skip, KEYS);
    expect(journey).toEqual(fixture());
  });
});

describe("#785 a failed control", () => {
  it("its refusal carries the control's diagnostics", async () => {
    const stored = { sessionStorageKeys: 1, localStorageKeys: 0, cookies: 0 };
    const diagnostics: NonNullable<TargetedProof["controlDiagnostics"]> = {
      failedSites: ["end-state:0"],
      control: { stepsTotal: 2, stepsCompleted: 2, sessionsOpened: 1, pageReplaced: false, writesSent: 1, writesAnswered: 1, writesAborted: 0, writesUnfinished: 0, storageBeforeEndState: stored, storageAfterEndState: stored, relaxedWaits: [] },
      indicates: [],
    };
    expect((await proveWithControl({ diagnostics })).proof.controlDiagnostics).toEqual(diagnostics);
  });
});

describe("a replay that failed sooner than an unmutated replay passed", () => {
  const END_STATE_FAILED = [{ where: "end-state", index: 0 }] as const;
  const OWN_FAILED = [{ where: "step", step: 1, postcondition: true }] as const;
  const relaxedRun = { outcome: "failed", failedSites: END_STATE_FAILED, waitsCut: ["end-state:0"] } as const;
  const setup = () => {
    const journey = waitedOwnClaim();
    const plan = planJourneyMutations(journey);
    const m = { ...block, id: "block-write:1" };
    const target = journeyAssertions(journey).find((s) => assertionSiteKey(s) === "end-state:0")!;
    return { journey, plan: { ...plan, mutations: [m], pairs: [{ site: "step:2", mutation: m.id }, { site: "end-state:0", mutation: m.id }] }, m, target };
  };

  it("leaves a site a relaxed replay failed a cascade, not sensitive", () => {
    const { m, target } = setup();
    expect(classifyMutation(target, m, { outcome: "failed", failedSites: OWN_FAILED, relaxed: relaxedRun })).toBe("cascade");
  });
  it("still lets that relaxed replay's pass read insensitive", () => {
    const { m, target } = setup();
    expect(classifyMutation(target, m, { outcome: "failed", failedSites: OWN_FAILED, relaxed: { outcome: "passed", failedSites: [], waitsCut: ["end-state:0"] } })).toBe("insensitive");
  });
  it("refuses an automatic proof resting on that relaxed replay, naming the site", async () => {
    const { journey, plan, m, target } = setup();
    const proof = await runTargetedProof(journey, plan, m, target, { outcome: "failed", failedSites: OWN_FAILED, relaxed: relaxedRun }, async () => ({ outcome: "passed", failedSites: [] }));
    expect(proof.refused).toMatch(/failed at end-state:0 sooner than an unmutated replay/);
  });
  it("refuses a declared proof whose targeted replay did", async () => {
    const { journey, plan, m, target } = setup();
    const proof = await runDeclaredTargetedProof(journey, plan, m, target, { check: "end-state:0", mustFailWhen: m.id, relax: ["step:2"] }, async () => relaxedRun);
    expect(proof.refused).toMatch(/sooner than an unmutated replay/);
  });
  it("refuses a step's own claim that did, naming the site", async () => {
    const journey = waitedOwnClaim();
    const target = journeyAssertions(journey).find((s) => assertionSiteKey(s) === "step:1")!;
    const proof = await runTargetedProof(journey, { mutations: [block], pairs: [{ site: "step:1", mutation: block.id }] }, block, target, { outcome: "failed", failedSites: OWN_FAILED, waitsCut: ["step:1"] }, async () => ({ outcome: "passed", failedSites: [] }));
    expect(proof.refused).toMatch(/failed at step:1 sooner/);
  });
  it("leaves that own claim a cascade", () => {
    const journey = waitedOwnClaim();
    const target = journeyAssertions(journey).find((s) => assertionSiteKey(s) === "step:1")!;
    expect(classifyMutation(target, block, { outcome: "failed", failedSites: OWN_FAILED, waitsCut: ["step:1"] })).toBe("cascade");
  });
  it("keeps an own claim that failed no sooner sensitive", () => {
    const journey = waitedOwnClaim();
    const target = journeyAssertions(journey).find((s) => assertionSiteKey(s) === "step:1")!;
    expect(classifyMutation(target, block, { outcome: "failed", failedSites: OWN_FAILED })).toBe("sensitive");
  });
});

describe("a targeted proof's control", () => {
  const END_STATE_FAILED = [{ where: "end-state", index: 0 }] as const;
  const declaredProof = (controlArrivedMs: readonly number[]) => {
    const journey = waitedOwnClaim();
    const m = block;
    const target = journeyAssertions(journey).find((s) => assertionSiteKey(s) === "end-state:0")!;
    const plan = { mutations: [m], pairs: [{ site: "step:2", mutation: m.id }, { site: "end-state:0", mutation: m.id }] };
    return runDeclaredTargetedProof(journey, plan, m, target, { check: "end-state:0", mustFailWhen: m.id, relax: ["step:2"] }, async (_d, kind) =>
      kind === "targeted" ? { outcome: "failed", failedSites: END_STATE_FAILED, endStateReachedMs: 2_000 } : { outcome: "passed", failedSites: [], arrivedMs: [0, 0], endStateReachedMs: controlArrivedMs.at(-1)!, marginMs: 1_000 },
    );
  };

  it("is refused when it got to the site later than the margin allows", async () => {
    expect((await declaredProof([1_000, 3_500])).refused).toMatch(/control reached end-state:0 at 3500ms and the mutated replay at 2000ms/);
  });
  it("is refused when it got to the site sooner than the margin allows", async () => {
    expect((await declaredProof([1_000, 500])).refused).toMatch(/control reached end-state:0 at 500ms and the mutated replay at 2000ms/);
  });
  it("counts within the margin, either way", async () => {
    expect((await declaredProof([1_000, 1_500])).refused).toBeUndefined();
    expect((await declaredProof([1_000, 2_500])).refused).toBeUndefined();
  });
  it("is named by its relaxations, so sites relaxing the same ones can share it", async () => {
    const journey = waitedOwnClaim();
    const target = journeyAssertions(journey).find((s) => assertionSiteKey(s) === "end-state:0")!;
    const plan = { mutations: [block], pairs: [{ site: "step:2", mutation: block.id }, { site: "end-state:0", mutation: block.id }] };
    let key: string | undefined;
    await runDeclaredTargetedProof(journey, plan, block, target, { check: "end-state:0", mustFailWhen: block.id, relax: ["step:2"] }, async (_d, kind, controlKey) => {
      if (kind === "control") key = controlKey;
      return kind === "targeted" ? { outcome: "failed", failedSites: END_STATE_FAILED } : { outcome: "passed", failedSites: [] };
    });
    expect(key).toBe("step:2");
  });
});
