import { redactText } from "@jevitate/ai-core";
import { worstOutcome, type MissionOutcome, clock } from "@jevitate/domain";
import { normalizeRoute, type TranscriptEntry } from "@jevitate/explore";
import {
  closeLogSources,
  openLogSources,
  type LogSourceHandle,
  type LogSourceSpec,
} from "./log-sources.js";
import {
  DotnetEntryGrouper,
  LogSpecError,
  matchesLogDefect,
  matchesLogIgnore,
  normalizeLogMessage,
  parseLogDefectSpec,
  parseLogIgnoreSpec,
  parseLogLine,
  serverLogFingerprint,
  type LogDefectMatcher,
  type LogIgnoreMatcher,
  type LogLevel,
  type LogLine,
} from "./log-lines.js";
import { DEFAULT_LOG_CLASS_RULES, classifyLogLine, type LogClassCause, type LogClassRule } from "./log-classes.js";
import { RequestIdLedger, declaredIds, type CorrelatedRequest, type RequestEvents } from "./log-trace.js";
import { observeBrowserSignals, redactSignalText, type RawBrowserSignal, type SignalEntry } from "./signal-triage.js";

/**
 * Correlates tailed backend log lines to the mission step they landed during (#142): each step's
 * "window" runs from the previous step's settle time to this step's own settle time (a mission's
 * `TranscriptListener` fires the moment a step is recorded — already the crash-safe incremental-
 * flush seam `MissionJournal` uses, per-step wall-clock epochs come for free from `Date.now()` at
 * that call, with no change needed to `@jevitate/explore`'s mission loop). The LAST step's window
 * is additionally held open for `drainMs` (`--server-log-drain-ms`) so async backend work that
 * settles after the browser gave up is still caught, never blocking the mission itself: the
 * runtime's own await (waiting out the drain) happens AFTER the mission function has already
 * returned.
 *
 * Fail closed: every line is redacted with the run's own secret list before it is ever attached to
 * a step, turned into a defect, or counted in the summary — a log line can contain secrets the page
 * never showed.
 *
 * #204 — by trace / correlation id first: a line that carries an id one of the run's requests sent
 * or received (`traceparent`, `x-request-id`, …; see `log-trace.ts`) is attached to EXACTLY that
 * request (`request: { method, url, status, id }`) and to the step that sent it, whenever it
 * landed. Only a line with no id falls back to the time window. Once ids demonstrably correlate, a
 * line carrying ANOTHER id is other work (another user, a background job) and is never this run's.
 *
 * #282 — `--log-scope`: when given, only lines matching it (a tenant id, a run marker) are
 * attributed; the rest count as `ignoredLines`. A line carrying one of the run's ids is in scope.
 */

export interface ServerLogEvidence {
  readonly level: LogLevel;
  /** Redacted human message. */
  readonly message: string;
  /** Redacted raw line. */
  readonly raw: string;
  readonly source: string;
  readonly epochMs: number;
  /** The logger's own target/category, when known (#169). */
  readonly target?: string;
  /**
   * #204: the run's request this line was correlated to by a trace/correlation id it carries —
   * method, redacted URL, response status (null: no response) and the id. Unset: attached by time.
   */
  readonly request?: ServerLogRequest;
}

/** #204: the request a server log line belongs to, by a correlation id both carry. */
export interface ServerLogRequest {
  readonly method: string;
  readonly url: string;
  readonly status: number | null;
  readonly id: string;
}

export type TranscriptEntryWithLogs = TranscriptEntry & { readonly serverLogs?: readonly ServerLogEvidence[] };

export interface ServerLogSourceStatus {
  readonly spec: string;
  readonly opened: boolean;
  readonly linesRead: number;
  readonly truncated: boolean;
  readonly error?: string;
  /** True when this source was declared `--log-quiet-ok` (#169): zero lines from it is expected,
   *  not a sign the oracle never actually watched the backend. */
  readonly quietOk?: boolean;
}

