import { describe, it, expect } from "vitest";
import type { AlignedColumn } from "./align.js";
import type { RecordedStep, Step } from "./schema.js";
import { classifyColumns } from "./classify.js";

// === Fixture helpers ===
// Hand-authored AlignedColumn[] + matching flat-index-keyed value Maps, built
// directly (no alignTraces call) so classifyColumns is tested in isolation.

function fillStep(testId: string, value: string): Step {
  return {
    kind: "fill",
    target: { testId },
    value: { redacted: false, value },
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

function rs(step: Step): RecordedStep {
  return { step };
}

describe("classifyColumns", () => {
  it("classifies identical captured values across takes as constant, high confidence", () => {
    // Single column, two takes, both fill the same field with the same value.
    const cols: AlignedColumn[] = [
      { cells: [rs(fillStep("email", "jane@example.com")), rs(fillStep("email", "jane@example.com"))] },
    ];
    const values = [
      new Map([["0", "jane@example.com"]]),
      new Map([["0", "jane@example.com"]]),
    ];

    const result = classifyColumns(cols, values);

    expect(result.columns).toHaveLength(1);
    expect(result.columns[0].kind).toBe("constant");
    expect(result.columns[0].confidence).toBeGreaterThanOrEqual(0.9);
    expect(result.columns[0].values).toEqual(["jane@example.com", "jane@example.com"]);
  });

  it("classifies two distinct emails across takes as variable(email), reasonably high confidence", () => {
    const cols: AlignedColumn[] = [
      { cells: [rs(fillStep("email", "jane@example.com")), rs(fillStep("email", "bob@example.com"))] },
    ];
    const values = [
      new Map([["0", "jane@example.com"]]),
      new Map([["0", "bob@example.com"]]),
    ];

    const result = classifyColumns(cols, values);

    expect(result.columns).toHaveLength(1);
    expect(result.columns[0].kind).toBe("variable");
    expect(result.columns[0].inferredType).toBe("email");
    expect(result.columns[0].confidence).toBeGreaterThanOrEqual(0.6);
    expect(result.columns[0].values).toEqual(["jane@example.com", "bob@example.com"]);
  });

  it("classifies a uuid-shaped value as noise, low confidence", () => {
    const uuid = "3fa85f64-5717-4562-b3fc-2c963f66afa6";
    const cols: AlignedColumn[] = [
      { cells: [rs(fillStep("session", uuid)), rs(fillStep("session", uuid))] },
    ];
    const values = [
      new Map([["0", uuid]]),
      new Map([["0", uuid]]),
    ];

    const result = classifyColumns(cols, values);

    expect(result.columns).toHaveLength(1);
    expect(result.columns[0].kind).toBe("noise");
    expect(result.columns[0].confidence).toBeLessThanOrEqual(0.3);
  });

  it("defaults a single-take-input column to constant, never variable or ambiguous", () => {
    // Only ONE take total is passed in `values` (values.length === 1).
    const cols: AlignedColumn[] = [
      { cells: [rs(fillStep("email", "jane@example.com"))] },
    ];
    const values = [new Map([["0", "jane@example.com"]])];

    const result = classifyColumns(cols, values);

    expect(result.columns).toHaveLength(1);
    expect(result.columns[0].kind).toBe("constant");
    expect(result.columns[0].kind).not.toBe("variable");
    expect(result.columns[0].kind).not.toBe("ambiguous");
  });

  it("classifies a non-fill/select column (all clicks) as constant with all-null values", () => {
    const cols: AlignedColumn[] = [
      { cells: [rs(clickStep("submit")), rs(clickStep("submit"))] },
    ];
    const values = [new Map<string, string>(), new Map<string, string>()];

    const result = classifyColumns(cols, values);

    expect(result.columns).toHaveLength(1);
    expect(result.columns[0].kind).toBe("constant");
    expect(result.columns[0].values).toEqual([null, null]);
  });

  it("classifies a column with a gap in one take as constant when the present takes agree", () => {
    // Take 0 has a gap (null) at this column; takes 1 and 2 agree.
    const cols: AlignedColumn[] = [
      {
        cells: [
          null,
          rs(fillStep("country", "US")),
          rs(fillStep("country", "US")),
        ],
      },
    ];
    const values = [
      new Map<string, string>(),
      new Map([["0", "US"]]),
      new Map([["0", "US"]]),
    ];

    const result = classifyColumns(cols, values);

    expect(result.columns).toHaveLength(1);
    expect(result.columns[0].kind).toBe("constant");
    expect(result.columns[0].values).toEqual([null, "US", "US"]);
  });

  it("classifies a column where 2 of 3 takes agree and 1 differs as variable", () => {
    const cols: AlignedColumn[] = [
      {
        cells: [
          rs(fillStep("name", "Jane")),
          rs(fillStep("name", "Jane")),
          rs(fillStep("name", "Bob")),
        ],
      },
    ];
    const values = [
      new Map([["0", "Jane"]]),
      new Map([["0", "Jane"]]),
      new Map([["0", "Bob"]]),
    ];

    const result = classifyColumns(cols, values);

    expect(result.columns).toHaveLength(1);
    expect(result.columns[0].kind).toBe("variable");
    expect(result.columns[0].inferredType).toBe("string");
  });

  it("derives flat step indices per take independent of column order (multi-column, multi-take)", () => {
    // Take 0: [fill(a), click(b), fill(c)] -> flat indices 0,1,2
    // Take 1: [fill(a), fill(c)] (no click(b), gap at column 1) -> flat indices 0,1
    const colA: AlignedColumn = {
      cells: [rs(fillStep("a", "same")), rs(fillStep("a", "same"))],
    };
    const colB: AlignedColumn = {
      cells: [rs(clickStep("b")), null],
    };
    const colC: AlignedColumn = {
      cells: [rs(fillStep("c", "x1")), rs(fillStep("c", "x2"))],
    };
    const cols: AlignedColumn[] = [colA, colB, colC];

    const values = [
      new Map([
        ["0", "same"], // fill(a) at flat index 0
        ["2", "x1"], // fill(c) at flat index 2 (click(b) is flat index 1, no value)
      ]),
      new Map([
        ["0", "same"], // fill(a) at flat index 0
        ["1", "x2"], // fill(c) at flat index 1 (take 1 has no click(b))
      ]),
    ];

    const result = classifyColumns(cols, values);

    expect(result.columns).toHaveLength(3);
    expect(result.columns[0].kind).toBe("constant");
    expect(result.columns[0].values).toEqual(["same", "same"]);
    expect(result.columns[1].kind).toBe("constant"); // non-fill/select column
    expect(result.columns[1].values).toEqual([null, null]);
    expect(result.columns[2].kind).toBe("variable");
    expect(result.columns[2].values).toEqual(["x1", "x2"]);
  });
});
