import { describe, expect, it } from "vitest";
import { RecordingSchema, STEP_ID_RE, TargetDescriptorSchema, mintStepId } from "./schema.js";

/** 0.10 shared contracts on recordings: step ids (#467), tflowId (#468), testIdAttr (#470). */

function recording(steps: unknown[]): unknown {
  return { version: "1", site: "http://127.0.0.1:1", pages: [{ url: "/", steps }] };
}

const navigate = { kind: "navigate", url: "/", expect: { kind: "urlIncludes", text: "/" } };

/** A random source that replays `values` in order, then repeats the last one. */
function sequence(values: readonly number[]): () => number {
  let i = 0;
  return () => values[Math.min(i++, values.length - 1)] ?? 0;
}

describe("RecordedStep.stepId (#467)", () => {
  it("a recording without step ids still parses", () => {
    expect(RecordingSchema.safeParse(recording([{ step: navigate }])).success).toBe(true);
  });

  it("a step id round-trips", () => {
    const parsed = RecordingSchema.parse(recording([{ step: navigate, stepId: "s-7f3k2a" }]));
    expect(parsed.pages[0]?.steps[0]?.stepId).toBe("s-7f3k2a");
  });

  it("a step id outside [a-z0-9._:-]{1,64} is refused", () => {
    expect(RecordingSchema.safeParse(recording([{ step: navigate, stepId: "S 1" }])).success).toBe(false);
  });

  it("two steps sharing a step id are refused", () => {
    const dup = recording([{ step: navigate, stepId: "s-aaaaaa" }, { step: navigate, stepId: "s-aaaaaa" }]);
    expect(RecordingSchema.safeParse(dup).success).toBe(false);
  });
});

describe("mintStepId (#467)", () => {
  it("mints `s-` plus six base36 characters", () => {
    expect(mintStepId(new Set(), sequence([0.5]))).toMatch(/^s-[a-z0-9]{6}$/);
  });

  it("a minted id matches the step id rule", () => {
    expect(STEP_ID_RE.test(mintStepId(new Set()))).toBe(true);
  });

  it("never returns an id already in the given set", () => {
    // The first six draws spell `s-000000`; the next six spell something else.
    const random = sequence([0, 0, 0, 0, 0, 0, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5]);
    expect(mintStepId(new Set(["s-000000"]), random)).toBe("s-iiiiii");
  });

  it("gives up rather than looping when the random source cannot escape the set", () => {
    expect(() => mintStepId(new Set(["s-000000"]), () => 0)).toThrow(/unique step id/);
  });
});

describe("TargetDescriptor.tflowId (#468) and testIdAttr (#470)", () => {
  it("a descriptor with a tflowId round-trips it as metadata", () => {
    const parsed = TargetDescriptorSchema.parse({ testId: "send", tflowId: "invite.send" });
    expect(parsed.tflowId).toBe("invite.send");
  });

  it("a tflowId alone does not satisfy the locator requirement", () => {
    expect(TargetDescriptorSchema.safeParse({ tflowId: "invite.send" }).success).toBe(false);
  });

  it("a testIdAttr naming the attribute a testId came from round-trips", () => {
    expect(TargetDescriptorSchema.parse({ testId: "send", testIdAttr: "data-cy" }).testIdAttr).toBe("data-cy");
  });

  it("a testIdAttr that is not an attribute name is refused", () => {
    expect(TargetDescriptorSchema.safeParse({ testId: "send", testIdAttr: "data cy" }).success).toBe(false);
  });
});
