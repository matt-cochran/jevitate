import { redactUrl } from "@jevitate/ai-core";
import { LogSpecError } from "./log-lines.js";
import { clock } from "@jevitate/domain";

/**
 * Request ↔ backend-log correlation by TRACE / CORRELATION ID (#204), instead of by time window.
 *
 * The browser side (`RequestIdLedger`) records, for every request the run's page sends, the ids it
 * carries: W3C `traceparent` (its trace-id), `x-request-id`, `x-correlation-id`, `request-id`,
 * `x-amzn-trace-id` (its `Root`), `x-b3-traceid`, `x-cloud-trace-context` (its trace) — on the
 * REQUEST (a frontend with OpenTelemetry) or the RESPONSE (a server-generated request id) — plus
 * any operator-named header (`--log-correlation-header`). The log side (`lineIds`) finds those
 * ids in a backend log line: any whitespace/punctuation-delimited token equal to a recorded id
 * (exact — never a prefix or a substring of a longer token).
 *
 * `ServerLogRuntime` then attaches a line that carries a run's id to EXACTLY that request (method,
 * URL, status) and to the step that sent it — whatever time the line landed — and falls back to the
 * time window only for lines with no id. Once ids demonstrably correlate (at least one line matched
 * a run's id), a line carrying a DIFFERENT id (`foreignIds`: a `trace_id=`/`request_id=` key, a
 * `traceparent`, or an operator `--log-id-pattern`) belongs to other work — another user, a
 * background job — and is never attributed to this run.
 *
 * Ids are not secrets, but every URL is redacted and every attached line is redacted with the run's
 * secrets, as before.
 */

/** Headers whose value identifies a request across the browser and the backend (lower-case). */
export const DEFAULT_CORRELATION_HEADERS: readonly string[] = [
  "traceparent",
  "x-request-id",
  "x-correlation-id",
  "request-id",
  "x-amzn-trace-id",
  "x-b3-traceid",
  "x-cloud-trace-context",
];

/** An id shorter than this would match unrelated tokens (a "1", a "200"): never used. */
const MIN_ID_CHARS = 8;
const MAX_ID_CHARS = 128;
const ID_SHAPE = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const TRACEPARENT = /^[0-9a-f]{2}-([0-9a-f]{32})-[0-9a-f]{16}-[0-9a-f]{2}$/i;
const HEADER_NAME = /^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,64}$/;
/** Most requests the ledger keeps (the oldest are dropped past it). */
const MAX_REQUESTS = 5_000;

/** Normalizes an id for comparison (hex trace ids are case-insensitive in practice). */
const norm = (id: string): string => id.toLowerCase();

function usable(id: string): string | null {
  const v = id.trim();
  if (v.length < MIN_ID_CHARS || v.length > MAX_ID_CHARS || !ID_SHAPE.test(v)) return null;
  // An all-zero trace id is the W3C "invalid" value: it identifies nothing.
  if (/^0+$/.test(v.replace(/[-:.]/g, ""))) return null;
  return v;
}

/** The correlation id(s) a header value carries. */
export function idsFromHeader(name: string, value: string): string[] {
  const n = name.toLowerCase();
  const v = value.trim();
  let candidates: string[];
  if (n === "traceparent") {
    const m = TRACEPARENT.exec(v);
    candidates = m === null ? [] : [m[1] as string];
  } else if (n === "x-amzn-trace-id") {
    const root = /(?:^|;)\s*Root=([^;]+)/i.exec(v);
    candidates = root === null ? [] : [root[1] as string];
  } else if (n === "x-cloud-trace-context") {
    candidates = [v.split("/")[0] ?? ""];
  } else {
    candidates = v.split(",").map((s) => s.trim());
  }
  return candidates.map(usable).filter((x): x is string => x !== null);
}

/** One request the run's page sent, with the ids that identify it to the backend. */
export interface CorrelatedRequest {
  readonly method: string;
  /** Redacted URL (the shared `redactUrl` rule). */
  readonly url: string;
  /** The response status; null while (or if never) answered. */
  status: number | null;
  /** When it was sent (epoch ms). */
  readonly startedAtMs: number;
  readonly ids: string[];
}

/** The page surface the ledger listens on (Playwright's `Page`, structurally). */
export interface RequestEvents {
  on(event: "request", fn: (r: LedgerRequest) => void): unknown;
  on(event: "response", fn: (r: { request(): LedgerRequest; status(): number; headers(): Record<string, string> }) => void): unknown;
}
export interface LedgerRequest {
  url(): string;
  method(): string;
  headers(): Record<string, string>;
}

/** Validates `--log-correlation-header` names (fails closed on the first bad one). */
export function parseCorrelationHeaders(raw: readonly string[]): string[] {
  return raw.map((h) => {
    const v = h.trim().toLowerCase();
    if (!HEADER_NAME.test(v)) throw new LogSpecError(`--log-correlation-header: not a header name: ${JSON.stringify(h)}`);
    return v;
  });
}

/**
 * Parses `--log-id-pattern` values: `/regex/flags` whose first capture group (or whole match) is a
 * correlation id in a log line of the operator's own format. Bounded and compiled once.
 */
