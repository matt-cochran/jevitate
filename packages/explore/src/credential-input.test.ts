import { describe, expect, it } from "vitest";
import { isCredentialInput, markSecretFieldDescriptor } from "./credential-input.js";
import { RunRecorder } from "./record.js";
import type { Control } from "./snapshot.js";

/** A text-entry control with just the fields `isCredentialInput` reads. */
const field = (name: string, inputType: string | null = "text", descriptor: Control["descriptor"] = { role: "textbox", name }): Control =>
  ({ index: 0, descriptor, role: "textbox", name, tag: "input", inputType, enabled: true, summary: `textbox "${name}"` }) as unknown as Control;

describe("isCredentialInput — the field decides, not the value's source", () => {
  it("a password input, a one-time-code field and a credential-named field are credentials", () => {
    expect(isCredentialInput(field("Your secret word", "password"))).toBe(true);
    expect(isCredentialInput(field("Verification code"))).toBe(true);
    expect(isCredentialInput(field("Password"))).toBe(true);
    expect(isCredentialInput(field("API key"))).toBe(true);
  });

  it("a field the snapshot saw as secret (e.g. by autocomplete) is one, whatever its name", () => {
    const d = { role: "textbox", name: "Answer" };
    markSecretFieldDescriptor(d);
    expect(isCredentialInput(field("Answer", "text", d))).toBe(true);
    // A different descriptor object with the same name is not.
    expect(isCredentialInput(field("Answer"))).toBe(false);
  });

  it("ordinary fields are not (no over-redaction)", () => {
    expect(isCredentialInput(field("Email", "email"))).toBe(false);
    expect(isCredentialInput(field("Full name"))).toBe(false);
    expect(isCredentialInput(field("Passengers", "number"))).toBe(false);
    expect(isCredentialInput(field("Search"))).toBe(false);
  });
});

describe("RunRecorder.fill — a secret field's fill is always redacted", () => {
  it("records a plain value into a perceived secret field { redacted: true }, any other field in the clear", () => {
    const MARKER = "MARKER-pw-0001";
    const pw = { role: "textbox", name: "Pass phrase" };
    markSecretFieldDescriptor(pw);
    // No registered secret: the value's source is unknown to the recorder (a goal-stated password).
    const rec = new RunRecorder("http://x");
    rec.navigate("http://x/login", 0);
    rec.fill({ role: "textbox", name: "Email" }, "a@b.example", 1);
    rec.fill(pw, MARKER, 2);
    rec.fill(pw, { redacted: false, value: MARKER }, 3);
    const out = rec.finish();
    const values = out.pages.flatMap((p) => p.steps.map((s) => s.step)).flatMap((s) => (s.kind === "fill" ? [s.value] : []));
    expect(values).toEqual([
      { redacted: false, value: "a@b.example" },
      { redacted: true, length: MARKER.length },
      { redacted: true, length: MARKER.length },
    ]);
    expect(JSON.stringify(out)).not.toContain(MARKER);
  });
});
