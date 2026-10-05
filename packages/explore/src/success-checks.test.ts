import { describe, expect, it } from "vitest";
import type { CapturedRequest } from "./page-monitor.js";
import { describeCheck, evaluateNetworkCheck } from "./success-checks.js";

const req = (
  method: string,
  path: string,
  status: number | null,
  failed = false,
  extra: Partial<Pick<CapturedRequest, "resourceType" | "contentType">> = {},
): CapturedRequest => ({
  method,
  path,
  url: `https://app.test${path}`,
  status,
  failed,
  ...extra,
});

const RUN: CapturedRequest[] = [
  req("GET", "/app/profile", 200),
  req("GET", "/api/profile/42", 200),
  req("PUT", "/api/profile/42", 204),
  req("POST", "/api/audit", 500),
  req("POST", "/api/audit", 201),
  req("GET", "/api/slow", null, true),
];

describe("network success checks (#65)", () => {
  it("requestMade holds when a request with that method matched the path glob", () => {
    expect(evaluateNetworkCheck({ kind: "requestMade", method: "PUT", pathGlob: "/api/profile/*" }, RUN)).toEqual({
      check: "requestMade:PUT /api/profile/*",
      passed: true,
      detail: "1 matching request(s)",
    });
    expect(evaluateNetworkCheck({ kind: "requestMade", method: "*", pathGlob: "/api/**" }, RUN).passed).toBe(true);
  });

  it("requestMade fails when no request matched — the silent no-op", () => {
    expect(evaluateNetworkCheck({ kind: "requestMade", method: "PATCH", pathGlob: "/api/profile/*" }, RUN)).toEqual({
      check: "requestMade:PATCH /api/profile/*",
      passed: false,
      // Near-miss hint (#130b): the same path went out under a different method.
      detail: "no PATCH request matched /api/profile/* (6 requests captured); saw GET /api/profile/42 → 200 (1×)",
    });
    // Method and glob must BOTH match; `*` stays within one segment.
    expect(evaluateNetworkCheck({ kind: "requestMade", method: "GET", pathGlob: "/api/*" }, [req("GET", "/api/a/b", 200)]).passed).toBe(false);
    // A truncated capture says so when a check fails.
    expect(evaluateNetworkCheck({ kind: "requestMade", method: "PUT", pathGlob: "/x" }, [], true).detail).toContain(
      "dropped its oldest requests",
    );
  });

  it("near-miss hint: same path, different method — the likely authoring typo (#130b)", () => {
    const run: CapturedRequest[] = [req("POST", "/api/v1/tool/profile", 200)];
    expect(evaluateNetworkCheck({ kind: "requestMade", method: "PUT", pathGlob: "/api/v1/tool/profile" }, run).detail).toBe(
      "no PUT request matched /api/v1/tool/profile (1 requests captured); saw POST /api/v1/tool/profile → 200 (1×)",
    );
  });

  it("near-miss hint: same method, one segment off — a path typo (#130b)", () => {
    const run: CapturedRequest[] = [req("PUT", "/api/v1/tools/profile", 200)];
    expect(evaluateNetworkCheck({ kind: "requestMade", method: "PUT", pathGlob: "/api/v1/tool/profile" }, run).detail).toContain(
      "saw PUT /api/v1/tools/profile → 200 (1×)",
    );
  });

  it("no near-miss hint when nothing is close", () => {
    const run: CapturedRequest[] = [req("GET", "/unrelated/thing", 200)];
    expect(evaluateNetworkCheck({ kind: "requestMade", method: "PUT", pathGlob: "/api/v1/tool/profile" }, run).detail).toBe(
      "no PUT request matched /api/v1/tool/profile (1 requests captured)",
    );
  });

  it("the captured count excludes static assets and Vite dev-server module requests (#130c)", () => {
    const run: CapturedRequest[] = [
      req("GET", "/src/main.tsx", 200, false, { resourceType: "script" }),
      req("GET", "/@vite/client", 200, false, { resourceType: "script" }),
      req("GET", "/assets/logo.png", 200, false, { resourceType: "image" }),
      req("GET", "/api/profile/42", 200, false, { resourceType: "fetch", contentType: "application/json" }),
    ];
    expect(evaluateNetworkCheck({ kind: "requestMade", method: "PUT", pathGlob: "/api/profile/*" }, run).detail).toBe(
      "no PUT request matched /api/profile/* (1 requests captured); saw GET /api/profile/42 → 200 (1×)",
    );
  });

  it("responseStatus needs at least one match, and every matching response in the class or equal to the code", () => {
    expect(
      evaluateNetworkCheck({ kind: "responseStatus", method: "PUT", pathGlob: "/api/profile/*", status: { class: 2 } }, RUN),
    ).toEqual({ check: "responseStatus:PUT /api/profile/*=2xx", passed: true, detail: "1 matching request(s), status 204" });
    expect(
      evaluateNetworkCheck({ kind: "responseStatus", method: "PUT", pathGlob: "/api/profile/*", status: { code: 200 } }, RUN),
    ).toMatchObject({ passed: false, detail: "expected 200, got 204 for 1 matching request(s)" });
    // A retried call that failed once is not a clean 2xx.
    expect(
      evaluateNetworkCheck({ kind: "responseStatus", method: "POST", pathGlob: "/api/audit", status: { class: 2 } }, RUN),
    ).toMatchObject({ passed: false, detail: "expected 2xx, got 500, 201 for 2 matching request(s)" });
    // A request that failed without a response never satisfies a status.
    expect(
      evaluateNetworkCheck({ kind: "responseStatus", method: "GET", pathGlob: "/api/slow", status: { class: 2 } }, RUN),
    ).toMatchObject({ passed: false, detail: "expected 2xx, got no response for 1 matching request(s)" });
    expect(
      evaluateNetworkCheck({ kind: "responseStatus", method: "DELETE", pathGlob: "/api/**", status: { class: 4 } }, RUN),
    ).toMatchObject({ passed: false, detail: expect.stringMatching(/^no DELETE request matched/) });
  });

  it("describes every check in the --success spec syntax", () => {
    expect(describeCheck({ kind: "page", assertion: { kind: "count", target: { role: "row" }, min: 1, max: 3 } })).toBe(
      "count:role=row|min=1,max=3",
    );
    expect(describeCheck({ kind: "reloadThen", assertion: { kind: "textIncludes", target: { testId: "t" }, text: "Hi" } })).toBe(
      "reloadThen:textIncludes:testId=t|Hi",
    );
    expect(describeCheck({ kind: "responseStatus", method: "GET", pathGlob: "/a", status: { code: 404 } })).toBe(
      "responseStatus:GET /a=404",
    );
  });
});

