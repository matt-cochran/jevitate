import { expect, test, vi } from "vitest";
import type { Recording } from "@jevitate/recording";
import type { JudgmentPort, GenerationPort } from "@jevitate/ai-core";
import { JourneySchema, isOwnTargetVisible } from "@jevitate/journey";
import { authorJourney } from "./author-journey.js";
import type { SuccessCheck } from "../success-checks.js";

// `recordingWith` is referenced inside the hoisted `vi.mock` factory, so it must itself be hoisted
// (a plain top-level const would not be initialized when the hoisted mock factory runs).
const { recordingWith } = vi.hoisted(() => ({
  recordingWith: (value: string): Recording =>
    ({
      version: "1.0",
      site: "https://example.test",
      pages: [
        {
          url: "/search",
          steps: [
            { step: { kind: "navigate", url: "/search", expect: { kind: "visible", target: { testId: "box" } } } },
            { step: { kind: "fill", target: { testId: "q" }, value: { redacted: false, value }, expect: { kind: "visible", target: { testId: "results" } } } },
          ],
        },
      ],
    }) as Recording,
}));
const discoveredRecording = recordingWith("widgets");

// The real `runGoalBasedMission` drives generation for each fill/select step it executes and records
// the generated value in the clear; the mock does the same for the recording's single fill step.
vi.mock("../missions/goal-based.js", () => ({
  runGoalBasedMission: vi.fn(async (cfg: { goal: string; gen: GenerationPort }) => {
    const res = await cfg.gen.generate("form.value", { fieldLabel: "q", goal: cfg.goal, visibleContext: "", history: [] });
    const text = (res.output as { text: string }).text;
    return { outcome: "succeeded", assertionPassed: true, checks: [], recording: recordingWith(text), transcript: [], finalUrl: "https://example.test/search", run: {} };
  }),
}));

const fakeJudgment: JudgmentPort = { systemOne: vi.fn(async () => ({})) } as unknown as JudgmentPort;
const fakeGeneration: GenerationPort = {
  generate: vi.fn(async () => ({ output: { text: "widgets" }, provenance: { model: "fake", tookMs: 0 } })),
} as unknown as GenerationPort;

test("single-take authoring (takes: 1) produces a fully-materialized, replayable Journey", async () => {
  const result = await authorJourney({
    goal: "search for widgets",
    successAssertion: { kind: "visible", target: { testId: "results" } },
    allowlist: ["https://example.test"],
    startUrl: "https://example.test/search",
    actor: {} as never,
    judgment: fakeJudgment,
    generation: fakeGeneration,
    takes: 1,
    journeyId: "explore-search",
    journeyName: "Explore: search",
  });

  expect(result.outcome).toBe("authored");
  if (result.outcome !== "authored") throw new Error("unreachable");
  expect(result.journey.metadata.authoredBy).toBe("jev-driven");
  expect(result.journey.metadata.promoted).toBe(false);
  const fillStep = result.journey.recording.pages[0].steps[1].step;
  expect(fillStep.kind).toBe("fill");
  if (fillStep.kind === "fill") {
    // single take, no corroboration -> materialized constant, not redacted.
    expect(fillStep.value).toEqual({ redacted: false, value: "widgets" });
  }
});

test("#118/#400: the authored Journey's end state asserts the independent success condition", async () => {
  const result = await authorJourney({
    goal: "search for widgets",
    successAssertion: { kind: "visible", target: { testId: "results" } },
    allowlist: ["https://example.test"],
    startUrl: "https://example.test/search",
    actor: {} as never,
    judgment: fakeJudgment,
    generation: fakeGeneration,
    takes: 1,
    journeyId: "explore-search",
    journeyName: "Explore: search",
  });

  expect(result.outcome).toBe("authored");
  if (result.outcome !== "authored") throw new Error("unreachable");
  expect(result.journey.metadata.endState).toEqual([{ kind: "page", assertion: { kind: "visible", target: { testId: "results" } } }]);
  // #400: the check lives in the end state, not as a trailing assert step too.
  const steps = result.journey.recording.pages.flatMap((p) => p.steps.map((s) => s.step.kind));
  expect(steps).not.toContain("assert");
  expect(JourneySchema.safeParse(result.journey).success).toBe(true);
});

test("returns not-reached when the discovery mission does not succeed", async () => {
  const { runGoalBasedMission } = await import("../missions/goal-based.js");
  (runGoalBasedMission as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
    outcome: "blocked",
    assertionPassed: false,
    recording: discoveredRecording,
    transcript: [],
    finalUrl: "https://example.test/search",
    reason: "the model stopped: blocked by the paid-control guard (Run simulation)",
    run: { stop: "blocked", decisions: 3, actions: 2, outcome: { status: "incomplete", reason: "blocked" } },
  });

  const result = await authorJourney({
    goal: "search for widgets",
    successAssertion: { kind: "visible", target: { testId: "results" } },
    allowlist: ["https://example.test"],
    startUrl: "https://example.test/search",
    actor: {} as never,
    judgment: fakeJudgment,
    generation: fakeGeneration,
    takes: 1,
    journeyId: "explore-search",
    journeyName: "Explore: search",
  });

  expect(result).toMatchObject({
    outcome: "not-reached",
    reason: "discovery mission blocked: the model stopped: blocked by the paid-control guard (Run simulation)",
    discovery: { outcome: "blocked", stop: "blocked", decisions: 3, actions: 2, runOutcome: { status: "incomplete", reason: "blocked" } },
    takes: { requested: 1, run: 1, succeeded: 0 },
  });
});

