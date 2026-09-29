import { RecordingInterpreter } from "@jevitate/interpreter";
import type { Recording } from "@jevitate/recording";
import { perceive, verifyReplayVerdict, type VerifyFixResult, type VerifyFixVerdict, type VerifySession } from "@jevitate/explore";
import { closeLogSources, openLogSources, parseLogSourceSpecs, type LogSourceSpec } from "./log-sources.js";
import { matchesLogDefect, normalizeLogMessage, parseLogDefectSpec, parseLogLine, type LogLine } from "./log-lines.js";

/**
 * `verify-fix` for a `server-log` defect (#142): NOT a re-check of `@jevitate/explore`'s
 * `verifyFix` (which looks for a fingerprint among DOM/console/network signals — a server log line
 * is none of those). Instead, this replays the defect's recorded steps in a fresh browser session
 * AND re-opens the SAME log sources for the SAME drain window, and asks whether a line matching
 * the SAME matcher and the SAME normalized message reappears. Kept entirely in the CLI layer (new
 * file) — `packages/explore/src/verify-fix.ts` is untouched.
 *
 * Mirrors `verifyFix`'s own replay discipline (#74): `replays` fresh-context attempts, only ones
 * that actually reached the defect's step count as evidence, and the pure `verifyReplayVerdict`
 * rule (fired on every ran attempt ⇒ still-reproduces, none ⇒ fixed, a mix ⇒ intermittent — never
 * "fixed" off one clean replay).
 */

export interface VerifyServerLogParams {
  readonly recording: Recording;
  /** Flat index of the last Recording step to replay (the defect's `repro.recordingStepIndex`). */
  readonly recordingStepIndex: number;
  readonly fingerprint: string;
  /** The defect's persisted log sources (raw `--log-source` specs) and matcher (raw `--log-defect`). */
  readonly sources: readonly string[];
  readonly matcher: string;
  readonly normalizedMessage: string;
  readonly drainMs: number;
  readonly allowLogCmd: boolean;
  /** Opens a FRESH browser session (never the one the defect was found in). */
  readonly openSession: () => Promise<VerifySession>;
  readonly settleCeilingMs?: number;
  readonly targetTimeoutMs?: number;
  /** Fresh-context replays (#74). Default `DEFAULT_VERIFY_REPLAYS` (mirrors `@jevitate/explore`). */
  readonly replays?: number;
}

const DEFAULT_REPLAYS = 3;

function firstLine(e: unknown): string {
  return e instanceof Error ? e.message.split("\n")[0] ?? e.message : String(e);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    t.unref?.();
  });
}

interface Attempt {
  readonly ran: boolean;
  readonly fired: boolean;
  readonly detail: string;
  readonly replay: VerifyFixResult["replay"];
}

async function runOneServerLogReplay(params: VerifyServerLogParams, sourceSpecs: readonly LogSourceSpec[]): Promise<Attempt> {
  const lines: LogLine[] = [];
  const handles = openLogSources(sourceSpecs, {
    onLine: (raw, arrivalEpochMs) => {
      if (lines.length >= 5_000) return;
      lines.push(parseLogLine(raw, arrivalEpochMs, ""));
    },
  });
  let session: VerifySession;
  try {
    session = await params.openSession();
  } catch (e) {
    await closeLogSources(handles);
    return {
      ran: false,
      fired: false,
      detail: `could not open a fresh session: ${firstLine(e)}`,
      replay: { outcome: "failed", at: -1, error: firstLine(e) },
    };
  }
  try {
    const interpreter = new RecordingInterpreter(params.targetTimeoutMs === undefined ? {} : { targetTimeoutMs: params.targetTimeoutMs });
    const outcome = await interpreter.runToCheckpoint(session.actor, params.recording, params.recordingStepIndex);
    await perceive(session.page, {
      ...(params.settleCeilingMs === undefined ? {} : { renderWaitMs: params.settleCeilingMs }),
    }).catch(() => undefined);
    // Hold the log sources open for the SAME drain window the original run used, so async backend
    // work that settles late is caught here too — never blocking anything but this one attempt.
    await sleep(params.drainMs);
    await closeLogSources(handles);

    const matcher = parseLogDefectSpec(params.matcher);
    const fired = lines.some((l) => matchesLogDefect(l, matcher) && normalizeLogMessage(l.message) === params.normalizedMessage);

    if (outcome.outcome !== "completed") {
      const replay: VerifyFixResult["replay"] =
        outcome.outcome === "failed"
          ? { outcome: "failed", at: outcome.at, error: outcome.error.split("\n")[0] ?? outcome.error, ...(outcome.reason === undefined ? {} : { reason: outcome.reason }) }
          : { outcome: "failed", at: outcome.at, error: "replay paused for a human hand-back" };
      const mismatch = outcome.outcome === "failed" && outcome.reason !== undefined;
      return {
        ran: false,
        fired,
        replay,
        detail: mismatch
          ? `replay stopped at step ${outcome.at}: ${outcome.reason} — the recorded path was not reproduced, so this proves nothing`
          : `replay could not reach step ${params.recordingStepIndex} (failed at ${outcome.at}); the log source was not re-checked against the intended step`,
      };
    }
    return {
      ran: true,
      fired,
      replay: { outcome: "completed" },
      detail: fired
        ? "a matching server log line reappeared during the drain window"
        : "replay reached the defect's step and no matching server log line appeared within the drain window",
    };
  } catch (e) {
    await closeLogSources(handles).catch(() => undefined);
    return { ran: false, fired: false, detail: `replay failed: ${firstLine(e)}`, replay: { outcome: "failed", at: -1, error: firstLine(e) } };
  } finally {
    await session.close().catch(() => undefined);
  }
}

export async function verifyServerLogDefect(params: VerifyServerLogParams): Promise<VerifyFixResult> {
  const base = { fingerprint: params.fingerprint };
  let sourceSpecs: LogSourceSpec[];
  try {
    sourceSpecs = parseLogSourceSpecs(params.sources, params.allowLogCmd);
    parseLogDefectSpec(params.matcher); // validated once up front, fail closed
  } catch (e) {
    return {
      ...base,
      verdict: "inconclusive",
      observedFingerprints: [],
      replay: { outcome: "failed", at: -1, error: "not replayed" },
      reason: `the defect's log source(s)/matcher no longer parse: ${firstLine(e)}`,
    };
  }
  const replays = params.replays ?? DEFAULT_REPLAYS;
  if (!Number.isInteger(replays) || replays < 1) throw new Error(`verifyServerLogDefect: replays must be >= 1, got ${replays}`);

  const runs: Attempt[] = [];
  for (let i = 0; i < replays; i++) runs.push(await runOneServerLogReplay(params, sourceSpecs));
  const last = runs[runs.length - 1] as Attempt;
  const verdict: VerifyFixVerdict = verifyReplayVerdict(runs);
  const ran = runs.filter((r) => r.ran).length;
  const fired = runs.filter((r) => r.ran && r.fired).length;
  const reason =
    verdict === "inconclusive"
      ? last.detail
      : verdict === "still-reproduces"
        ? `the matching server log line reappeared on all ${fired}/${ran} replay(s) that ran`
        : verdict === "fixed"
          ? `no matching server log line appeared on any of the ${ran}/${runs.length} replay(s) that ran`
          : `the matching server log line appeared on ${fired}/${ran} replay(s) that ran — intermittent on the current code, never reported as fixed`;
  return { ...base, verdict, observedFingerprints: fired > 0 ? [params.fingerprint] : [], replay: last.replay, reason, attempts: runs.map((r) => ({ ran: r.ran, fired: r.fired, detail: r.detail })) };
}
