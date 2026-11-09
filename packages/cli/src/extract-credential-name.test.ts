import { describe, expect, it } from "vitest";
import { isSecretName } from "@jevitate/journey";
import { isCredentialExtractName } from "./secret-params.js";

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