export function parseLogIdPatterns(raw: readonly string[]): RegExp[] {
  return raw.map((p) => {
    const m = /^\/(.+)\/([a-z]*)$/s.exec(p);
    if (m === null) throw new LogSpecError(`--log-id-pattern must be /regex/flags, got ${JSON.stringify(p)}`);
    if ((m[1] as string).length > 500) throw new LogSpecError("--log-id-pattern is too long (max 500 chars)");
    try {
      const flags = (m[2] as string).replace(/[gy]/g, "");
      return new RegExp(m[1] as string, `${flags}g`);
    } catch (e) {
      throw new LogSpecError(`--log-id-pattern: invalid regex ${JSON.stringify(p)}: ${e instanceof Error ? e.message : String(e)}`);
    }
  });
}

/** Records every request a run's page sends with its correlation ids (#204). */
export class RequestIdLedger {
  readonly #headers: ReadonlySet<string>;
  readonly #now: () => number;
  readonly #byRequest = new WeakMap<object, CorrelatedRequest>();
  readonly #byId = new Map<string, CorrelatedRequest>();
  readonly #requests: CorrelatedRequest[] = [];

  constructor(opts: { readonly headers?: readonly string[]; readonly now?: () => number } = {}) {
    this.#headers = new Set([...DEFAULT_CORRELATION_HEADERS, ...(opts.headers ?? []).map((h) => h.toLowerCase())]);
    this.#now = opts.now ?? clock.now;
  }

  /** Starts listening on a page (call before its first navigation). */
  observe(page: RequestEvents): void {
    page.on("request", (r) => {
      let rec: CorrelatedRequest;
      let headers: Record<string, string>;
      try {
        rec = { method: r.method().toUpperCase(), url: redactUrl(r.url()), status: null, startedAtMs: this.#now(), ids: [] };
        headers = r.headers();
      } catch {
        return; // a request whose page is already gone: nothing to correlate
      }
      this.#byRequest.set(r, rec);
      this.#requests.push(rec);
      if (this.#requests.length > MAX_REQUESTS) {
        const old = this.#requests.shift();
        for (const id of old?.ids ?? []) if (this.#byId.get(norm(id)) === old) this.#byId.delete(norm(id));
      }
      this.#addIds(rec, headers);
    });
    page.on("response", (res) => {
      try {
        const rec = this.#byRequest.get(res.request());
        if (rec === undefined) return;
        rec.status = res.status();
        this.#addIds(rec, res.headers());
      } catch {
        // a response whose page is already gone: nothing more to learn
      }
    });
  }

  #addIds(rec: CorrelatedRequest, headers: Record<string, string>): void {
    for (const [name, value] of Object.entries(headers)) {
      if (!this.#headers.has(name.toLowerCase())) continue;
      for (const id of idsFromHeader(name, value)) {
        if (rec.ids.includes(id)) continue;
        rec.ids.push(id);
        // The same id on two requests (a trace spanning several calls): the first sender owns it.
        if (!this.#byId.has(norm(id))) this.#byId.set(norm(id), rec);
      }
    }
  }

  /** How many requests carried at least one id. */
  get requestsWithIds(): number {
    return this.#requests.filter((r) => r.ids.length > 0).length;
  }

  /** The request a log line belongs to (by an id it carries), or undefined. */
  requestFor(raw: string): { readonly request: CorrelatedRequest; readonly id: string } | undefined {
    if (this.#byId.size === 0) return undefined;
    for (const token of tokens(raw)) {
      const hit = this.#byId.get(norm(token));
      if (hit !== undefined) return { request: hit, id: token };
      const tp = TRACEPARENT.exec(token);
      if (tp !== null) {
        const t = this.#byId.get(norm(tp[1] as string));
        if (t !== undefined) return { request: t, id: tp[1] as string };
      }
    }
    return undefined;
  }
}

/** The tokens of a log line an id can be (delimited by anything an id cannot contain). */
function tokens(raw: string): string[] {
  return raw.split(/[^A-Za-z0-9._:-]+/).filter((t) => t.length >= MIN_ID_CHARS && t.length <= 200);
}

/** Built-in id keys: `trace_id=…`, `"traceId": "…"`, `request-id: …`, `correlationId=…`, `x-request-id=…`. */
const KEYED_ID =
  /(?:^|[^A-Za-z0-9])(?:x-)?(?:trace|request|req|correlation|corr)[_.-]?id["']?\s*[:=]\s*["']?([A-Za-z0-9][A-Za-z0-9._:-]{7,127})/gi;
const TRACEPARENT_IN_TEXT = /\b[0-9a-f]{2}-([0-9a-f]{32})-[0-9a-f]{16}-[0-9a-f]{2}\b/gi;

/**
 * The correlation ids a log line DECLARES (#204): a keyed id (`trace_id=`, `"requestId":`, …), a
 * `traceparent`, or an operator `--log-id-pattern` match. Used to tell another request's line
 * (foreign) from one with no id at all (time-window fallback).
 */
export function declaredIds(raw: string, patterns: readonly RegExp[] = []): string[] {
  const out = new Set<string>();
  for (const re of [KEYED_ID, TRACEPARENT_IN_TEXT, ...patterns]) {
    re.lastIndex = 0;
    for (const m of raw.matchAll(re)) {
      const id = usable(m[1] ?? m[0]);
      if (id !== null) out.add(id);
    }
  }
  return [...out];
}
