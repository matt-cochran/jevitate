import type { Recording } from "@jevitate/recording";
import { RecordingInterpreter } from "@jevitate/interpreter";
import { perceive, type PerceiveOptions } from "./perceive.js";
import { monitorFor } from "./page-monitor.js";
import { observeAfterStep } from "./record.js";
import { hangFingerprint, type HangKind, type HangSignal } from "./hang.js";
import { messageClass } from "./adversarial/defect-fingerprint.js";
import type { VerifySession } from "./verify-fix.js";
import type { TranscriptEntry } from "./transcript.js";
import type { MissionOutcome } from "@jevitate/domain";
import { hostProbe, type HostProbe } from "./host-pressure.js";

/**
 * Reproducing a hang (owner ruling 7): when a hang is detected, the steps that led to it are
 * replayed in a FRESH browser context N times (default 2), through the existing Recording
 * interpreter, and the page is examined with the same hang rule. `reproduced k/N`, where only an
 * attempt that actually RAN counts as evidence either way:
 *
 *  - k ≥ 1 ⇒ `reproduced` — a confirmed hang finding;
 *  - k = 0 and at least one attempt ran fully ⇒ `intermittent` — seen once, not again;
 *  - no attempt ran (the fresh session could not open, the replay itself failed before reaching the
 *    step) ⇒ `inconclusive` — a replay that never ran is NOT a non-reproduction.
 *
 * Every attempt's evidence is kept; the finding is never dropped and never reported clean.
 *
 * `ui-no-progress` has two sub-kinds, told apart by `HangSignal.element` (#108):
 *
 *  - a BUSY-INDICATOR hang (`element` set — a spinner/progressbar that never cleared): "the same
 *    hang" means THAT indicator (by its normalized identity) is visible again after the replay. A
 *    settled page with a stable signature is not evidence either way — it is what a genuinely
 *    fixed page looks like, so it can never alone read as reproduced;
 *  - a STALLED-STATE hang (`element` undefined — an action whose result undid itself, #79/#80): "the
 *    same hang" means the replay lands on the SAME page signature and stays there for the stall
 *    window.
 */

export const DEFAULT_HANG_REPLAYS = 2;
/** How long a replayed page must stay stuck to count as the same no-progress hang (ms). */
export const DEFAULT_STALL_MS = 8_000;

export interface HangAttempt {
  readonly reproduced: boolean;
  /** The hang kind the replay showed (null: none). */
  readonly kind: HangKind | null;
  /** How the replay itself went. */
  readonly replay: "completed" | "failed" | "hung";
  /**
   * Did the attempt actually RUN — replay the recorded steps up to the hang and examine the page?
   * False when the session could not open or the replay failed before the step: no evidence.
   */
  readonly ran: boolean;
  readonly detail: string;
}

export type ReproductionStatus = "reproduced" | "intermittent" | "inconclusive";

export interface HangReproduction {
  readonly attempts: number;
  /** Attempts that actually ran (the rest could not execute and prove nothing). */
  readonly ran: number;
  readonly reproduced: number;
  readonly status: ReproductionStatus;
  readonly runs: HangAttempt[];
}

/** The status rule (pure): any reproduction confirms; a run that ran clean is intermittent; else inconclusive. */
export function reproductionStatus(runs: readonly Pick<HangAttempt, "reproduced" | "ran">[]): ReproductionStatus {
  if (runs.some((r) => r.reproduced)) return "reproduced";
  if (runs.some((r) => r.ran)) return "intermittent";
  return "inconclusive";
}

/** A reproduction's status as a mission outcome. */
export function hangOutcome(status: ReproductionStatus): MissionOutcome {
  return status === "reproduced" ? "hang" : status;
}

/** No replay could be attempted at all (no way to open a fresh session): nothing ran. */
export const NOT_REPLAYED: HangReproduction = { attempts: 0, ran: 0, reproduced: 0, status: "inconclusive", runs: [] };

export interface ReproduceHangParams {
  readonly recording: Recording;
  /** Flat index of the last Recording step to replay (the step that led to the hang). */
  readonly recordingStepIndex: number;
  readonly hang: HangSignal;
  /** Opens a FRESH browser session for each attempt. */
  readonly openSession: () => Promise<VerifySession>;
  readonly attempts?: number;
  /** The perception bounds used to re-detect the hang (the same rule the mission used). */
  readonly perceive?: PerceiveOptions;
  /** For a stalled-state `ui-no-progress`: how long the state must stay stuck. */
  readonly stallMs?: number;
  /** Bound on the replay itself (a hung page can block a step). Default 60s. */
  readonly replayBoundMs?: number;
  /** Sleep seam for the stall window (default: a real timer). */
  readonly sleep?: (ms: number) => Promise<void>;
}

function firstLine(e: unknown): string {
  return e instanceof Error ? e.message.split("\n")[0] ?? e.message : String(e);
}

const realSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** One attempt: fresh session → replay → re-detect. Never throws. */
export async function replayAndDetectHang(p: ReproduceHangParams): Promise<HangAttempt> {
  let session: VerifySession;
  try {
    session = await p.openSession();
  } catch (e) {
    return { reproduced: false, kind: null, replay: "failed", ran: false, detail: `could not open a fresh session: ${firstLine(e)}` };
  }
  try {
    await monitorFor(session.page).instrument();
    const bound = p.replayBoundMs ?? 60_000;
    let timer: ReturnType<typeof setTimeout> | undefined;
    // Replay up to the step that led to the hang, then OBSERVE (that step's own postcondition is not
    // the verdict — the hang rule applied afterwards is).
    const replayP = new RecordingInterpreter().runToCheckpoint(
      session.actor,
      observeAfterStep(p.recording, p.recordingStepIndex),
      p.recordingStepIndex,
    );
    replayP.catch(() => undefined);
    const outcome = await Promise.race([
      replayP.then((r) => ({ kind: "done" as const, r })),
      new Promise<{ kind: "hung" }>((resolve) => {
        timer = setTimeout(() => resolve({ kind: "hung" }), bound);
      }),
    ]).finally(() => {
      if (timer !== undefined) clearTimeout(timer);
    });
    if (outcome.kind === "done" && outcome.r.outcome !== "completed") {
      const why =
        outcome.r.outcome === "failed"
          ? `failed at step ${outcome.r.at}${outcome.r.reason === undefined ? "" : ` (${outcome.r.reason})`}: ${outcome.r.error.split("\n")[0]}`
          : "paused for a hand-back";
      return { reproduced: false, kind: null, replay: "failed", ran: false, detail: `replay ${why}` };
    }
    const replay: HangAttempt["replay"] = outcome.kind === "hung" ? "hung" : "completed";

    const seen = await perceive(session.page, p.perceive ?? {});
    const kind = seen.hang?.kind ?? null;
    if (p.hang.kind === "ui-no-progress" && p.hang.element !== undefined) {
      // A busy-indicator hang (#108): reproduction requires THAT indicator to be visible again.
      // A stable, settled page signature alone proves nothing — it is exactly what a fixed page
      // looks like, so the same-signature rule below must never decide this sub-kind.
      const wantElement = messageClass(p.hang.element);
      const backAgain = kind === "ui-no-progress" && seen.hang?.element !== undefined && messageClass(seen.hang.element) === wantElement;
      return {
        reproduced: backAgain,
        kind: backAgain ? "ui-no-progress" : kind,
        replay,
        ran: true,
        detail: backAgain
          ? `busy-indicator rule: the indicator (${seen.hang?.element ?? p.hang.element}) is back — ${seen.hang?.detail ?? p.hang.detail}`
          : kind === null
            ? `busy-indicator rule: the indicator (${p.hang.element}) is gone and the page settled — fixed`
            : kind === "ui-no-progress"
              ? `busy-indicator rule: a different busy indicator (${seen.hang?.element ?? "unknown"}), not the one that hung`
              : `busy-indicator rule: no busy indicator, a different hang (${kind}) instead`,
      };
    }
    if (p.hang.kind === "ui-no-progress" && kind !== "ui-no-progress") {
      // A stalled state (no busy indicator, #79/#80): the replay must land on the SAME state and
      // stay there.
      const stalled = p.hang.lastState.signature;
      if (seen.snapshot.signature !== stalled) {
        return { reproduced: false, kind, replay, ran: true, detail: "stalled-state rule: replay reached a different page state (progress was made)" };
      }
      await (p.sleep ?? realSleep)(p.stallMs ?? DEFAULT_STALL_MS);
      const again = await perceive(session.page, p.perceive ?? {});
      const stuck = again.snapshot.signature === stalled;
      return {
        reproduced: stuck,
        kind: stuck ? "ui-no-progress" : null,
        replay,
        ran: true,
        detail: stuck
          ? "stalled-state rule: the replay landed on the same stalled state and stayed there"
          : "stalled-state rule: the page moved on after the stall window",
      };
    }
    const reproduced = kind === p.hang.kind;
    return {
      reproduced,
      kind,
      replay,
      ran: true,
      detail: reproduced ? (seen.hang?.detail ?? p.hang.detail) : kind === null ? "same-kind rule: the page settled — no hang" : `same-kind rule: a different hang (${kind})`,
    };
  } catch (e) {
    return { reproduced: false, kind: null, replay: "failed", ran: false, detail: `replay failed: ${firstLine(e)}` };
  } finally {
    await session.close().catch(() => undefined);
  }
}

