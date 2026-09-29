import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  AnnotationDraftMismatchError,
  AnnotationDraftSchema,
  JourneySchema,
  applyAnnotationDraft,
  formatAnnotationChanges,
  intentCoverage,
  secretParamNames,
  secretParamValues,
  type AnnotationDraft,
  type Journey,
} from "./index.js";

const HERE = dirname(fileURLToPath(import.meta.url));
/** A Journey as written before #246 (no intent fields) — the back-compat golden. */
const PRE_INTENT = JSON.parse(readFileSync(join(HERE, "__fixtures__", "pre-intent-journey.json"), "utf8")) as unknown;

function draftFor(journey: Journey, patch: Partial<AnnotationDraft> = {}): AnnotationDraft {
  return AnnotationDraftSchema.parse({
    kind: "jevitate.journey-annotations.draft",
    version: 1,
    journeyId: journey.metadata.id,
    journeyHash: "0".repeat(64),
    createdAtIso: "2026-09-28T00:00:00.000Z",
    provenance: { adapter: "fake", model: "fake", promptVersion: "1" },
    replay: { outcome: "completed", reachedSteps: 4, totalSteps: 4 },
    steps: [],
    ...patch,
  });
}

describe("#246 Journey intent — schema back-compat golden", () => {
  it("a pre-#246 Journey (no intent fields) validates UNCHANGED: nothing added, nothing stripped", () => {
    const parsed = JourneySchema.parse(PRE_INTENT);
    expect(parsed).toEqual(PRE_INTENT);
    expect(intentCoverage(parsed)).toEqual({ steps: 4, withObjective: 0, withoutObjective: 4, withExpectedResult: 0, hasGoal: false });
  });

  it("accepts every intent field (Journey + step), all optional", () => {
    const j = structuredClone(PRE_INTENT) as Journey;
    j.metadata = {
      ...j.metadata,
      goal: "Save a display name",
      persona: "A returning customer",
      role: "member",
      preconditions: [{ description: "Signed in", login: true }, { description: "Seeded account", fixture: "fixtures.json", hook: "seed-db" }],
      successCriteria: [{ description: "Status says Saved", check: { kind: "textIncludes", target: { testId: "status" }, text: "Saved" } }],
      parameters: [{ name: "displayName", description: "the new name" }, { name: "apiToken", secret: true }],
    };
    const first = j.recording.pages[0]!.steps[0]!;
    first.objective = "Open settings to change the display name";
    first.expectedResult = "The Settings page is shown";
    expect(() => JourneySchema.parse(j)).not.toThrow();
    expect(intentCoverage(JourneySchema.parse(j))).toMatchObject({ withObjective: 1, withoutObjective: 3, hasGoal: true });
  });

  it("rejects unknown intent keys and duplicate parameter names (the schema stays closed)", () => {
    const j = structuredClone(PRE_INTENT) as { metadata: Record<string, unknown> };
    expect(JourneySchema.safeParse({ ...j, metadata: { ...j.metadata, persona: "x", mood: "happy" } }).success).toBe(false);
    expect(
      JourneySchema.safeParse({ ...j, metadata: { ...j.metadata, parameters: [{ name: "a" }, { name: "a", secret: true }] } }).success,
    ).toBe(false);
    expect(
      JourneySchema.safeParse({ ...j, metadata: { ...j.metadata, parameters: [{ name: "a", value: "leak" }] } }).success,
    ).toBe(false);
  });
});

describe("#246 secret parameters", () => {
  it("declared secret, or a credential-like name, is secret; values are the given --param values", () => {
    const j = JourneySchema.parse(PRE_INTENT);
    const withParams: Journey = { ...j, metadata: { ...j.metadata, parameters: [{ name: "displayName" }, { name: "pinNumber", secret: true }] } };
    expect(secretParamNames(withParams, { password: "x" })).toEqual(["password", "pinNumber"]);
    expect(secretParamValues(withParams, { displayName: "Dana", pinNumber: "4242", password: "" })).toEqual(["4242"]);
  });
});

describe("#246 applyAnnotationDraft", () => {
  it("writes only the four intent fields and reports a human-readable diff", () => {
    const j = JourneySchema.parse(PRE_INTENT);
    const { journey, changes } = applyAnnotationDraft(
      j,
      draftFor(j, {
        goal: "Save a display name",
        successCriteria: ["The status says Saved"],
        steps: [{ index: 2, step: "click", objective: "Save the new name", expectedResult: "Status shows Saved" }],
      }),
    );
    expect(journey.metadata.goal).toBe("Save a display name");
    expect(journey.metadata.successCriteria).toEqual([{ description: "The status says Saved" }]);
    expect(journey.recording.pages[0]!.steps[2]).toMatchObject({ objective: "Save the new name", expectedResult: "Status shows Saved" });
    // Everything else is untouched: promotion, actions, assertions, timing.
    const stripped = structuredClone(journey);
    delete stripped.metadata.goal;
    delete stripped.metadata.successCriteria;
    delete stripped.recording.pages[0]!.steps[2]!.objective;
    delete stripped.recording.pages[0]!.steps[2]!.expectedResult;
    expect(stripped).toEqual(j);
    expect(changes.map((c) => [c.field, c.index])).toEqual([["goal", undefined], ["successCriteria", undefined], ["objective", 2], ["expectedResult", 2]]);
    expect(formatAnnotationChanges(changes)).toContain("~ step 3 objective — click button \"Save\" (save)\n  + Save the new name");
  });

  it("refuses a draft naming a step the Journey does not have (never a partial apply)", () => {
    const j = JourneySchema.parse(PRE_INTENT);
    expect(() => applyAnnotationDraft(j, draftFor(j, { steps: [{ index: 9, step: "x", objective: "y" }] }))).toThrow(AnnotationDraftMismatchError);
  });
});
