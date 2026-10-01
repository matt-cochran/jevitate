import { describe, expect, test } from "vitest";
import { OVERSIZE_CHARS, valueFor } from "./input-strategy.js";
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

  test("#301: 'unicode' carries an RTL override and zero-width characters", () => {
    const v = valueFor("unicode", control({ name: "Username" }));
    expect(v).toContain("\u202E");
    expect(v).toContain("\u200B");
  });

  test("#301: the markup canaries are inert — no script, no event handler, no javascript: URL", () => {
    const c = control({ name: "Comment" });
    const html = valueFor("markup", c, "abc123");
    const attr = valueFor("attribute", c, "abc123");
    expect(html).toBe('<i data-jev-canary="abc123">jevabc123</i>');
    expect(attr).toBe('jevabc123" data-jev-canary="abc123');
    for (const v of [html, attr]) {
      expect(v).not.toMatch(/<script|\son\w+\s*=|javascript:|<img|<iframe|<svg|src\s*=|href\s*=/i);
    }
  });

  test("#301: 'oversize' is far past field limits; numeric and date fields never get text canaries", () => {
    expect(valueFor("oversize", control({ name: "Comment" }))).toHaveLength(OVERSIZE_CHARS);
    expect(Number.isFinite(Number(valueFor("markup", control({ inputType: "number", role: "spinbutton" }))))).toBe(true);
    expect(valueFor("attribute", control({ inputType: "date" }))).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});
