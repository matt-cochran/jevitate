// Recording, redaction, MockServer expectation building, the secret scan and the drift probe for the
// #802 mock-harness lab. Pure functions over recorded exchanges plus a recording proxy.
import { createServer, request as httpRequest } from "node:http";
import { appendFileSync } from "node:fs";
import { decode, encode, parseBody, responseBody } from "./proto.js";

/** The response message type of each TriageService method. */
export const RESPONSE_TYPES = { ListClusters: "ListClustersResponse", GetCluster: "GetClusterResponse", FileIssue: "FileIssueResponse" };
export const REQUEST_TYPES = { ListClusters: "ListClustersRequest", GetCluster: "GetClusterRequest", FileIssue: "FileIssueRequest" };
const RPC = /^\/journeeze\.v1\.TriageService\/(\w+)$/;

/**
 * A recording proxy: forwards every request to `upstream` and appends one JSON line per exchange
 * (method, path, request headers and body, status, response headers and body as base64) to `logFile`.
 * The log holds the run's real session cookie and CSRF token: it stays in the lab's work dir and is
 * never committed; only `redact()`ed expectations are.
 */
export function startRecordingProxy({ port, upstream, logFile }) {
  const target = new URL(upstream);
  const server = createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const body = Buffer.concat(chunks);
      const headers = { ...req.headers, host: target.host };
      const up = httpRequest({ host: target.hostname, port: target.port, method: req.method, path: req.url, headers }, (upRes) => {
        const out = [];
        upRes.on("data", (c) => out.push(c));
        upRes.on("end", () => {
          const resBody = Buffer.concat(out);
          appendFileSync(
            logFile,
            JSON.stringify({
              method: req.method,
              path: (req.url ?? "/").split("?")[0],
              requestHeaders: req.headers,
              requestBody: body.toString("base64"),
              status: upRes.statusCode,
              responseHeaders: upRes.headers,
              responseBody: resBody.toString("base64"),
            }) + "\n",
          );
          res.writeHead(upRes.statusCode ?? 502, upRes.headers).end(resBody);
        });
      });
      up.on("error", () => res.writeHead(502).end());
      up.end(body);
    });
  });
  return new Promise((resolve) => server.listen(port, "127.0.0.1", () => resolve(server)));
}

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const KEEP_RESPONSE_HEADERS = ["content-type", "cache-control", "access-control-expose-headers"];

function redactStrings(value, emails) {
  if (typeof value === "string") {
    return value.replace(EMAIL, (e) => {
      if (e.endsWith("@example.invalid")) return e;
      if (!emails.has(e)) emails.set(e, `reporter-${emails.size + 1}@example.invalid`);
      return emails.get(e);
    });
  }
  if (Array.isArray(value)) return value.map((v) => redactStrings(v, emails));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redactStrings(v, emails)]));
  return value;
}

/**
 * Redacts one recorded exchange: request headers dropped (the expectation matches method, path and
 * body only), `set-cookie` replaced by a synthetic session, the CSRF meta tag replaced, and every
 * e-mail address in an HTML or gRPC-Web body replaced by a stable synthetic one. gRPC-Web payloads
 * are decoded with the service schema, redacted field by field and re-encoded, so the mock serves
 * valid protobuf.
 */
