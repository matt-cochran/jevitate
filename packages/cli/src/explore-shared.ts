/** Wiring shared by every explore strategy runner (goal, coverage, adversarial, feature): server-log and declared-invariant result fields, storageState persistence, drafts/filing context. */
import { chmod, writeFile } from "node:fs/promises";
import { assertSessionFileOutsideProject } from "./project-dir.js";
import type { JudgmentPort, GenerationPort, CredentialKey, UsageTracker, VerifyFetch } from "@jevitate/ai-core";
import { type BrowserPort } from "@jevitate/playwright";
import { CastActor, BrowseTheWeb } from "@jevitate/screenplay";
import { type InvariantSpec, type RecordingEmulation } from "@jevitate/recording";
import type { InvariantDefect, InvariantReport } from "@jevitate/explore";
import {
  currentEnvironment,
  isLoginLikeUrl,
  type DraftContext,
  type VerifySession,
} from "@jevitate/explore";
import { type FilingConfig, type IssueFilerPort } from "@jevitate/domain";
import { readCliVersion } from "./version.js";
import { type EngineInfo } from "./engine.js";
import { MissionJournal } from "./mission-journal.js";
import { StorageStateSnapshotter } from "./storage-state-snapshot.js";
import { type ServerLogDefect, type ServerLogRuntimeResult, type ServerLogsSummary } from "./log-correlation.js";
import { signalsPathFor, triageRunResult, writeSignals, type LogTriageOptions } from "./signal-triage.js";
import type { LogSourceSpec } from "./log-sources.js";
import type { LogDefectMatcher, LogIgnoreMatcher } from "./log-lines.js";

/**
 * Backend log correlation (#142): already-validated `--log-source`/`--log-defect` specs, threaded
 * into every mission-type builder below the same way `invariants` is. `undefined`/empty ⇒ no
 * sources ⇒ `openServerLogRuntime` is a complete no-op (existing runs pay nothing).
 */
export interface ServerLogOptions {
  readonly sources: readonly LogSourceSpec[];
  readonly logDefect: readonly LogDefectMatcher[];
  readonly allowLogCmd?: boolean;
  readonly drainMs?: number;
  /** Raw `--log-source` specs (`--log-quiet-ok`, #169) allowed to deliver zero lines without making
   *  `serverLogs.oracleOk` false — for a source the operator KNOWS is legitimately quiet. */
  readonly quietOk?: readonly string[];
  /** Already-parsed `--log-ignore` matchers (#169 item 3): known-noise lines excluded from
   *  correlation and the defect oracle. */
  readonly logIgnore?: readonly LogIgnoreMatcher[];
  /** #282: already-parsed `--log-scope` matchers: only matching lines are attributed to the run. */
  readonly logScope?: readonly LogIgnoreMatcher[];
  /** #204: extra correlation-id headers (`--log-correlation-header`, lower-case). */
  readonly correlationHeaders?: readonly string[];
  /** #204: compiled `--log-id-pattern`s (how an id is written in the operator's log format). */
  readonly idPatterns?: readonly RegExp[];
  /** #313 `--log-triage`: record the run's whole signal timeline and triage it per defect (Jev when `judge` is live). */
  readonly triage?: LogTriageOptions;
}

/**
 * The `openServerLogRuntime` options every strategy shares, from its `ServerLogOptions` (#142,
 * #169, #204, #282) — the caller adds its own `secrets` and transcript listener.
 */
export function serverLogRuntimeOptions(o: ServerLogOptions | undefined): {
  sources: readonly LogSourceSpec[];
  logDefect: readonly LogDefectMatcher[];
  quietOk: readonly string[];
  logIgnore: readonly LogIgnoreMatcher[];
  logScope: readonly LogIgnoreMatcher[];
  correlationHeaders: readonly string[];
  idPatterns: readonly RegExp[];
  drainMs?: number;
  signals?: boolean;
} {
  return {
    sources: o?.sources ?? [],
    logDefect: o?.logDefect ?? [],
    quietOk: o?.quietOk ?? [],
    logIgnore: o?.logIgnore ?? [],
    logScope: o?.logScope ?? [],
    correlationHeaders: o?.correlationHeaders ?? [],
    idPatterns: o?.idPatterns ?? [],
    ...(o?.drainMs === undefined ? {} : { drainMs: o.drainMs }),
    ...(o?.triage === undefined ? {} : { signals: true }),
  };
}

/**
 * The result's `serverLogs` summary. Server-log defects go into the result's `defects` (#195); the
 * deprecated `serverLogDefects` alias was removed in 0.3.0.
 */
export function serverLogResult(runtimeResult: { summary: ServerLogsSummary; defects: ServerLogDefect[] } | undefined): {
  serverLogs?: ServerLogsSummary;
} {
  if (runtimeResult === undefined) return {};
  return { serverLogs: runtimeResult.summary };
}