export async function reproduceHang(p: ReproduceHangParams): Promise<HangReproduction> {
  const attempts = p.attempts ?? DEFAULT_HANG_REPLAYS;
  if (!Number.isInteger(attempts) || attempts < 1) throw new Error(`reproduceHang: attempts must be >= 1, got ${attempts}`);
  const runs: HangAttempt[] = [];
  for (let i = 0; i < attempts; i++) runs.push(await replayAndDetectHang(p));
  return {
    attempts,
    ran: runs.filter((r) => r.ran).length,
    reproduced: runs.filter((r) => r.reproduced).length,
    status: reproductionStatus(runs),
    runs,
  };
}

/** A hang the mission found, with how to reproduce it and how often it did. */
export interface HangFinding {
  readonly fingerprint: string;
  /** Always `hang` (so a finding list can hold defects and hangs); the hang's own kind is `hangKind`. */
  readonly kind: "hang";
  readonly hangKind: HangKind;
  readonly title: string;
  /** The route it was FIRST seen on. */
  readonly route: string;
  readonly url: string;
  readonly signal: HangSignal;
  readonly firstSeenStep: number;
  /** How many times this same hang (by fingerprint) was hit in the run, and at which steps. */
  readonly occurrences: number;
  readonly occurrenceSteps: number[];
  /**
   * Every DISTINCT route this same hang (by fingerprint) was seen on, first-seen order (#87): a
   * global element (e.g. a shared layout widget) hanging on many routes is ONE finding that lists
   * every route it was met on, never one finding per route.
   */
  readonly routes: string[];
  /**
   * `recording` is set when the hang was found after the mission RESET (a fresh page): the steps to
   * replay are then this segment's own Recording, not the run's first one.
   */
  readonly repro: { readonly steps: TranscriptEntry[]; readonly recordingStepIndex: number; readonly recording?: Recording };
  readonly reproduction: HangReproduction;
}

/** Assembles a hang finding (its identity, title and repro) from what the mission saw. */
export function hangFinding(
  signal: HangSignal,
  steps: readonly TranscriptEntry[],
  recordingStepIndex: number,
  reproduction: HangReproduction,
): HangFinding {
  return {
    fingerprint: hangFingerprint(signal),
    kind: "hang",
    hangKind: signal.kind,
    title: `Hang (${signal.kind}) on ${signal.route}: ${signal.detail}`,
    route: signal.route,
    url: signal.url,
    signal,
    firstSeenStep: steps.length,
    occurrences: 1,
    occurrenceSteps: [steps.length],
    routes: [signal.route],
    // The repro is the ordered steps; their timing stays in the run transcript.
    repro: {
      steps: steps.map((e): TranscriptEntry => {
        const { timing: _timing, ...step } = e;
        return step;
      }),
      recordingStepIndex,
    },
    reproduction,
  };
}

/**
 * Records a hang met by a COVERAGE mission (induction / feature) into its deduped set: a new
 * fingerprint is reproduced by replaying `recording` (the path that led to it) in fresh contexts; a
 * known one is one more occurrence. The caller then resets and keeps exploring the frontier.
 */
export async function recordCoverageHang(p: {
  readonly hang: HangSignal;
  readonly recording: Recording;
  readonly steps: readonly TranscriptEntry[];
  readonly found: Map<string, HangFinding>;
  readonly openSession?: () => Promise<VerifySession>;
  readonly attempts?: number;
  readonly perceive?: PerceiveOptions;
  /** Samples the host's resource pressure for the evidence. Default: this platform's signals. */
  readonly hostProbe?: HostProbe;
}): Promise<void> {
  const fingerprint = hangFingerprint(p.hang);
  const known = p.found.get(fingerprint);
  const step = p.steps.length;
  if (known !== undefined) {
    // Already confirmed (or being confirmed): no replay budget spent again — just one more
    // occurrence, and the route added when it is a new one ("also seen on <route>", #87).
    p.found.set(fingerprint, {
      ...known,
      occurrences: known.occurrences + 1,
      occurrenceSteps: [...known.occurrenceSteps, step],
      routes: known.routes.includes(p.hang.route) ? known.routes : [...known.routes, p.hang.route],
    });
    return;
  }
  const index = Math.max(0, p.recording.pages.reduce((n, page) => n + page.steps.length, 0) - 1);
  const hang: HangSignal = { ...p.hang, host: await (p.hostProbe ?? hostProbe())() };
  const reproduction: HangReproduction =
    p.openSession === undefined
      ? NOT_REPLAYED
      : await reproduceHang({
          recording: p.recording,
          recordingStepIndex: index,
          hang,
          openSession: p.openSession,
          ...(p.attempts === undefined ? {} : { attempts: p.attempts }),
          ...(p.perceive === undefined ? {} : { perceive: p.perceive }),
        });
  const finding = hangFinding(hang, p.steps, index, reproduction);
  p.found.set(fingerprint, { ...finding, repro: { ...finding.repro, recording: p.recording } });
}
