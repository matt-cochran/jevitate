import { describe, it, expect } from "vitest";
import type { Recording, Step } from "./schema.js";
import { AuthoringTakeSchema } from "./diff.js";
import type { AuthoringRecording } from "./diff.js";
import { diffTakes } from "./diff.js";
import type { DiffResult } from "./classify.js";
import { applyPostdoc, SecretMaterializationError } from "./postdoc.js";
import type { PostdocDecision } from "./postdoc.js";

// === Fixture helpers (same conventions as diff.test.ts) ===

function fillStep(testId: string, value: string): Step {
  return {
    kind: "fill",
    target: { testId },
    value: { redacted: false, value },
    expect: { kind: "visible", target: { testId } },
  };
}

function navigateStep(url: string): Step {
  return {
    kind: "navigate",
    url,
    expect: { kind: "urlIncludes", text: url },
  };
}

function clickStep(testId: string): Step {
  return {
    kind: "click",
    target: { testId },
    expect: { kind: "visible", target: { testId } },
  };
}

/**
 * Builds an AuthoringRecording from a flat list of steps (single page),
 * auto-populating `values` for fill/select steps from their captured
 * (non-redacted) `value` — same helper shape as `diff.test.ts`'s.
 */
function authoringRecording(steps: Step[]): AuthoringRecording {
  const values: Record<string, string> = {};
  steps.forEach((step, i) => {
    if ((step.kind === "fill" || step.kind === "select") && step.value && "value" in step.value) {
      values[`0:${i}`] = step.value.value;
    }
  });
  const recording: Recording = {
    version: "1.0",
    site: "https://example.test",
    pages: [
      {
        url: "https://example.test/login",
        steps: steps.map((step) => ({ step })),
      },
    ],
  };
  const validated = AuthoringTakeSchema.parse({ recording, values });
  return { recording: validated.recording, values: new Map(Object.entries(validated.values)) };
}

/** A minimal empty DiffResult — postdoc tests don't rely on diff content. */
function emptyDiff(columns: number): DiffResult {
  return { columns: Array.from({ length: columns }, () => ({ kind: "constant" as const, confidence: 1, values: [] })) };
}

