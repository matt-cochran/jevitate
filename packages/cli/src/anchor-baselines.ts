import { flatJourneySteps, type Journey } from "@jevitate/journey";
import type { CheckBaseline, CheckBaselineAnchor } from "./check-types.js";

/**
 * #469 (contract §4.3): the machine baseline of ONE clean Journey run. Pure — no I/O, no clock.
 * `atMs` of an anchor = milliseconds from the first executed step's start to the anchor step's
 * COMPLETION (its start + duration). Never produced from a run that did not complete.
 *
 * Check integration: after replaying a Journey item, pass the interpreter's outcome plus the per-step
 * `StepTiming`s the run sank (`RecordedStep.timing` + `stepId`, with the flat step `index`) —
 * `baseline: anchorBaseline(journey, { outcome: result.outcome, steps })`.
 */
export interface BaselineRunStep {
  /** The step's 0-based flat position in the Journey (the interpreter's numbering). */
  readonly index: number;
  readonly stepId?: string;
  /** Milliseconds from the run's start to this step's start (`StepTiming.atMs`). */
  readonly atMs: number;
  readonly durationMs: number;
}

export interface BaselineRun {
  /** The interpreter's run outcome; only `completed` yields a baseline. */
  readonly outcome: string;
  /** One entry per step actually executed (skipped steps record none). */
  readonly steps: readonly BaselineRunStep[];
}

export function anchorBaseline(journey: Journey, run: BaselineRun): CheckBaseline | undefined {
  if (run.outcome !== "completed" || run.steps.length === 0) return undefined;
  const firstStart = Math.min(...run.steps.map((s) => s.atMs));
  const end = (s: BaselineRunStep): number => s.atMs - firstStart + s.durationMs;
  const byIndex = new Map(run.steps.map((s) => [s.index, s] as const));
  const flat = flatJourneySteps(journey);
  const totalMs = Math.round(Math.max(...run.steps.map(end)));
  const lastStep = Math.max(...run.steps.map((s) => s.index)) + 1;
  const firstStepNo = Math.min(...run.steps.map((s) => s.index)) + 1;
  const anchors: CheckBaselineAnchor[] = [{ name: "job_start", step: firstStepNo, atMs: 0 }];
  for (const a of journey.metadata.anchors ?? []) {
    const byId = a.stepId === undefined ? -1 : flat.findIndex((f) => f.recorded.stepId === a.stepId);
    const index = byId >= 0 ? byId : a.step - 1;
    const ran = byIndex.get(index);
    if (ran === undefined) continue;
    const stepId = flat[index]?.recorded.stepId;
    anchors.push({ name: a.name, step: index + 1, ...(stepId === undefined ? {} : { stepId }), atMs: Math.round(end(ran)) });
  }
  anchors.push({ name: "job_end", step: lastStep, atMs: totalMs });
  return { steps: run.steps.length, totalMs, anchors };
}
