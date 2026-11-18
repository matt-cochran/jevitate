import { describe, expect, it } from "vitest";
import { proofSlice, sliced } from "./proof-slice.testkit.js";

describe("#858 proof slices", () => {
  it("runs everything when no slice is set", () => {
    expect(proofSlice(undefined)).toEqual({ k: 1, n: 1 });
    expect(proofSlice("")).toEqual({ k: 1, n: 1 });
    expect(sliced([1, 2, 3], { k: 1, n: 1 })).toEqual([1, 2, 3]);
  });

  it("deals every item to exactly one slice", () => {
    const items = Array.from({ length: 50 }, (_, i) => i);
    const slices = [1, 2, 3].map((k) => sliced(items, proofSlice(`${k}/3`)));
    expect(slices.flat().sort((a, b) => a - b)).toEqual(items);
    expect(slices.map((s) => s.length)).toEqual([17, 17, 16]);
  });

  it.each(["0/3", "4/3", "1/0", "a/b", "1-3"])("refuses %s", (raw) => {
    expect(() => proofSlice(raw)).toThrow(/JEV_PROOF_SLICE/);
  });
});