export interface ServerLogTopMessage {
  readonly level: LogLevel;
  /** Normalized message class (ids/numbers/uuids/timestamps stripped). */
  readonly message: string;
  /** The logger's own target/category, when known (#169) — kept distinct in this summary too. */
  readonly target?: string;
  readonly count: number;
}

export interface ServerLogsSummary {
  readonly sources: readonly ServerLogSourceStatus[];
  readonly byLevel: Readonly<Record<string, number>>;
  readonly topMessages: readonly ServerLogTopMessage[];
  readonly attachedLines: number;
  readonly unattributedLines: number;
  /** Lines excluded by `--log-ignore` (#169 item 3) — known noise, never attached, never a defect
   *  candidate, not counted in `byLevel`/`topMessages` — plus lines outside `--log-scope` (#282) and
   *  lines carrying another request's correlation id (#204), broken down in `correlation`. */
  readonly ignoredLines: number;
  /**
   * #204/#282: how lines were correlated — set when a request carried a correlation id or
   * `--log-scope` was given. `idMatchedLines`: attached to their exact request by id;
   * `foreignLines`: carried another request's id (never this run's); `outOfScopeLines`: outside
   * `--log-scope`. The last two are included in `ignoredLines`.
   */
  readonly correlation?: {
    readonly requestsWithIds: number;
    readonly idMatchedLines: number;
    readonly foreignLines: number;
    readonly outOfScopeLines: number;
  };
  /**
   * False when `--log-defect` was given but at least one declared source is unhealthy: it never
   * opened/errored, OR it opened and delivered not one line while NOT declared `--log-quiet-ok`
   * (#169) — an absence of `server-log` defects then proves nothing about the backend; it must never
   * be read as "held"/clean (#142).
   */
  readonly oracleOk: boolean;
  /** Why `oracleOk` is false — which source(s), and whether they failed to open or were silently
   *  quiet. Unset when `oracleOk` is true. */
  readonly oracleReason?: string;
}

export interface ServerLogDefect {
  readonly fingerprint: string;
  readonly related: string[];
  readonly kind: "server-log";
  readonly title: string;
  readonly route: string;
  readonly level: LogLevel;
  /** First occurrence's redacted message. */
  readonly message: string;
  /** #421: the `--log-source` (its raw spec) the first occurrence was read from. */
  readonly source: string;
  /** #421: the transcript step the first occurrence was attributed to (the run's last step for an unattributed line). */
  readonly firstSeenStep: number;
  /** #421: how many lines of this run share the fingerprint (= `occurrences`, the name every consumer reads). */
  readonly count: number;
  readonly occurrences: number;
  readonly repro: { readonly recordingStepIndex: number };
  /** #204: the request the first occurrence was correlated to by id, when it was. */
  readonly request?: ServerLogRequest;
  /** So `verify-fix` can re-open the SAME sources and re-check the SAME matcher (#142). */
  readonly serverLog: {
    readonly sources: readonly string[];
    readonly matcher: string;
    readonly normalizedMessage: string;
    readonly drainMs: number;
    /** #282: the run's `--log-scope` (raw specs): verify-fix counts only lines in scope too. */
    readonly scope?: readonly string[];
  };
}

export interface ServerLogRuntimeResult {
  readonly transcript: readonly TranscriptEntryWithLogs[];
  readonly summary: ServerLogsSummary;
  readonly defects: ServerLogDefect[];
  /** #422: `--log-defect` lines a `log-classes` rule classed `environment` — never defects (empty when none). */
  readonly environment?: readonly LogClassCause[];
  /** #422: `--log-defect` lines a rule classed `expected-validation` — recorded, never failing the run. */
  readonly expectedValidation?: readonly LogClassCause[];
  /** #313 (`signals: true`): the run's whole redacted signal timeline — every backend line at every
   *  level plus the browser's console, page errors and failed requests — each placed in its step. */
  readonly signals?: { readonly entries: readonly SignalEntry[]; readonly truncated: boolean };
}

const UNATTRIBUTED_ROUTE = "(run)";
/** Only these levels are auto-attached as step evidence (a `--log-defect` match is ALWAYS attached,
 *  whatever its level, since it is now a candidate defect). */
