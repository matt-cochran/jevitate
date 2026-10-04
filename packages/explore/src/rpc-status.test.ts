import { describe, expect, it } from "vitest";
import {
  describeStatusWithRpc,
  effectiveStatus,
  parseConnectEndStream,
  parseConnectUnaryError,
  parseGrpcWebTrailer,
  rpcHttpEquivalent,
  rpcStatusFromBody,
  rpcStatusFromHeaders,
  rpcStatusOfResponse,
  RPC_CONTENT,
} from "./rpc-status.js";

/** One length-prefixed gRPC-web / Connect frame. */
function frame(flag: number, payload: string | Uint8Array): Buffer {
  const bytes = typeof payload === "string" ? Buffer.from(payload, "utf8") : Buffer.from(payload);
  const head = Buffer.alloc(5);
  head[0] = flag;
  head.writeUInt32BE(bytes.length, 1);
  return Buffer.concat([head, bytes]);
}

const MESSAGE = frame(0x00, Uint8Array.from([0x0a, 0x03, 0x61, 0x62, 0x63]));
const trailer = (code: number, message = ""): Buffer =>
  frame(0x80, `grpc-status: ${code}\r\n${message === "" ? "" : `grpc-message: ${message}\r\n`}`);

describe("#378 gRPC-web trailer parsing", () => {
  it("binary framing: the trailer frame after the message carries the RPC's status", () => {
    expect(parseGrpcWebTrailer(Buffer.concat([MESSAGE, trailer(13, "boom")]), "application/grpc-web+proto")).toBe(13);
    expect(parseGrpcWebTrailer(Buffer.concat([MESSAGE, trailer(0)]), "application/grpc-web+proto")).toBe(0);
    // A trailers-only body (no message frame) and a mixed-case key.
    expect(parseGrpcWebTrailer(frame(0x80, "Grpc-Status:9\r\ngrpc-message:quota\r\n"), "application/grpc-web")).toBe(9);
  });

  it("text framing: base64, including several padded chunks back to back", () => {
    const whole = Buffer.concat([MESSAGE, trailer(14)]).toString("base64");
    expect(parseGrpcWebTrailer(Buffer.from(whole), "application/grpc-web-text+proto")).toBe(14);
    const chunked = MESSAGE.toString("base64") + trailer(2).toString("base64");
    expect(parseGrpcWebTrailer(Buffer.from(chunked), "application/grpc-web-text")).toBe(2);
  });

  it("no trailer frame, or a truncated one, is unknown (null) — never OK", () => {
    expect(parseGrpcWebTrailer(MESSAGE, "application/grpc-web+proto")).toBeNull();
    expect(parseGrpcWebTrailer(trailer(13).subarray(0, 8), "application/grpc-web+proto")).toBeNull();
    expect(parseGrpcWebTrailer(Buffer.alloc(0), "application/grpc-web+proto")).toBeNull();
  });

  it("a trailers-only response's grpc-status header", () => {
    expect(rpcStatusFromHeaders({ "content-type": "application/grpc-web+proto", "grpc-status": "13" })).toEqual({ protocol: "grpc-web", code: 13, name: "internal" });
    expect(rpcStatusFromHeaders({ "content-type": "application/grpc-web+proto", "grpc-status": " 0 " })).toEqual({ protocol: "grpc-web", code: 0, name: "ok" });
    expect(rpcStatusFromHeaders({ "content-type": "application/grpc-web+proto" })).toBeNull();
    expect(rpcStatusFromHeaders({ "grpc-status": "nope" })).toBeNull();
  });

  it("only RPC content types are body-read", () => {
    for (const t of ["application/grpc-web", "application/grpc-web+proto", "application/grpc-web+json", "application/grpc-web-text", "application/grpc-web-text+proto", "application/connect+proto", "application/connect+json; charset=utf-8"]) {
      expect(RPC_CONTENT.test(t), t).toBe(true);
    }
    for (const t of ["application/json", "application/proto", "text/html", "application/grpc-webby"]) expect(RPC_CONTENT.test(t), t).toBe(false);
    expect(rpcStatusFromBody(Buffer.concat([MESSAGE, trailer(13)]), "application/octet-stream")).toBeNull();
  });
});

