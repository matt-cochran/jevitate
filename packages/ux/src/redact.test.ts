import { describe, expect, it } from "vitest";
import { assertNoSecretInPayload } from "@jevitate/ai-core";
import { redactEvidence, RedactionUnavailableError } from "./redact.js";
import type { UxEvidence } from "./types.js";

const SECRET = "hunter2-super-secret";

function evidenceWith(secret: string): UxEvidence {
  return {
    screenId: "s1",
    url: `https://app.example.com/checkout?token=${secret}`,
    controls: [
      { index: 0, role: "textbox", name: `password ${secret}`, tag: "input", inputType: "password", enabled: true, summary: `textbox "password ${secret}"` },
      { index: 1, role: "button", name: "Continue", tag: "button", inputType: null, enabled: true, summary: 'button "Continue"' },
    ],
    visibleText: `Welcome. Your one-time code is ${secret}. Please continue.`,
    appContext: { appClass: "consumer-checkout", persona: "first-time buyer" },
    job: "complete checkout",
    history: [{ screenId: "s0", url: "https://app.example.com/cart" }],
    behavior: { noProgress: false, backtracks: 0, formReentry: 1, dwellMs: 4200, errors: 0 },
    a11yFacts: { controls: [] },
  };
}

describe("redactEvidence (fail-closed, branded)", () => {
  it("removes a declared secret from visibleText and control names/summaries", () => {
    const redacted = redactEvidence(evidenceWith(SECRET), [SECRET]);
    const serialized = JSON.stringify(redacted);
    expect(serialized).not.toContain(SECRET);
    // and the shared choke point agrees — no secret survived anywhere
    expect(() => assertNoSecretInPayload(redacted, [SECRET])).not.toThrow();
  });

  it("preserves non-secret content", () => {
    const redacted = redactEvidence(evidenceWith(SECRET), [SECRET]);
    expect(JSON.stringify(redacted)).toContain("Continue");
    expect(redacted.appContext.appClass).toBe("consumer-checkout");
  });

  it("carries a resolvable ref set for the finding gate", () => {
    const redacted = redactEvidence(evidenceWith(SECRET), [SECRET]);
    expect(redacted.refs.has("control:0")).toBe(true);
    expect(redacted.refs.has("visibleText")).toBe(true);
  });

  it("FAILS CLOSED: if the redactor throws, redactEvidence throws and never returns raw", () => {
    const throwing = () => {
      throw new Error("redactor backend unavailable");
    };
    expect(() => redactEvidence(evidenceWith(SECRET), [SECRET], throwing)).toThrow(RedactionUnavailableError);
  });

  it("FAILS CLOSED: a redactor that leaves a secret behind is caught by the proof step", () => {
    const noop = (text: string) => text; // does NOT redact
    expect(() => redactEvidence(evidenceWith(SECRET), [SECRET], noop)).toThrow();
  });
});
