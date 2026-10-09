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

describe("#399: registered secrets are matched in their strict (RFC 3986) percent-encoded form too", () => {
  // A navigate `${param}` value is substituted strictly encoded (`!'()*` too), the form a browser keeps.
  const secret = "it's(1)*!";
  const strict = "it%27s%281%29%2A%21";

  it("redactText scrubs the strictly encoded form", () => {
    expect(redactText(`/accept?token=${strict}`, [secret])).toBe(`/accept?token=${REDACTION_MASK}`);
  });

  it("assertNoSecretInPayload throws on a strictly encoded survivor", () => {
    expect(() => assertNoSecretInPayload({ url: `/accept?token=${strict}` }, [secret])).toThrow(SecretLeakError);
  });
});

describe("#399: lowercase-%xx and +-for-space forms are matched too", () => {
  const secret = "a b/c'd";

  it("redactText scrubs the lowercase-hex and the form-urlencoded (+ for space) forms", () => {
    expect(redactText("q=a%20b%2fc%27d", [secret])).toBe(`q=${REDACTION_MASK}`);
    expect(redactText("q=a+b%2Fc%27d", [secret])).toBe(`q=${REDACTION_MASK}`);
    expect(redactText("q=a+b%2fc%27d", [secret])).toBe(`q=${REDACTION_MASK}`);
  });

  it("assertNoSecretInPayload throws on them", () => {
    expect(() => assertNoSecretInPayload({ url: "/x?q=a+b%2Fc%27d" }, [secret])).toThrow(SecretLeakError);
    expect(() => assertNoSecretInPayload({ url: "/x?q=a%20b%2fc'd" }, [secret])).toThrow(SecretLeakError);
  });

  it("a lone surrogate never makes the guard throw a URIError (its raw form is still matched)", () => {
    const odd = "x\uD800y";
    expect(redactText(`v=${odd}`, [odd])).toBe(`v=${REDACTION_MASK}`);
  });
});

describe("short secrets (#454) — matched as whole tokens, never inside ordinary words", () => {
  it("leaves a word that merely contains a short secret's letters unchanged", () => {
    expect(redactText("Timeout waiting for the form", ["me"])).toBe("Timeout waiting for the form");
  });

  it("redacts a short secret that stands alone as a word", () => {
    expect(redactText("user me logged in", ["me"])).toBe(`user ${REDACTION_MASK} logged in`);
  });

  it("redacts a short secret bounded by an @ sign", () => {
    expect(redactText("me@x.io", ["me"])).toBe(`${REDACTION_MASK}@x.io`);
  });

  it("redacts a short secret bounded by URL parameter punctuation", () => {
    expect(redactText("pass=me&x", ["me"])).toBe(`pass=${REDACTION_MASK}&x`);
  });

  it("still redacts a long secret embedded inside a word", () => {
    expect(redactText("prefixhunter2xsuffix", ["hunter2x"])).toBe(`prefix${REDACTION_MASK}suffix`);
  });

  it("redacts the percent-encoded form of a short secret standing as a token", () => {
    expect(redactText("/login?u=a%20b&next=1", ["a b"])).toBe(`/login?u=${REDACTION_MASK}&next=1`);
  });

  it("makes the payload guard reject a short secret appearing as a token", () => {
    expect(() => assertNoSecretInPayload({ text: "signed in as me" }, ["me"])).toThrow(SecretLeakError);
  });

  it("makes the payload guard accept a word that merely contains a short secret's letters", () => {
    expect(() => assertNoSecretInPayload({ text: "Timeout" }, ["me"])).not.toThrow();
  });

  it("makes the payload guard reject a short secret right after a newline inside a structured payload", () => {
    expect(() => assertNoSecretInPayload({ text: "line one\nme" }, ["me"])).toThrow(SecretLeakError);
  });
});
