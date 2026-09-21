import { describe, it, expect } from "vitest";
import type { PageSegment, Recording, RecordedStep, Step, StepTiming } from "./schema.js";
import { fitInteractionPolicy } from "./fit.js";

// === Fixture helpers ===
// Deliberately simple, hand-authored steps/timings so each derived number is
// easy to check by hand.

function timing(atMs: number, durationMs: number, gapBeforeMs: number): StepTiming {
  return { atMs, durationMs, gapBeforeMs };
}

function rs(step: Step, timing?: StepTiming): RecordedStep {
  return timing ? { step, timing } : { step };
}

function fillStep(testId: string, length: number): Step {
  return {
    kind: "fill",
    target: { testId },
    value: { redacted: true, length },
    expect: { kind: "visible", target: { testId } },
  };
}

function fillStepValue(testId: string, value: string): Step {
  return {
    kind: "fill",
    target: { testId },
    value: { redacted: false, value },
    expect: { kind: "visible", target: { testId } },
  };
}

function fillStepVar(testId: string, varName: string): Step {
  return {
    kind: "fill",
    target: { testId },
    value: { var: varName },
    expect: { kind: "visible", target: { testId } },
  };
}

function clickStep(testId: string): Step {
  return {
    kind: "click",
    target: { testId },
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

function waitForStep(testId: string): Step {
  return {
    kind: "waitFor",
    target: { testId },
    state: "visible",
  };
}

function page(url: string, steps: RecordedStep[]): PageSegment {
  return { url, steps };
}

function recording(pages: PageSegment[]): Recording {
  return { version: "1", site: "https://example.com", pages };
}

describe("fitInteractionPolicy", () => {
  it("derives typing.charsPerSecond ~= 5 from a fill with 5 chars over 1000ms", () => {
    const rec = recording([
      page("/a", [rs(fillStep("field", 5), timing(0, 1000, 0))]),
    ]);

    const result = fitInteractionPolicy(rec);

    expect(result.typing).toBeDefined();
    expect(result.typing!.charsPerSecond).toBeCloseTo(5, 5);
  });

  it("omits typing entirely when there are no fill/select steps", () => {
    const rec = recording([
      page("/a", [
        rs(navigateStep("/a"), timing(0, 0, 0)),
        rs(clickStep("btn"), timing(100, 0, 50)),
        rs(waitForStep("thing")),
      ]),
    ]);

    const result = fitInteractionPolicy(rec);

    expect("typing" in result).toBe(false);
    expect(Object.keys(result)).not.toContain("typing");
  });

  it("derives thinkBeforeActionMs.mean from a click's gapBeforeMs", () => {
    const rec = recording([
      page("/a", [rs(clickStep("btn"), timing(1000, 0, 800))]),
    ]);

    const result = fitInteractionPolicy(rec);

    expect(result.thinkBeforeActionMs).toBeDefined();
    expect(result.thinkBeforeActionMs!.mean).toBeCloseTo(800, 5);
  });

  it("omits thinkBeforeActionMs when there are no click/navigate steps with timing", () => {
    const rec = recording([
      page("/a", [rs(fillStep("field", 5), timing(0, 1000, 0))]),
    ]);

    const result = fitInteractionPolicy(rec);

    expect("thinkBeforeActionMs" in result).toBe(false);
  });

  it("computes perKeyJitter as coefficient of variation across >=2 fill steps of differing rates", () => {
    // step 1: 5 chars / 1000ms = 5 chars/sec
    // step 2: 10 chars / 1000ms = 10 chars/sec
    // mean = 7.5, sample sd = sqrt(((5-7.5)^2 + (10-7.5)^2)/(2-1)) = sqrt(12.5) ≈ 3.5355
    // cv = 3.5355 / 7.5 ≈ 0.4714
    const rec = recording([
      page("/a", [
        rs(fillStep("f1", 5), timing(0, 1000, 0)),
        rs(fillStep("f2", 10), timing(1000, 1000, 0)),
      ]),
    ]);

    const result = fitInteractionPolicy(rec);

    expect(result.typing).toBeDefined();
    expect(result.typing!.charsPerSecond).toBeCloseTo(7.5, 5);
    expect(result.typing!.perKeyJitter).toBeCloseTo(0.4714045208, 5);
  });

  it("defaults perKeyJitter to 0 with exactly one usable fill step", () => {
    const rec = recording([
      page("/a", [rs(fillStep("field", 5), timing(0, 1000, 0))]),
    ]);

    const result = fitInteractionPolicy(rec);

    expect(result.typing!.perKeyJitter).toBe(0);
  });

  it("skips fill steps with a var value (no length signal) and zero-duration steps", () => {
    const rec = recording([
      page("/a", [
        rs(fillStepVar("field", "someVar"), timing(0, 1000, 0)),
        rs(fillStepValue("field2", "abc"), timing(1000, 0, 0)), // durationMs 0 -> skipped
      ]),
    ]);

    const result = fitInteractionPolicy(rec);

    expect("typing" in result).toBe(false);
  });

  it("derives interInteractionMs.mean from gapBeforeMs across every timed step (not just click/navigate)", () => {
    // gaps: 0 (navigate), 50 (click), 0 (fill) -> mean = (0+50+0)/3 = 16.666...
    const rec = recording([
      page("/a", [
        rs(navigateStep("/a"), timing(0, 0, 0)),
        rs(clickStep("btn"), timing(100, 0, 50)),
        rs(fillStep("field", 5), timing(200, 1000, 0)),
      ]),
    ]);

    const result = fitInteractionPolicy(rec);

    expect(result.interInteractionMs).toBeDefined();
    expect(result.interInteractionMs!.mean).toBeCloseTo(50 / 3, 5);
  });

  it("omits interInteractionMs when no step has timing", () => {
    const rec = recording([page("/a", [rs(clickStep("btn"))])]);

    const result = fitInteractionPolicy(rec);

    expect("interInteractionMs" in result).toBe(false);
  });

  it("never omits readingMsPerChar/maxReadingMs/wordPauseMs/sentencePauseMs/hesitation (always absent)", () => {
    const rec = recording([
      page("/a", [
        rs(fillStep("field", 5), timing(0, 1000, 0)),
        rs(clickStep("btn"), timing(1000, 0, 800)),
      ]),
    ]);

    const result = fitInteractionPolicy(rec);

    expect(result.readingMsPerChar).toBeUndefined();
    expect(result.maxReadingMs).toBeUndefined();
    expect(result.typing!.wordPauseMs).toBeUndefined();
    expect(result.typing!.sentencePauseMs).toBeUndefined();
    expect(result.typing!.hesitation).toBeUndefined();
  });
});
