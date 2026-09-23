import type { Op } from "./actions.js";
import type { Control, Snapshot } from "./snapshot.js";
import { redactText, redactUrl } from "./redact.js";
import type { PageTiming, RequestTiming } from "./timing.js";

/**
 * The transcript's copy of a perception's timing: redacted, and WITHOUT the per-request sample list
 * (count, pending and the slowest requests stay) — the samples feed the run summary only, so a busy
 * page's hundreds of requests are not copied into every transcript file.
 */
function transcriptTiming(t: PageTiming, secrets: readonly string[]): PageTiming {
  const r = (v: string): string => (secrets.length === 0 ? v : redactText(v, secrets));
  const req = (q: RequestTiming): RequestTiming => ({ ...q, endpoint: r(q.endpoint), url: r(q.url) });
  return {
    ...t,
    route: r(t.route),
    requests: { ...t.requests, slowest: t.requests.slowest.map(req), samples: [] },
  };
}

/**
 * The decision transcript — ONE shape and ONE builder shared by every mission that acts on a
 * page (goal/usability explore, adversarial, induction/coverage), so any run that stalls or
 * fails is explainable after the fact: what was perceived, what was chosen (and by whom), what
 * the model judged, and whether the action landed.
 *
 * Every page-derived string (control summary, URL, reason) passes through the shared redaction
 * seam before it is stored, so a transcript is safe to persist next to its Recording.
 */

/** Who chose a step's action: the model (a Jev choice) or a deterministic mission strategy. */
export type ChosenBy = "model" | "strategy";

/** An advisory model judgment recorded at a step (never a gate — guardrail #4). */
export interface TranscriptJudgment {
  readonly value: boolean;
  readonly probability: number;
}

export interface TranscriptEntry {
  readonly step: number;
  /** The op executed; `null` when the mission's strategy found no applicable action this step. */
  readonly op: Op | null;
  readonly target: string | null;
  /** The model's confidence in the chosen action; `null` when a deterministic strategy chose it. */
  readonly confidence: number | null;
  readonly chosenBy: ChosenBy;
  /** The mission strategy that chose the action (e.g. an adversarial misuse strategy). */
  readonly strategy?: string;
  readonly actOk: boolean;
  readonly reason?: string;
  readonly url: string;
  readonly signature: string;
  /** Interactive controls perceived on the page when this step was decided. */
  readonly controlCount: number;
  /** Advisory model judgments made at this step, by question name (e.g. `looksBroken`). */
  readonly judgments?: Readonly<Record<string, TranscriptJudgment>>;
  /**
   * How the page reached the state this step was decided on — navigation/transition timing and its
   * network (owner ruling 6). A measurement, never a verdict.
   */
  readonly timing?: PageTiming;
}

export interface TranscriptStep {
  readonly op: Op | null;
  readonly control: Control | null;
  readonly confidence: number | null;
  readonly chosenBy: ChosenBy;
  readonly strategy?: string;
  readonly actOk: boolean;
  readonly reason?: string;
  /** The snapshot the step was decided on. */
  readonly snapshot: Snapshot;
  readonly judgments?: Readonly<Record<string, TranscriptJudgment>>;
  /** The timing of the perception that produced `snapshot`. */
  readonly timing?: PageTiming;
}

/**
 * Receives every entry the moment it is recorded — the incremental-flush seam: a caller persists
 * the transcript step by step so a run that dies mid-way (browser crash, killed process) still
 * leaves every step up to the failure on disk.
 */
export type TranscriptListener = (entry: TranscriptEntry, all: readonly TranscriptEntry[]) => void;

/** Append-only, redacting transcript builder. Steps are numbered from 1 in record order. */
export class TranscriptLog {
  readonly #entries: TranscriptEntry[] = [];
  readonly #secrets: readonly string[];
  readonly #listener: TranscriptListener | undefined;

  constructor(secrets: readonly string[] = [], listener?: TranscriptListener) {
    this.#secrets = secrets;
    this.#listener = listener;
  }

  record(step: TranscriptStep): TranscriptEntry {
    const entry: TranscriptEntry = {
      step: this.#entries.length + 1,
      op: step.op,
      target: step.control === null ? null : redactText(step.control.summary, this.#secrets),
      confidence: step.confidence,
      chosenBy: step.chosenBy,
      ...(step.strategy === undefined ? {} : { strategy: step.strategy }),
      actOk: step.actOk,
      ...(step.reason === undefined ? {} : { reason: redactText(step.reason, this.#secrets) }),
      url: redactText(redactUrl(step.snapshot.url), this.#secrets),
      signature: step.snapshot.signature,
      controlCount: step.snapshot.controls.length,
      ...(step.judgments === undefined ? {} : { judgments: step.judgments }),
      ...(step.timing === undefined ? {} : { timing: transcriptTiming(step.timing, this.#secrets) }),
    };
    this.#entries.push(entry);
    this.#listener?.(entry, this.#entries);
    return entry;
  }

  /** The number of the next step to be recorded. */
  get nextStep(): number {
    return this.#entries.length + 1;
  }

  entries(): TranscriptEntry[] {
    return [...this.#entries];
  }
}
