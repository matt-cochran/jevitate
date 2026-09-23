import type { Page } from "playwright";
import type { Actor } from "@jevitate/screenplay";
import type { Recording } from "@jevitate/recording";
import { RecordingInterpreter } from "@jevitate/interpreter";
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
 * defect's fingerprint among the signals the replay produced:
 *
 *  - `still-reproduces` — the same fingerprint fired again;
 *  - `fixed`            — the replay reached the defect's step and the fingerprint did NOT fire;
 *  - `inconclusive`     — the replay could not reach the step (the app changed, a step failed, the
 *                         session could not open) and the fingerprint did not fire: that proves
 *                         nothing, so it is never reported as fixed.
 *
 * Never throws: every failure is an `inconclusive` verdict with its reason.
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
}

export type VerifyFixVerdict = "fixed" | "still-reproduces" | "inconclusive";

export interface VerifyFixResult {
  readonly verdict: VerifyFixVerdict;
  readonly fingerprint: string;
  /** Distinct signal fingerprints the replay produced (evidence for the verdict). */
  readonly observedFingerprints: string[];
  /** How far the replay got: `completed`, or the step it failed at and why. */
  readonly replay: { readonly outcome: "completed" } | { readonly outcome: "failed"; readonly at: number; readonly error: string };
  readonly reason: string;
}

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
    if (attempt.replay === "failed") {
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
  let session: VerifySession;
  try {
    session = await params.openSession();
  } catch (e) {
    return {
      ...base,
      verdict: "inconclusive",
      observedFingerprints: [],
      replay: { outcome: "failed", at: -1, error: firstLine(e) },
      reason: `could not open a fresh session: ${firstLine(e)}`,
    };
  }
  try {
    // The oracle listens BEFORE the first replayed step, exactly as in the original run.
    const collector = new PageSignalCollector(session.page);
    await monitorFor(session.page).instrument();
    // The defect's step is replayed to OBSERVE what the app does next — its own postcondition is not
    // the verdict (a fixed app may legitimately behave differently after it); the signal check is.
    const result = await new RecordingInterpreter().runToCheckpoint(
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
          ? { outcome: "failed", at: result.at, error: result.error.split("\n")[0] ?? result.error }
          : { outcome: "failed", at: result.at, error: "replay paused for a human hand-back" };

    if (observed.includes(params.fingerprint)) {
      return { ...base, verdict: "still-reproduces", observedFingerprints: observed, replay, reason: "the defect's fingerprint fired again on replay" };
    }
    if (replay.outcome === "failed") {
      return {
        ...base,
        verdict: "inconclusive",
        observedFingerprints: observed,
        replay,
        reason: `replay could not reach the defect's step (failed at step ${replay.at}); absence of the signal proves nothing`,
      };
    }
    return { ...base, verdict: "fixed", observedFingerprints: observed, replay, reason: "replay reached the defect's step and the fingerprint did not fire" };
  } catch (e) {
    return {
      ...base,
      verdict: "inconclusive",
      observedFingerprints: [],
      replay: { outcome: "failed", at: -1, error: firstLine(e) },
      reason: `replay failed: ${firstLine(e)}`,
    };
  } finally {
    await session.close().catch(() => undefined);
  }
}
