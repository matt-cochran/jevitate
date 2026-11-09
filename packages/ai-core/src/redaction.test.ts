import { afterEach, describe, expect, it } from "vitest";
import {
  JevJudgmentGateway,
  OpenRouterGenerationGateway,
  REDACTION_MASK,
  envCredentialStore,
  SecretLeakError,
  assertNoSecretInPayload,
  ModelSecretsFullError,
  openModelSecretScope,
  redactContext,
  redactModelPayload,
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

describe("F5 — a short secret inside a longer token", () => {
  it("masks a 3-5 character secret of letters and digits wherever it occurs, inside a longer token too", () => {
    expect(redactText("Code abcPw12xdef here", ["Pw12x"])).toBe(`Code abc${REDACTION_MASK}def here`);
    expect(redactText("ref=x9q7z", ["9q7"])).toBe(`ref=x${REDACTION_MASK}z`);
    expect(() => assertNoSecretInPayload({ text: "abcPw12xdef" }, ["Pw12x"])).toThrow(SecretLeakError);
  });

  it("masks a single-kind 3-5 character secret where it does not continue a run of its own kind", () => {
    // Digits next to letters, letters next to digits or punctuation: a token boundary of its own kind.
    expect(redactText("pin1234x", ["1234"])).toBe(`pin${REDACTION_MASK}x`);
    expect(redactText("abc123 and x_abc", ["abc"])).toBe(`${REDACTION_MASK}123 and x_${REDACTION_MASK}`);
    expect(() => assertNoSecretInPayload({ text: "pin1234x" }, ["1234"])).toThrow(SecretLeakError);
  });

  it("never masks a single-kind short secret inside a longer run of its own kind", () => {
    expect(redactText("12345 and 01234", ["1234"])).toBe("12345 and 01234");
    expect(redactText("the cabbage and abcdef", ["abc", "bag"])).toBe("the cabbage and abcdef");
    expect(redactText("data-base", ["a-b"])).toBe("data-base");
    expect(() => assertNoSecretInPayload({ text: "12345 cabbage" }, ["1234", "bag"])).not.toThrow();
  });

  it("a one- or two-character secret stays whole-token only", () => {
    expect(redactText("Timeout me2 a1b step7", ["me", "a1", "7"])).toBe("Timeout me2 a1b step7");
    expect(redactText("user me, room 7", ["me", "7"])).toBe(`user ${REDACTION_MASK}, room ${REDACTION_MASK}`);
  });

  it("masks at least everything the whole-token rule masked (a symbol edge is never narrower)", () => {
    expect(redactText("##ab and a#ab", ["#ab"])).toBe(`#${REDACTION_MASK} and a${REDACTION_MASK}`);
    expect(redactText("pass=abc&x", ["abc"])).toBe(`pass=${REDACTION_MASK}&x`);
  });

  it("masks the encoded form of an embedded short secret", () => {
    expect(redactText("/x?q=zzP%40w1zz", ["P@w1"])).toBe(`/x?q=zz${REDACTION_MASK}zz`);
  });
});

describe("the gateways' backstop", () => {
  const store = envCredentialStore({ OPENROUTER_API_KEY: "sk-or-test", TYPESAFE_API_KEY: "ts-test" }, {});
  const genSent = async (input: unknown): Promise<string> => {
    const bodies: unknown[] = [];
    const gen = new OpenRouterGenerationGateway({
      store,
      catalog: [{ id: "m", promptUsdPer1k: 0.1, completionUsdPer1k: 0.1, regions: ["US"], latencyClass: "fast", capabilities: [] }] as never,
      constraints: { requireRegion: "US", maxPromptUsdPer1k: 1, requiredCapabilities: [] } as never,
      call: (async (a: { body: unknown }) => (bodies.push(a.body), { object: { order: [], control: null }, latencyMs: 1 })) as never,
    });
    await gen.generate("heal.rank", input as never);
    return JSON.stringify(bodies);
  };
  const rank = (summary: string) => ({ step: "click x", evidence: [], candidates: [], controls: [{ index: 2, summary }] });
  const open: Array<{ release(): void }> = [];
  const scope = (...values: string[]) => {
    const s = openModelSecretScope();
    open.push(s);
    s.add(values);
    return s;
  };
  afterEach(() => {
    for (const s of open.splice(0)) s.release();
  });

  it("masks a live run's value at both gateways, in every string", async () => {
    scope("S3ntinel-Bound-Value");
    const sent = await genSent(rank(`button "${encodeURIComponent("S3ntinel-Bound-Value")} x" S3ntinel-Bound-Value`));
    expect(sent).not.toContain("S3ntinel-Bound-Value");
    expect(sent).toContain(REDACTION_MASK);
    const seen: unknown[] = [];
    const judge = new JevJudgmentGateway(store, (async (a: unknown) => (seen.push(a), {})) as never);
    await judge.systemOne({ state: { page: "shows S3ntinel-Bound-Value" } as never, questions: {} });
    expect(JSON.stringify(seen)).not.toContain("S3ntinel-Bound-Value");
  });

  it.each(["2", "1", "Save", "token", "short"])("%s is too short to be a secret here: never masked, and nothing throws", async (value) => {
    scope(value);
    const sent = await genSent(rank("Save 2 token 1 «redacted»"));
    expect(sent).toContain("Save 2 token 1 «redacted»");
  });

  it("a run's values go with it: a later run's call is untouched", async () => {
    const first = scope("Longer-Value-Here");
    first.release();
    expect(await genSent(rank("Longer-Value-Here"))).toContain("Longer-Value-Here");
  });

  it("longest first: a secret that starts another leaves no tail", async () => {
    scope("SECRETPART", "SECRETPARTTAILSECRET");
    expect(await genSent(rank("SECRETPARTTAILSECRET"))).not.toContain("TAILSECRET");
  });

  it("too many live values: the call fails rather than passing one in clear", async () => {
    scope(...Array.from({ length: 2001 }, (_, i) => `live-secret-${i}`));
    await expect(genSent(rank("live-secret-0"))).rejects.toBeInstanceOf(ModelSecretsFullError);
  });

  it("masks a value in an object key too", () => {
    scope("S3ntinel-Bound-Value");
    expect(JSON.stringify(redactModelPayload({ "S3ntinel-Bound-Value": "x" }))).not.toContain("S3ntinel-Bound-Value");
  });

  it("a registered value that survives masking stops the call", async () => {
    scope("1234567890");
    expect(() => redactModelPayload({ n: 1234567890 })).toThrow(SecretLeakError);
    await expect(genSent({ ...rank("x"), controls: [{ index: 1234567890, summary: "x" }] })).rejects.toBeInstanceOf(SecretLeakError);
  });

  it.each(["redacted", "«redacted»", "x«redacted»y"])("%s can't be told from the mask, so it isn't held, and nothing throws", (value) => {
    scope(value);
    expect(redactModelPayload({ a: "«redacted»" })).toEqual({ a: "«redacted»" });
  });

  it("with nothing live the payload passes untouched", () => {
    const p = { a: "plain" };
    expect(redactModelPayload(p)).toBe(p);
  });
});
