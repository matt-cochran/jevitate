import { messageClass, normalizeRoute } from "@jevitate/explore";
import { contentHash } from "@jevitate/domain";

/**
 * Backend log line parsing, normalization and fingerprinting (#142). Pure and mechanical — never
 * `eval`ed, never a model call. A parsed line is ONE of the run's evidence sources: it is
 * correlated to the step it landed during (`log-correlation.ts`) and, with `--log-defect`,
 * optionally promoted to a `server-log` defect.
 */

export type LogLevel = "error" | "warn" | "info" | "debug" | "unknown";

const LEVEL_RANK: Readonly<Record<LogLevel, number>> = { unknown: 0, debug: 1, info: 2, warn: 3, error: 4 };

/** True when `a` is at least as severe as `b`. `unknown` is never >= a NAMED level (fail closed). */
export function levelAtLeast(a: LogLevel, b: LogLevel): boolean {
  if (b === "unknown") return true;
  if (a === "unknown") return false;
  return LEVEL_RANK[a] >= LEVEL_RANK[b];
}

function normalizeLevelName(raw: string): LogLevel {
  const v = raw.trim().toLowerCase();
  if (v === "error" || v === "err" || v === "fatal" || v === "critical" || v === "crit") return "error";
  if (v === "warn" || v === "warning") return "warn";
  if (v === "info" || v === "notice") return "info";
  if (v === "debug" || v === "trace" || v === "verbose") return "debug";
  return "unknown";
}

/** A parsed backend log line. `raw`/`message` are UNREDACTED — callers redact before persisting. */
export interface LogLine {
  readonly level: LogLevel;
  /** The human message: a JSON/logfmt log's `message`/`msg`/`error` field, else the whole line. */
  readonly message: string;
  /** The raw line exactly as read. */
  readonly raw: string;
  /** The line's own timestamp (ms since epoch) when one parsed; else the arrival time. */
  readonly epochMs: number;
  /** True when `epochMs` came from the line itself, not from arrival order. */
  readonly ownTimestamp: boolean;
  /** The `--log-source` spec this line came from (its raw form, e.g. `file:/var/log/app.log`). */
  readonly source: string;
}

const ISO_TS_SRC = String.raw`\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?`;
const ISO_TS = new RegExp(ISO_TS_SRC);

/** Seconds vs ms heuristic: a value under 10^10 is (almost) certainly seconds — ms would be before
 *  2001-09-09, never a real log line's own timestamp — so it is scaled up. */
function parseTimeValue(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v < 10_000_000_000 ? v * 1000 : v;
  if (typeof v === "string") {
    const t = Date.parse(v);
    return Number.isNaN(t) ? null : t;
  }
  return null;
}

function firstDefined(obj: Readonly<Record<string, unknown>>, keys: readonly string[]): unknown {
  for (const k of keys) if (obj[k] !== undefined) return obj[k];
  return undefined;
}

const LEVEL_KEYS = ["level", "severity", "loglevel", "log_level"];
const TIME_KEYS = ["time", "timestamp", "ts", "@timestamp"];
const MESSAGE_KEYS = ["message", "msg", "error", "err"];

function parseJsonLine(trimmed: string, source: string, arrivalEpochMs: number): LogLine | null {
  let obj: unknown;
  try {
    obj = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (obj === null || typeof obj !== "object" || Array.isArray(obj)) return null;
  const rec = obj as Record<string, unknown>;
  const levelRaw = firstDefined(rec, LEVEL_KEYS);
  const level = typeof levelRaw === "string" || typeof levelRaw === "number" ? normalizeLevelName(String(levelRaw)) : "unknown";
  const parsedTime = parseTimeValue(firstDefined(rec, TIME_KEYS));
  const msgRaw = firstDefined(rec, MESSAGE_KEYS);
  return {
    level,
    message: typeof msgRaw === "string" ? msgRaw : trimmed,
    raw: trimmed,
    epochMs: parsedTime ?? arrivalEpochMs,
    ownTimestamp: parsedTime !== null,
    source,
  };
}

/** `key=value key2="quoted value" level=error` — a bare word with no `=` is not a pair. */
const LOGFMT_PAIR = /([a-zA-Z_][\w.-]*)=("(?:[^"\\]|\\.)*"|\S+)/g;

function parseLogfmtLine(trimmed: string, source: string, arrivalEpochMs: number): LogLine | null {
  const pairs: Record<string, string> = {};
  let matched = 0;
  for (const m of trimmed.matchAll(LOGFMT_PAIR)) {
    matched += 1;
    const key = (m[1] ?? "").toLowerCase();
    let value = m[2] ?? "";
    if (value.startsWith('"') && value.endsWith('"')) {
      try {
        value = JSON.parse(value) as string;
      } catch {
        value = value.slice(1, -1);
      }
    }
    pairs[key] = value;
  }
  // Require at least two pairs AND a level or message key — a stray "a=b" inside free text is not logfmt.
  if (matched < 2 || (pairs.level === undefined && pairs.severity === undefined && pairs.msg === undefined && pairs.message === undefined)) {
    return null;
  }
  const levelRaw = firstDefined(pairs, LEVEL_KEYS);
  const level = typeof levelRaw === "string" ? normalizeLevelName(levelRaw) : "unknown";
  const parsedTime = parseTimeValue(firstDefined(pairs, TIME_KEYS));
  const msgRaw = firstDefined(pairs, MESSAGE_KEYS);
  return {
    level,
    message: typeof msgRaw === "string" ? msgRaw : trimmed,
    raw: trimmed,
    epochMs: parsedTime ?? arrivalEpochMs,
    ownTimestamp: parsedTime !== null,
    source,
  };
}

