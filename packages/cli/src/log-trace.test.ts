import { describe, expect, it } from "vitest";
import { RequestIdLedger, declaredIds, idsFromHeader, parseCorrelationHeaders, parseLogIdPatterns, type LedgerRequest } from "./log-trace.js";
import { LogSpecError } from "./log-lines.js";

/** #204 — the pure halves of request ↔ log-line correlation by id. */

const TRACE = "4bf92f3577b34da6a3ce929d0e0e4736";

describe("idsFromHeader", () => {
  it("reads the trace id out of traceparent, x-amzn-trace-id and x-cloud-trace-context; others whole", () => {
    expect(idsFromHeader("traceparent", `00-${TRACE}-00f067aa0ba902b7-01`)).toEqual([TRACE]);
    expect(idsFromHeader("X-Amzn-Trace-Id", "Root=1-5759e988-bd862e3fe1be46a994272793;Sampled=1")).toEqual(["1-5759e988-bd862e3fe1be46a994272793"]);
    expect(idsFromHeader("x-cloud-trace-context", "105445aa7843bc8bf206b12000100000/1;o=1")).toEqual(["105445aa7843bc8bf206b12000100000"]);
    expect(idsFromHeader("x-request-id", "req-0001-7f3a9c")).toEqual(["req-0001-7f3a9c"]);
  });

  it("never uses an id too short to be unique, a malformed one, or the all-zero invalid trace", () => {
    expect(idsFromHeader("x-request-id", "42")).toEqual([]);
    expect(idsFromHeader("x-request-id", "has space inside")).toEqual([]);
    expect(idsFromHeader("traceparent", "00-00000000000000000000000000000000-00f067aa0ba902b7-01")).toEqual([]);
    expect(idsFromHeader("traceparent", "garbage")).toEqual([]);
  });
});

/** A minimal page: emit request/response events by hand. */
function fakePage() {
  const on: Record<string, Array<(x: never) => void>> = {};
  const page = { on: (ev: string, fn: (x: never) => void) => ((on[ev] ??= []).push(fn), page) };
  const send = (url: string, reqHeaders: Record<string, string>, status: number, resHeaders: Record<string, string>): void => {
    const r: LedgerRequest = { url: () => url, method: () => "post", headers: () => reqHeaders };
    for (const fn of on.request ?? []) fn(r as never);
    for (const fn of on.response ?? []) fn({ request: () => r, status: () => status, headers: () => resHeaders } as never);
  };
  return { page, send };
}

describe("RequestIdLedger", () => {
  it("finds a line's request by an EXACT id token (request- or response-side), never a prefix or substring", () => {
    const { page, send } = fakePage();
    const ledger = new RequestIdLedger({ headers: ["x-trace"], now: () => 1_000 });
    ledger.observe(page as never);
    send("http://app.test/api/a?token=s3cret", { traceparent: `00-${TRACE}-00f067aa0ba902b7-01` }, 200, {});
    send("http://app.test/api/b", {}, 409, { "x-request-id": "req-0002-7f3a9c" });
    send("http://app.test/api/c", {}, 200, { "x-trace": "custom-abc-123" });
    expect(ledger.requestsWithIds).toBe(3);
    expect(ledger.requestFor(`ERROR trace_id=${TRACE} failed`)?.request).toMatchObject({ method: "POST", status: 200 });
    // The URL is redacted (a token-like query value is masked).
    expect(ledger.requestFor(`ERROR trace_id=${TRACE} failed`)?.request.url).not.toContain("s3cret");
    expect(ledger.requestFor(`[00-${TRACE}-1111111111111111-01] x`)?.id).toBe(TRACE);
    expect(ledger.requestFor('{"level":"error","requestId":"req-0002-7f3a9c"}')?.request).toMatchObject({ url: "http://app.test/api/b", status: 409 });
    expect(ledger.requestFor("rid=custom-abc-123 boom")?.request.url).toBe("http://app.test/api/c");
    expect(ledger.requestFor("request_id=req-0002-7f3a9cX")).toBeUndefined();
    expect(ledger.requestFor("request_id=xreq-0002-7f3a9c")).toBeUndefined();
    expect(ledger.requestFor("no ids here")).toBeUndefined();
  });
});

describe("declaredIds (what marks a line as another request's)", () => {
  it("finds keyed ids, traceparents and operator patterns; a line with none is id-less", () => {
    expect(declaredIds("ERROR request_id=req-9999-0bd1e2 boom")).toEqual(["req-9999-0bd1e2"]);
    expect(declaredIds('{"traceId":"abcdef0123456789"}')).toEqual(["abcdef0123456789"]);
    expect(declaredIds(`x 00-${TRACE}-00f067aa0ba902b7-01 y`)).toEqual([TRACE]);
    expect(declaredIds("WARN slow query on drafts")).toEqual([]);
    expect(declaredIds("[rid:job-77-abcdef] retry", parseLogIdPatterns(["/rid:([\\w-]+)/"]))).toEqual(["job-77-abcdef"]);
  });
});

describe("flag parsing fails closed", () => {
  it("--log-correlation-header / --log-id-pattern", () => {
    expect(parseCorrelationHeaders(["X-Trace"])).toEqual(["x-trace"]);
    expect(() => parseCorrelationHeaders(["bad header"])).toThrow(LogSpecError);
    expect(() => parseLogIdPatterns(["rid=(\\w+)"])).toThrow(/must be \/regex\/flags/);
    expect(() => parseLogIdPatterns(["/(/"])).toThrow(LogSpecError);
  });
});
