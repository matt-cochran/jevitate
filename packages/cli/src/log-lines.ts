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
  // "fail"/"crit" are .NET's `Microsoft.Extensions.Logging` console-formatter tokens (#165): `fail`
  // maps to `error`, and `crit`("critical") also maps to `error` — this LogLevel enum has no
  // separate "critical" tier, so both collapse the same way `fatal` already did.
  if (v === "error" || v === "err" || v === "fatal" || v === "critical" || v === "crit" || v === "fail") return "error";
  if (v === "warn" || v === "warning") return "warn";
  if (v === "info" || v === "notice") return "info";
  // "dbug"/"trce" are .NET's own short tokens for debug/trace.
  if (v === "debug" || v === "trace" || v === "verbose" || v === "dbug" || v === "trce") return "debug";
  return "unknown";
}

/** A parsed backend log line. `raw`/`message` are UNREDACTED — callers redact before persisting. */
export interface LogLine {
  readonly level: LogLevel;
  /** The human message: a JSON/logfmt log's `message`/`msg`/`error` field, else the whole line. */
  readonly message: string;
  /** The raw line exactly as read (for a multi-line entry — .NET console, #165 — every joined line). */
  readonly raw: string;
  /** The line's own timestamp (ms since epoch) when one parsed; else the arrival time. */
  readonly epochMs: number;
  /** True when `epochMs` came from the line itself, not from arrival order. */
  readonly ownTimestamp: boolean;
  /** The `--log-source` spec this line came from (its raw form, e.g. `file:/var/log/app.log`). */
  readonly source: string;
  /**
   * The structured logger's own module/category (#169): a JSON log's `target`/`logger` field (Rust
   * `tracing`'s `target`), so a `server-log` defect's fingerprint tells apart two distinct errors
   * that happen to normalize to the same message class.
   */
  readonly target?: string;
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

const LEVEL_KEYS = ["level", "severity", "loglevel", "log_level", "LogLevel"];
const TIME_KEYS = ["time", "timestamp", "ts", "@timestamp"];
/** Top-level message-ish keys, highest priority first. */
const TOP_MESSAGE_KEYS = ["message", "msg", "Message"];
/** `fields.<key>` — Rust `tracing`/`tracing-subscriber`'s JSON formatter (#169) nests the actual
 *  message under `fields`, not at the top level; the top-level object is otherwise just envelope
 *  (timestamp/level/target/span). */
const NESTED_FIELD_KEYS = ["fields"];
const NESTED_MESSAGE_KEYS = ["message", "msg"];
const FALLBACK_MESSAGE_KEYS = ["@message", "error", "err"];
const TARGET_KEYS = ["target", "logger", "Category"];

/**
 * The human message of a JSON log line (#169): `message`/`msg` at the top level, else
 * `fields.message`/`fields.msg` (tracing-subscriber), else `@message`, else `error`/`err` as a last
 * resort for a line with no explicit message key. Anything else (a whole nested object with no
 * string message anywhere) falls back to the raw line in the caller, rather than JSON.stringify-ing
 * an object through `messageClass` into unreadable `{<s>:<s>…}` noise.
 */
function extractMessage(rec: Readonly<Record<string, unknown>>): string | undefined {
  const top = firstDefined(rec, TOP_MESSAGE_KEYS);
  if (typeof top === "string") return top;
  for (const fk of NESTED_FIELD_KEYS) {
    const nestedObj = rec[fk];
    if (nestedObj !== null && typeof nestedObj === "object" && !Array.isArray(nestedObj)) {
      const nested = firstDefined(nestedObj as Record<string, unknown>, NESTED_MESSAGE_KEYS);
      if (typeof nested === "string") return nested;
    }
  }
  const fallback = firstDefined(rec, FALLBACK_MESSAGE_KEYS);
  return typeof fallback === "string" ? fallback : undefined;
}

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
  const message = extractMessage(rec);
  const targetRaw = firstDefined(rec, TARGET_KEYS);
  const target = typeof targetRaw === "string" && targetRaw !== "" ? targetRaw : undefined;
  return {
    level,
    message: message ?? trimmed,
    raw: trimmed,
    epochMs: parsedTime ?? arrivalEpochMs,
    ownTimestamp: parsedTime !== null,
    source,
    ...(target === undefined ? {} : { target }),
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
  const msgRaw = firstDefined(pairs, [...TOP_MESSAGE_KEYS, ...FALLBACK_MESSAGE_KEYS]);
  return {
    level,
    message: typeof msgRaw === "string" ? msgRaw : trimmed,
    raw: trimmed,
    epochMs: parsedTime ?? arrivalEpochMs,
    ownTimestamp: parsedTime !== null,
    source,
  };
}

/**
 * The .NET default console formatter's entry header (#165, `Microsoft.Extensions.Logging`):
 * `lvl: Category.Name[EventId]`, e.g. `fail: OutboundLabs...StripeReconciliationHostedService[0]`.
 * The message is on the following indented line(s) — see `DotnetEntryGrouper`, which joins them
 * into one multi-line entry BEFORE it reaches this parser.
 */
const DOTNET_HEADER_RE = /^(trce|dbug|info|warn|fail|crit):\s+(.+)\[(-?\d+)\]\s*$/i;

/**
 * Parses an entry already joined by `DotnetEntryGrouper` (header line + its indented continuation
 * lines, `\n`-separated) — or a bare header line with no continuation, for direct unit testing.
 * `null` when the first line is not a `lvl: Category[id]` header, so this format never claims a
 * line meant for another parser.
 */
function parseDotnetLine(trimmedWhole: string, source: string, arrivalEpochMs: number): LogLine | null {
  const lines = trimmedWhole.split("\n");
  const headerLine = (lines[0] ?? "").trim();
  const m = DOTNET_HEADER_RE.exec(headerLine);
  if (m === null) return null;
  const level = normalizeLevelName(m[1] ?? "");
  const category = (m[2] ?? "").trim();
  // Continuation lines (the message, and any exception stack trace) are dedented and collapsed into
  // one message string — `normalizeLogMessage`/`messageClass` collapse whitespace anyway, and a
  // single-line message reads better in `topMessages`/a defect title than a raw multi-line blob.
  const body = lines
    .slice(1)
    .map((l) => l.trim())
    .filter((l) => l !== "")
    .join(" ");
  return {
    level,
    message: body !== "" ? body : category,
    raw: trimmedWhole,
    epochMs: arrivalEpochMs,
    ownTimestamp: false,
    source,
    ...(category === "" ? {} : { target: category }),
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
 * Parses one raw log line — or, for the .NET console format (#165), one already-grouped multi-line
 * entry (see `DotnetEntryGrouper`): JSON (`level`/`severity` + `time`/`timestamp`/`ts`), then logfmt
 * (`level=error msg="…" time=…`), then the .NET default console formatter (`lvl: Category[id]` +
 * indented continuation lines), then a bracketed/bare level with an optional leading ISO timestamp,
 * else falls back to the line verbatim with an `unknown` level and the arrival time. Never throws.
 */
export function parseLogLine(raw: string, arrivalEpochMs: number, source: string): LogLine {
  const trimmed = raw.trim();
  if (trimmed === "") return { level: "unknown", message: "", raw, epochMs: arrivalEpochMs, ownTimestamp: false, source };
  return (
    parseJsonLine(trimmed, source, arrivalEpochMs) ??
    parseLogfmtLine(trimmed, source, arrivalEpochMs) ??
    parseDotnetLine(trimmed, source, arrivalEpochMs) ??
    parseBracketedLine(trimmed, source, arrivalEpochMs)
  );
}

/** One raw (possibly multi-line, `\n`-joined) entry, ready for `parseLogLine`. */
export interface RawLogEntry {
  readonly raw: string;
  readonly epochMs: number;
}

/** A line that only extends a pending .NET entry when one is open: indented and non-blank. */
function isDotnetContinuation(line: string): boolean {
  return /^[ \t]/.test(line) && line.trim() !== "";
}

/**
 * Groups the .NET default console formatter's multi-line entries (#165) — a `lvl: Category[id]`
 * header followed by one or more indented message/exception-stack-trace lines — into ONE logical
 * entry before it reaches `parseLogLine`. Stateful and meant for ONE `--log-source` (`log-
 * correlation.ts` keeps one instance per source): lines arrive one at a time, in order, from `log-
 * sources.ts`'s line splitter.
 *
 * A header line always starts a NEW pending entry (flushing whatever was pending first); an
 * indented, non-blank line — while an entry is pending — extends it instead of starting its own;
 * anything else (not indented, not itself a header) is its own one-line entry. Every other log
 * format (JSON, logfmt, bracketed/bare) never triggers buffering: `feed` only holds a line back
 * when it is itself a header or it is indented AND a header is already pending, so a single
 * already-indented stray line with no pending entry passes straight through unchanged.
 */
export class DotnetEntryGrouper {
  #pending: string[] | undefined;
  #pendingEpochMs = 0;

  /** Feed one raw line. Returns the entries this line completed — usually 0 or 1, occasionally 2
   *  (a pending entry flushed by, immediately followed by, this line's own one-line entry). */
  feed(raw: string, epochMs: number): RawLogEntry[] {
    const isHeader = DOTNET_HEADER_RE.test(raw.trim());
    if (this.#pending !== undefined && !isHeader && isDotnetContinuation(raw)) {
      this.#pending.push(raw);
      return [];
    }
    const out: RawLogEntry[] = [];
    if (this.#pending !== undefined) {
      out.push({ raw: this.#pending.join("\n"), epochMs: this.#pendingEpochMs });
      this.#pending = undefined;
    }
    if (isHeader) {
      this.#pending = [raw];
      this.#pendingEpochMs = epochMs;
      return out;
    }
    out.push({ raw, epochMs });
    return out;
  }

  /** Flushes a still-pending entry (call when the source is closing: the log's last entry has no
   *  following header/non-continuation line to trigger its own flush). `undefined` when idle. */
  flush(): RawLogEntry | undefined {
    if (this.#pending === undefined) return undefined;
    const out: RawLogEntry = { raw: this.#pending.join("\n"), epochMs: this.#pendingEpochMs };
    this.#pending = undefined;
    return out;
  }
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
 * normalized message class, plus — when known (#169) — the logger's own `target`/`logger`/category
 * (Rust `tracing`'s `target`, a JSON log's `logger`, a .NET entry's category). Two lines whose
 * message happens to normalize the same, from two different loggers/modules, are DISTINCT defects:
 * without `target` they would collapse into one fingerprint, hiding one of the two real bugs.
 * Unattributed lines (outside every step window) are fingerprinted with `route = "(run)"` — still
 * stable across repeated occurrences of the same line.
 */
export function serverLogFingerprint(route: string, normalizedMessage: string, target?: string): string {
  const targetPart = target === undefined || target === "" ? "" : `|${target}`;
  return contentHash(`server-log|${route === "(run)" ? route : normalizeRoute(route)}|${normalizedMessage}${targetPart}`).slice(0, 16);
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