export function redactExchange(x, emails) {
  const rpc = RPC.exec(x.path);
  const headers = {};
  for (const h of KEEP_RESPONSE_HEADERS) if (x.responseHeaders[h] !== undefined) headers[h] = [String(x.responseHeaders[h])];
  if (x.responseHeaders["set-cookie"] !== undefined) headers["set-cookie"] = ["jz_session=REDACTED_SYNTHETIC_SESSION; Path=/; HttpOnly; SameSite=Lax"];
  let body = Buffer.from(x.responseBody, "base64");
  if (rpc && RESPONSE_TYPES[rpc[1]]) {
    const parsed = parseBody(new Uint8Array(body));
    const msg = parsed.status === 0 ? redactStrings(decode(RESPONSE_TYPES[rpc[1]], parsed.data), emails) : undefined;
    body = Buffer.from(parsed.status === 0 ? responseBody(encode(RESPONSE_TYPES[rpc[1]], msg)) : responseBody(new Uint8Array(0), parsed.status, redactStrings(parsed.message, emails)));
  } else if (/text\/html/.test(String(x.responseHeaders["content-type"] ?? ""))) {
    const html = body.toString("utf8").replace(/(<meta name="csrf-token" content=")[^"]*(")/, "$1REDACTED_SYNTHETIC_CSRF$2");
    body = Buffer.from(redactStrings(html, emails), "utf8");
  }
  return { method: x.method, path: x.path, requestBody: x.method === "GET" ? undefined : x.requestBody, status: x.status, headers, body: body.toString("base64") };
}

/**
 * MockServer expectations from redacted exchanges, in recorded order. Identical requests whose
 * responses differ over the run (GetCluster before and after the issue is filed) become a sequence:
 * every response but the last answers `remainingTimes: 1`, the last answers forever. Consecutive
 * identical responses collapse into one with a count. This is the whole of the mock's "state".
 */
export function toExpectations(redacted) {
  const groups = new Map();
  for (const x of redacted) {
    const key = `${x.method} ${x.path} ${x.requestBody ?? ""}`;
    if (!groups.has(key)) groups.set(key, []);
    const seq = groups.get(key);
    const last = seq[seq.length - 1];
    if (last && last.body === x.body && last.status === x.status) last.count++;
    else seq.push({ ...x, count: 1 });
  }
  const out = [];
  for (const seq of groups.values()) {
    seq.forEach((x, i) => {
      const final = i === seq.length - 1;
      out.push({
        httpRequest: {
          method: x.method,
          path: x.path,
          ...(x.requestBody === undefined ? {} : { body: { type: "BINARY", base64Bytes: x.requestBody } }),
        },
        httpResponse: { statusCode: x.status, headers: x.headers, body: { type: "BINARY", base64Bytes: x.body } },
        times: final ? { unlimited: true } : { remainingTimes: x.count },
      });
    });
  }
  return out;
}

/** Every text the scanner reads in one expectation: paths, headers, raw body, and decoded gRPC fields. */
export function scanTexts(item) {
  const texts = [];
  const push = (where, s) => texts.push({ where, text: s });
  const path = item.httpRequest?.path ?? item.path ?? "";
  push("path", path);
  const bodies = [];
  if (item.httpRequest) {
    push("response.headers", JSON.stringify(item.httpResponse.headers ?? {}));
    if (item.httpRequest.body) bodies.push(["request.body", item.httpRequest.body.base64Bytes, "req"]);
    bodies.push(["response.body", item.httpResponse.body.base64Bytes, "res"]);
  } else {
    push("request.headers", JSON.stringify(item.requestHeaders ?? {}));
    push("response.headers", JSON.stringify(item.responseHeaders ?? {}));
    if (item.requestBody) bodies.push(["request.body", item.requestBody, "req"]);
    bodies.push(["response.body", item.responseBody, "res"]);
  }
  const rpc = RPC.exec(path);
  for (const [where, b64, dir] of bodies) {
    const buf = Buffer.from(b64, "base64");
    push(where, buf.toString("latin1"));
    if (rpc && (dir === "res" ? RESPONSE_TYPES[rpc[1]] : REQUEST_TYPES[rpc[1]])) {
      try {
        const parsed = parseBody(new Uint8Array(buf));
        const type = dir === "res" ? RESPONSE_TYPES[rpc[1]] : REQUEST_TYPES[rpc[1]];
        push(`${where} (decoded protobuf)`, JSON.stringify(decode(type, parsed.data)) + " " + parsed.message);
      } catch {
        push(`${where} (undecodable)`, "");
      }
    }
  }
  return texts;
}

/** Secret patterns: generic ones, plus the exact values the recorded run's server issued. */
export function secretRules(knownSecrets) {
  const rules = [
    { id: "lab-session-cookie", re: /jzs_[0-9a-f]{40}/g },
    { id: "bearer-token", re: /\bBearer\s+[A-Za-z0-9._~+/-]{16,}/gi },
    { id: "jwt", re: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g },
    { id: "github-token", re: /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,})/g },
    { id: "aws-access-key", re: /\bAKIA[0-9A-Z]{16}\b/g },
    { id: "private-key", re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/g },
    { id: "long-hex-secret", re: /\b[0-9a-f]{40,}\b/g },
    { id: "email-not-synthetic", re: /[A-Za-z0-9._%+-]+@(?!example\.invalid\b)[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g },
  ];
  for (const [i, v] of knownSecrets.entries()) rules.push({ id: `exact-issued-secret-${i + 1}`, literal: v });
  return rules;
}

/** Scans items; returns findings with the rule id and location, never the matched value. */
export function scan(items, rules) {
  const findings = [];
  items.forEach((item, idx) => {
    for (const { where, text } of scanTexts(item)) {
      for (const r of rules) {
        const n = r.literal !== undefined ? text.split(r.literal).length - 1 : [...text.matchAll(r.re)].length;
        if (n > 0) findings.push({ item: idx, where, rule: r.id, count: n });
      }
    }
  });
  return findings;
}

/** The decoded, comparable view of a gRPC-Web or HTML response, for the drift probe. */
export function responseView(path, status, b64) {
  const rpc = RPC.exec(path);
  const buf = Buffer.from(b64, "base64");
  if (rpc && RESPONSE_TYPES[rpc[1]]) {
    const p = parseBody(new Uint8Array(buf));
    return { http: status, grpcStatus: p.status, grpcMessage: p.message, message: p.status === 0 ? decode(RESPONSE_TYPES[rpc[1]], p.data) : null };
  }
  return { http: status, bytes: buf.length };
}

/** Field paths whose values differ between two views (recursively). */
export function diffFields(a, b, prefix = "") {
  if (typeof a !== "object" || a === null || typeof b !== "object" || b === null) return JSON.stringify(a) === JSON.stringify(b) ? [] : [prefix || "."];
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  return [...keys].flatMap((k) => diffFields(a[k], b[k], prefix ? `${prefix}.${k}` : k));
}
