import { contentHash } from "@jevitate/domain";
import { isNon5xxResourceConsoleError, type DefectSignal } from "./defect-oracle.js";

/**
 * Stable defect identity. A defect is keyed by WHAT broke and WHERE, never by when or by the
 * incidental parts of a message (ids, timestamps, counts, quoted values), so the same bug seen
 * on step 2 and on step 40 — or in two different runs — has ONE fingerprint:
 *
 *  - HTTP 5xx:       kind + endpoint pattern + exact status
 *  - failed request: kind + endpoint pattern + error class
 *  - console/page:   kind + page route pattern + message class
 *  - invariant:      kind + page route pattern + declared invariant id (else reason class)
 *
 * Pure: the same inputs always produce the same fingerprint. Used both when a defect is found and
 * when `verifyFix` replays it, so "still reproduces" means "the SAME fingerprint fired again".
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NUMERIC = /^\d+$/;
const HEXISH = /^[0-9a-f]{12,}$/i;
/** A long opaque token that mixes letters and digits (e.g. an object id or a hash). */
const OPAQUE = /^(?=.*\d)(?=.*[a-z])[a-z0-9_-]{16,}$/i;
/** A literal prefix (kept) followed by `-` and a UUID suffix — `candidate-<uuid>` → `candidate-:id`
 *  (#95). Checked before `PREFIXED_ID_SUFFIX` so a uuid's own internal dashes never split wrong. */
