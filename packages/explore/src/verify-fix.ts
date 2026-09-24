import type { Page } from "playwright";
import type { Actor } from "@jevitate/screenplay";
import type { Recording } from "@jevitate/recording";
import { RecordingInterpreter, type ReplayTargetFailure } from "@jevitate/interpreter";
import { perceive, type PerceiveOptions } from "./perceive.js";
import { observeAfterStep } from "./record.js";
import type { HangSignal } from "./hang.js";
import { replayAndDetectHang } from "./hang-repro.js";
import { monitorFor } from "./page-monitor.js";
import { PageSignalCollector } from "./adversarial/defect-oracle.js";
import { signalFingerprint } from "./adversarial/defect-fingerprint.js";

/**
 * verifyFix — "is this defect fixed?", answered by REPLAY, not by opinion.
 *
 * Replays a defect's reproduction (its Recording up to `recordingStepIndex`, via the existing
 * `RecordingInterpreter.runToCheckpoint` — no second replay engine) in a FRESH session with the
 * same hard-signal oracle attached before the first step, lets the page settle, and looks for the
 * defect's fingerprint among the signals the replay produced.
 *
 * A SINGLE clean replay is not evidence a fix landed (#74): a timing-dependent signal (the
 * `net::ERR_ABORTED`-after-response case in #73 is one example, but any signal can be
 * intermittent) can simply not fire once and still be there. The replay runs `replays` times
 * (default `DEFAULT_VERIFY_REPLAYS`), each in its own FRESH session, mirroring the reproduction
 * machinery `hang-repro.ts` uses to confirm a hang. Only attempts that actually RAN (reached the
 * defect's step) count as evidence:
 *
 *  - `still-reproduces` — the fingerprint fired on EVERY attempt that ran;
 *  - `fixed`            — the fingerprint fired on NONE of the attempts that ran, and at least one
 *                         ran;
 *  - `intermittent`     — the fingerprint fired on SOME but not all attempts that ran: the signal
 *                         is flaky on the CURRENT code, so absence on any one replay proves
 *                         nothing — never reported as fixed;
 *  - `inconclusive`     — no attempt ran (the app changed so the recorded path no longer matches,
 *                         a step failed, every session failed to open): that proves nothing either
 *                         way.
 *
 * Never throws (aside from a caller bug like an invalid `replays` count): every failure is an
 * `inconclusive` verdict with its reason.
 */

export interface VerifySession {
  readonly page: Page;
  readonly actor: Actor;
  close(): Promise<void>;
}

export interface VerifyFixParams {
  readonly recording: Recording;
  /** Flat index of the last Recording step to replay (the defect's `repro.recordingStepIndex`). */
  readonly recordingStepIndex: number;
  /** The defect's fingerprint. */
  readonly fingerprint: string;
  /**
   * The defect's kind. An `invariant` defect was concluded by a user-supplied probe that is not
   * part of the Recording, so a replay alone cannot re-check it: its verdict is `inconclusive`.
   */
  readonly defectKind: string;
  /** Opens a FRESH browser session (never the one the defect was found in). */
  readonly openSession: () => Promise<VerifySession>;
  /** Render/settle ceiling after the replay (ms). Default: perceive's default. */
  readonly settleCeilingMs?: number;
  /**
   * For a `hang` finding: the hang signal. Its fix is verified by replaying and re-applying the hang
   * rule — it passes only if the replay now settles within the bound.
   */
  readonly hang?: HangSignal;
  /** Perception bounds for the hang re-check (the ones the mission used). */
  readonly perceive?: PerceiveOptions;
  /** Stall window for a stalled-state `ui-no-progress` hang (ms). */
  readonly stallMs?: number;
  /** How long a recorded target may take to appear on replay (ms). Default: the interpreter's. */
  readonly targetTimeoutMs?: number;
  /** Fresh-context replays for a non-hang defect signal (#74). Default `DEFAULT_VERIFY_REPLAYS`. */
  readonly replays?: number;
  /**
   * The defect's recorded reproducibility at mission time, when it's available (e.g. an
   * `AdversarialDefect.occurrences` — how many times the SAME run hit it). Consulted only for the
   * verdict's evidence trail (`reason`); the replay verdict itself is always decided by what this
   * replay actually observed, never by opinion about how reproducible the original finding "should"
   * have been.
   */
  readonly occurrences?: number;
}

export type VerifyFixVerdict = "fixed" | "still-reproduces" | "intermittent" | "inconclusive";