test("multi-take authoring (takes: 2) promotes a value that differs across takes to a variable", async () => {
  // Uses the default mock (which drives cfg.gen once per mission call); the
  // generation port yields a different value on each of the two takes, so the
  // single fill step varies across takes and is promoted to a variable.
  const generation: GenerationPort = {
    generate: vi
      .fn()
      .mockResolvedValueOnce({ output: { text: "widgets" }, provenance: { model: "fake", tookMs: 0 } })
      .mockResolvedValueOnce({ output: { text: "gadgets" }, provenance: { model: "fake", tookMs: 0 } }),
  } as unknown as GenerationPort;

  const result = await authorJourney({
    goal: "search for something",
    successAssertion: { kind: "visible", target: { testId: "results" } },
    allowlist: ["https://example.test"],
    startUrl: "https://example.test/search",
    actor: {} as never,
    judgment: fakeJudgment,
    generation,
    takes: 2,
    journeyId: "explore-search",
    journeyName: "Explore: search",
  });

  expect(result.outcome).toBe("authored");
  if (result.outcome !== "authored") throw new Error("unreachable");
  expect(result.journey.metadata.params.length).toBe(1); // the fill step was promoted to a variable
  const fillStep = result.journey.recording.pages[0].steps[1].step;
  if (fillStep.kind === "fill") expect(fillStep.value).toEqual({ var: expect.any(String) });
});

test("#400: every --success check, of every kind, becomes an end-state assertion, in order", async () => {
  const successChecks: SuccessCheck[] = [
    { kind: "page", assertion: { kind: "textIncludes", target: { testId: "status" }, text: "Published" } },
    { kind: "page", assertion: { kind: "valueEquals", target: { label: "Title" }, value: "Hi" } },
    { kind: "page", assertion: { kind: "count", target: { css: "li" }, min: 2 } },
    { kind: "page", assertion: { kind: "attr", target: { testId: "site" }, name: "data-state", value: "live" } },
    { kind: "page", assertion: { kind: "flashed", target: { testId: "status" }, className: "toast" } },
    { kind: "reloadThen", assertion: { kind: "textIncludes", target: { css: "main" }, text: "Hello" } },
    { kind: "requestMade", method: "POST", pathGlob: "/api.v1.Settings/Save" },
    { kind: "responseStatus", method: "POST", pathGlob: "/api.v1.Settings/Save", status: { class: 2 } },
  ];
  const result = await authorJourney({
    goal: "save the settings",
    successAssertion: { kind: "visible", target: { testId: "results" } },
    successChecks,
    allowlist: ["https://example.test"],
    startUrl: "https://example.test/search",
    actor: {} as never,
    judgment: fakeJudgment,
    generation: fakeGeneration,
    takes: 1,
    journeyId: "save-settings",
    journeyName: "Save settings",
  });
  if (result.outcome !== "authored") throw new Error("unreachable");
  expect(result.journey.metadata.endState).toEqual([{ kind: "page", assertion: { kind: "visible", target: { testId: "results" } } }, ...successChecks]);
  expect(result.journey.metadata.networkChecks).toBeUndefined();
  expect(JourneySchema.safeParse(result.journey).success).toBe(true);
});

test("#322: a success check is required", async () => {
  const base = {
    goal: "save",
    allowlist: ["https://example.test"],
    startUrl: "https://example.test/search",
    actor: {} as never,
    judgment: fakeJudgment,
    generation: fakeGeneration,
    journeyId: "j",
    journeyName: "J",
  };
  await expect(authorJourney(base)).rejects.toThrow(/a success check is required/);
});