describe("#378 Connect status parsing", () => {
  it("a Connect unary error body's code", () => {
    expect(parseConnectUnaryError(JSON.stringify({ code: "unavailable", message: "try later" }))).toBe("unavailable");
    expect(parseConnectUnaryError("{}")).toBeNull();
    expect(parseConnectUnaryError("not json")).toBeNull();
  });

  it("a Connect streaming end-of-stream frame: error code, or OK without one", () => {
    const end = (json: unknown): Buffer => Buffer.concat([frame(0x00, "{}"), frame(0x02, JSON.stringify(json))]);
    expect(parseConnectEndStream(end({ error: { code: "internal", message: "x" } }))).toBe(13);
    expect(parseConnectEndStream(end({ metadata: {} }))).toBe(0);
    expect(parseConnectEndStream(end({ error: {} }))).toBe(2);
    expect(parseConnectEndStream(frame(0x00, "{}"))).toBeNull();
    expect(rpcStatusFromBody(end({ error: { code: "failed_precondition" } }), "application/connect+json")).toEqual({ protocol: "connect", code: 9, name: "failed_precondition" });
  });
});

describe("#378 effective status", () => {
  it("an OK RPC keeps its HTTP status; a failed one maps to its HTTP equivalent", () => {
    expect(effectiveStatus({ status: 200 })).toBe(200);
    expect(effectiveStatus({ status: 200, rpcStatus: { protocol: "grpc-web", code: 0, name: "ok" } })).toBe(200);
    expect(effectiveStatus({ status: 200, rpcStatus: { protocol: "grpc-web", code: 13, name: "internal" } })).toBe(500);
    expect(effectiveStatus({ status: 200, rpcStatus: { protocol: "grpc-web", code: 9, name: "failed_precondition" } })).toBe(400);
    expect(effectiveStatus({ status: 200, rpcStatus: { protocol: "grpc-web", code: 14, name: "unavailable" } })).toBe(503);
    // A non-2xx HTTP status is already the failure: it is kept.
    expect(effectiveStatus({ status: 401, rpcStatus: { protocol: "grpc-web", code: 16, name: "unauthenticated" } })).toBe(401);
    expect(effectiveStatus({ status: null })).toBeNull();
    expect(rpcHttpEquivalent(99)).toBe(500);
    expect(describeStatusWithRpc({ status: 200, rpcStatus: { protocol: "grpc-web", code: 13, name: "internal" } })).toBe("200 (grpc-status 13 internal)");
    expect(describeStatusWithRpc({ status: 200, rpcStatus: { protocol: "grpc-web", code: 0, name: "ok" } })).toBe("200");
  });

  it("reads a response once: the header first, the body only for an RPC content type", async () => {
    let reads = 0;
    const res = (headers: Record<string, string>, body: Buffer) => ({
      headers: () => headers,
      body: async () => {
        reads += 1;
        return body;
      },
    });
    const failed = res({ "content-type": "application/grpc-web+proto" }, Buffer.concat([MESSAGE, trailer(13)]));
    expect(await rpcStatusOfResponse(failed)).toEqual({ protocol: "grpc-web", code: 13, name: "internal" });
    expect(await rpcStatusOfResponse(failed)).toEqual({ protocol: "grpc-web", code: 13, name: "internal" });
    expect(reads).toBe(1);
    expect(await rpcStatusOfResponse(res({ "content-type": "application/grpc-web+proto", "grpc-status": "7" }, Buffer.alloc(0)))).toMatchObject({ code: 7 });
    expect(await rpcStatusOfResponse(res({ "content-type": "application/json" }, Buffer.from("{}")))).toBeNull();
    expect(await rpcStatusOfResponse(res({ "content-type": "application/grpc-web+proto", "content-length": String(64 * 1024 * 1024) }, Buffer.alloc(0)))).toBeNull();
    expect(reads).toBe(1);
    const unreadable = { headers: () => ({ "content-type": "application/grpc-web+proto" }), body: () => Promise.reject(new Error("gone")) };
    expect(await rpcStatusOfResponse(unreadable)).toBeNull();
  });
});
