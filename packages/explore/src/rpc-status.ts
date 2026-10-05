/**
 * #378: the EFFECTIVE status of a gRPC-web / Connect call. gRPC-web answers HTTP 200 for an RPC
 * that failed: the real result is `grpc-status` — a response header for a trailers-only response, or
 * the trailer frame at the end of the body (a length-prefixed frame with flag 0x80 whose payload is
 * `grpc-status: N\r\ngrpc-message: …\r\n`; base64 for `application/grpc-web-text`). Connect
 * streaming ends with an end-of-stream frame (flag 0x02) carrying `{"error":{"code":…}}`; a Connect
 * unary error already has a non-2xx HTTP status (+ a JSON `{code, message}` body).
 *
 * Bounded by design: a body is only read for an RPC content type (`RPC_CONTENT`), only the status
 * CODE is kept (never `grpc-message`, never any body byte), and nothing here logs or persists it.
 */

/** Response content types whose body may carry the RPC's status (gRPC-web, Connect streaming). */
export const RPC_CONTENT = /^\s*application\/(?:grpc-web(?:-text)?(?:\+[\w.-]+)?|connect\+[\w.-]+)\s*(?:;|$)/i;

/** The gRPC status code names (index = code), as Connect spells them. */
export const GRPC_CODE_NAMES: readonly string[] = [
  "ok",
  "canceled",
  "unknown",
  "invalid_argument",
  "deadline_exceeded",
  "not_found",
  "already_exists",
  "permission_denied",
  "resource_exhausted",
  "failed_precondition",
  "aborted",
  "out_of_range",
  "unimplemented",
  "internal",
  "unavailable",
  "data_loss",
  "unauthenticated",
];

/** The standard gRPC → HTTP status mapping (index = code); what the status checks judge. */
const HTTP_EQUIVALENT: readonly number[] = [200, 499, 500, 400, 504, 404, 409, 403, 429, 400, 409, 400, 501, 500, 503, 500, 401];

/** Bodies larger than this are not read for a trailer (the status is then the header's, or unknown). */
export const MAX_RPC_BODY_BYTES = 8 * 1024 * 1024;

/** An RPC's own result, next to its HTTP status. `code` is the gRPC status code (0 = OK). */
export interface RpcStatus {
  readonly protocol: "grpc-web" | "connect";
  readonly code: number;
  /** The code's name (`ok`, `internal`, `failed_precondition`, …). */
  readonly name: string;
}

function statusOf(protocol: RpcStatus["protocol"], code: number): RpcStatus | null {
  if (!Number.isInteger(code) || code < 0) return null;
  return { protocol, code, name: GRPC_CODE_NAMES[code] ?? `code_${code}` };
}

/** The HTTP status an RPC result corresponds to (gRPC 0 → 200, 13 → 500, 9 → 400, …; unknown → 500). */
export function rpcHttpEquivalent(code: number): number {
  return HTTP_EQUIVALENT[code] ?? 500;
}

/**
 * A request's effective status: its HTTP status, unless the RPC it carried failed — then the HTTP
 * equivalent of the RPC's code (an HTTP 200 with grpc-status 13 is a 500). Null without a response.
 */
export function effectiveStatus(r: { readonly status: number | null; readonly rpcStatus?: RpcStatus }): number | null {
  if (r.status === null) return null;
  if (r.rpcStatus === undefined || r.rpcStatus.code === 0) return r.status;
  return r.status >= 200 && r.status < 300 ? rpcHttpEquivalent(r.rpcStatus.code) : r.status;
}

/** `200 (grpc-status 13 internal)` — the HTTP status plus a failed RPC's code, for evidence. */
export function describeStatusWithRpc(r: { readonly status: number | null; readonly rpcStatus?: RpcStatus }): string {
  if (r.status === null) return "no response";
  if (r.rpcStatus === undefined || r.rpcStatus.code === 0) return String(r.status);
  return `${r.status} (grpc-status ${r.rpcStatus.code} ${r.rpcStatus.name})`;
}

function protocolOf(contentType: string): RpcStatus["protocol"] | null {
  if (!RPC_CONTENT.test(contentType)) return null;
  return /connect\+/i.test(contentType) ? "connect" : "grpc-web";
}

/** A trailers-only response's `grpc-status` header (any content type that carries one). */
export function rpcStatusFromHeaders(headers: Readonly<Record<string, string>>, contentType = headers["content-type"] ?? ""): RpcStatus | null {
  const raw = headers["grpc-status"];
  if (raw === undefined || !/^\s*\d+\s*$/.test(raw)) return null;
  return statusOf(/connect\+/i.test(contentType) ? "connect" : "grpc-web", Number(raw.trim()));
}

/** `application/grpc-web-text` bodies are base64 — possibly several padded chunks back to back. */
function decodeGrpcWebText(body: Uint8Array): Uint8Array {
  const text = Buffer.from(body.buffer, body.byteOffset, body.byteLength).toString("latin1").replace(/\s+/g, "");
  const chunks = text.match(/[^=]+={0,2}|={1,2}/g) ?? [];
  return Buffer.concat(chunks.map((c) => Buffer.from(c, "base64")));
}