const PREFIXED_UUID = /^(.+-)([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;
/** A literal prefix (kept) followed by `-` and a short numeric/hex id — `item-42` → `item-:id`; below
 *  `OPAQUE`'s 16-char floor, so this is what catches the SHORT prefixed ids that floor misses. */
const PREFIXED_ID_SUFFIX = /^(.+-)([0-9]+|[0-9a-f-]{8,})$/i;

/** One path segment → `:id` when it is an identifier rather than a route word; `prefix-<id>` → `prefix-:id`
 *  so a resource id with a literal prefix collapses to ONE route without losing the prefix (#95:
 *  `/decisions/candidate-<uuid-a>` and `/decisions/candidate-<uuid-b>` both normalize identically). */
function normalizeSegment(seg: string): string {
  if (seg === "") return seg;
  if (NUMERIC.test(seg) || UUID.test(seg) || HEXISH.test(seg) || OPAQUE.test(seg)) return ":id";
  const uuidSuffix = PREFIXED_UUID.exec(seg);
  if (uuidSuffix) return `${uuidSuffix[1]}:id`;
  const idSuffix = PREFIXED_ID_SUFFIX.exec(seg);
  if (idSuffix) return `${idSuffix[1]}:id`;
  return seg;
}

/**
 * The route/endpoint PATTERN of a URL: its path with identifier segments replaced by `:id`, the
 * query and fragment dropped, and a trailing slash removed. Host is dropped on purpose so the same
 * route compares across environments (local/staging) and runs. A non-URL input is treated as a path.
 */
export function normalizeRoute(raw: string): string {
  let path: string;
  try {
    path = new URL(raw).pathname;
  } catch {
    path = raw.split(/[?#]/)[0] ?? raw;
  }
  const segments = path.split("/").map(normalizeSegment);
  const joined = segments.join("/").replace(/\/+$/, "");
  return joined === "" ? "/" : joined.startsWith("/") ? joined : `/${joined}`;
}

/**
 * The CLASS of a free-text message: URLs, numbers, hex ids and quoted values are replaced by
 * placeholders and whitespace collapsed, so two occurrences of one bug that differ only in an id,
 * a count or a timestamp share a class.
 */
export function messageClass(text: string): string {
  return text
    .replace(/https?:\/\/\S+/g, "<url>")
    .replace(/"[^"]*"|'[^']*'|`[^`]*`/g, "<s>")
    .replace(/\b[0-9a-f]{8,}\b/gi, "<id>")
    .replace(/\d+(\.\d+)?/g, "<n>")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 160);
}

/** The fingerprint key parts (before hashing) — exposed so a report can show WHY two match. */
export function signalKey(signal: DefectSignal): string {
  switch (signal.kind) {
    case "http-5xx":
      return `http-5xx|${normalizeRoute(signal.url)}|${signal.status}`;
    case "failed-request":
      return `failed-request|${normalizeRoute(signal.url)}|${messageClass(signal.detail)}`;
    case "console-error":
    case "page-error":
      return `${signal.kind}|${normalizeRoute(signal.pageUrl ?? "")}|${messageClass(signal.detail)}`;
  }
}

function hashKey(key: string): string {
  return contentHash(key).slice(0, 16);
}

/** A signal's stable fingerprint (16 hex chars). */
export function signalFingerprint(signal: DefectSignal): string {
  return hashKey(signalKey(signal));
}

/**
 * An invariant violation's fingerprint. A DECLARED invariant (#86) is keyed by its id + route —
 * its reason carries the observed values, which differ between occurrences of the same bug. A
 * code-level invariant without an id keeps the original key: route + reason class.
 */
export function invariantFingerprint(pageUrl: string, reason: string, id?: string): string {
  if (id !== undefined) return hashKey(`invariant|${normalizeRoute(pageUrl)}|id:${id}`);
  return hashKey(`invariant|${normalizeRoute(pageUrl)}|${messageClass(reason)}`);
}

/**
 * Chromium's own console echo of a failed resource load (`Failed to load resource: the server
 * responded with a status of 500 …`) restates an HTTP signal the response listener already
 * captured with its URL. It is kept as evidence but never becomes a defect of its own.
 */
export function isResourceLoadEcho(signal: DefectSignal): boolean {
  return (
    signal.kind === "console-error" &&
    /Failed to load resource: the server responded with a status of \d{3}/i.test(signal.detail) &&
    !isNon5xxResourceConsoleError(signal.detail)
  );
}

const PRIORITY: Readonly<Record<DefectSignal["kind"], number>> = {
  "page-error": 0,
  "http-5xx": 1,
  "failed-request": 2,
  "console-error": 3,
};

/** One step's hard signals as ONE defect: its primary signal plus every signal's fingerprint. */
export interface SignalGroup {
  readonly primary: DefectSignal;
  /** The primary's fingerprint — the defect's identity. */
  readonly fingerprint: string;
  /** Every distinct signal fingerprint in the group (the primary's included), for dedup + verify. */
  readonly related: string[];
}

/**
 * Groups the hard signals ONE step produced into one defect. A single broken call typically fires
 * a cascade (the 500, Chromium's console echo of it, the app's own "request failed" logs); filing
 * each as its own defect would turn one bug into many. The primary is the most specific signal — an
 * uncaught page error, then a server error, a network failure, a console error; a resource-load
 * echo is evidence only. Returns null for no signals.
 */
export function groupStepSignals(signals: readonly DefectSignal[]): SignalGroup | null {
  if (signals.length === 0) return null;
  const nonEcho = signals.filter((s) => !isResourceLoadEcho(s));
  const pool = nonEcho.length > 0 ? nonEcho : signals;
  const primary = [...pool].sort((a, b) => PRIORITY[a.kind] - PRIORITY[b.kind])[0];
  if (primary === undefined) return null;
  const related = [...new Set(signals.map(signalFingerprint))];
  return { primary, fingerprint: signalFingerprint(primary), related };
}

/**
 * A short human title for an ADVISORY console-error (#88): a console error correlated with a
 * captured 4xx response — reported for visibility, but never a defect title (never `defectTitle`).
 */
export function advisoryTitle(signal: Extract<DefectSignal, { kind: "console-error" }>, status: number): string {
  return `Console error on ${normalizeRoute(signal.pageUrl ?? "")} (advisory — correlated with HTTP ${status}): ${messageClass(signal.detail).slice(0, 80)}`;
}

/** A short human title for a defect's primary signal. */
export function defectTitle(signal: DefectSignal): string {
  switch (signal.kind) {
    case "http-5xx":
      return `HTTP ${signal.status} from ${normalizeRoute(signal.url)}`;
    case "failed-request":
      return `Request failed: ${normalizeRoute(signal.url)} (${messageClass(signal.detail)})`;
    case "console-error":
      return `Console error on ${normalizeRoute(signal.pageUrl ?? "")}: ${messageClass(signal.detail).slice(0, 80)}`;
    case "page-error":
      return `Uncaught page error on ${normalizeRoute(signal.pageUrl ?? "")}: ${messageClass(signal.detail).slice(0, 80)}`;
  }
}
