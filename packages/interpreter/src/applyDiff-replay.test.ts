import { describe, it, expect, vi } from "vitest";
import { CastActor, BrowseTheWeb } from "@doit/screenplay";
import type { Recording, Step, AuthoringRecording } from "@doit/recording";
import { diffTakes, applyDiff, boundVariables, AuthoringTakeSchema } from "@doit/recording";
import { RecordingInterpreter } from "./interpreter.js";

// === Fixture helpers ===
//
// This file's fixtures are structurally identical to
// `packages/recording/src/diff.test.ts`'s own `fillStep`/`authoringRecording`
// helpers, duplicated here (rather than shared) because this test moved OUT
// of `@doit/recording` specifically to avoid depending on it beyond its
// normal runtime dependency — see the doc comment this replaced in
// `diff.test.ts`.

function fillStep(testId: string, value: string): Step {
  return {
    kind: "fill",
    target: { testId },
    value: { redacted: false, value },
    expect: { kind: "visible", target: { testId } },
  };
}

/**
 * Builds an AuthoringRecording (`{recording, values}`) from a flat list of
 * steps (single page), auto-populating `values` for fill/select steps from
 * their captured (non-redacted) `value`, keyed `"page:stepInPage"` per
 * `@doit/recording`'s convention (single page here, so always `"0:${i}"`).
 * Validated against `@doit/recording`'s `AuthoringTakeSchema` — the ONE
 * canonical take-file shape — before being converted to the `Map` form
 * `diffTakes` wants.
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

describe("applyDiff replay-level proof", () => {
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