/**
 * Overflow/emulation CLI flags shared by every strategy (#149): `emulation` is validated and
 * resolved by `PlaywrightBrowserPort.open` itself (an unknown device or --viewport+--device
 * together refuses BEFORE any browser opens); `overflow` gates and configures the horizontal-
 * overflow hard signal (coverage only, for now).
 */
export interface OverflowFlags {
  readonly checkOverflow?: boolean;
  readonly toleranceCss?: number;
  readonly ignoreSelectors?: readonly string[];
}

/** The viewport/device emulation actually applied to a session — recorded on the Recording (#149). */
export function recordingEmulation(
  resolved: { viewport: { width: number; height: number }; device?: string; deviceScaleFactor?: number; isMobile?: boolean; hasTouch?: boolean } | undefined,
): RecordingEmulation | undefined {
  if (resolved === undefined) return undefined;
  return {
    viewport: resolved.viewport,
    ...(resolved.device === undefined ? {} : { device: resolved.device }),
    ...(resolved.deviceScaleFactor === undefined ? {} : { deviceScaleFactor: resolved.deviceScaleFactor }),
    ...(resolved.isMobile === undefined ? {} : { isMobile: resolved.isMobile }),
    ...(resolved.hasTouch === undefined ? {} : { hasTouch: resolved.hasTouch }),
  };
}

/** Filing is off by default: drafts only, never a tracker call. */
export const DRAFTS_ONLY: FilingConfig = { enabled: false, jevitateRepo: "matt-cochran/jevitate" };

export const NO_FILER = (): IssueFilerPort => {
  throw new Error("issue filing is enabled but no filer was configured");
};

export function draftContext(
  origin: string,
  journal: MissionJournal,
  secrets: readonly string[],
  browserVersion: string | undefined,
  engine: EngineInfo,
): DraftContext {
  return {
    environment: currentEnvironment(origin, {
      jevitateVersion: readCliVersion(),
      commit: engine.commit,
      builtAt: engine.builtAt,
      ...(browserVersion === undefined ? {} : { browser: browserVersion }),
    }),
    recordingPath: journal.recordingPath,
    transcriptPath: journal.transcriptPath,
    secrets,
  };
}

/**
 * Opens a FRESH browser session for replays (hang reproduction): a new context from the same port
 * and options — same authenticated storageState, never the session the finding was made in.
 */
export function freshSessionOpener(
  portFactory: () => BrowserPort,
  launch: Parameters<BrowserPort["open"]>[0],
  allowlist: readonly string[],
): () => Promise<VerifySession> {
  return async () => {
    const session = await portFactory().open(launch);
    const actor = CastActor.named("replay").whoCan(new BrowseTheWeb(session, [...allowlist]));
    return { page: session.page, actor, close: () => session.close() };
  };
}

/** `session.page.url()`, or `undefined` when reading it throws (a closed/crashed page/context). */
export function currentUrlSafe(session: { page: { url(): string } }): string | undefined {
  try {
    return session.page.url();
  } catch {
    return undefined;
  }
}

/**
 * Writes the browser context's storageState (cookies + origin storage) to `file` when the caller
 * asked for one (CLI `--save-storage-state`, #82) — so a rotating refresh token stays usable across
 * runs instead of the `--storage-state` file it started from going stale on first use. Called from
 * every mission's `finally`, so a thrown error still reaches it (#159) — the context is still open at
 * that point, whatever failed inside the mission itself. A no-op when `file` is undefined.
 *
 * #159 — never persists a lost/logged-out session over a good file: when the CURRENT page looks
 * login-like (`isLoginLikeUrl`, the #82 signal), a live capture is skipped in favor of `snapshotter`'s
 * last known-good in-memory snapshot (refreshed after each settled step — see
 * `storage-state-snapshot.ts` — and itself never updated from a login-like page, so it always holds
 * the most recent GOOD state). The same fallback covers a live capture that simply fails (a
 * crashed/closed context after the page url could still be read). If neither a safe live capture nor
 * a snapshot is available, nothing is written — any existing file at `file` is left untouched. There
 * is no flag today for an operator to force the write anyway; see `saveStorageState`'s own doc.
 *
 * The file holds live session credentials: written with mode 0600 (owner read/write only), and its
 * contents are never logged either way.
 */
/**
 * #195: refused BEFORE a browser opens — a `saveStorageState` inside a repo's `.jevitate/` (which
 * never holds sessions or secrets). `persistStorageState` re-checks at the write itself.
 */
export function assertSaveStorageStateOutsideProject(file: string | undefined): void {
  if (file !== undefined) assertSessionFileOutsideProject(file, "saveStorageState");
}

