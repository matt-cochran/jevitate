import { describe, expect, it } from "vitest";
import { isSecretName } from "@jevitate/journey";
import { isCredentialExtractName, masksExtractedValue } from "./secret-params.js";

/** Extract naming (0.29.0 accepted limit): an `extract as` name refuses heal and annotate only when it is a credential's name. */
describe("isCredentialExtractName", () => {
  it.each([
    "password", "newPassword", "passwd", "pwd", "user_pass", "pass", "passcode", "apiKey", "api_key", "access_key", "privateKey",
    "authToken", "auth", "authorization", "oauth", "token", "accessToken", "csrfToken", "csrftoken", "secret", "clientSecret",
    "session", "session_id", "sessionId", "sessid", "sess", "sid", "cookie", "otp", "otpCode", "mfa_code", "pin", "pin2", "user_pin",
    "pinCode", "pin_code", "ssn", "cvv", "jwt", "bearer", "nonce", "key", "credentials", "secretary", "tokenize",
  ])("%s is a credential name", (name) => {
    expect(isCredentialExtractName(name)).toBe(true);
  });

  it.each([
    "passengers", "passenger", "passport_country", "compass", "bypass_cache", "footprint", "hotpink", "spin", "lapin",
    "token_count", "tokenCount", "max_tokens_count", "session_name", "session_count", "token_type", "token_label", "cookie_banner",
    "otp_channel", "author", "authorName", "issue", "note", "invite",
  ])("%s is not", (name) => {
    expect(isCredentialExtractName(name)).toBe(false);
  });

  it("is never wider than the broad rule", () => {
    for (const name of ["shopping", "keyboard", "author", "pinned", "count", "x", "monkey", "turkey"]) {
      if (!isSecretName(name)) expect(isCredentialExtractName(name)).toBe(false);
    }
  });
});

/** Independent check (low): a credential term followed by a describing word is still masked when its value is credential-length. */
describe("masksExtractedValue", () => {
  const none = new Set<string>();
  it.each([
    ["apiKey_name", "sk_live_51HxQ9Zq"],
    ["session_label", "a8f3c2d1e9"],
    ["token_type", "eyJhbGciOi"],
    ["password", "pw"],
    ["apiKey", "x"],
  ])("%s = %s is masked", (name, value) => {
    expect(masksExtractedValue(name, value, none)).toBe(true);
  });

  it.each([
    ["token_count", "42"],
    ["cookie_banner", "shown"],
    ["passengers", "Ada Lovelace, Grace Hopper"],
    ["note", "a8f3c2d1e9"],
    ["apiKey", "  "],
  ])("%s = %s is not", (name, value) => {
    expect(masksExtractedValue(name, value, none)).toBe(false);
  });

  it("a name declared secret: false is never masked", () => {
    expect(masksExtractedValue("apiKey", "sk_live_51HxQ9Zq", new Set(["apiKey"]))).toBe(false);
  });
});