describe("applyPostdoc", () => {
  it("a `variable` decision promotes the step's value to {var}", () => {
    const takeA = authoringRecording([fillStep("username", "jane")]);
    const diff = emptyDiff(1);
    const decisions: PostdocDecision[] = [
      { step: { page: 0, step: 0 }, classify: "variable", name: "username" },
    ];

    const result = applyPostdoc(takeA, diff, decisions);

    const step = result.pages[0].steps[0];
    expect(step.step).toMatchObject({ value: { var: "username" } });
    expect(step.variableName).toBe("username");
  });

  it("a `constant` decision on a non-secret value materializes the local authoring value as a literal", () => {
    const takeA = authoringRecording([fillStep("username", "jane")]);
    const diff = emptyDiff(1);
    const decisions: PostdocDecision[] = [{ step: { page: 0, step: 0 }, classify: "constant" }];

    const result = applyPostdoc(takeA, diff, decisions);

    const step = result.pages[0].steps[0];
    expect(step.step).toMatchObject({ value: { redacted: false, value: "jane" } });
  });

  it("throws when a `constant` decision targets a step with no local authoring value (secret/absent)", () => {
    // A fill step whose authoring value was never captured (e.g. a
    // password field the recorder redacted without ever recording a local
    // authoring value) — simulated here by building the AuthoringRecording
    // by hand with an empty `values` map.
    const recording: Recording = {
      version: "1.0",
      site: "https://example.test",
      pages: [
        {
          url: "https://example.test/login",
          steps: [
            {
              step: {
                kind: "fill",
                target: { testId: "password" },
                value: { redacted: true, length: 8 },
                expect: { kind: "visible", target: { testId: "password" } },
              },
            },
          ],
        },
      ],
    };
    const authoring: AuthoringRecording = { recording, values: new Map() };
    const diff = emptyDiff(1);
    const decisions: PostdocDecision[] = [{ step: { page: 0, step: 0 }, classify: "constant" }];

    expect(() => applyPostdoc(authoring, diff, decisions)).toThrow(SecretMaterializationError);
  });

  it("throws a `SecretMaterializationError` (not a plain Error) for the secret/absent-value case", () => {
    const recording: Recording = {
      version: "1.0",
      site: "https://example.test",
      pages: [
        {
          url: "https://example.test/login",
          steps: [
            {
              step: {
                kind: "fill",
                target: { testId: "password" },
                value: { redacted: true, length: 8 },
                expect: { kind: "visible", target: { testId: "password" } },
              },
            },
          ],
        },
      ],
    };
    const authoring: AuthoringRecording = { recording, values: new Map() };
    const diff = emptyDiff(1);
    const decisions: PostdocDecision[] = [{ step: { page: 0, step: 0 }, classify: "constant" }];

    try {
      applyPostdoc(authoring, diff, decisions);
      expect.unreachable("expected applyPostdoc to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(SecretMaterializationError);
      expect((err as Error).name).toBe("SecretMaterializationError");
    }
  });

  it("a `constant` decision on a column that VARIED across takes throws SecretMaterializationError without acknowledgeVaried", () => {
    const takeA = authoringRecording([fillStep("username", "jane")]);
    const takeB = authoringRecording([fillStep("username", "bob")]);
    const diff = diffTakes([takeA, takeB]);
    // Sanity: this really is a confident-variable column, not an artifact of
    // a miscoded fixture.
    expect(diff.columns[0]).toMatchObject({ kind: "variable" });
    expect(diff.columns[0].confidence).toBeGreaterThanOrEqual(0.6);

    const decisions: PostdocDecision[] = [{ step: { page: 0, step: 0 }, classify: "constant" }];

    expect(() => applyPostdoc(takeA, diff, decisions)).toThrow(SecretMaterializationError);
  });

  it("a `constant` decision on a varied column WITH acknowledgeVaried:true materializes take-0's authoring value", () => {
    const takeA = authoringRecording([fillStep("username", "jane")]);
    const takeB = authoringRecording([fillStep("username", "bob")]);
    const diff = diffTakes([takeA, takeB]);

    const decisions: PostdocDecision[] = [
      { step: { page: 0, step: 0 }, classify: "constant", acknowledgeVaried: true },
    ];

    const result = applyPostdoc(takeA, diff, decisions);
    const step = result.pages[0].steps[0];
    expect(step.step).toMatchObject({ value: { redacted: false, value: "jane" } });
  });

  it("a `constant` decision on a genuinely constant column (corroborated across takes) succeeds without any acknowledgeVaried", () => {
    const takeA = authoringRecording([fillStep("submitFlag", "yes")]);
    const takeB = authoringRecording([fillStep("submitFlag", "yes")]);
    const diff = diffTakes([takeA, takeB]);
    expect(diff.columns[0]).toMatchObject({ kind: "constant" });

    const decisions: PostdocDecision[] = [{ step: { page: 0, step: 0 }, classify: "constant" }];

    const result = applyPostdoc(takeA, diff, decisions);
    const step = result.pages[0].steps[0];
    expect(step.step).toMatchObject({ value: { redacted: false, value: "yes" } });
  });

  it("applies `label` and `chunk` alongside a classify decision", () => {
    const takeA = authoringRecording([fillStep("username", "jane")]);
    const diff = emptyDiff(1);
    const decisions: PostdocDecision[] = [
      {
        step: { page: 0, step: 0 },
        classify: "variable",
        name: "username",
        label: "Enter username",
        chunk: "login",
      },
    ];

    const result = applyPostdoc(takeA, diff, decisions);

    const step = result.pages[0].steps[0];
    expect(step.step.label).toBe("Enter username");
    expect(step.chunk).toBe("login");
  });

  it("does NOT materialize an unlisted fill/select step — it is left exactly as authored", () => {
    const takeA = authoringRecording([fillStep("username", "jane"), fillStep("password", "hunter2")]);
    const diff = emptyDiff(2);
    // Only the first step has a decision; the second (password) is unlisted.
    const decisions: PostdocDecision[] = [
      { step: { page: 0, step: 0 }, classify: "variable", name: "username" },
    ];

    const result = applyPostdoc(takeA, diff, decisions);

    const unlistedStep = result.pages[0].steps[1];
    // Byte-identical to the original authored step: not promoted to a
    // variable, not re-materialized, not touched in any way.
    expect(unlistedStep).toEqual(takeA.recording.pages[0].steps[1]);
    expect(unlistedStep.variableName).toBeUndefined();
  });

  it("a `handback` decision converts the step to a handback step carrying the given prompt", () => {
    const takeA = authoringRecording([fillStep("otp", "123456")]);
    const diff = emptyDiff(1);
    const decisions: PostdocDecision[] = [
      { step: { page: 0, step: 0 }, classify: "handback", prompt: "Enter the OTP you received" },
    ];

    const result = applyPostdoc(takeA, diff, decisions);

    const step = result.pages[0].steps[0].step;
    expect(step.kind).toBe("handback");
    expect(step).toMatchObject({ prompt: "Enter the OTP you received" });
  });

  it("real diffTakes() output can be passed through (integration sanity)", () => {
    const takeA = authoringRecording([navigateStep("/login"), fillStep("username", "jane"), clickStep("submit")]);
    const takeB = authoringRecording([navigateStep("/login"), fillStep("username", "bob"), clickStep("submit")]);
    const diff = diffTakes([takeA, takeB]);

    const decisions: PostdocDecision[] = [
      { step: { page: 0, step: 1 }, classify: "variable", name: "username" },
    ];

    const result = applyPostdoc(takeA, diff, decisions);
    expect(result.pages[0].steps[1].step).toMatchObject({ value: { var: "username" } });
  });
});
