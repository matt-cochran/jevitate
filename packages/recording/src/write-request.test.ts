import { describe, expect, it } from "vitest";
import { isWriteRequest, rpcMethodOf, writeClassifier } from "./write-request.js";

describe("isWriteRequest (#110)", () => {
  it("GET/HEAD/OPTIONS are reads; plain POST/PUT/PATCH/DELETE are writes", () => {
    expect(isWriteRequest({ method: "GET", path: "/api/items" })).toBe(false);
    expect(isWriteRequest({ method: "head", path: "/api/items" })).toBe(false);
    expect(isWriteRequest({ method: "OPTIONS", path: "/pkg.Svc/CreateX" })).toBe(false);
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      expect(isWriteRequest({ method, path: "/api/items", contentType: "application/json" })).toBe(true);
    }
  });

  it("an RPC-over-POST read method (gRPC-web / Connect / JSON) is a read", () => {
    for (const contentType of ["application/grpc-web+proto", "application/grpc-web-text", "application/connect+json", "application/proto", "application/json", null, undefined]) {
      expect(isWriteRequest({ method: "POST", path: "/simuli.decision.DecisionService/GetDecisionDetail", contentType })).toBe(false);
    }
    for (const m of ["ListNodeTests", "SearchX", "FindY", "WatchZ", "StreamEvents", "CountRows", "DescribeThing", "ReadDoc", "Get"]) {
      expect(isWriteRequest({ method: "POST", path: `/pkg.Service/${m}`, contentType: "application/grpc-web+proto" }), m).toBe(false);
    }
    expect(isWriteRequest({ method: "POST", path: "http://127.0.0.1:18582/twirp/a.b.Svc/ListDecisions?x=1" })).toBe(false);
  });

  it("an RPC write method, a verb-prefix look-alike, or a non-RPC body stays a write", () => {
    expect(isWriteRequest({ method: "POST", path: "/pkg.Service/CreateSimulation", contentType: "application/grpc-web+proto" })).toBe(true);
    expect(isWriteRequest({ method: "POST", path: "/pkg.Service/Getaway" })).toBe(true); // "Get" + lower-case: not a read verb
    expect(isWriteRequest({ method: "POST", path: "/pkg.Service/ListX", contentType: "application/x-www-form-urlencoded" })).toBe(true);
    expect(isWriteRequest({ method: "POST", path: "/api/GetThing" })).toBe(true); // no `pkg.Service` segment: not RPC-shaped
  });

  it("operator read patterns: a path glob or an RPC-method glob", () => {
    const classify = writeClassifier({ readRequests: ["/api/search*", "Estimate*", "QuoteService/Price*"] });
    expect(classify({ method: "POST", path: "/api/search/v2" })).toBe(false);
    expect(classify({ method: "POST", path: "/api/items" })).toBe(true);
    expect(classify({ method: "POST", path: "/pkg.Billing/EstimateCost", contentType: "application/json" })).toBe(false);
    expect(classify({ method: "POST", path: "/pkg.QuoteService/PriceBet" })).toBe(false);
    expect(classify({ method: "POST", path: "/pkg.QuoteService/AcceptQuote" })).toBe(true);
  });

  it("rpcMethodOf parses /<pkg>.<Service>/<Method>", () => {
    expect(rpcMethodOf("/simuli.workspace.WorkspaceService/ListNodeTests")).toEqual({ service: "simuli.workspace.WorkspaceService", method: "ListNodeTests" });
    expect(rpcMethodOf("/api/items/42")).toBeNull();
  });
});