export interface VerifyFixResult {
  readonly verdict: VerifyFixVerdict;
  readonly fingerprint: string;
  /** Distinct signal fingerprints the replay produced (evidence for the verdict). */
  readonly observedFingerprints: string[];
  /** How far the (last-run) replay got: `completed`, or the step it failed at and why. */
  readonly replay:
    | { readonly outcome: "completed" }
    | {
        readonly outcome: "failed";
        readonly at: number;
        readonly error: string;
        /** A replay-TARGET failure: the recorded element is missing or ambiguous (never guessed). */
        readonly reason?: ReplayTargetFailure;
      };
  readonly reason: string;
  /** Every fresh-context attempt for a non-hang defect signal (#74): absent for `hang`/`invariant`. */
  readonly attempts?: ReplayAttemptEvidence[];
}

/** One fresh-context replay's evidence: did it RUN (reach the step), and did the signal FIRE. */
export interface ReplayAttemptEvidence {
  readonly ran: boolean;
  readonly fired: boolean;
  readonly detail: string;
}

/**
 * The pure verdict rule (#74): only attempts that RAN count as evidence. Absence on every one that
 * ran is `fixed`; firing on every one is `still-reproduces`; a mix is `intermittent` — a signal
 * that is flaky on the CURRENT code is never reported as fixed just because one replay was clean.
 */
export function verifyReplayVerdict(runs: readonly Pick<ReplayAttemptEvidence, "ran" | "fired">[]): VerifyFixVerdict {
  const ran = runs.filter((r) => r.ran);
  if (ran.length === 0) return "inconclusive";
  const fired = ran.filter((r) => r.fired).length;
  if (fired === 0) return "fixed";
  if (fired === ran.length) return "still-reproduces";
  return "intermittent";
}

export const DEFAULT_VERIFY_REPLAYS = 3;

function firstLine(e: unknown): string {
  return e instanceof Error ? e.message.split("\n")[0] ?? e.message : String(e);
}

export async function verifyFix(params: VerifyFixParams): Promise<VerifyFixResult> {
  const base = { fingerprint: params.fingerprint };
  if (params.defectKind === "hang") {
    if (params.hang === undefined) {
      return {
        ...base,
        verdict: "inconclusive",
        observedFingerprints: [],
        replay: { outcome: "failed", at: -1, error: "not replayed" },
        reason: "a hang finding needs its hang signal to be re-checked",
      };
    }
    const attempt = await replayAndDetectHang({
      recording: params.recording,
      recordingStepIndex: params.recordingStepIndex,
      hang: params.hang,
      openSession: params.openSession,
      ...(params.perceive === undefined ? {} : { perceive: params.perceive }),
      ...(params.stallMs === undefined ? {} : { stallMs: params.stallMs }),
    });
    const replay: VerifyFixResult["replay"] =
      attempt.replay === "failed" ? { outcome: "failed", at: -1, error: attempt.detail } : { outcome: "completed" };
    if (attempt.reproduced) {
      return { ...base, verdict: "still-reproduces", observedFingerprints: [params.fingerprint], replay, reason: `the hang reproduced: ${attempt.detail}` };
    }
    if (!attempt.ran) {
      // The attempt never ran (no session, or the replay failed before the step): no evidence.
      return { ...base, verdict: "inconclusive", observedFingerprints: [], replay, reason: `${attempt.detail}; absence of the hang proves nothing` };
    }
    return { ...base, verdict: "fixed", observedFingerprints: [], replay, reason: `the replay settled within the bound (${attempt.detail})` };
  }
  if (params.defectKind === "invariant") {
    return {
      ...base,
      verdict: "inconclusive",
      observedFingerprints: [],
      replay: { outcome: "failed", at: -1, error: "not replayed" },
      reason: "an invariant defect needs its user invariant to be re-checked; a replay alone proves nothing",
    };
  }
  const replays = params.replays ?? DEFAULT_VERIFY_REPLAYS;
  if (!Number.isInteger(replays) || replays < 1) throw new Error(`verifyFix: replays must be >= 1, got ${replays}`);

  const runs: SingleReplayAttempt[] = [];
  for (let i = 0; i < replays; i++) {
    const attempt = await runOneReplay(params);
    runs.push(attempt);
    // The recorded path itself does not match the current app: retrying cannot change that, so more
    // attempts would not add evidence (matches the pre-#74 single-attempt inconclusive verdict).
    if (attempt.targetMismatch) break;
  }
  const last = runs[runs.length - 1] as SingleReplayAttempt;
  const observedFingerprints = [...new Set(runs.flatMap((r) => r.observed))];
  const attempts: ReplayAttemptEvidence[] = runs.map((r) => ({ ran: r.ran, fired: r.fired, detail: r.detail }));
  const verdict = verifyReplayVerdict(runs);
  const ran = runs.filter((r) => r.ran).length;
  const fired = runs.filter((r) => r.ran && r.fired).length;
  const occNote = params.occurrences === undefined ? "" : ` (the original run observed it ${params.occurrences} time(s))`;
  const reason: string =
    verdict === "inconclusive"
      ? `${last.detail}${occNote}`
      : verdict === "still-reproduces"
        ? `the defect's fingerprint fired on all ${fired}/${ran} replay(s) that ran${occNote}`
        : verdict === "fixed"
          ? `the defect's fingerprint was absent on all ${ran}/${runs.length} replay(s) that ran${occNote}`
          : `the defect's fingerprint fired on ${fired}/${ran} replay(s) that ran — intermittent on the current code, never reported as fixed${occNote}`;
  return { ...base, verdict, observedFingerprints, replay: last.replay, reason, attempts };
}