const ATTACH_LEVELS: ReadonlySet<LogLevel> = new Set(["warn", "error"]);
export const DEFAULT_SERVER_LOG_DRAIN_MS = 3_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const t = clock.setTimeout(resolve, ms);
    t.unref?.();
  });
}

export interface ServerLogRuntimeOptions {
  readonly sources: readonly LogSourceSpec[];
  /** Already-parsed `--log-defect` matchers (empty ⇒ evidence attachment only, no defects). */
  readonly logDefect: readonly LogDefectMatcher[];
  readonly drainMs?: number;
  readonly secrets: readonly string[];
  /** Raw `--log-source` specs (matched against a source's own `spec.raw`) that are allowed to
   *  deliver zero lines without making `oracleOk` false (#169's `--log-quiet-ok`). */
  readonly quietOk?: readonly string[];
  /** Already-parsed `--log-ignore` matchers (#169 item 3): known-noise lines excluded from
   *  correlation AND the defect oracle, counted separately (`serverLogs.ignoredLines`). */
  readonly logIgnore?: readonly LogIgnoreMatcher[];
  /** #282: `--log-scope` matchers (same `/regex/` or substring grammar as `--log-ignore`): only lines
   *  matching one are attributed (or carrying one of the run's correlation ids); the rest are ignored. */
  readonly logScope?: readonly LogIgnoreMatcher[];
  /** #204: extra response/request headers carrying a correlation id (`--log-correlation-header`). */
  readonly correlationHeaders?: readonly string[];
  /** #204: `--log-id-pattern`s: how an id is written in a log line of the operator's own format. */
  readonly idPatterns?: readonly RegExp[];
  /** #313 `--log-triage`: also record the whole signal timeline (`ServerLogRuntimeResult.signals`). */
  readonly signals?: boolean;
  /** #422: how a `--log-defect` line is classed (project `.jevitate/log-classes.json` + defaults); default: the built-in rules. */
  readonly logClasses?: readonly LogClassRule[];
  /** The journal's own listener — still called for every entry (the crash-safe flush is unchanged). */
  readonly onTranscriptEntry?: (entry: TranscriptEntry, all: readonly TranscriptEntry[]) => void;
}

/**
 * Opens every source and starts correlating (#142). Returns `undefined` when `sources` is empty —
 * a complete no-op, so a run without `--log-source` pays nothing.
 */
export function openServerLogRuntime(opts: ServerLogRuntimeOptions): ServerLogRuntime | undefined {
  if (opts.sources.length === 0) return undefined;
  return new ServerLogRuntime(opts);
}

export class ServerLogRuntime {
  readonly #handles: LogSourceHandle[];
  readonly #groupers: DotnetEntryGrouper[] = [];
  readonly #lines: LogLine[] = [];
  readonly #stepEpoch = new Map<number, number>();
  readonly #missionStartEpochMs = clock.now();
  readonly #secrets: readonly string[];
  readonly #matchers: readonly LogDefectMatcher[];
  readonly #drainMs: number;
  readonly #quietOk: ReadonlySet<string>;
  readonly #logIgnore: readonly LogIgnoreMatcher[];
  readonly #logScope: readonly LogIgnoreMatcher[];
  readonly #idPatterns: readonly RegExp[];
  readonly #logClasses: readonly LogClassRule[];
  readonly #ledger: RequestIdLedger;
  #ignoredLines = 0;
  readonly #inner: ((entry: TranscriptEntry, all: readonly TranscriptEntry[]) => void) | undefined;
  readonly #maxTotalLines = 20_000;
  readonly #signalsOn: boolean;
  readonly #browserSignals: RawBrowserSignal[] = [];
  #signalsDropped = false;
  #finished = false;
  readonly #exitHook = (): void => {
    for (const h of this.#handles) h.killSync();
  };

