import type { Recording } from "@jevitate/recording";
import { RecordingInterpreter } from "@jevitate/interpreter";
import { perceive, type PerceiveOptions } from "./perceive.js";
import { monitorFor } from "./page-monitor.js";
import { observeAfterStep } from "./record.js";
import { hangFingerprint, type HangKind, type HangSignal } from "./hang.js";
import type { VerifySession } from "./verify-fix.js";
import type { TranscriptEntry } from "./transcript.js";

/**
 * Reproducing a hang (owner ruling 7): when a hang is detected, the steps that led to it are
 * replayed in a FRESH browser context N times (default 2), through the existing Recording
 * interpreter, and the page is examined with the same hang rule. `reproduced k/N`:
 *
 *  - k = N ⇒ `reproduced` — a confirmed hang finding;
 *  - k < N ⇒ `intermittent` — reported with the evidence of every attempt; never dropped, never clean.
 *
 * For `ui-no-progress` found as a stalled state (no busy indicator), "the same hang" means the
 * replay lands on the SAME stalled page state and it stays there for the stall window.
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
  readonly detail: string;
}

export interface HangReproduction {
  readonly attempts: number;
  readonly reproduced: number;
  readonly status: "reproduced" | "intermittent";
  readonly runs: HangAttempt[];
}

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
    return { reproduced: false, kind: null, replay: "failed", detail: `could not open a fresh session: ${firstLine(e)}` };
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
      return { reproduced: false, kind: null, replay: "failed", detail: `replay ${why}` };
    }
    const replay: HangAttempt["replay"] = outcome.kind === "hung" ? "hung" : "completed";

    const seen = await perceive(session.page, p.perceive ?? {});
    const kind = seen.hang?.kind ?? null;
    if (p.hang.kind === "ui-no-progress" && kind !== "ui-no-progress") {
      // A stalled state: the replay must land on the SAME state and stay there.
      const stalled = p.hang.lastState.signature;
      if (seen.snapshot.signature !== stalled) {
        return { reproduced: false, kind, replay, detail: "replay reached a different page state (progress was made)" };
      }
      await (p.sleep ?? realSleep)(p.stallMs ?? DEFAULT_STALL_MS);
      const again = await perceive(session.page, p.perceive ?? {});
      const stuck = again.snapshot.signature === stalled;
      return {
        reproduced: stuck,
        kind: stuck ? "ui-no-progress" : null,
        replay,
        detail: stuck ? "the replay landed on the same stalled state and stayed there" : "the page moved on after the stall window",
      };
    }
    const reproduced = kind === p.hang.kind;
    return {
      reproduced,
      kind,
      replay,
      detail: reproduced ? (seen.hang?.detail ?? p.hang.detail) : kind === null ? "the page settled — no hang" : `a different hang (${kind})`,
    };
  } catch (e) {
    return { reproduced: false, kind: null, replay: "failed", detail: `replay failed: ${firstLine(e)}` };
  } finally {
    await session.close().catch(() => undefined);
  }
}

export async function reproduceHang(p: ReproduceHangParams): Promise<HangReproduction> {
  const attempts = p.attempts ?? DEFAULT_HANG_REPLAYS;
  if (!Number.isInteger(attempts) || attempts < 1) throw new Error(`reproduceHang: attempts must be >= 1, got ${attempts}`);
  const runs: HangAttempt[] = [];
  for (let i = 0; i < attempts; i++) runs.push(await replayAndDetectHang(p));
  const reproduced = runs.filter((r) => r.reproduced).length;
  return { attempts, reproduced, status: reproduced === attempts ? "reproduced" : "intermittent", runs };
}

/** A hang the mission found, with how to reproduce it and how often it did. */
export interface HangFinding {
  readonly fingerprint: string;
  /** Always `hang` (so a finding list can hold defects and hangs); the hang's own kind is `hangKind`. */
  readonly kind: "hang";
  readonly hangKind: HangKind;
  readonly title: string;
  readonly route: string;
  readonly url: string;
  readonly signal: HangSignal;
  readonly firstSeenStep: number;
  /** How many times this same hang (by fingerprint) was hit in the run, and at which steps. */
  readonly occurrences: number;
  readonly occurrenceSteps: number[];
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
}): Promise<void> {
  const fingerprint = hangFingerprint(p.hang);
  const known = p.found.get(fingerprint);
  const step = p.steps.length;
  if (known !== undefined) {
    p.found.set(fingerprint, { ...known, occurrences: known.occurrences + 1, occurrenceSteps: [...known.occurrenceSteps, step] });
    return;
  }
  const index = Math.max(0, p.recording.pages.reduce((n, page) => n + page.steps.length, 0) - 1);
  const reproduction: HangReproduction =
    p.openSession === undefined
      ? { attempts: 0, reproduced: 0, status: "intermittent", runs: [] }
      : await reproduceHang({
          recording: p.recording,
          recordingStepIndex: index,
          hang: p.hang,
          openSession: p.openSession,
          ...(p.attempts === undefined ? {} : { attempts: p.attempts }),
          ...(p.perceive === undefined ? {} : { perceive: p.perceive }),
        });
  const finding = hangFinding(p.hang, p.steps, index, reproduction);
  p.found.set(fingerprint, { ...finding, repro: { ...finding.repro, recording: p.recording } });
}