test("#400: each step's expect is derived from what it changed — the write's status, the added text — never its own target", async () => {
  const target = { testId: "publish" };
  const discovered: Recording = {
    version: "1.0",
    site: "https://example.test",
    pages: [
      {
        url: "/editor",
        steps: [
          { step: { kind: "navigate", url: "/editor", expect: { kind: "urlIncludes", text: "/editor" } } },
          { step: { kind: "click", target: { testId: "preview" }, expect: { kind: "visible", target: { testId: "preview" } } }, delta: { verdict: "relevant-change", why: "x", changes: ["+ text: Preview updated"], requests: ["POST /portal.v1.OwnerSiteEditService/PreviewSiteEdits → 200"], overheadMs: 1 } },
          { step: { kind: "click", target, expect: { kind: "visible", target } }, delta: { verdict: "inconclusive", why: "a request was sent but nothing visible changed", changes: [], requests: ["POST /portal.v1.OwnerSiteEditService/PublishSiteEdits → 200"], overheadMs: 1 } },
        ],
      },
    ],
  };
  const result = await authorJourney({
    goal: "publish the edit",
    successChecks: [{ kind: "reloadThen", assertion: { kind: "textIncludes", target: { css: "main" }, text: "Hello" } }],
    allowlist: ["https://example.test"],
    startUrl: "https://example.test/editor",
    runTake: async () => take("succeeded", discovered),
    journeyId: "publish",
    journeyName: "Publish",
  });
  if (result.outcome !== "authored") throw new Error("unreachable");
  const steps = result.journey.recording.pages[0].steps;
  expect(steps[1]).toMatchObject({
    step: { expect: { kind: "visible", target: { text: "Preview updated", textMatch: "contains" } } },
    expectRequests: [{ kind: "responseStatus", method: "POST", pathGlob: "/portal.v1.OwnerSiteEditService/PreviewSiteEdits", status: { class: 2 } }],
  });
  expect(steps[2]).toMatchObject({
    step: { expect: { kind: "count", target, min: 0 } },
    expectRequests: [{ kind: "responseStatus", method: "POST", pathGlob: "/portal.v1.OwnerSiteEditService/PublishSiteEdits", status: { class: 2 } }],
  });
  for (const s of steps) expect(isOwnTargetVisible(s.step)).toBe(false);
  expect(result.journey.metadata.endState).toEqual([{ kind: "reloadThen", assertion: { kind: "textIncludes", target: { css: "main" }, text: "Hello" } }]);
  expect(JourneySchema.safeParse(result.journey).success).toBe(true);
});

const take = (outcome: string, recording: Recording, diagnostics: Record<string, unknown> = {}) => ({
  outcome,
  recording,
  diagnostics: { outcome, ...diagnostics },
});

test("#369: a runTake take's not-reached result carries its artifact paths and concrete reason", async () => {
  const diagnostics = {
    reason: "the success check did not hold: textIncludes:testId=status|Saved (saw \"Error\")",
    stop: "done",
    resultPath: "/logs/explore-1.result.json",
    transcriptPath: "/logs/explore-1.transcript.json",
    recordingPaths: ["/logs/explore-1.json"],
    screenshotsDir: "/logs/explore-1.screenshots",
  };
  const runTake = vi.fn(async () => take("failed", discoveredRecording, diagnostics));
  const result = await authorJourney({
    goal: "save",
    successAssertion: { kind: "visible", target: { testId: "results" } },
    allowlist: ["https://example.test"],
    startUrl: "https://example.test/search",
    runTake,
    takes: 3,
    journeyId: "j",
    journeyName: "J",
  });
  expect(runTake).toHaveBeenCalledTimes(1);
  expect(result).toEqual({
    outcome: "not-reached",
    reason: `discovery mission failed: ${diagnostics.reason}`,
    discovery: { outcome: "failed", ...diagnostics },
    takes: { requested: 3, run: 1, succeeded: 0 },
  });
});

test("#369: a code-typed (redacted) field becomes a secret parameter, never a kept value", async () => {
  const withSecret: Recording = {
    ...discoveredRecording,
    pages: [
      {
        ...discoveredRecording.pages[0],
        steps: [
          ...discoveredRecording.pages[0].steps,
          { step: { kind: "fill", target: { label: "Password" }, value: { redacted: true, length: 9 }, expect: { kind: "visible", target: { testId: "results" } } } },
        ],
      },
    ],
  };
  const result = await authorJourney({
    goal: "sign in and search",
    successAssertion: { kind: "visible", target: { testId: "results" } },
    allowlist: ["https://example.test"],
    startUrl: "https://example.test/search",
    runTake: async () => take("succeeded", withSecret, { resultPath: "/logs/r.result.json" }),
    journeyId: "j",
    journeyName: "J",
  });
  if (result.outcome !== "authored") throw new Error(`not authored: ${JSON.stringify(result)}`);
  const steps = result.journey.recording.pages[0].steps.map((s) => s.step);
  expect(steps[1]).toMatchObject({ kind: "fill", value: { redacted: false, value: "widgets" } });
  expect(steps[2]).toMatchObject({ kind: "fill", value: { var: "secret1" } });
  expect(result.journey.metadata.params).toEqual(["secret1"]);
  expect(result.journey.metadata.parameters).toEqual([expect.objectContaining({ name: "secret1", secret: true })]);
  expect(JSON.stringify(result.journey)).not.toContain("jevitate:code-typed-secret");
  expect(result.discovery).toEqual({ outcome: "succeeded", resultPath: "/logs/r.result.json" });
  expect(result.takes).toEqual({ requested: 1, run: 1, succeeded: 1 });
});
