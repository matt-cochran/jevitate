import { AsyncLocalStorage } from "node:async_hooks";
import { clock } from "./clock.js";

/**
 * #852 (E1): where a run's wall time goes, by phase. A surface that runs something (`journey run`,
 * a `check` item) opens a recorder with {@link withPhaseRecorder}; code on that run's async path
 * wraps a phase's work in {@link timePhase}. Nothing is threaded through signatures, and with no
 * recorder open every call is a plain pass-through, so instrumented code costs nothing elsewhere.
 *
 * Phases nest: time spent in an inner phase is charged to the inner one only (self time), so the
 * phases never double-count and their sum never exceeds the wall time. What no phase claimed is
 * `unattributedMs`, reported explicitly: the acceptance for #852 is that it stays small.
 */
export const PHASES = [
  "prepare",
  "siteGate",
  "fixtures",
  "login",
  "browserOpen",
  "stepAction",
  "stepCheck",
  "stepPace",
  "doneCheck",
  "teardown",
  "report",
] as const;
export type Phase = (typeof PHASES)[number];

export interface PhaseTimings {
  /** Wall time of the whole recorded run, ms. */
  readonly totalMs: number;
  /** Self time per phase, ms; a phase that never ran is absent. */
  readonly phases: Partial<Record<Phase, number>>;
  /** `totalMs` less every phase: time no phase claimed (CLI setup, result assembly, process work). */
  readonly unattributedMs: number;
}

interface Frame {
  readonly phase: Phase;
  readonly startedAt: number;
  childMs: number;
}

export class PhaseRecorder {
  readonly #startedAt: number;
  readonly #totals = new Map<Phase, number>();
  #endedAt: number | undefined;

  constructor() {
    this.#startedAt = clock.monotonicMs();
  }

  /** Charge `selfMs` of finished work to `phase`. */
  add(phase: Phase, selfMs: number): void {
    if (!(selfMs > 0)) return;
    this.#totals.set(phase, (this.#totals.get(phase) ?? 0) + selfMs);
  }

  /** Stops the wall clock (idempotent); later phases are still charged, `totalMs` stays fixed. */
  end(): void {
    this.#endedAt ??= clock.monotonicMs();
  }

  snapshot(): PhaseTimings {
    const totalMs = Math.max(0, (this.#endedAt ?? clock.monotonicMs()) - this.#startedAt);
    const phases: Partial<Record<Phase, number>> = {};
    let claimed = 0;
    for (const phase of PHASES) {
      const ms = this.#totals.get(phase);
      if (ms === undefined) continue;
      phases[phase] = Math.round(ms);
      claimed += ms;
    }
    return { totalMs: Math.round(totalMs), phases, unattributedMs: Math.max(0, Math.round(totalMs - claimed)) };
  }
}

interface Context {
  readonly recorder: PhaseRecorder;
  readonly stack: Frame[];
}

const current = new AsyncLocalStorage<Context>();

/** Runs `fn` with `recorder` open for everything on its async path. */
export function withPhaseRecorder<T>(recorder: PhaseRecorder, fn: () => Promise<T>): Promise<T> {
  return current.run({ recorder, stack: [] }, fn);
}

/** The recorder open on this async path, if any. */
export function activePhaseRecorder(): PhaseRecorder | undefined {
  return current.getStore()?.recorder;
}

/**
 * Times `fn` as `phase` on the open recorder (self time: an inner `timePhase` is subtracted). With no
 * recorder open it just runs `fn`. The phase is charged whether `fn` resolves or throws.
 */
export async function timePhase<T>(phase: Phase, fn: () => Promise<T>): Promise<T> {
  const ctx = current.getStore();
  if (ctx === undefined) return fn();
  const parent = ctx.stack[ctx.stack.length - 1];
  const frame: Frame = { phase, startedAt: clock.monotonicMs(), childMs: 0 };
  // Each timed call gets its own stack copy, so concurrent phases on one recorder never interleave frames.
  const stack = [...ctx.stack, frame];
  try {
    return await current.run({ recorder: ctx.recorder, stack }, fn);
  } finally {
    const elapsed = clock.monotonicMs() - frame.startedAt;
    ctx.recorder.add(phase, elapsed - frame.childMs);
    if (parent !== undefined) parent.childMs += elapsed;
  }
}
