import { describe, it, expect, vi } from "vitest";
import { CastActor, BrowseTheWeb } from "@doit/screenplay";
import { RecordingInterpreter } from "@doit/interpreter";
import type { Recording, Step } from "./schema.js";
import { diffTakes, applyDiff } from "./diff.js";
import type { AuthoringRecording } from "./diff.js";
import { boundVariables } from "./promote.js";

// === Fixture helpers ===

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
 * Builds an AuthoringRecording (Task 1's `{recording, values}` shape) from a
 * flat list of steps (single page), auto-populating `values` for fill/select
 * steps from their captured (non-redacted) `value`. Keys `values` with
 * Task 1's `"page:stepInPage"` convention (single page here, so always
 * `"0:${i}"`), NOT the flat-index convention `classifyColumns` wants — that
 * re-keying is exactly what `diffTakes` is responsible for doing.
 */
function authoringRecording(steps: Step[]): AuthoringRecording {
  const values = new Map<string, string>();
  steps.forEach((step, i) => {
    if ((step.kind === "fill" || step.kind === "select") && step.value && "value" in step.value) {
      values.set(`0:${i}`, step.value.value);
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
  return { recording, values };
}

describe("diffTakes", () => {
  it("classifies a fill that differs only by captured value as variable, and everything else as constant", () => {
    const takeA = authoringRecording([
      navigateStep("/login"),
      fillStep("username", "jane"),
      clickStep("submit"),
    ]);
    const takeB = authoringRecording([
      navigateStep("/login"),
      fillStep("username", "bob"),
      clickStep("submit"),
    ]);

    const diff = diffTakes([takeA, takeB]);

    expect(diff.columns).toHaveLength(3);
    expect(diff.columns[0].kind).toBe("constant"); // navigate
    expect(diff.columns[1].kind).toBe("variable"); // fill
    expect(diff.columns[1].values).toEqual(["jane", "bob"]);
    expect(diff.columns[2].kind).toBe("constant"); // click
  });
});

describe("applyDiff", () => {
  it("promotes a confident-variable fill to {var:...} and leaves every other step untouched", () => {
    const takeA = authoringRecording([
      navigateStep("/login"),
      fillStep("username", "jane"),
      clickStep("submit"),
    ]);
    const takeB = authoringRecording([
      navigateStep("/login"),
      fillStep("username", "bob"),
      clickStep("submit"),
    ]);

    const diff = diffTakes([takeA, takeB]);
    const result = applyDiff(takeA.recording, diff);

    const fillResultStep = result.pages[0].steps[1];
    expect(fillResultStep.step.kind).toBe("fill");
    expect(fillResultStep.step).toMatchObject({ value: { var: expect.any(String) } });
    expect(typeof fillResultStep.variableName).toBe("string");
    expect(fillResultStep.variableName!.length).toBeGreaterThan(0);
    // classify.ts's inferType has no email/number match for "jane"/"bob" ->
    // falls through to "string"; applyDiff's default name is
    // `${inferredType ?? "value"}${suffix}` -> "string" (no collision, so
    // no numeric suffix).
    expect(fillResultStep.variableName).toBe("string");

    // Every OTHER step is byte-identical to takeA's original.
    expect(result.pages[0].steps[0]).toEqual(takeA.recording.pages[0].steps[0]);
    expect(result.pages[0].steps[2]).toEqual(takeA.recording.pages[0].steps[2]);

    // Everything besides the promoted step's `step.value`/`variableName` is
    // unchanged on the promoted step too.
    expect(fillResultStep.step.target).toEqual(takeA.recording.pages[0].steps[1].step.target);
  });

  it("dedupes default var names across the whole diff: two same-inferred-type variable columns get distinct names", () => {
    const takeA = authoringRecording([
      fillStep("email1", "jane@example.com"),
      fillStep("email2", "jsmith@example.com"),
    ]);
    const takeB = authoringRecording([
      fillStep("email1", "bob@example.com"),
      fillStep("email2", "bsmith@example.com"),
    ]);

    const diff = diffTakes([takeA, takeB]);
    expect(diff.columns[0].kind).toBe("variable");
    expect(diff.columns[0].inferredType).toBe("email");
    expect(diff.columns[1].kind).toBe("variable");
    expect(diff.columns[1].inferredType).toBe("email");

    const result = applyDiff(takeA.recording, diff);
    const name0 = result.pages[0].steps[0].variableName;
    const name1 = result.pages[0].steps[1].variableName;

    expect(name0).toBe("email");
    expect(name1).toBe("email2");
    expect(name0).not.toBe(name1);
  });

  it("respects caller-supplied names via the `names` map, keyed by diff column index", () => {
    const takeA = authoringRecording([fillStep("username", "jane")]);
    const takeB = authoringRecording([fillStep("username", "bob")]);

    const diff = diffTakes([takeA, takeB]);
    const result = applyDiff(takeA.recording, diff, { 0: "myCustomName" });

    expect(result.pages[0].steps[0].variableName).toBe("myCustomName");
  });

  it("leaves a constant column's step completely untouched (no promotion)", () => {
    const takeA = authoringRecording([fillStep("username", "jane")]);
    const takeB = authoringRecording([fillStep("username", "jane")]);

    const diff = diffTakes([takeA, takeB]);
    expect(diff.columns[0].kind).toBe("constant");

    const result = applyDiff(takeA.recording, diff);
    expect(result).toEqual(takeA.recording);
    expect(result.pages[0].steps[0].variableName).toBeUndefined();
  });

  it("replay-level proof: interprets the applyDiff result with a fake actor, supplying the promoted var", async () => {
    const takeA = authoringRecording([fillStep("username", "jane")]);
    const takeB = authoringRecording([fillStep("username", "bob")]);

    const diff = diffTakes([takeA, takeB]);
    const result = applyDiff(takeA.recording, diff);

    const varName = result.pages[0].steps[0].variableName!;
    expect(boundVariables(result)).toContain(varName);

    const locator = {
      click: vi.fn(async () => {}),
      fill: vi.fn(async () => {}),
      pressSequentially: vi.fn(async () => {}),
      innerText: vi.fn(async () => ""),
      isVisible: vi.fn(async () => true),
      count: vi.fn(async () => 0),
      waitFor: vi.fn(async () => {}),
    };
    const page = {
      goto: vi.fn(async () => {}),
      url: vi.fn(() => "https://example.test/login"),
      getByTestId: vi.fn(() => locator),
      getByRole: vi.fn(() => locator),
      getByLabel: vi.fn(() => locator),
      getByText: vi.fn(() => locator),
      locator: vi.fn(() => locator),
    };
    const actor = CastActor.named("test").whoCan(
      new BrowseTheWeb(
        { page, startTracing: vi.fn(), stopTracingToFile: vi.fn(), close: vi.fn() } as any,
        [],
      ),
    );

    const interp = new RecordingInterpreter();
    const interpResult = await interp.run(actor as any, result, { [varName]: "supplied-value" });

    expect(interpResult).toEqual({ outcome: "completed", vars: { [varName]: "supplied-value" } });
    expect(locator.fill).toHaveBeenCalledWith("supplied-value");
  });
});
