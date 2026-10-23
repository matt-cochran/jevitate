import { describe, expect, it } from "vitest";
import { appearedLines } from "./progress.js";

// #640: a wizard whose steps share the same controls moves on only in its step text. The step
// indicator changing ("Confirmation 1 of 3" → "2 of 3") is new text the model must be told; a
// ticking number elsewhere (a clock, a timer) stays masked as the same line changing (#390).

const confirmation = (n: number): string =>
  `Import contacts from a CSV\nConfirmation ${n} of 3\nPlease confirm that you want to continue with this import.\nContinue`;

describe("#640 appearedLines on a step indicator", () => {
  it("reports the next wizard step as new text", () => {
    expect(appearedLines(confirmation(1), confirmation(2))).toEqual(["Confirmation 2 of 3"]);
  });

  it("reports a 'Step N' heading that advanced", () => {
    expect(appearedLines("Step 1: choose your CSV\nContinue", "Step 2: map the columns\nContinue")).toEqual(["Step 2: map the columns"]);
  });

  it("reports a 'N/M' question counter that advanced", () => {
    expect(appearedLines("Question 3/10\nNext", "Question 4/10\nNext")).toEqual(["Question 4/10"]);
  });
});

describe("#390 appearedLines on a ticking number", () => {
  it("keeps a clock that changed masked as the same line", () => {
    expect(appearedLines("Last saved 12:01\nSave", "Last saved 12:02\nSave")).toEqual([]);
  });

  it("keeps a running count that changed masked as the same line", () => {
    expect(appearedLines("42 contacts\nRefresh", "43 contacts\nRefresh")).toEqual([]);
  });
});
