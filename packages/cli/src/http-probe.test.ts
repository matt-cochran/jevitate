import { describe, expect, it } from "vitest";
import { evaluateHttpCheck, type SuccessCheck } from "@jevitate/explore";
import { HttpCheckOffAllowlistError, assertHttpChecksAllowed, createHttpProbe, httpCheckRefs } from "./http-probe.js";

const OUTBOX = "http://localhost:8025";
const allowlist = ["http://localhost:3000", OUTBOX];

/** A fetch double: records each call, answers with `body` (status 200). */
function fakeFetch(body: string | Uint8Array = "{}", status = 200): { fetchImpl: typeof fetch; calls: Array<{ url: string; init: RequestInit | undefined }> } {
  const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return new Response(body, { status });
  }) as typeof fetch;
  return { fetchImpl, calls };
}

describe("createHttpProbe (#543)", () => {
  it("refuses an off-allowlist URL without making a request", async () => {
    const f = fakeFetch();
    await createHttpProbe({ allowlist, fetchImpl: f.fetchImpl })("http://evil.test/api", 1000);
    expect(f.calls).toEqual([]);
  });

  it("returns a refusal error for an off-allowlist URL", async () => {
    const f = fakeFetch();
    expect(await createHttpProbe({ allowlist, fetchImpl: f.fetchImpl })("http://evil.test/api", 1000)).toHaveProperty("error");
  });

  it("refuses a URL whose substituted value moved it off the allowlist", async () => {
    const f = fakeFetch();
    const check: SuccessCheck = { kind: "http", method: "GET", url: `${OUTBOX}/api?q=\${q}`, textIncludes: ["x"], withinMs: 0 };
    // A resolver that tries to smuggle another origin in: the value is encoded as one component.
    await evaluateHttpCheck(check, { probe: createHttpProbe({ allowlist: ["http://localhost:3000"], fetchImpl: f.fetchImpl }), resolveRef: () => ({ value: "x", secret: false }) });
    expect(f.calls).toEqual([]);
  });

  it("never follows a redirect", async () => {
    const f = fakeFetch();
    await createHttpProbe({ allowlist, fetchImpl: f.fetchImpl })(`${OUTBOX}/api/messages`, 1000);
    expect(f.calls[0]?.init?.redirect).toBe("manual");
  });

  it("sends no credentials", async () => {
    const f = fakeFetch();
    await createHttpProbe({ allowlist, fetchImpl: f.fetchImpl })(`${OUTBOX}/api/messages`, 1000);
    expect(f.calls[0]?.init?.credentials).toBe("omit");
  });

  it("sends only the accept header", async () => {
    const f = fakeFetch();
    await createHttpProbe({ allowlist, fetchImpl: f.fetchImpl })(`${OUTBOX}/api/messages`, 1000);
    expect(f.calls[0]?.init?.headers).toEqual({ accept: "application/json, */*;q=0.1" });
  });

  it("is an error past the 1 MiB body cap", async () => {
    const f = fakeFetch(new Uint8Array(1024 * 1024 + 1));
    expect(await createHttpProbe({ allowlist, fetchImpl: f.fetchImpl })(`${OUTBOX}/api/messages`, 1000)).toEqual({ error: "response exceeds 1 MiB" });
  });

  it("returns the status and body text of an allowed response", async () => {
    const f = fakeFetch('{"total":1}', 201);
    expect(await createHttpProbe({ allowlist, fetchImpl: f.fetchImpl })(`${OUTBOX}/api/messages`, 1000)).toEqual({ status: 201, bodyText: '{"total":1}' });
  });

  it("returns a transport error as { error }", async () => {
    const fetchImpl = (async () => {
      throw new Error("connect ECONNREFUSED");
    }) as typeof fetch;
    expect(await createHttpProbe({ allowlist, fetchImpl })(`${OUTBOX}/api/messages`, 1000)).toEqual({ error: "connect ECONNREFUSED" });
  });
});

describe("assertHttpChecksAllowed (#543)", () => {
  it("throws E_HTTP_CHECK_OFF_ALLOWLIST for an origin outside the allowlist", () => {
    const check: SuccessCheck = { kind: "http", method: "GET", url: `${OUTBOX}/api`, status: { class: 2 } };
    expect(() => assertHttpChecksAllowed([check], ["http://localhost:3000"])).toThrow(HttpCheckOffAllowlistError);
  });

  it("admits an allowed origin", () => {
    const check: SuccessCheck = { kind: "http", method: "GET", url: `${OUTBOX}/api`, status: { class: 2 } };
    expect(() => assertHttpChecksAllowed([check], allowlist)).not.toThrow();
  });
});

describe("httpCheckRefs (#543)", () => {
  it("#564: marks a credential-named param secret even when it was not declared secret", () => {
    expect(httpCheckRefs({ params: { apiKey: "k" } })("apiKey")).toEqual({ value: "k", secret: true });
  });

  it("marks a secret param secret", () => {
    expect(httpCheckRefs({ params: { token: "t" }, secretParams: ["token"] })("token")).toEqual({ value: "t", secret: true });
  });

  it("marks a secret setup output secret", () => {
    expect(httpCheckRefs({ bindings: { values: { k: "v" }, secretNames: new Set(["k"]) } })("setup.k")).toEqual({ value: "v", secret: true });
  });

  it("resolves a public setup output", () => {
    expect(httpCheckRefs({ bindings: { values: { email: "a@x" }, secretNames: new Set() } })("setup.email")).toEqual({ value: "a@x", secret: false });
  });
});
