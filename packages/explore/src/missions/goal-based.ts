import type { Assertion, Recording } from "@jevitate/recording";
import { checkAssertion } from "@jevitate/interpreter";
import { explore, type ExploreConfig, type ExploreRun, type TranscriptEntry } from "../explore.js";
import { hangFinding, reproduceHang, type HangFinding, type HangReproduction } from "../hang-repro.js";
import type { VerifySession } from "../verify-fix.js";

/**
 * The goal-based exploratory mission (P1's first mission).
 *
 * Runs the bounded exploration loop toward `goal`, then adjudicates success
 * with an INDEPENDENT oracle: a user-supplied `Assertion` from the recording
 * schema, evaluated by the SAME assertion engine replay uses
 * (`@jevitate/interpreter`'s `checkAssertion`). Jev's `done` is advisory only —
 * it can propose the goal is met, but it never certifies it (guardrail #4).
 *
 * Outcome:
 *  - `succeeded`  — the success assertion holds against the live final page.
 *  - `exhausted`  — the assertion did not hold and the loop hit a budget cap.
 *  - `blocked`    — the assertion did not hold and the loop stopped otherwise
 *                   (model done/blocked, no valid target, no-progress, …).
 *  - `inconclusive` — the model decision stayed unavailable; the run proves nothing.
 *  - `crashed`    — the engine failed (browser/page crash, unexpected exception).
 *                   Never a pass: the assertion is not trusted on a broken run.
 *  - `hang` / `intermittent` — the app under test hung; its steps were replayed in fresh
 *                   browser contexts and it reproduced every time (`hang`) or not (`intermittent`).
 *
 * The durable product is always the emitted `Recording`, whatever the outcome.
 */

export interface GoalBasedMissionConfig extends Omit<ExploreConfig, "missionContext"> {
  /** The independent success oracle (user-supplied). */
  readonly successAssertion: Assertion;
  /** Overall bound for the oracle's bounded polling check (ms). Default 3000. */
  readonly oracleTimeoutMs?: number;
  /**
   * Opens a FRESH browser session — used to reproduce a hang by replaying its steps. Without it a
   * hang cannot be confirmed and is reported `intermittent` (0 replays), never dropped.
   */
  readonly openFreshSession?: () => Promise<VerifySession>;
  /** How many fresh-context replays confirm a hang. Default 2. */
  readonly hangReplays?: number;
}

export type GoalBasedOutcome = "succeeded" | "exhausted" | "blocked" | "hang" | "intermittent" | "inconclusive" | "crashed";

export interface GoalBasedResult {
  readonly outcome: GoalBasedOutcome;
  /** Whether the independent assertion held (the ONLY success signal). */
  readonly assertionPassed: boolean;
  readonly run: ExploreRun;
  readonly recording: Recording;
  readonly transcript: TranscriptEntry[];
  readonly finalUrl: string;
  /** The hang finding (with its reproduction k/N), for a `hang`/`intermittent` outcome. */
  readonly hang?: HangFinding;
}

export async function runGoalBasedMission(
  cfg: GoalBasedMissionConfig,
): Promise<GoalBasedResult> {
  const run = await explore({
    ...cfg,
    missionContext:
      "success is judged independently by a user-supplied assertion — your `done` is only a proposal, not the verdict",
  });

  // A hang is a first-class finding: reproduce it in fresh contexts, then report k/N.
  if (run.stop === "hang" && run.hang !== undefined) {
    const h = run.hang;
    const reproduction: HangReproduction =
      cfg.openFreshSession === undefined
        ? { attempts: 0, reproduced: 0, status: "intermittent", runs: [] }
        : await reproduceHang({
            recording: run.recording,
            recordingStepIndex: h.recordingStepIndex,
            hang: h.signal,
            openSession: cfg.openFreshSession,
            ...(cfg.hangReplays === undefined ? {} : { attempts: cfg.hangReplays }),
            perceive: {
              ...(cfg.renderWaitMs === undefined ? {} : { renderWaitMs: cfg.renderWaitMs }),
              ...(cfg.hangProbeMs === undefined ? {} : { hangProbeMs: cfg.hangProbeMs }),
              ...(cfg.requestBoundMs === undefined ? {} : { requestBoundMs: cfg.requestBoundMs }),
            },
            ...(cfg.stallMs === undefined ? {} : { stallMs: cfg.stallMs }),
          });
    const finding = hangFinding(h.signal, run.transcript, h.recordingStepIndex, reproduction);
    return {
      outcome: reproduction.status === "reproduced" ? "hang" : "intermittent",
      assertionPassed: false,
      run,
      recording: run.recording,
      transcript: run.transcript,
      finalUrl: run.finalUrl,
      hang: finding,
    };
  }

  // A broken run proves nothing: its assertion is never evaluated into a pass.
  if (run.stop === "crashed" || run.stop === "inconclusive") {
    return {
      outcome: run.stop,
      assertionPassed: false,
      run,
      recording: run.recording,
      transcript: run.transcript,
      finalUrl: run.finalUrl,
    };
  }

  // Independent oracle: never Jev's self-report. Evaluated against the live page. An oracle that
  // cannot even be evaluated (the page died after the loop ended) is a crash, never a pass.
  let assertionPassed: boolean;
  try {
    assertionPassed = await checkAssertion(cfg.actor, cfg.successAssertion, {
      timeoutMs: cfg.oracleTimeoutMs ?? 3000,
    });
  } catch (e) {
    const message = e instanceof Error ? e.message.split("\n")[0] ?? e.message : String(e);
    const crashedRun: ExploreRun = {
      ...run,
      stop: "crashed",
      failure: { kind: "exception", message: `success oracle failed: ${message}` },
    };
    return {
      outcome: "crashed",
      assertionPassed: false,
      run: crashedRun,
      recording: run.recording,
      transcript: run.transcript,
      finalUrl: run.finalUrl,
    };
  }

  const outcome: GoalBasedOutcome = assertionPassed
    ? "succeeded"
    : run.stop === "exhausted"
      ? "exhausted"
      : "blocked";

  return {
    outcome,
    assertionPassed,
    run,
    recording: run.recording,
    transcript: run.transcript,
    finalUrl: run.finalUrl,
  };
}
