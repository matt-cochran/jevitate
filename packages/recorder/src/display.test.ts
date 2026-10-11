import { describe, expect, it } from "vitest";
import type { ElementFacts } from "./descriptor.js";
import { DISPLAY_NAME_MAX, displayFromFacts, displayNameOf, displayOrRefusal, targetDisplay } from "./display.js";

const facts = (over: Partial<ElementFacts>): ElementFacts => ({
  tag: "button",
  roleAttr: null,
  hasHref: false,
  inputType: null,
  selectIsMulti: false,
  ariaLabel: null,
  text: "",
  alt: null,
  title: null,
  value: null,
  labelText: null,
  testId: null,
  css: null,
  ...over,
});

describe("targetDisplay: what a Recording may store as a step's visible label (#497)", () => {
  it("keeps a plain label with its role", () => {
    expect(targetDisplay({ role: "button", name: "Import" })).toEqual({ role: "button", name: "Import" });
  });

  it("collapses whitespace in the label", () => {
    expect(targetDisplay({ name: "  Import\n  contacts " })?.name).toBe("Import contacts");
  });

  it("drops a generic role", () => {
    expect(targetDisplay({ role: "generic", name: "Card" })).toEqual({ name: "Card" });
  });

  it("stores nothing for a credential field", () => {
    expect(targetDisplay({ role: "textbox", name: "Password" }, { secretField: true })).toBeUndefined();
  });

  it("stores nothing for a label holding a registered secret", () => {
    expect(targetDisplay({ name: "Signed in as ada@example.com" }, { secrets: ["ada@example.com"] })).toBeUndefined();
  });

  it("stores nothing for a label holding a credential-shaped string", () => {
    expect(targetDisplay({ name: "Copy sk_live_abcdefghijklmnop1234" })).toBeUndefined();
  });

  it("says a secret-bearing label was refused as a secret", () => {
    expect(displayOrRefusal({ name: "key sk_live_abcdefghijklmnop1234" })).toEqual({ refused: "secret" });
  });

  it("stores nothing for an empty label", () => {
    expect(targetDisplay({ role: "button", name: "   " })).toBeUndefined();
  });

  it("cuts a long label to the maximum length", () => {
    expect(targetDisplay({ name: "word ".repeat(100) })?.name.length).toBeLessThanOrEqual(DISPLAY_NAME_MAX);
  });
});

describe("displayNameOf: the human recorder's visible label (#497)", () => {
  it("prefers aria-label over text", () => {
    expect(displayNameOf(facts({ ariaLabel: "Close dialog", text: "×" }))).toBe("Close dialog");
  });

  it("uses an input's <label>", () => {
    expect(displayNameOf(facts({ tag: "input", inputType: "email", labelText: "Email" }))).toBe("Email");
  });

  it("never uses a textarea's text, which is its value", () => {
    expect(displayNameOf(facts({ tag: "textarea", text: "my private note", placeholder: "Note" }))).toBe("Note");
  });

  it("refuses the label of a password field", () => {
    expect(displayFromFacts(facts({ tag: "input", inputType: "password", labelText: "Password" }), "textbox")).toBeUndefined();
  });

  it("refuses the label of a revealed password field (autocomplete keeps it secret)", () => {
    expect(displayFromFacts(facts({ tag: "input", inputType: "text", autocomplete: "current-password", labelText: "Password" }), "textbox")).toBeUndefined();
  });
});
