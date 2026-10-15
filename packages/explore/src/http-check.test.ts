import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FakeClock, installClock, resetClock } from "@jevitate/domain";
import type { HttpCheck } from "@jevitate/recording";
import { evaluateHttpCheck, judgeHttpResponse, type HttpCheckRefResolver, type HttpProbe, type HttpProbeResult } from "./http-check.js";

const OUTBOX = "http://localhost:8025/api/messages";
const subjects = (...s: string[]): string => JSON.stringify({ messages: s.map((Subject) => ({ Subject })), total: s.length });
const ok = (bodyText: string, status = 200) => ({ status, bodyText });
const check = (over: Partial<HttpCheck>): HttpCheck => ({ kind: "http", method: "GET", url: OUTBOX, ...over });

describe("judgeHttpResponse (#543)", () => {
  it("equals holds when a selected scalar's text is the value", () => {
    const c = check({ json: [{ path: "$.total", op: "equals", value: "2" }] });
    expect(judgeHttpResponse(c, ok(subjects("a", "b"))).passed).toBe(true);
  });

  it("includes holds on a substring of a selected string", () => {
    const c = check({ json: [{ path: "$.messages[0].Subject", op: "includes", value: "password" }] });
    expect(judgeHttpResponse(c, ok(subjects("Reset your password"))).passed).toBe(true);
  });

  it("includes holds on an array containing the value", () => {
    const c = check({ json: [{ path: "$.tags", op: "includes", value: "reset" }] });
    expect(judgeHttpResponse(c, ok(JSON.stringify({ tags: ["welcome", "reset"] }))).passed).toBe(true);
  });

  it("exists fails on a null value", () => {
    const c = check({ json: [{ path: "$.last", op: "exists" }] });
    expect(judgeHttpResponse(c, ok(JSON.stringify({ last: null }))).passed).toBe(false);
  });

  it("holds when any fanned-out value satisfies the operator", () => {
    const c = check({ json: [{ path: "$.messages[*].Subject", op: "equals", value: "Reset" }] });
    expect(judgeHttpResponse(c, ok(subjects("Welcome", "Reset"))).passed).toBe(true);
  });

  it("fails a json assertion on a body that is not JSON", () => {
    const c = check({ json: [{ path: "$.total", op: "exists" }] });
    expect(judgeHttpResponse(c, ok("<html>")).detail).toBe("response is not JSON");
  });

  it("textIncludes matches the raw body", () => {
    expect(judgeHttpResponse(check({ textIncludes: ["Reset your"] }), ok("Subject: Reset your password")).passed).toBe(true);
  });

  it("defaults the expected status to 2xx", () => {
    expect(judgeHttpResponse(check({ textIncludes: ["x"] }), ok("x", 500)).passed).toBe(false);
  });

  it("fails a 3xx, saying the redirect was not followed", () => {
    expect(judgeHttpResponse(check({ textIncludes: ["x"] }), ok("x", 302)).detail).toContain("a redirect is never followed");
  });

  it("passes an exact expected status", () => {
    expect(judgeHttpResponse(check({ status: { code: 204 } }), ok("", 204)).passed).toBe(true);
  });
});

