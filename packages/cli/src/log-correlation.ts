import { redactText } from "@jevitate/ai-core";
import { worstOutcome, type MissionOutcome } from "@jevitate/domain";
import type { TranscriptEntry } from "@jevitate/explore";
import {
  closeLogSources,
  openLogSources,
  type LogSourceHandle,
  type LogSourceSpec,
} from "./log-sources.js";
import {
  matchesLogDefect,
  normalizeLogMessage,
  parseLogDefectSpec,
  parseLogLine,
  serverLogFingerprint,
  type LogDefectMatcher,
  type LogLevel,
  type LogLine,
} from "./log-lines.js";

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
 */

export interface ServerLogEvidence {
  readonly level: LogLevel;
  /** Redacted human message. */
  readonly message: string;
  /** Redacted raw line. */
  readonly raw: string;
  readonly source: string;
  readonly epochMs: number;
}

export type TranscriptEntryWithLogs = TranscriptEntry & { readonly serverLogs?: readonly ServerLogEvidence[] };

export interface ServerLogSourceStatus {
  readonly spec: string;
  readonly opened: boolean;
  readonly linesRead: number;
  readonly truncated: boolean;
  readonly error?: string;
}

export interface ServerLogTopMessage {
  readonly level: LogLevel;
  /** Normalized message class (ids/numbers/uuids/timestamps stripped). */
  readonly message: string;
  readonly count: number;
}

export interface ServerLogsSummary {
  readonly sources: readonly ServerLogSourceStatus[];
  readonly byLevel: Readonly<Record<string, number>>;
  readonly topMessages: readonly ServerLogTopMessage[];
  readonly attachedLines: number;
  readonly unattributedLines: number;
  /**
   * False when `--log-defect` was given but every declared source failed to open, or opened and
   * delivered not one line — an absence of `server-log` defects then proves nothing about the
   * backend; it must never be read as "held"/clean (#142).
   */
  readonly oracleOk: boolean;
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
  readonly occurrences: number;
  readonly repro: { readonly recordingStepIndex: number };
  /** So `verify-fix` can re-open the SAME sources and re-check the SAME matcher (#142). */
  readonly serverLog: {
    readonly sources: readonly string[];
    readonly matcher: string;
    readonly normalizedMessage: string;
    readonly drainMs: number;
  };
}

export interface ServerLogRuntimeResult {
  readonly transcript: readonly TranscriptEntryWithLogs[];
  readonly summary: ServerLogsSummary;
  readonly defects: ServerLogDefect[];
}

const UNATTRIBUTED_ROUTE = "(run)";
/** Only these levels are auto-attached as step evidence (a `--log-defect` match is ALWAYS attached,
 *  whatever its level, since it is now a candidate defect). */
const ATTACH_LEVELS: ReadonlySet<LogLevel> = new Set(["warn", "error"]);
export const DEFAULT_SERVER_LOG_DRAIN_MS = 3_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    t.unref?.();
  });
}

export interface ServerLogRuntimeOptions {
  readonly sources: readonly LogSourceSpec[];
  /** Already-parsed `--log-defect` matchers (empty ⇒ evidence attachment only, no defects). */
  readonly logDefect: readonly LogDefectMatcher[];
  readonly drainMs?: number;
  readonly secrets: readonly string[];
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
  readonly #lines: LogLine[] = [];
  readonly #stepEpoch = new Map<number, number>();
  readonly #missionStartEpochMs = Date.now();
  readonly #secrets: readonly string[];
  readonly #matchers: readonly LogDefectMatcher[];
  readonly #drainMs: number;
  readonly #inner: ((entry: TranscriptEntry, all: readonly TranscriptEntry[]) => void) | undefined;
  readonly #maxTotalLines = 20_000;
  #finished = false;
  readonly #exitHook = (): void => {
    for (const h of this.#handles) h.killSync();
  };