describe("#378 responseStatus judges a gRPC-web/Connect RPC's effective status", () => {
  const rpc = (code: number, name: string): CapturedRequest => ({
    ...req("POST", "/pkg.Svc/Method", 200, false, { contentType: "application/grpc-web+proto" }),
    rpcStatus: { protocol: "grpc-web", code, name },
  });
  const check = (status: { class: number } | { code: number }) =>
    ({ kind: "responseStatus", method: "POST", pathGlob: "/pkg.Svc/Method", status }) as const;

  it("HTTP 200 + grpc-status 13 is not a 2xx (nor a 200); it is a 5xx", () => {
    expect(evaluateNetworkCheck(check({ class: 2 }), [rpc(13, "internal")])).toEqual({
      check: "responseStatus:POST /pkg.Svc/Method=2xx",
      passed: false,
      detail: "expected 2xx, got 200 (grpc-status 13 internal) for 1 matching request(s)",
    });
    expect(evaluateNetworkCheck(check({ code: 200 }), [rpc(13, "internal")]).passed).toBe(false);
    expect(evaluateNetworkCheck(check({ class: 5 }), [rpc(13, "internal")]).passed).toBe(true);
    expect(evaluateNetworkCheck(check({ class: 4 }), [rpc(9, "failed_precondition")]).passed).toBe(true);
  });

  it("an OK RPC still holds =2xx; requestMade is unaffected", () => {
    expect(evaluateNetworkCheck(check({ class: 2 }), [rpc(0, "ok")])).toMatchObject({ passed: true, detail: "1 matching request(s), status 200" });
    expect(evaluateNetworkCheck({ kind: "requestMade", method: "POST", pathGlob: "/pkg.Svc/Method" }, [rpc(13, "internal")]).passed).toBe(true);
  });
});