describe("evaluateHttpCheck polling on the clock (#543)", () => {
  let fake: FakeClock;
  beforeEach(() => {
    fake = new FakeClock();
    installClock(fake);
  });
  afterEach(() => resetClock());

  const sequence = (results: HttpProbeResult[]): { probe: HttpProbe; calls: () => number } => {
    let n = 0;
    return {
      probe: async () => results[Math.min(n++, results.length - 1)] as HttpProbeResult,
      calls: () => n,
    };
  };
  const reset = check({ json: [{ path: "$.messages[*].Subject", op: "includes", value: "Reset" }], withinMs: 5_000 });

  it("passes when the assertion first holds on the third attempt", async () => {
    const { probe } = sequence([ok(subjects()), ok(subjects()), ok(subjects("Reset"))]);
    const p = evaluateHttpCheck(reset, { probe });
    await fake.runUntilIdle();
    expect((await p).passed).toBe(true);
  });

  it("fails once the window has passed without the assertion holding", async () => {
    const { probe } = sequence([ok(subjects())]);
    const p = evaluateHttpCheck(reset, { probe });
    await fake.runUntilIdle();
    const v = await p;
    expect([v.passed, v.unevaluable === true]).toEqual([false, false]);
  });

  it("stops polling when the window is over", async () => {
    const { probe, calls } = sequence([ok(subjects())]);
    const p = evaluateHttpCheck(reset, { probe });
    await fake.runUntilIdle();
    await p;
    expect(calls()).toBe(11);
  });

  it("is unevaluable when every attempt was a transport error", async () => {
    const { probe } = sequence([{ error: "connect ECONNREFUSED" }]);
    const p = evaluateHttpCheck(reset, { probe });
    await fake.runUntilIdle();
    expect((await p).unevaluable).toBe(true);
  });

  it("fails closed as unevaluable without a probe", async () => {
    expect((await evaluateHttpCheck(reset, {})).detail).toBe("unevaluable: this context cannot make HTTP checks");
  });

  it("makes exactly one attempt when asked to probe once", async () => {
    const { probe, calls } = sequence([ok(subjects())]);
    await evaluateHttpCheck(reset, { probe, once: true });
    expect(calls()).toBe(1);
  });
});

describe("evaluateHttpCheck placeholders and redaction (#543)", () => {
  const templated = check({ url: "http://localhost:8025/api/search?query=to:${email}", textIncludes: ["Reset"], withinMs: 0 });
  const refs = (map: Record<string, { value: string; secret: boolean }>): HttpCheckRefResolver => (n) => map[n];

  it("encodes a placeholder's value as one URL component", async () => {
    let seen = "";
    const probe: HttpProbe = async (url) => {
      seen = url;
      return ok("Reset");
    };
    await evaluateHttpCheck(templated, { probe, resolveRef: refs({ email: { value: "a+b@x.test", secret: false } }) });
    expect(seen).toBe("http://localhost:8025/api/search?query=to:a%2Bb%40x.test");
  });

  it("refuses a secret placeholder with E_HTTP_CHECK_SECRET_REF and makes no request", async () => {
    let calls = 0;
    const probe: HttpProbe = async () => {
      calls += 1;
      return ok("Reset");
    };
    const v = await evaluateHttpCheck(templated, { probe, resolveRef: refs({ email: { value: "x", secret: true } }) });
    expect({ detail: v.detail.includes("E_HTTP_CHECK_SECRET_REF"), calls }).toEqual({ detail: true, calls: 0 });
  });

  it("shows the URL with its placeholder name, never the value", async () => {
    const v = await evaluateHttpCheck(templated, { probe: async () => ok("nope"), resolveRef: refs({ email: { value: "who@x.test", secret: false } }) });
    expect(v.detail).toContain("query=to:<param email>");
  });

  it("never quotes a registered secret from the body", async () => {
    const body = JSON.stringify({ messages: [{ Subject: "token tok_SECRET_123 inside" }] });
    const c = check({ json: [{ path: "$.messages[*].Subject", op: "equals", value: "x" }], withinMs: 0 });
    const v = await evaluateHttpCheck(c, { probe: async () => ok(body), secrets: ["tok_SECRET_123"] });
    expect(v.detail).not.toContain("tok_SECRET_123");
  });

  it("quotes at most 200 characters of the body", async () => {
    const c = check({ textIncludes: ["absent"], withinMs: 0 });
    const v = await evaluateHttpCheck(c, { probe: async () => ok("y".repeat(5_000)) });
    expect(v.detail.match(/y{2,}/)?.[0].length).toBe(200);
  });
});
