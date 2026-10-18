import { describe, expect, it } from "vitest";
import { isSecretField } from "./index.js";

describe("isSecretField — the one shared secret-control predicate", () => {
  it("treats type=password as secret regardless of autocomplete", () => {
    expect(isSecretField("password", null)).toBe(true);
    expect(isSecretField("PASSWORD", "username")).toBe(true);
  });

  it("treats a password / one-time-code autocomplete token as secret even when type is text (show-password toggle)", () => {
    for (const ac of ["current-password", "new-password", "one-time-code", "CURRENT-PASSWORD", "section-login current-password", "otp"]) {
      expect(isSecretField("text", ac)).toBe(true);
    }
    // a textarea / non-input has no type but can still carry the marker
    expect(isSecretField(null, "one-time-code")).toBe(true);
  });

  it("does not flag ordinary controls", () => {
    expect(isSecretField("text", null)).toBe(false);
    expect(isSecretField("email", "email")).toBe(false);
    expect(isSecretField("text", "username")).toBe(false);
    expect(isSecretField(null, null)).toBe(false);
  });

  it("#564: treats a credential-named field as secret by its name / id / label / placeholder", () => {
    for (const hint of ["apiKey", "api_key", "API Key", "x-api-key", "accessToken", "Client secret", "user_password", "passcode", "CVV", "cvc", "Card number", "cardNumber", "SSN", "otp", "One-time code", "PIN", "credentials"]) {
      expect(isSecretField("text", null, [null, hint])).toBe(true);
    }
    expect(isSecretField("text", "cc-number")).toBe(true);
    expect(isSecretField("tel", "cc-csc")).toBe(true);
    expect(isSecretField(null, null, "Enter your PIN")).toBe(true);
  });

  it("#564: matches whole words only — no false positive on look-alikes", () => {
    for (const hint of ["pinned", "spinner", "Pinterest", "passport", "Passenger name", "tokenizer", "secretary", "compass", "keyword", "opinion", "username", "email"]) {
      expect(isSecretField("text", null, [hint])).toBe(false);
    }
  });

  it("is self-contained, so its source can be shipped into the page", () => {
    // Re-hydrate from source with no surrounding scope: must still work.
    const rehydrated: unknown = new Function(`return (${isSecretField.toString()});`)();
    expect(typeof rehydrated).toBe("function");
    if (typeof rehydrated !== "function") return;
    expect(rehydrated("text", "current-password")).toBe(true);
    expect(rehydrated("text", "email")).toBe(false);
    expect(rehydrated("text", null, ["apiKey"])).toBe(true);
    expect(rehydrated("text", null, ["spinner"])).toBe(false);
  });
});