/** Walks the length-prefixed frames; returns the payload of the last one whose flag has `bit`. */
function lastFrameWith(bytes: Uint8Array, bit: number): Uint8Array | null {
  let found: Uint8Array | null = null;
  let at = 0;
  while (at + 5 <= bytes.length) {
    const flag = bytes[at] ?? 0;
    const len = (((bytes[at + 1] ?? 0) << 24) >>> 0) + ((bytes[at + 2] ?? 0) << 16) + ((bytes[at + 3] ?? 0) << 8) + (bytes[at + 4] ?? 0);
    const end = at + 5 + len;
    if (end > bytes.length) break;
    if ((flag & bit) !== 0) found = bytes.subarray(at + 5, end);
    at = end;
  }
  return found;
}

/** The gRPC status code in a gRPC-web body's trailer frame (binary or `-text`), or null when absent. */
export function parseGrpcWebTrailer(body: Uint8Array, contentType: string): number | null {
  const bytes = /grpc-web-text/i.test(contentType) ? decodeGrpcWebText(body) : body;
  const trailer = lastFrameWith(bytes, 0x80);
  if (trailer === null) return null;
  for (const line of Buffer.from(trailer.buffer, trailer.byteOffset, trailer.byteLength).toString("latin1").split(/\r?\n/)) {
    const m = /^\s*grpc-status\s*:\s*(\d+)\s*$/i.exec(line);
    if (m !== null) return Number(m[1]);
  }
  return null;
}

/** The Connect code NAME in a Connect unary error body (`{"code":"internal","message":…}`), or null. */
export function parseConnectUnaryError(body: string): string | null {
  try {
    const parsed: unknown = JSON.parse(body);
    const code = parsed !== null && typeof parsed === "object" && "code" in parsed ? (parsed as { code: unknown }).code : null;
    return typeof code === "string" && /^[a-z_]+$/.test(code) ? code : null;
  } catch {
    return null;
  }
}

/**
 * The gRPC code of a Connect streaming body's end-of-stream frame (flag 0x02): its `error.code`, or
 * 0 when it ends without an error. Null without a (readable, uncompressed) end-of-stream frame.
 */
export function parseConnectEndStream(body: Uint8Array): number | null {
  const end = lastFrameWith(body, 0x02);
  if (end === null) return null;
  try {
    const parsed: unknown = JSON.parse(Buffer.from(end.buffer, end.byteOffset, end.byteLength).toString("utf8"));
    if (parsed === null || typeof parsed !== "object") return null;
    const error = (parsed as { error?: unknown }).error;
    if (error === undefined || error === null) return 0;
    const name = typeof error === "object" ? (error as { code?: unknown }).code : undefined;
    if (typeof name !== "string") return 2; // an error without a code is `unknown`
    const code = GRPC_CODE_NAMES.indexOf(name);
    return code <= 0 ? 2 : code;
  } catch {
    return null;
  }
}

/** The RPC status a response BODY carries (a gRPC-web trailer or a Connect end-of-stream frame). */
export function rpcStatusFromBody(body: Uint8Array, contentType: string): RpcStatus | null {
  const protocol = protocolOf(contentType);
  if (protocol === null) return null;
  const code = protocol === "connect" ? parseConnectEndStream(body) : parseGrpcWebTrailer(body, contentType);
  return code === null ? null : statusOf(protocol, code);
}

/** What `rpcStatusOfResponse` needs of a Playwright `Response`. */
export interface RpcResponseLike {
  headers(): Record<string, string>;
  body(): Promise<Buffer>;
}

const reads = new WeakMap<object, Promise<RpcStatus | null>>();

/**
 * A response's RPC status: the `grpc-status` header (trailers-only), else — for an RPC content type
 * only, and a body within `MAX_RPC_BODY_BYTES` — the body's trailer / end-of-stream frame. Null for
 * anything else or when it cannot be read. One read per response, shared by every caller; never throws.
 */
export function rpcStatusOfResponse(response: RpcResponseLike): Promise<RpcStatus | null> {
  const known = reads.get(response);
  if (known !== undefined) return known;
  const read = (async (): Promise<RpcStatus | null> => {
    const headers = response.headers();
    const contentType = headers["content-type"] ?? "";
    const fromHeader = rpcStatusFromHeaders(headers, contentType);
    if (fromHeader !== null) return fromHeader;
    if (protocolOf(contentType) === null) return null;
    const declared = Number(headers["content-length"] ?? "0");
    if (Number.isFinite(declared) && declared > MAX_RPC_BODY_BYTES) return null;
    const body = await response.body();
    return body.length > MAX_RPC_BODY_BYTES ? null : rpcStatusFromBody(body, contentType);
  })().catch(() => null);
  reads.set(response, read);
  return read;
}
