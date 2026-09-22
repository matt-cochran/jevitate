import { describe, expect, test } from "vitest";
import { chooseInputStrategy, valueFor } from "./input-strategy.js";
import type { Control } from "../index.js";

/** Build a valid `Control` (real shape) for the pure value-selection tests. */
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
    summary: "textbox",
    ...over,
  };
}

describe("chooseInputStrategy", () => {
  test("picks 'empty' first for any textbox not yet tried with it", () => {
    const c = control({ role: "textbox", name: "Username" });
    expect(chooseInputStrategy(c, [])).toBe("empty");
  });

  test("advances to the next untried strategy in a fixed order", () => {
    const c = control({ role: "textbox", name: "Username" });
    expect(chooseInputStrategy(c, ["empty"])).toBe("boundary");
    expect(chooseInputStrategy(c, ["empty", "boundary"])).toBe("long");
  });

  test("returns null once every strategy has been tried (bounded — never repeats forever)", () => {
    const c = control({ role: "textbox", name: "Username" });
    expect(chooseInputStrategy(c, ["empty", "boundary", "long", "unicode", "invalid", "normal"])).toBeNull();
  });
});

describe("valueFor", () => {
  test("an email-named field gets a syntactically-invalid value under 'invalid'", () => {
    const c = control({ role: "textbox", name: "Email address" });
    expect(valueFor("invalid", c)).toBe("not-an-email");
  });

  test("a numeric/quantity-named field gets a negative value under 'invalid'", () => {
    const c = control({ role: "textbox", name: "Quantity" });
    expect(valueFor("invalid", c)).toBe("-1");
  });

  test("'empty' always yields the empty string regardless of field semantics", () => {
    expect(valueFor("empty", control({ name: "Anything" }))).toBe("");
  });

  test("'long' yields a value far past typical field length limits", () => {
    expect(valueFor("long", control({ name: "Username" })).length).toBeGreaterThan(1000);
  });

  test("'unicode' includes multi-byte/RTL characters, never invents real PII", () => {
    const v = valueFor("unicode", control({ name: "Username" }));
    expect(v).toMatch(/[^\x00-\x7F]/);
  });
});
