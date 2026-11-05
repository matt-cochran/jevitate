import { describe, expect, it } from "vitest";
import {
  JourneySchema,
  assertionSiteKey,
  journeyAssertions,
  mutationWait,
  nextTargetedRelaxation,
  planJourneyMutations,
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
  it("a mutated replay caps a kept waitFor, since what it waits on may never come", () => {
    expect(siteWait(targetedMutationReplay(fixture(), skip, "end-state:0", KEYS).relaxedSiteWaits, "step:2")).toMatchObject({ wait: mutationWait(WAIT) });
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
