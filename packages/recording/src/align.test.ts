import { describe, it, expect } from "vitest";
import type { PageSegment, Recording, RecordedStep, Step } from "./schema.js";
import { alignTraces } from "./align.js";
import { stepSignature } from "./signature.js";

// === Fixture helpers ===
// Deliberately simple, hand-authored steps with clearly distinguishable
// TargetDescriptors, so each step's stepSignature is easy to reason about
// by inspection.

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

describe("alignTraces", () => {
  it("aligns two identical-length takes with matching signatures 1:1", () => {
    const A = click("step-a");
    const B = click("step-b");
    const C1 = fill("step-c", "foo");
    const C2 = fill("step-c", "bar"); // different value, same signature as C1

    const take0 = recording([page("/a", [A, B, C1])]);
    const take1 = recording([page("/a", [A, B, C2])]);

    const result = alignTraces([take0, take1]);

    expect(result).toEqual([
      { cells: [rs(A), rs(A)] },
      { cells: [rs(B), rs(B)] },
      { cells: [rs(C1), rs(C2)] },
    ]);
  });

  it("introduces a gap column for a take with one extra step", () => {
    const A = click("step-a");
    const B = click("step-b");
    const X = click("step-x"); // matches nothing in take0
    const C = click("step-c");

    const take0 = recording([page("/a", [A, B, C])]);
    const take1 = recording([page("/a", [A, B, X, C])]);

    const result = alignTraces([take0, take1]);

    expect(result).toEqual([
      { cells: [rs(A), rs(A)] },
      { cells: [rs(B), rs(B)] },
      { cells: [null, rs(X)] },
      { cells: [rs(C), rs(C)] },
    ]);
  });

  it("aligns three takes into columns, with one take introducing a gap", () => {
    const A = click("step-a");
    const B = click("step-b");
    const C = click("step-c");
    const X = click("step-x"); // matches nothing in take0/take1

    const take0 = recording([page("/a", [A, B, C])]);
    const take1 = recording([page("/a", [A, B, C])]);
    const take2 = recording([page("/a", [A, X, B, C])]);

    const result = alignTraces([take0, take1, take2]);

    expect(result).toEqual([
      { cells: [rs(A), rs(A), rs(A)] },
      { cells: [null, null, rs(X)] },
      { cells: [rs(B), rs(B), rs(B)] },
      { cells: [rs(C), rs(C), rs(C)] },
    ]);
  });

  it("never merges two different-signature steps into the same column (true divergence)", () => {
    const A = click("step-a");
    const B = click("step-b");
    const Y = click("step-y"); // different signature than B, same relative position

    const take0 = recording([page("/a", [A, B])]);
    const take1 = recording([page("/a", [A, Y])]);

    const result = alignTraces([take0, take1]);

    expect(result).toEqual([
      { cells: [rs(A), rs(A)] },
      { cells: [rs(B), null] },
      { cells: [null, rs(Y)] },
    ]);

    // Directly assert the invariant: no column ever holds two non-null
    // cells with different signatures. Uses the real `stepSignature` (not
    // a stand-in like JSON.stringify) so this is airtight against future
    // fixtures too — every cell here is on page "/a".
    for (const column of result) {
      const nonNull = column.cells.filter((c): c is RecordedStep => c !== null);
      if (nonNull.length > 1) {
        const sigs = new Set(nonNull.map((c) => stepSignature(c.step, "/a")));
        expect(sigs.size).toBe(1);
      }
    }
  });

  it("returns an empty column list for zero takes", () => {
    expect(alignTraces([])).toEqual([]);
  });

  it("returns one single-cell column per step for a single take", () => {
    const A = click("step-a");
    const B = click("step-b");
    const C = fill("step-c", "foo");

    const singleTake = recording([page("/a", [A, B, C])]);

    const result = alignTraces([singleTake]);

    expect(result).toEqual([
      { cells: [rs(A)] },
      { cells: [rs(B)] },
      { cells: [rs(C)] },
    ]);
    for (const column of result) {
      expect(column.cells.length).toBe(1);
    }
  });
});
