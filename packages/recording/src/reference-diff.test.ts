import { describe, it, expect } from "vitest";
import type { PageSegment, Recording, RecordedStep, Step } from "./schema.js";
import type { AlignedColumn } from "./align.js";
import { diffRecordings, diffColumns } from "./reference-diff.js";

// === Fixture helpers ===
// Same pattern as align.test.ts: simple, hand-authored steps with clearly
// distinguishable TargetDescriptors so each step's stepSignature is easy to
// reason about by inspection.

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

function page(url: string, steps: Step[]): PageSegment {
  return { url, steps: steps.map((step) => ({ step })) };
}

function recording(pages: PageSegment[]): Recording {
  return { version: "1", site: "https://example.com", pages };
}

function rs(step: Step): RecordedStep {
  return { step };
}

describe("diffRecordings", () => {
  it("returns divergedAt: null for identical structure (values may differ)", () => {
    const A = click("step-a");
    const B = click("step-b");
    const C_run = fill("step-c", "typed-by-run");
    const C_ref = fill("step-c", "typed-by-reference"); // different value, same signature

    const run = recording([page("/a", [A, B, C_run])]);
    const reference = recording([page("/a", [A, B, C_ref])]);

    expect(diffRecordings(run, reference)).toEqual({ divergedAt: null });
  });

  it("localizes a run missing a step as kind: 'missing' at the expected index", () => {
    const A = click("step-a");
    const B = click("step-b");
    const C = click("step-c");

    // reference has [A, B, C]; run has [A, C] — B is cleanly missing, with
    // no adjacent unrelated extra step for run right after the gap.
    const reference = recording([page("/a", [A, B, C])]);
    const run = recording([page("/a", [A, C])]);

    // Verified by hand against the real alignTraces output (see task
    // report): alignTraces([run, reference]) produces
    //   col0: [A, A]        (perfect)
    //   col1: [null, B]     (run missing B — first non-perfect column)
    //   col2: [C, C]        (perfect, so no adjacent opposite-gap collapse)
    // so divergedAt is 1.
    expect(diffRecordings(run, reference)).toEqual(
      expect.objectContaining({ divergedAt: 1, kind: "missing" }),
    );
  });

  it("localizes a changed target signature as kind: 'changed' (adjacent-pair collapse)", () => {
    const A = click("step-a");
    const B = click("step-b");
    const X = click("step-x"); // different signature than B
    const C = click("step-c");

    // reference has [A, B, C]; run has [A, X, C] — X substitutes for B.
    const reference = recording([page("/a", [A, B, C])]);
    const run = recording([page("/a", [A, X, C])]);

    // Verified by hand against the real alignTraces output (see task
    // report): alignTraces([run, reference]) produces
    //   col0: [A, A]        (perfect)
    //   col1: [X, null]     (run has extra X — first non-perfect column)
    //   col2: [null, B]     (reference expected B — adjacent opposite gap)
    //   col3: [C, C]        (perfect)
    // so the adjacent-pair collapse fires: divergedAt is 1, kind "changed".
    expect(diffRecordings(run, reference)).toEqual(
      expect.objectContaining({ divergedAt: 1, kind: "changed" }),
    );
  });

  it("localizes a clean extra run step as kind: 'extra' (no adjacent opposite gap)", () => {
    const A = click("step-a");
    const X = click("step-x"); // matches nothing in reference
    const C = click("step-c");

    // reference has [A, C]; run has [A, X, C] — X is a clean insertion,
    // immediately followed by a perfectly matching column (C, C).
    const reference = recording([page("/a", [A, C])]);
    const run = recording([page("/a", [A, X, C])]);

    // Verified by hand against the real alignTraces output (see task
    // report): alignTraces([run, reference]) produces
    //   col0: [A, A]        (perfect)
    //   col1: [X, null]     (run has extra X — first non-perfect column)
    //   col2: [C, C]        (perfect, so no adjacent opposite-gap collapse)
    // so divergedAt is 1, kind "extra".
    expect(diffRecordings(run, reference)).toEqual(
      expect.objectContaining({ divergedAt: 1, kind: "extra" }),
    );
  });

  it("diffColumns collapses a 'missing-first' adjacent gap pair into kind: 'changed'", () => {
    // Per code review, real alignTraces([run, reference]) output is not
    // known to ever produce this ordering (a [null, ref] column
    // immediately followed by a [run, null] column) — align.ts's
    // needlemanWunsch tie-break docstring guarantees `a`'s (run's)
    // leftover element surfaces before `b`'s (reference's) does, so real
    // substitutions come out "extra-first" (see the test above), not
    // "missing-first". This test bypasses alignTraces entirely and feeds
    // a hand-built AlignedColumn[] straight into diffColumns, to prove the
    // collapse logic itself is correct and covered even though this exact
    // shape may never arise from a real diffRecordings call today.
    const A = click("step-a");
    const B = click("step-b"); // reference's expected step
    const X = click("step-x"); // run's actual (different) step
    const C = click("step-c");

    const cols: AlignedColumn[] = [
      { cells: [rs(A), rs(A)] },
      { cells: [null, rs(B)] }, // missing-first: reference has B, run doesn't
      { cells: [rs(X), null] }, // immediately followed by: run has X, reference doesn't
      { cells: [rs(C), rs(C)] },
    ];

    expect(diffColumns(cols)).toEqual(
      expect.objectContaining({ divergedAt: 1, kind: "changed" }),
    );
  });

  it("never reports divergedAt for a position where run and reference actually agree", () => {
    const A = click("step-a");
    const B = click("step-b");
    const C = click("step-c");

    const run = recording([page("/a", [A, B, C])]);
    const reference = recording([page("/a", [A, B, C])]);

    const result = diffRecordings(run, reference);
    expect(result.divergedAt).toBeNull();
  });
});