export async function persistStorageState(
  session: { page: { url(): string }; saveStorageState(file: string): Promise<void> },
  file: string | undefined,
  snapshotter?: StorageStateSnapshotter,
): Promise<void> {
  if (file === undefined) return;
  // #195: the final chokepoint for every caller — nothing is written inside a repo's .jevitate/;
  // the refusal is thrown (the run reports it), never swallowed.
  assertSessionFileOutsideProject(file, "saveStorageState");
  const url = currentUrlSafe(session);
  if (url === undefined || !isLoginLikeUrl(url)) {
    try {
      await session.saveStorageState(file);
      await chmod(file, 0o600);
      return;
    } catch {
      // A crashed/closed context, or a mid-write failure — fall back to the last known-good snapshot.
    }
  }
  const fallback = snapshotter?.snapshot();
  if (fallback === undefined) return;
  await writeFile(file, fallback, { encoding: "utf8", mode: 0o600 });
}

export function browserVersionOf(page: { context(): { browser(): { version(): string } | null } }): string | undefined {
  try {
    return page.context().browser()?.version();
  } catch {
    return undefined;
  }
}

/** The adversarial outcome plus where its Recording and decision transcript were written. */
/** Where a mission ran — enough for `verify-fix` to replay one of its defects in a fresh session. */
export interface MissionTarget {
  readonly seedUrl: string;
  readonly allowlist: string[];
  /** Absolute path of the storageState file the run started from (never its contents). */
  readonly storageStatePath?: string;
  /** #147: every actor's name, role and storageState PATH (never its contents) — for verify-fix. */
  readonly actors?: ReadonlyArray<{ readonly name: string; readonly storageStatePath: string; readonly role: "primary" | "observer" }>;
}

/**
 * The declared-invariant fields of a persisted result (#86): the defects (top-level `defects`, where
 * `verify-fix` looks), the per-invariant report, and the spec itself so a later `verify-fix`
 * re-checks exactly what the run checked. Nothing at all when the run had no `--invariants`.
 */
export function declaredResult(
  spec: InvariantSpec | undefined,
  defects: readonly InvariantDefect[] | undefined,
  report: readonly InvariantReport[] | undefined,
): { defects?: InvariantDefect[]; invariants?: InvariantReport[]; invariantSpec?: InvariantSpec } {
  if (spec === undefined) return {};
  return { defects: [...(defects ?? [])], invariants: [...(report ?? [])], invariantSpec: spec };
}

/** Injectable wiring for the `explore` CLI command (all optional). */
export interface ExploreCliDeps {
  /** Injected issue filer (tests use a fake — nothing real is ever filed from a test). */
  issueFiler?: () => IssueFilerPort;
  /** Injected filing config file path (tests). Default `~/.jevitate/filing.json`. */
  filingConfigPath?: string;
  /** Injected per-target config file path (tests). Default `~/.jevitate/targets.json`. */
  targetsConfigPath?: string;
  /** Injected judgment gateway (tests). */
  judge?: JudgmentPort;
  /** Injected generation gateway (tests). */
  gen?: GenerationPort;
  /** Injected usage tracker (tests): injected gateways that record into it report known costs (#163). */
  usage?: UsageTracker;
  browserPortFactory?: () => BrowserPort;
  env?: Record<string, string | undefined>;
  localConfig?: Partial<Record<CredentialKey, string>>;
  /** #291: the startup key check's verifier (tests; default the live HTTPS check). */
  verifyFetch?: VerifyFetch;
}

/** #313: what `withRunEvidence` needs to triage a finished run's signals (`--log-triage`). */
export interface RunTriage {
  readonly options: LogTriageOptions;
  readonly signals: NonNullable<ServerLogRuntimeResult["signals"]>;
  readonly secrets: readonly string[];
}

/**
 * The run's `serverLog` options with the triage gateway set (#313): Jev scores relevance only on a
 * live (`--real`) run — a fake gateway has no answers for it, so a `--fake-ai` run triages by code.
 */
export function triagedServerLog(serverLog: ServerLogOptions | undefined, judge: JudgmentPort, live: boolean): { serverLog?: ServerLogOptions } {
  if (serverLog === undefined) return {};
  if (serverLog.triage === undefined || !live) return { serverLog };
  return { serverLog: { ...serverLog, triage: { ...serverLog.triage, judge } } };
}

/** The run's triage, or `undefined` unless `--log-triage` was given and the runtime recorded signals. */
export function triageOf(o: { readonly serverLog?: ServerLogOptions }, run: ServerLogRuntimeResult | undefined, secrets: readonly string[]): RunTriage | undefined {
  const options = o.serverLog?.triage;
  if (options === undefined || run?.signals === undefined) return undefined;
  return { options, signals: run.signals, secrets };
}

/** Writes the run's `<stem>.signals.jsonl` and triages it into the result (#313). */
export async function withRunTriage<R extends { readonly resultPath: string }>(result: R, t: RunTriage | undefined): Promise<R> {
  if (t === undefined) return result;
  writeSignals(signalsPathFor(result.resultPath), t.signals.entries);
  return triageRunResult(result, result.resultPath, { ...t.options, secrets: t.secrets, truncated: t.signals.truncated });
}
