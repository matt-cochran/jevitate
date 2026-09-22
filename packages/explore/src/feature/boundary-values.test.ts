import { describe, expect, test } from "vitest";
import { boundaryValueCandidates, isSecretLike } from "./boundary-values.js";
import type { Control } from "../snapshot.js";

function control(over: Partial<Control>): Control {
  return {
    index: 0,
    descriptor: { css: "input" },
    stability: "high",
    role: "textbox",
    name: "",
    tag: "input",
    inputType: "text",
    enabled: true,
    summary: "",
    ...over,
  };
}

describe("boundaryValueCandidates", () => {
  test("a quantity-like field gets zero, one, and a large-but-valid value", () => {
    expect(boundaryValueCandidates(control({ role: "textbox", name: "Quantity" }))).toEqual(["0", "1", "99"]);
  });

  test("a generic required text field gets a minimal single-character value", () => {
    expect(boundaryValueCandidates(control({ role: "textbox", name: "Username" }))).toEqual(["x"]);
  });

  test("a select/combobox control falls back to the generic candidate (no option metadata on Control today)", () => {
    expect(boundaryValueCandidates(control({ role: "combobox", name: "Plan" }))).toEqual(["x"]);
  });
});

describe("isSecretLike", () => {
  test("flags password/token/secret-ish field names", () => {
    expect(isSecretLike(control({ name: "Password" }))).toBe(true);
    expect(isSecretLike(control({ name: "API token" }))).toBe(true);
  });
  test("does not flag an ordinary field", () => {
    expect(isSecretLike(control({ name: "Username" }))).toBe(false);
  });
});
