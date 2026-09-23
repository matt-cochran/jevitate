import { describe, expect, it } from "vitest";
import {
  REDACTION_MASK,
  SecretLeakError,
  assertNoSecretInPayload,
  redactContext,
  redactText,
  redactUrl,
} from "./index.js";

describe("redactUrl — sensitive query/fragment parameter values are blanked", () => {
  it("blanks the value of every sensitive query param, keeping its name and the rest of the URL", () => {
    const out = redactUrl("https://app.test/cb?state=ok&code=abc123&x=1");
    expect(out).toBe(`https://app.test/cb?state=ok&code=${REDACTION_MASK}&x=1`);
  });

  it("matches names case-insensitively", () => {
    expect(redactUrl("/p?Access_Token=T1&API_KEY=K1")).toBe(
      `/p?Access_Token=${REDACTION_MASK}&API_KEY=${REDACTION_MASK}`,
    );
  });

  it("blanks fragment params (OAuth implicit flow)", () => {
    expect(redactUrl("https://app.test/#access_token=T2&token_type=bearer&id_token=I2")).toBe(
      `https://app.test/#access_token=${REDACTION_MASK}&token_type=bearer&id_token=${REDACTION_MASK}`,
    );
  });

  it("covers the whole agreed name set", () => {
    const names = [
      "token", "access_token", "refresh_token", "id_token", "code", "key", "api_key", "apikey",
      "secret", "client_secret", "signature", "sig", "password", "pwd", "otp", "session", "auth",
    ];
    for (const n of names) {
      expect(redactUrl(`/p?${n}=v4lue`)).toBe(`/p?${n}=${REDACTION_MASK}`);
    }
  });

  it("leaves non-sensitive params and param-less URLs byte-identical", () => {
    for (const u of ["/search?q=shoes&page=2", "https://app.test/a/b", "about:blank", "/tokens?keyword=x"]) {
      expect(redactUrl(u)).toBe(u);
    }
  });

  it("works on a URL embedded in free text", () => {
    expect(redactUrl('navigated to /reset?token=zz9 then "done"')).toBe(
      `navigated to /reset?token=${REDACTION_MASK} then "done"`,
    );
  });
});

describe("registered secrets are matched in their encodeURIComponent form too", () => {
  const secret = "p@ss word/1";
  const encoded = encodeURIComponent(secret);

  it("redactText scrubs the URL-encoded form", () => {
    const out = redactText(`/cb?q=${encoded} and raw ${secret}`, [secret]);
    expect(out).not.toContain(encoded);
    expect(out).not.toContain(secret);
    expect(out).toBe(`/cb?q=${REDACTION_MASK} and raw ${REDACTION_MASK}`);
  });

  it("assertNoSecretInPayload throws on a URL-encoded survivor (fail closed)", () => {
    expect(() => assertNoSecretInPayload({ url: `/cb?q=${encoded}` }, [secret])).toThrow(SecretLeakError);
  });

  it("redactContext returns a clean string for an encoded occurrence", () => {
    expect(redactContext(`see ${encoded}`, [secret])).toBe(`see ${REDACTION_MASK}`);
  });
});
