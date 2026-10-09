import { describe, it, expect } from "vitest";
import type { PageSegment, Recording, RecordedStep, Step } from "./schema.js";
import { STEP_ID_RE } from "./schema.js";
import { ensureStepIds, spliceRecording, stepIdsOf } from "./splice.js";
import { applyPostdoc } from "./postdoc.js";
import { applyDiff, diffTakes } from "./diff.js";
import { promoteToVariable } from "./promote.js";

/** #467: stable step ids — minted where a recording is written, kept by every transformation. */

const click = (testId: string): Step => ({ kind: "click", target: { testId }, expect: { kind: "visible", target: { testId } } });
const fill = (testId: string, value: string): Step => ({
  kind: "fill",
  target: { testId },
  value: { redacted: false, value },
  expect: { kind: "visible", target: { testId } },
});
const rs = (step: Step, stepId?: string): RecordedStep => (stepId === undefined ? { step } : { step, stepId });
const page = (url: string, steps: RecordedStep[]): PageSegment => ({ url, steps });
const rec = (pages: PageSegment[]): Recording => ({ version: "1", site: "https://example.com", pages });
const ids = (r: Recording): (string | undefined)[] => r.pages.flatMap((p) => p.steps.map((s) => s.stepId));

const legacy = rec([page("/a", [rs(click("a")), rs(click("b"))]), page("/b", [rs(click("c"))])]);
const withIds = rec([page("/a", [rs(click("a"), "s-aaaaaa"), rs(click("b"), "s-bbbbbb")]), page("/b", [rs(click("c"), "s-cccccc")])]);

describe("ensureStepIds", () => {
  it("mints an id for every step that lacks one", () => {
    expect(ids(ensureStepIds(legacy)).every((id) => id !== undefined && STEP_ID_RE.test(id))).toBe(true);
  });

  it("mints ids unique within the recording", () => {
    expect(stepIdsOf(ensureStepIds(legacy)).size).toBe(3);
  });

  it("returns the same recording when every step already has an id", () => {
    expect(ensureStepIds(withIds)).toBe(withIds);
  });

  it("keeps an existing id and mints only the missing ones", () => {
    const partial = rec([page("/a", [rs(click("a"), "s-keep01"), rs(click("b"))])]);
    expect(ids(ensureStepIds(partial))[0]).toBe("s-keep01");
  });

  it("mints the same ids for the same id-less recording (no churn across writes)", () => {
    expect(ids(ensureStepIds(legacy))).toEqual(ids(ensureStepIds(structuredClone(legacy))));
  });

  it("never mints an id another step already has", () => {
    const partial = rec([page("/a", [rs(click("a"), "s-000000"), rs(click("b"))])]);
    let draws = 0;
    expect(ids(ensureStepIds(partial, () => (draws++ < 6 ? 0 : 0.5)))[1]).not.toBe("s-000000");
  });
});

describe("spliceRecording keeps step ids", () => {
  const segment = rec([page("/seg", [rs(click("new"))])]);

  it("keeps every base step's id when a step is inserted", () => {
    const out = spliceRecording(withIds, { page: 0, step: 1 }, segment, "insert");
    expect(ids(out).filter((id) => ["s-aaaaaa", "s-bbbbbb", "s-cccccc"].includes(id ?? ""))).toEqual(["s-aaaaaa", "s-bbbbbb", "s-cccccc"]);
  });

  it("mints a new unique id for an inserted step without one", () => {
    const out = spliceRecording(withIds, { page: 0, step: 1 }, segment, "insert");
    expect(stepIdsOf(out).size).toBe(4);
  });

  it("re-mints an inserted step's id that a kept base step already has", () => {
    const clash = rec([page("/seg", [rs(click("new"), "s-bbbbbb")])]);
    const out = spliceRecording(withIds, { page: 0, step: 1 }, clash, "insert");
    expect(stepIdsOf(out).size).toBe(4);
  });

  it("keeps an inserted step's own id when no kept step has it", () => {
    const own = rec([page("/seg", [rs(click("new"), "s-newnew")])]);
    const out = spliceRecording(withIds, { page: 0, step: 1 }, own, "insert");
    expect(ids(out)[1]).toBe("s-newnew");
  });

  it("lets a replace-from segment reuse the id of a step it replaces", () => {
    const healed = rec([page("/a", [rs(click("b2"), "s-bbbbbb")])]);
    const out = spliceRecording(withIds, { page: 0, step: 1 }, healed, "replace-from");
    expect(ids(out)).toEqual(["s-aaaaaa", "s-bbbbbb"]);
  });
});

describe("edits keep step ids", () => {
  const authoring = {
    recording: rec([page("/f", [rs(fill("name", "x"), "s-fill01"), rs(click("go"), "s-click1")])]),
    values: new Map([["0:0", "Ada"]]),
  };

  it("promoting a value to a variable keeps the step's id", () => {
    expect(ids(promoteToVariable(authoring.recording, { page: 0, step: 0 }, "name"))[0]).toBe("s-fill01");
  });

  it("a postdoc handback decision keeps the step's id", () => {
    const diff = diffTakes([authoring]);
    const out = applyPostdoc(authoring, diff, [{ step: { page: 0, step: 0 }, classify: "handback", prompt: "type it" }]);
    expect(ids(out)[0]).toBe("s-fill01");
  });

  it("a postdoc constant reads a value keyed by the step's id before its position", () => {
    const keyed = { recording: authoring.recording, values: new Map([["s-fill01", "Grace"], ["0:0", "Ada"]]) };
    const out = applyPostdoc(keyed, diffTakes([keyed]), [{ step: { page: 0, step: 0 }, classify: "constant" }]);
    expect(out.pages[0]!.steps[0]!.step).toMatchObject({ value: { redacted: false, value: "Grace" } });
  });

  it("applyDiff keeps every step's id", () => {
    const take2 = { recording: authoring.recording, values: new Map([["0:0", "Bob"]]) };
    expect(ids(applyDiff(authoring.recording, diffTakes([authoring, take2])))).toEqual(["s-fill01", "s-click1"]);
  });
});