  constructor(opts: ServerLogRuntimeOptions) {
    this.#secrets = opts.secrets;
    this.#matchers = opts.logDefect;
    this.#drainMs = opts.drainMs ?? DEFAULT_SERVER_LOG_DRAIN_MS;
    this.#inner = opts.onTranscriptEntry;
    // One `openLogSources` call per spec: each source's `onLine` must stamp ITS OWN spec onto every
    // `LogLine` (a shared callback across sources could not tell them apart).
    this.#handles = opts.sources.map(
      (spec) =>
        openLogSources([spec], {
          onLine: (raw, arrivalEpochMs) => {
            if (this.#lines.length >= this.#maxTotalLines) return;
            this.#lines.push(parseLogLine(raw, arrivalEpochMs, spec.raw));
          },
        })[0] as LogSourceHandle,
    );
    process.on("exit", this.#exitHook);
  }

  /** Wraps the journal's own `TranscriptListener`: unchanged persistence, plus this step's epoch. */
  readonly onTranscriptEntry = (entry: TranscriptEntry, all: readonly TranscriptEntry[]): void => {
    this.#stepEpoch.set(entry.step, Date.now());
    this.#inner?.(entry, all);
  };

  /** Call once the mission function has returned. Waits out the drain window, closes every source,
   *  and returns the correlated transcript/summary/defects. Idempotent (a second call is a no-op
   *  empty result) — never blocks the mission itself, only this post-processing step. */
  async finish(transcript: readonly TranscriptEntry[]): Promise<ServerLogRuntimeResult> {
    if (this.#finished) return { transcript, summary: this.#summary([]), defects: [] };
    this.#finished = true;
    await sleep(this.#drainMs);
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

    for (const line of this.#lines) {
      const win = windows.find((w) => line.epochMs >= w.startMs && line.epochMs <= w.endMs);
      const isDefectCandidate = this.#matchers.some((m) => matchesLogDefect(line, m));
      const attach = ATTACH_LEVELS.has(line.level) || isDefectCandidate;
      if (win === undefined) {
        if (attach) unattributed.push(line);
        continue;
      }
      if (!attach) continue;
      attachedLines += 1;
      const list = perStep.get(win.step) ?? [];
      list.push({
        level: line.level,
        message: redactText(line.message, this.#secrets),
        raw: redactText(line.raw, this.#secrets),
        source: line.source,
        epochMs: line.epochMs,
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

    const defects = this.#matchers.length === 0 ? [] : this.#buildDefects(transcript, perStepRaw, unattributed);
    const summary = this.#summary(unattributed, attachedLines);
    return { transcript: augmented, summary, defects };
  }

  #buildDefects(
    transcript: readonly TranscriptEntry[],
    perStepRaw: ReadonlyMap<number, LogLine[]>,
    unattributed: readonly LogLine[],
  ): ServerLogDefect[] {
    const grouped = new Map<string, { defect: ServerLogDefect; count: number }>();
    const lastStep = transcript.length > 0 ? (transcript[transcript.length - 1] as TranscriptEntry).step : 0;

    const consider = (line: LogLine, route: string, atStep: number): void => {
      const matched = this.#matchers.find((m) => matchesLogDefect(line, m));
      if (matched === undefined) return;
      const normalizedMessage = normalizeLogMessage(line.message);
      const fp = serverLogFingerprint(route, normalizedMessage);
      const existing = grouped.get(fp);
      if (existing !== undefined) {
        existing.count += 1;
        return;
      }
      grouped.set(fp, {
        count: 1,
        defect: {
          fingerprint: fp,
          related: [fp],
          kind: "server-log",
          title: `Server log ${line.level} on ${route === UNATTRIBUTED_ROUTE ? "(unattributed)" : route}: ${normalizedMessage.slice(0, 80)}`,
          route,
          level: line.level,
          message: redactText(line.message, this.#secrets),
          occurrences: 1,
          repro: { recordingStepIndex: recordingStepIndexFor(transcript, atStep) },
          serverLog: {
            sources: this.#handles.map((h) => h.spec.raw),
            matcher: matched.raw,
            normalizedMessage,
            drainMs: this.#drainMs,
          },
        },
      });
    };

    for (const entry of transcript) {
      const route = entry.url;
      for (const line of perStepRaw.get(entry.step) ?? []) consider(line, route, entry.step);
    }
    for (const line of unattributed) consider(line, UNATTRIBUTED_ROUTE, lastStep);

    return [...grouped.values()].map(({ defect, count }) => ({ ...defect, occurrences: count }));
  }

  #summary(unattributed: readonly LogLine[], attachedLines = 0): ServerLogsSummary {
    const byLevel: Record<string, number> = {};
    for (const line of this.#lines) byLevel[line.level] = (byLevel[line.level] ?? 0) + 1;

    const counts = new Map<string, { level: LogLevel; message: string; count: number }>();
    for (const line of this.#lines) {
      const message = normalizeLogMessage(line.message);
      const key = `${line.level}|${message}`;
      const e = counts.get(key);
      if (e === undefined) counts.set(key, { level: line.level, message, count: 1 });
      else e.count += 1;
    }
    const topMessages = [...counts.values()].sort((a, b) => b.count - a.count).slice(0, 10);

    const sources: ServerLogSourceStatus[] = this.#handles.map((h) => ({
      spec: h.spec.raw,
      opened: h.opened,
      linesRead: h.linesRead,
      truncated: h.truncated,
      ...(h.error === undefined ? {} : { error: h.error }),
    }));
    // An unreadable source, or one that read 0 lines, cannot let this oracle count as "held": a
    // `server-log` defect's absence proves nothing unless at least one source demonstrably saw
    // SOMETHING (proof it was actually being tailed).
    const oracleOk = this.#matchers.length === 0 || sources.some((s) => s.linesRead > 0);

    return {
      sources,
      byLevel,
      topMessages,
      attachedLines,
      unattributedLines: unattributed.length,
      oracleOk,
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
