import { describe, expect, it } from "vitest";
import { parseFirstNumber, parseNumbers } from "./declared-invariants.js";

/**
 * #156 — the `number` parser behind `DomObservable.number`: a Unicode minus (U+2212) must not be
 * dropped, thousands separators and decimals must parse, and a range's dash must stay a separator
 * (never mistaken for a sign) so BOTH bounds of a range are readable.
 */
describe("parseNumbers (#156)", () => {
  it("reads a Unicode minus sign (U+2212), not just ASCII '-'", () => {
    expect(parseNumbers("−40 credits")).toEqual([-40]);
    expect(parseFirstNumber("−40 credits")).toBe(-40);
  });

  it("reads an ASCII negative number", () => {
    expect(parseNumbers("-5")).toEqual([-5]);
    expect(parseFirstNumber("-5")).toBe(-5);
  });

  it("reads thousands separators and a decimal together", () => {
    expect(parseNumbers("1,234.5")).toEqual([1234.5]);
    expect(parseFirstNumber("≈ 1,234.5 credits")).toBe(1234.5);
  });

  it("keeps a range's en-dash a separator: both bounds are readable, neither is negated", () => {
    expect(parseNumbers("≈ 30–90 credits")).toEqual([30, 90]);
  });

  it("keeps a spaced dash a separator too (index 1 reads the second number, not -7)", () => {
    const nums = parseNumbers("3 – 7");
    expect(nums).toEqual([3, 7]);
    expect(nums.at(1)).toBe(7);
  });

  it("a negative index counts from the end", () => {
    const nums = parseNumbers("≈ 30–90 credits");
    expect(nums.at(-1)).toBe(90);
  });

  it("returns an empty list when there is no number", () => {
    expect(parseNumbers("no digits here")).toEqual([]);
    expect(parseFirstNumber("no digits here")).toBeNull();
  });
});
