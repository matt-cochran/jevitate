import { describe, expect, it } from "vitest";
import { classifyRequest, endpointOf, p50, summarizeTimings, type PageTiming, type RequestKind, type RequestTiming } from "./timing.js";

const req = (endpoint: string, durationMs: number, status: number | null = 200, kind: RequestKind = "api"): RequestTiming => ({
  endpoint,
  kind,
  url: `http://x.test${endpoint.split(" ")[1] ?? ""}`,
  status,
  durationMs,
});

const nav = (route: string, loadMs: number | null, dcl = 100, requests: RequestTiming[] = []): PageTiming => ({
  route,
  kind: "navigation",
  navigation: { ttfbMs: 10, domContentLoadedMs: dcl, loadMs },
  settled: true,
  requests: { count: requests.length, pending: 0, slowest: requests.slice(0, 3), samples: requests },
});

const transition = (route: string, settleMs: number, requests: RequestTiming[] = []): PageTiming => ({
  route,
  kind: "transition",
  settleMs,
  settled: true,
  requests: { count: requests.length, pending: 0, slowest: requests.slice(0, 3), samples: requests },
});

describe("timing aggregation — p50, max, top N, normalization (owner ruling 6)", () => {
  it("p50 is the nearest-rank median", () => {
    expect(p50([5])).toBe(5);
    expect(p50([3, 1, 2])).toBe(2);
    expect(p50([4, 1, 3, 2])).toBe(2);
    expect(p50([10, 10, 900])).toBe(10);
  });

  it("endpoints are keyed by METHOD + normalized path (ids collapsed, query and host dropped)", () => {
    expect(endpointOf("get", "http://127.0.0.1:6310/api/v1/contacts/12345?page=2")).toBe("GET /api/v1/contacts/:id");
    expect(endpointOf("POST", "https://staging.test/api/v1/contacts/98765")).toBe("POST /api/v1/contacts/:id");
  });

  it("pages and transitions are keyed by kind + route, with p50 and max across repeats", () => {
    const s = summarizeTimings([
      nav("/contacts/:id", 1200),
      nav("/contacts/:id", 400),
      nav("/contacts/:id", 800),
      nav("/home", null, 300), // load not finished → DOMContentLoaded
      transition("/contacts/:id", 2500),
      undefined,
      { route: "/idle", kind: "idle", settled: true, requests: { count: 0, pending: 0, slowest: [], samples: [] } },
    ]);
    expect(s.pages["navigation /contacts/:id"]).toEqual({
      key: "navigation /contacts/:id",
      route: "/contacts/:id",
      kind: "navigation",
      samples: 3,
      p50Ms: 800,
      maxMs: 1200,
    });
    expect(s.pages["navigation /home"]).toMatchObject({ samples: 1, p50Ms: 300, maxMs: 300 });
    expect(s.pages["transition /contacts/:id"]).toMatchObject({ samples: 1, maxMs: 2500 });
    expect(Object.keys(s.pages)).not.toContain("idle /idle");
    expect(s.slowestPages.map((p) => p.key)).toEqual([
      "transition /contacts/:id",
      "navigation /contacts/:id",
      "navigation /home",
    ]);
  });

  it("endpoints aggregate every request in every step, slowest first, top N only", () => {
    const s = summarizeTimings(
      [
        nav("/a", 100, 50, [req("GET /api/slow/:id", 900), req("GET /api/fast", 20), req("GET /api/boom", 50, 500)]),
        transition("/a", 300, [req("GET /api/slow/:id", 700), req("GET /api/fast", 40), req("GET /api/mid", 300)]),
      ],
      2,
    );
    expect(s.endpoints["GET /api/slow/:id"]).toEqual({
      endpoint: "GET /api/slow/:id",
      kind: "api",
      samples: 2,
      p50Ms: 700,
      maxMs: 900,
      statuses: [200],
    });
    expect(s.endpoints["GET /api/boom"]?.statuses).toEqual([500]);
    expect(s.slowestEndpoints.map((e) => e.endpoint)).toEqual(["GET /api/slow/:id", "GET /api/mid"]);
  });

  it("an empty run summarizes to empty maps", () => {
    expect(summarizeTimings([])).toEqual({ pages: {}, endpoints: {}, slowestPages: [], slowestEndpoints: [], slowestAssets: [] });
  });
});

describe("request classification — the API is ranked apart from assets and dev modules (round 2d)", () => {
  it.each<[string, Parameters<typeof classifyRequest>[0], RequestKind]>([
    ["a JSON fetch", { url: "http://a.test/api/v1/contacts", resourceType: "fetch", contentType: "application/json; charset=utf-8" }, "api"],
    ["an XHR with no body type (204)", { url: "http://a.test/api/ping", resourceType: "xhr", contentType: null }, "api"],
    ["a page load", { url: "http://a.test/contacts", resourceType: "document", contentType: "text/html" }, "document"],
    ["a script", { url: "http://a.test/assets/app.js", resourceType: "script", contentType: "text/javascript" }, "asset"],
    ["a Vite dev module", { url: "http://localhost:3000/src/pages/Home.tsx", resourceType: "script", contentType: "text/javascript" }, "asset"],
    ["a Vite client module fetched by script", { url: "http://localhost:3000/@vite/client", resourceType: "fetch", contentType: null }, "asset"],
    ["a node_modules dep", { url: "http://localhost:3000/node_modules/.vite/deps/react.js?v=1", resourceType: "script", contentType: null }, "asset"],
    ["a stylesheet", { url: "http://a.test/app.css", resourceType: "stylesheet", contentType: "text/css" }, "asset"],
    ["an image fetched by script", { url: "http://a.test/logo", resourceType: "fetch", contentType: "image/png" }, "asset"],
  ])("%s → %s", (_n, r, want) => {
    expect(classifyRequest(r)).toBe(want);
  });

  it("a configured API prefix wins over the heuristics", () => {
    expect(classifyRequest({ url: "http://a.test/graphql", resourceType: "other", contentType: "text/html" }, ["/graphql"])).toBe("api");
  });

  it("slowestEndpoints ranks API endpoints only; slowestAssets ranks assets; the full data keeps both", () => {
    const s = summarizeTimings([
      nav("/", 100, 50, [
        req("GET /src/pages/Home.tsx", 7_000, 200, "asset"),
        req("GET /@vite/client", 4_000, 200, "asset"),
        req("GET /api/v1/tool/billing/payment-methods", 640, 500, "api"),
        req("GET /api/v1/account/balance", 890, 200, "api"),
        req("GET /", 30, 200, "document"),
      ]),
    ]);
    expect(s.slowestEndpoints.map((e) => e.endpoint)).toEqual([
      "GET /api/v1/account/balance",
      "GET /api/v1/tool/billing/payment-methods",
    ]);
    expect(s.slowestAssets.map((e) => e.endpoint)).toEqual(["GET /src/pages/Home.tsx", "GET /@vite/client"]);
    expect(Object.keys(s.endpoints)).toHaveLength(5);
    expect(s.endpoints["GET /"]?.kind).toBe("document");
  });
});