/** One fresh-context replay's raw outcome, before it is folded into the verdict. */
interface SingleReplayAttempt extends ReplayAttemptEvidence {
  readonly observed: string[];
  readonly replay: VerifyFixResult["replay"];
  /** A replay-TARGET failure (the recorded element is missing or ambiguous): more attempts cannot help. */
  readonly targetMismatch: boolean;
}

/** Session open → replay to the defect's step → observe. Never throws. */
async function runOneReplay(params: VerifyFixParams): Promise<SingleReplayAttempt> {
  let session: VerifySession;
  try {
    session = await params.openSession();
  } catch (e) {
    return {
      ran: false,
      fired: false,
      observed: [],
      replay: { outcome: "failed", at: -1, error: firstLine(e) },
      detail: `could not open a fresh session: ${firstLine(e)}`,
      targetMismatch: false,
    };
  }
  try {
    // The oracle listens BEFORE the first replayed step, exactly as in the original run.
    const collector = new PageSignalCollector(session.page);
    await monitorFor(session.page).instrument();
    // The defect's step is replayed to OBSERVE what the app does next — its own postcondition is not
    // the verdict (a fixed app may legitimately behave differently after it); the signal check is.
    const result = await new RecordingInterpreter(
      params.targetTimeoutMs === undefined ? {} : { targetTimeoutMs: params.targetTimeoutMs },
    ).runToCheckpoint(
      session.actor,
      observeAfterStep(params.recording, params.recordingStepIndex),
      params.recordingStepIndex,
    );
    // Let async work the replayed step started (the late 500, the deferred console error) land.
    await perceive(session.page, {
      ...(params.settleCeilingMs === undefined ? {} : { renderWaitMs: params.settleCeilingMs }),
    }).catch(() => undefined);
    await session.page.waitForTimeout(10);
    const observed = [...new Set(collector.drain().map(signalFingerprint))];
    const replay: VerifyFixResult["replay"] =
      result.outcome === "completed"
        ? { outcome: "completed" }
        : result.outcome === "failed"
          ? {
              outcome: "failed",
              at: result.at,
              error: result.error.split("\n")[0] ?? result.error,
              ...(result.reason === undefined ? {} : { reason: result.reason }),
            }
          : { outcome: "failed", at: result.at, error: "replay paused for a human hand-back" };

    // The replay could not find (or tell apart) a recorded element: it did not reproduce the
    // recorded path, so nothing it saw — or did not see — is evidence. Always inconclusive.
    if (replay.outcome === "failed" && replay.reason !== undefined) {
      return {
        ran: false,
        fired: false,
        observed,
        replay,
        detail: `replay stopped at step ${replay.at}: ${replay.reason} — the recorded path was not reproduced, so this proves nothing`,
        targetMismatch: true,
      };
    }
    const fired = observed.includes(params.fingerprint);
    if (fired) {
      return { ran: true, fired: true, observed, replay, detail: "the defect's fingerprint fired again on replay", targetMismatch: false };
    }
    if (replay.outcome === "failed") {
      return {
        ran: false,
        fired: false,
        observed,
        replay,
        detail: `replay could not reach the defect's step (failed at step ${replay.at}); absence of the signal proves nothing`,
        targetMismatch: false,
      };
    }
    return {
      ran: true,
      fired: false,
      observed,
      replay,
      detail: "replay reached the defect's step and the fingerprint did not fire",
      targetMismatch: false,
    };
  } catch (e) {
    return {
      ran: false,
      fired: false,
      observed: [],
      replay: { outcome: "failed", at: -1, error: firstLine(e) },
      detail: `replay failed: ${firstLine(e)}`,
      targetMismatch: false,
    };
  } finally {
    await session.close().catch(() => undefined);
  }
}