  constructor(opts: ServerLogRuntimeOptions) {
    this.#secrets = opts.secrets;
    this.#matchers = opts.logDefect;
    this.#drainMs = opts.drainMs ?? DEFAULT_SERVER_LOG_DRAIN_MS;
    this.#quietOk = new Set(opts.quietOk ?? []);
    this.#logIgnore = opts.logIgnore ?? [];
    this.#logScope = opts.logScope ?? [];
    this.#idPatterns = opts.idPatterns ?? [];
    this.#logClasses = opts.logClasses ?? DEFAULT_LOG_CLASS_RULES;
    this.#ledger = new RequestIdLedger({ headers: opts.correlationHeaders ?? [] });
    this.#inner = opts.onTranscriptEntry;
    this.#signalsOn = opts.signals === true;
    // One `openLogSources` call per spec: each source's `onLine` must stamp ITS OWN spec onto every
    // `LogLine` (a shared callback across sources could not tell them apart). Each source also gets
    // its OWN `DotnetEntryGrouper` (#165) — a multi-line .NET entry must never straddle two sources.
    this.#handles = opts.sources.map((spec, i) => {
      this.#groupers[i] = new DotnetEntryGrouper();
      return openLogSources([spec], {
        onLine: (raw, arrivalEpochMs) => {
          const grouper = this.#groupers[i] as DotnetEntryGrouper;
          for (const entry of grouper.feed(raw, arrivalEpochMs)) this.#pushLine(entry.raw, entry.epochMs, spec.raw);
        },
      })[0] as LogSourceHandle;
    });
    process.on("exit", this.#exitHook);
  }

  #pushLine(raw: string, epochMs: number, sourceRaw: string): void {
    if (this.#lines.length >= this.#maxTotalLines) {
      this.#signalsDropped = true;
      return;
    }
    const parsed = parseLogLine(raw, epochMs, sourceRaw);
    // #169 item 3: a known-noise line is dropped here, BEFORE it can become step evidence, a
    // `topMessages`/`byLevel` entry or a defect candidate — but it was still delivered by the
    // source (already counted in `linesRead`), so it says nothing about the oracle's health.
    if (this.#logIgnore.some((m) => matchesLogIgnore(parsed, m))) {
      this.#ignoredLines += 1;
      return;
    }
    this.#lines.push(parsed);
  }

  /** Flushes any still-pending `DotnetEntryGrouper` entry per source — the last entry in a .NET log
   *  has no following header to trigger its own flush otherwise. */
  #flushGroupers(): void {
    this.#groupers.forEach((grouper, i) => {
      const entry = grouper.flush();
      const spec = this.#handles[i]?.spec.raw;
      if (entry !== undefined && spec !== undefined) this.#pushLine(entry.raw, entry.epochMs, spec);
    });
  }

  /**
   * #204: records the correlation ids of every request this page sends and receives. Call before
   * the page's first navigation (the seed load's requests count too).
   */
  observe(page: RequestEvents): void {
    this.#ledger.observe(page);
    // #313: with --log-triage, the browser's own signals join the same timeline.
    if (this.#signalsOn) {
      observeBrowserSignals(page, this.#browserSignals, () => clock.now(), () => {
        this.#signalsDropped = true;
      });
    }
  }

  /** Wraps the journal's own `TranscriptListener`: unchanged persistence, plus this step's epoch. */
  readonly onTranscriptEntry = (entry: TranscriptEntry, all: readonly TranscriptEntry[]): void => {
    this.#stepEpoch.set(entry.step, clock.now());
    this.#inner?.(entry, all);
  };

  /** Call once the mission function has returned. Waits out the drain window, closes every source,
   *  and returns the correlated transcript/summary/defects. Idempotent (a second call is a no-op
   *  empty result) — never blocks the mission itself, only this post-processing step. */
  async finish(transcript: readonly TranscriptEntry[]): Promise<ServerLogRuntimeResult> {
    if (this.#finished) return { transcript, summary: this.#summary([], this.#lines), defects: [] };
    this.#finished = true;
    await sleep(this.#drainMs);
    this.#flushGroupers();
    await closeLogSources(this.#handles);
    process.off("exit", this.#exitHook);
    return this.#correlate(transcript);
  }

  /**
   * Safety net for the mission-threw-before-`finish` path: closes every source immediately, with NO
   * drain wait and no correlation. A no-op once `finish` already ran. Never throws.
   */
  async abort(): Promise<void> {
    if (this.#finished) return;
    this.#finished = true;
    await closeLogSources(this.#handles);
    process.off("exit", this.#exitHook);
  }

  #correlate(transcript: readonly TranscriptEntry[]): ServerLogRuntimeResult {
    const windows = stepWindows(transcript, this.#stepEpoch, this.#missionStartEpochMs, this.#drainMs);
    const perStep = new Map<number, ServerLogEvidence[]>();
    const perStepRaw = new Map<number, LogLine[]>();
    const unattributed: LogLine[] = [];
    let attachedLines = 0;

    // #204: which lines carry one of the run's own correlation ids (and so belong to that request).
    const byId = new Map<LogLine, { readonly request: CorrelatedRequest; readonly id: string }>();
    for (const line of this.#lines) {
      const hit = this.#ledger.requestFor(line.raw);
      if (hit !== undefined) byId.set(line, hit);
    }
    // Ids demonstrably correlate (a line matched one): a line declaring ANOTHER id is other work.
    const idsLive = byId.size > 0;
    let foreignLines = 0;
    let outOfScopeLines = 0;
    const kept: LogLine[] = [];
    for (const line of this.#lines) {
      if (!byId.has(line)) {
        if (this.#logScope.length > 0 && !this.#logScope.some((m) => matchesLogIgnore(line, m))) {
          outOfScopeLines += 1;
          continue;
        }
        if (idsLive && declaredIds(line.raw, this.#idPatterns).length > 0) {
          foreignLines += 1;
          continue;
        }
      }
      kept.push(line);
    }
    const windowAt = (epochMs: number): { step: number } | undefined =>
      windows.find((w) => epochMs >= w.startMs && epochMs <= w.endMs) ?? (epochMs < (windows[0]?.startMs ?? 0) ? windows[0] : undefined);

    const requests = new Map<LogLine, ServerLogRequest>();
    for (const line of kept) {
      const hit = byId.get(line);
      // An id-correlated line belongs to the step that SENT its request, whenever the line landed.
      const win = hit === undefined ? windows.find((w) => line.epochMs >= w.startMs && line.epochMs <= w.endMs) : windowAt(hit.request.startedAtMs);
      const isDefectCandidate = this.#matchers.some((m) => matchesLogDefect(line, m));
      const attach = ATTACH_LEVELS.has(line.level) || isDefectCandidate;
      if (win === undefined) {
        if (attach) unattributed.push(line);
        continue;
      }
      if (!attach) continue;
      attachedLines += 1;
      const request: ServerLogRequest | undefined =
        hit === undefined
          ? undefined
          : { method: hit.request.method, url: redactText(hit.request.url, this.#secrets), status: hit.request.status, id: redactText(hit.id, this.#secrets) };
      if (request !== undefined) requests.set(line, request);
      const list = perStep.get(win.step) ?? [];
      list.push({
        level: line.level,
        message: redactText(line.message, this.#secrets),
        raw: redactText(line.raw, this.#secrets),
        source: line.source,
        epochMs: line.epochMs,
        ...(line.target === undefined ? {} : { target: redactText(line.target, this.#secrets) }),
        ...(request === undefined ? {} : { request }),
      });
      perStep.set(win.step, list);
      const rawList = perStepRaw.get(win.step) ?? [];
      rawList.push(line);
      perStepRaw.set(win.step, rawList);
    }

    const augmented: TranscriptEntryWithLogs[] = transcript.map((entry) => {
      const logs = perStep.get(entry.step);
      return logs === undefined || logs.length === 0 ? entry : { ...entry, serverLogs: logs };
    });

    const classified = this.#matchers.length === 0 ? undefined : this.#buildDefects(transcript, perStepRaw, unattributed, requests);
    const defects = classified?.defects ?? [];
    const classes = {
      ...(classified === undefined || classified.environment.length === 0 ? {} : { environment: classified.environment }),
      ...(classified === undefined || classified.expectedValidation.length === 0 ? {} : { expectedValidation: classified.expectedValidation }),
    };
    const correlation =
      this.#ledger.requestsWithIds > 0 || this.#logScope.length > 0
        ? { requestsWithIds: this.#ledger.requestsWithIds, idMatchedLines: kept.filter((l) => byId.has(l)).length, foreignLines, outOfScopeLines }
        : undefined;
    const summary = this.#summary(unattributed, kept, attachedLines, correlation);
    if (!this.#signalsOn) return { transcript: augmented, summary, defects, ...classes };
    // #313: every kept line (all levels) and every browser signal, redacted, placed in its step.
    const place = (step: number | undefined): Pick<SignalEntry, "step" | "recordingStepIndex"> =>
      step === undefined ? {} : { step, recordingStepIndex: recordingStepIndexFor(transcript, step) };
    const entries: SignalEntry[] = [
      ...kept.map((line): SignalEntry => {
        const hit = byId.get(line);
        const win = hit === undefined ? windows.find((w) => line.epochMs >= w.startMs && line.epochMs <= w.endMs) : windowAt(hit.request.startedAtMs);
        return {
          epochMs: line.epochMs,
          source: `server:${line.source}`,
          level: line.level,
          text: redactSignalText(line.raw, this.#secrets),
          ...place(win?.step),
          ...(hit === undefined
            ? {}
            : { request: { method: hit.request.method, url: redactSignalText(hit.request.url, this.#secrets), ...(hit.request.status === null ? {} : { status: hit.request.status }), id: redactText(hit.id, this.#secrets) } }),
        };
      }),
      ...this.#browserSignals.map((b): SignalEntry => ({
        epochMs: b.epochMs,
        source: b.source,
        level: b.level,
        text: redactSignalText(b.text, this.#secrets),
        ...place(windows.find((w) => b.epochMs >= w.startMs && b.epochMs <= w.endMs)?.step),
      })),
    ].sort((a, b) => a.epochMs - b.epochMs);
    return { transcript: augmented, summary, defects, ...classes, signals: { entries, truncated: this.#signalsDropped } };
  }

  #buildDefects(
    transcript: readonly TranscriptEntry[],
    perStepRaw: ReadonlyMap<number, LogLine[]>,
    unattributed: readonly LogLine[],
    requests: ReadonlyMap<LogLine, ServerLogRequest>,
  ): { defects: ServerLogDefect[]; environment: LogClassCause[]; expectedValidation: LogClassCause[] } {
    const grouped = new Map<string, { defect: ServerLogDefect; count: number }>();
    // #422: a candidate a `log-classes` rule classes `environment` / `expected-validation` is not a
    // defect — one cause per (rule, source, message class), counted.
    const causes = { environment: new Map<string, LogClassCause>(), "expected-validation": new Map<string, LogClassCause>() };
    const lastStep = transcript.length > 0 ? (transcript[transcript.length - 1] as TranscriptEntry).step : 0;

    const consider = (line: LogLine, route: string, atStep: number): void => {
      const matched = this.#matchers.find((m) => matchesLogDefect(line, m));
      if (matched === undefined) return;
      const normalizedMessage = normalizeLogMessage(line.message);
      const rule = classifyLogLine(this.#logClasses, line);
      if (rule !== undefined && rule.class !== "defect") {
        const into = causes[rule.class];
        const key = `${rule.id}|${line.source}|${normalizedMessage}`;
        const seen = into.get(key);
        into.set(
          key,
          seen === undefined
            ? { ruleId: rule.id, source: line.source, message: redactText(line.message, this.#secrets), count: 1 }
            : { ...seen, count: seen.count + 1 },
        );
        return;
      }
      const fp = serverLogFingerprint(route, normalizedMessage, line.target);
      const existing = grouped.get(fp);
      if (existing !== undefined) {
        existing.count += 1;
        return;
      }
      // #169 item 3: the STORED route is templated too (the shared #95/#127 templater, same as the
      // fingerprint already used internally) — two occurrences that only differ by an id in the URL
      // read as the same defect everywhere, not just in the hash.
      const templatedRoute = route === UNATTRIBUTED_ROUTE ? route : normalizeRoute(route);
      const request = requests.get(line);
      grouped.set(fp, {
        count: 1,
        defect: {
          fingerprint: fp,
          related: [fp],
          kind: "server-log",
          title: `Server log ${line.level} on ${templatedRoute === UNATTRIBUTED_ROUTE ? "(unattributed)" : templatedRoute}${line.target === undefined ? "" : ` (${line.target})`}: ${normalizedMessage.slice(0, 80)}`,
          route: templatedRoute,
          level: line.level,
          message: redactText(line.message, this.#secrets),
          source: line.source,
          firstSeenStep: atStep,
          count: 1,
          occurrences: 1,
          repro: { recordingStepIndex: recordingStepIndexFor(transcript, atStep) },
          ...(request === undefined ? {} : { request }),
          serverLog: {
            sources: this.#handles.map((h) => h.spec.raw),
            matcher: matched.raw,
            normalizedMessage,
            drainMs: this.#drainMs,
            ...(this.#logScope.length === 0 ? {} : { scope: this.#logScope.map((m) => m.raw) }),
          },
        },
      });
    };

    for (const entry of transcript) {
      const route = entry.url;
      for (const line of perStepRaw.get(entry.step) ?? []) consider(line, route, entry.step);
    }
    for (const line of unattributed) consider(line, UNATTRIBUTED_ROUTE, lastStep);

    return {
      defects: [...grouped.values()].map(({ defect, count }) => ({ ...defect, count, occurrences: count })),
      environment: [...causes.environment.values()],
      expectedValidation: [...causes["expected-validation"].values()],
    };
  }

  #summary(
    unattributed: readonly LogLine[],
    lines: readonly LogLine[],
    attachedLines = 0,
    correlation?: NonNullable<ServerLogsSummary["correlation"]>,
  ): ServerLogsSummary {
    const byLevel: Record<string, number> = {};
    for (const line of lines) byLevel[line.level] = (byLevel[line.level] ?? 0) + 1;

    const counts = new Map<string, { level: LogLevel; message: string; target?: string; count: number }>();
    for (const line of lines) {
      const message = normalizeLogMessage(line.message);
      const key = `${line.level}|${line.target ?? ""}|${message}`;
      const e = counts.get(key);
      if (e === undefined) counts.set(key, { level: line.level, message, ...(line.target === undefined ? {} : { target: line.target }), count: 1 });
      else e.count += 1;
    }
    const topMessages = [...counts.values()].sort((a, b) => b.count - a.count).slice(0, 10);

    const sources: ServerLogSourceStatus[] = this.#handles.map((h) => ({
      spec: h.spec.raw,
      opened: h.opened,
      linesRead: h.linesRead,
      truncated: h.truncated,
      ...(h.error === undefined ? {} : { error: h.error }),
      ...(this.#quietOk.has(h.spec.raw) ? { quietOk: true } : {}),
    }));

    // Per-source health (#169): a source is unhealthy when it never opened/errored, OR it opened and
    // delivered not one line while NOT declared `--log-quiet-ok` — a source the operator KNOWS runs
    // quiet. Every declared source must be healthy for the oracle to count as "held": one dead/silent
    // source among several is still a hole in the evidence, not proof of anything.
    const unhealthy = sources.filter((s) => {
      if (!s.opened || s.error !== undefined) return true;
      return s.linesRead === 0 && s.quietOk !== true;
    });
    const oracleOk = this.#matchers.length === 0 || unhealthy.length === 0;
    const failedSpecs = unhealthy.filter((s) => !s.opened || s.error !== undefined).map((s) => s.spec);
    const quietSpecs = unhealthy.filter((s) => s.opened && s.error === undefined).map((s) => s.spec);
    let oracleReason: string | undefined;
    if (oracleOk) {
      oracleReason = undefined;
    } else if (quietSpecs.length === 0) {
      oracleReason =
        "the --log-defect oracle could not run: every declared --log-source failed to open or read a line — an absence of server-log defects proves nothing";
    } else if (failedSpecs.length === 0) {
      oracleReason = "log source produced no lines";
    } else {
      oracleReason = `the --log-defect oracle could not run: ${failedSpecs.join(", ")} failed to open or read a line; ${quietSpecs.join(", ")} produced no lines`;
    }

    return {
      sources,
      byLevel,
      topMessages,
      attachedLines,
      unattributedLines: unattributed.length,
      ignoredLines: this.#ignoredLines + (correlation?.foreignLines ?? 0) + (correlation?.outOfScopeLines ?? 0),
      ...(correlation === undefined ? {} : { correlation }),
      oracleOk,
      ...(oracleReason === undefined ? {} : { oracleReason }),
    };
  }
}

/** Contiguous per-step correlation windows: `[previous settle, this settle]`, the LAST one extended
 *  by `drainMs` so async backend work that lands after the mission's own bounds still attaches. */
function stepWindows(
  transcript: readonly TranscriptEntry[],
  stepEpoch: ReadonlyMap<number, number>,
  missionStartEpochMs: number,
  drainMs: number,
): Array<{ step: number; startMs: number; endMs: number }> {
  const windows: Array<{ step: number; startMs: number; endMs: number }> = [];
  let prevEnd = missionStartEpochMs;
  for (let i = 0; i < transcript.length; i++) {
    const entry = transcript[i] as TranscriptEntry;
    const settle = stepEpoch.get(entry.step) ?? prevEnd;
    const isLast = i === transcript.length - 1;
    const endMs = isLast ? settle + drainMs : settle;
    windows.push({ step: entry.step, startMs: prevEnd, endMs });
    prevEnd = settle;
  }
  return windows;
}

/**
 * The flat `Recording` step index for a transcript step (#142's best-effort mapping): a failed
 * action (`actOk: false`) never becomes a Recording step (`transcript.ts`'s own invariant), so this
 * counts only the successful ones up to and including `uptoStep`. Clamped to 0 when none yet ran —
 * `verify-fix` then replays from the start, which is always a safe (if wide) anchor.
 */
function recordingStepIndexFor(transcript: readonly TranscriptEntry[], uptoStep: number): number {
  let idx = -1;
  for (const e of transcript) {
    if (e.step > uptoStep) break;
    if (e.actOk) idx += 1;
  }
  return Math.max(0, idx);
}

/** Parses `--log-defect` values, failing closed on the first bad one. */
export function parseLogDefectSpecs(raw: readonly string[]): LogDefectMatcher[] {
  return raw.map(parseLogDefectSpec);
}

/** Parses `--log-ignore` values, failing closed on the first bad one (#169 item 3). */
export function parseLogIgnoreSpecs(raw: readonly string[]): LogIgnoreMatcher[] {
  return raw.map(parseLogIgnoreSpec);
}

/** Parses `--log-scope` values (#282): the `--log-ignore` grammar, a `/regex/flags/` or a substring. */
export function parseLogScopeSpecs(raw: readonly string[]): LogIgnoreMatcher[] {
  return raw.map((r) => {
    try {
      return parseLogIgnoreSpec(r);
    } catch (e) {
      if (e instanceof LogSpecError) throw new LogSpecError(e.message.replace(/--log-ignore/g, "--log-scope"));
      throw e;
    }
  });
}

/**
 * Folds a server-log correlation result into an already-computed `MissionOutcome` (#142, follow-up
 * on the exit-code requirement): a found `server-log` defect is at least `defects-found` — via
 * `worstOutcome`, so it never DOWNGRADES a worse outcome (hang/crashed/inconclusive already proves
 * more, or the same, than a defect). An unreadable `--log-defect` oracle (`oracleOk: false`) turns
 * an otherwise-`clean` run `inconclusive` — its absence of defects proves nothing when the source
 * that would have caught them was never demonstrably read. `undefined` (no `--log-source`) is a
 * complete no-op.
 */
export function applyServerLogOutcome(outcome: MissionOutcome, run: ServerLogRuntimeResult | undefined): MissionOutcome {
  if (run === undefined) return outcome;
  if (run.defects.length > 0) return worstOutcome(outcome, "defects-found");
  if (!run.summary.oracleOk && outcome === "clean") return "inconclusive";
  return outcome;
}