const BRACKETED_LEVEL = /\[(ERROR|ERR|FATAL|CRITICAL|CRIT|WARN(?:ING)?|INFO|NOTICE|DEBUG|TRACE)\]/i;
const BARE_LEVEL = /\b(ERROR|FATAL|WARN(?:ING)?|INFO|DEBUG|TRACE)\b:?/;

function parseBracketedLine(trimmed: string, source: string, arrivalEpochMs: number): LogLine {
  const tsMatch = ISO_TS.exec(trimmed);
  const parsedTime = tsMatch === null ? null : parseTimeValue(tsMatch[0]);
  const levelMatch = BRACKETED_LEVEL.exec(trimmed) ?? BARE_LEVEL.exec(trimmed);
  const level = levelMatch === null ? "unknown" : normalizeLevelName(levelMatch[1] ?? levelMatch[0]);
  return { level, message: trimmed, raw: trimmed, epochMs: parsedTime ?? arrivalEpochMs, ownTimestamp: parsedTime !== null, source };
}

/**
 * Parses one raw log line: JSON (`level`/`severity` + `time`/`timestamp`/`ts`), then logfmt
 * (`level=error msg="…" time=…`), then a bracketed/bare level with an optional leading ISO
 * timestamp, else falls back to the line verbatim with an `unknown` level and the arrival time.
 * Never throws.
 */
export function parseLogLine(raw: string, arrivalEpochMs: number, source: string): LogLine {
  const trimmed = raw.trim();
  if (trimmed === "") return { level: "unknown", message: "", raw, epochMs: arrivalEpochMs, ownTimestamp: false, source };
  return (
    parseJsonLine(trimmed, source, arrivalEpochMs) ??
    parseLogfmtLine(trimmed, source, arrivalEpochMs) ??
    parseBracketedLine(trimmed, source, arrivalEpochMs)
  );
}

const UUID_RE = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
const ISO_TS_G = new RegExp(ISO_TS_SRC, "g");

/**
 * The CLASS of a log message, for correlation-noise dedup and the `server-log` defect fingerprint:
 * an ISO timestamp, then a uuid, are replaced by placeholders first (so a timestamp's own digits
 * don't collide with the generic number-stripping below), then `@jevitate/explore`'s `messageClass`
 * strips URLs, quoted values, long hex ids and remaining numbers. Two occurrences of one bug that
 * differ only in an id, a count or a timestamp share a class.
 */
export function normalizeLogMessage(message: string): string {
  return messageClass(message.replace(ISO_TS_G, "<ts>").replace(UUID_RE, "<uuid>"));
}

/**
 * A `server-log` defect's fingerprint (#142): the templated route the line correlated to, plus the
 * normalized message class. Unattributed lines (outside every step window) are fingerprinted with
 * `route = "(run)"` — still stable across repeated occurrences of the same line.
 */
export function serverLogFingerprint(route: string, normalizedMessage: string): string {
  return contentHash(`server-log|${route === "(run)" ? route : normalizeRoute(route)}|${normalizedMessage}`).slice(0, 16);
}

export class LogSpecError extends Error {
  readonly code = "E_LOG_SPEC" as const;
  constructor(message: string) {
    super(message);
    this.name = "LogSpecError";
  }
}

/** A `--log-defect` matcher: a minimum level, or a `/regex/flags` pattern over the raw line. */
export type LogDefectMatcher =
  | { readonly kind: "level"; readonly level: LogLevel; readonly raw: string }
  | { readonly kind: "pattern"; readonly re: RegExp; readonly raw: string };

const REGEX_SPEC = /^\/(.*)\/([a-z]*)$/s;
const MAX_PATTERN_LENGTH = 500;

/**
 * Parses one `--log-defect` value: `/pattern/flags` (bounded length, compiled once via `new
 * RegExp` — never `eval`ed) or a level name (`error`, `warn`, `info`, `debug`), matched as
 * `level >= this`. Throws `LogSpecError` on anything else, so a bad spec is refused before any
 * browser opens (the same fail-closed discipline as `--invariants`).
 */
export function parseLogDefectSpec(raw: string): LogDefectMatcher {
  const m = REGEX_SPEC.exec(raw);
  if (m !== null) {
    const pattern = m[1] ?? "";
    const flags = m[2] ?? "";
    if (pattern.length > MAX_PATTERN_LENGTH) {
      throw new LogSpecError(`--log-defect pattern is too long (max ${MAX_PATTERN_LENGTH} chars): ${raw.slice(0, 40)}…`);
    }
    try {
      return { kind: "pattern", re: new RegExp(pattern, flags), raw };
    } catch (e) {
      throw new LogSpecError(`--log-defect: invalid regex ${JSON.stringify(raw)}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  const level = normalizeLevelName(raw);
  if (level === "unknown") {
    throw new LogSpecError(`--log-defect must be a level (error|warn|info|debug) or a /regex/: got ${JSON.stringify(raw)}`);
  }
  return { kind: "level", level, raw };
}

/** Whether a parsed line matches a `--log-defect` matcher. */
export function matchesLogDefect(line: Pick<LogLine, "level" | "raw">, matcher: LogDefectMatcher): boolean {
  return matcher.kind === "level" ? levelAtLeast(line.level, matcher.level) : matcher.re.test(line.raw);
}
