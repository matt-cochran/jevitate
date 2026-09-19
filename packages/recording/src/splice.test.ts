import { describe, it, expect } from "vitest";
import type { PageSegment, Recording, RecordedStep, Step } from "./schema.js";
import { RecordingSchema } from "./schema.js";
import { spliceRecording } from "./splice.js";

// === Fixture helpers (mirrors align.test.ts's style) ===

function click(testId: string): Step {
  return {
    kind: "click",
    target: { testId },
    expect: { kind: "visible", target: { testId } },
  };
}

function fill(testId: string, value: string): Step {
  return {
    kind: "fill",
    target: { testId },
    value: { redacted: false, value },
    expect: { kind: "visible", target: { testId } },
  };
}

function rs(step: Step): RecordedStep {
  return { step };
}

function page(url: string, steps: Step[]): PageSegment {
  return { url, steps: steps.map(rs) };
}

function recording(pages: PageSegment[]): Recording {
  return { version: "1", site: "https://example.com", pages };
}

describe("spliceRecording", () => {
  describe("mode: insert", () => {
    it("splices a 2-step segment in mid-recording, re-flowing pages/indices, and validates", () => {
      const A = click("step-a");
      const B = click("step-b");
      const C = click("step-c");

      const base = recording([page("/a", [A, B, C])]);

      const S1 = fill("seg-1", "x");
      const S2 = click("seg-2");
      const segment = recording([page("/seg", [S1, S2])]);

      const result = spliceRecording(base, { page: 0, step: 1 }, segment, "insert");

      // Base page splits around the checkpoint: [A] | segment pages | [B, C]
      expect(result.pages).toEqual([
        { url: "/a", steps: [rs(A)] },
        { url: "/seg", steps: [rs(S1), rs(S2)] },
        { url: "/a", steps: [rs(B), rs(C)] },
      ]);

      // Result is schema-valid.
      expect(RecordingSchema.safeParse(result).success).toBe(true);

      // Purity: base and segment are untouched.
      expect(base.pages).toEqual([page("/a", [A, B, C])]);
      expect(segment.pages).toEqual([page("/seg", [S1, S2])]);
    });

    it("omits an empty split half when inserting at a page boundary", () => {
      const A = click("step-a");
      const B = click("step-b");
      const base = recording([page("/a", [A, B])]);

      const S1 = click("seg-1");
      const segment = recording([page("/seg", [S1])]);

      // Insert at step 0: nothing precedes the checkpoint on this page.
      const result = spliceRecording(base, { page: 0, step: 0 }, segment, "insert");

      expect(result.pages).toEqual([
        { url: "/seg", steps: [rs(S1)] },
        { url: "/a", steps: [rs(A), rs(B)] },
      ]);
      expect(RecordingSchema.safeParse(result).success).toBe(true);
    });
  });

  describe("mode: replace-from", () => {
    it("truncates from the checkpoint and appends the segment", () => {
      const A = click("step-a");
      const B = click("step-b");
      const C = click("step-c");
      const base = recording([page("/a", [A, B, C]), page("/b", [click("later")])]);

      const S1 = fill("seg-1", "y");
      const segment = recording([page("/seg", [S1])]);

      const result = spliceRecording(base, { page: 0, step: 1 }, segment, "replace-from");

      // [A] survives (before the checkpoint); B, C and the whole /b page are
      // dropped; segment's page is appended.
      expect(result.pages).toEqual([
        { url: "/a", steps: [rs(A)] },
        { url: "/seg", steps: [rs(S1)] },
      ]);
      expect(RecordingSchema.safeParse(result).success).toBe(true);
    });

    it("drops the checkpoint page entirely when nothing precedes the checkpoint", () => {
      const A = click("step-a");
      const base = recording([page("/a", [A])]);
      const segment = recording([page("/seg", [click("seg-1")])]);

      const result = spliceRecording(base, { page: 0, step: 0 }, segment, "replace-from");

      expect(result.pages).toEqual([page("/seg", [click("seg-1")])]);
    });
  });

  it("result parses RecordingSchema (fail-closed contract)", () => {
    const base = recording([page("/a", [click("a"), click("b")])]);
    const segment = recording([page("/seg", [click("s1"), click("s2")])]);

    const inserted = spliceRecording(base, { page: 0, step: 1 }, segment, "insert");
    expect(() => RecordingSchema.parse(inserted)).not.toThrow();

    const replaced = spliceRecording(base, { page: 0, step: 1 }, segment, "replace-from");
    expect(() => RecordingSchema.parse(replaced)).not.toThrow();
  });

  it("is idempotent in shape: re-splicing a well-formed result stays valid", () => {
    const base = recording([page("/a", [click("a"), click("b"), click("c")])]);
    const segment = recording([page("/seg", [click("s1"), click("s2")])]);

    const once = spliceRecording(base, { page: 0, step: 1 }, segment, "insert");
    expect(RecordingSchema.safeParse(once).success).toBe(true);

    // Splice again into the already-spliced result.
    const twice = spliceRecording(once, { page: 1, step: 1 }, segment, "insert");
    expect(RecordingSchema.safeParse(twice).success).toBe(true);
  });

  it("throws when the page index is out of range", () => {
    const base = recording([page("/a", [click("a")])]);
    const segment = recording([page("/seg", [click("s1")])]);
    expect(() => spliceRecording(base, { page: 5, step: 0 }, segment, "insert")).toThrow();
  });

  it("throws when the step index is out of range", () => {
    const base = recording([page("/a", [click("a")])]);
    const segment = recording([page("/seg", [click("s1")])]);
    expect(() => spliceRecording(base, { page: 0, step: 5 }, segment, "insert")).toThrow();
  });
});
