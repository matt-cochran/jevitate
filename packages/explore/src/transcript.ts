import type { TargetDescriptor } from "@jevitate/recording";
import type { Op } from "./actions.js";
import type { Control, Snapshot } from "./snapshot.js";
import { REDACTION_MASK, redactText, redactUrl } from "./redact.js";
import type { PageTiming, RequestTiming } from "./timing.js";
import type { RunAnswer } from "./answer.js";

/**
 * The transcript's copy of a perception's timing: redacted, and WITHOUT the per-request sample list
 * (count, pending and the slowest requests stay) — the samples feed the run summary only, so a busy
 * page's hundreds of requests are not copied into every transcript file.
 */
/** Redacts every string field of a `TargetDescriptor`, recursively into `container`. */
function redactDescriptor(d: TargetDescriptor, secrets: readonly string[]): TargetDescriptor {
  return {
    ...d,
    ...(d.testId === undefined ? {} : { testId: redactText(d.testId, secrets) }),
    ...(d.role === undefined ? {} : { role: redactText(d.role, secrets) }),
    ...(d.name === undefined ? {} : { name: redactText(d.name, secrets) }),
    ...(d.label === undefined ? {} : { label: redactText(d.label, secrets) }),
    ...(d.text === undefined ? {} : { text: redactText(d.text, secrets) }),
    ...(d.frameUrl === undefined ? {} : { frameUrl: redactText(redactUrl(d.frameUrl), secrets) }),
    ...(d.container === undefined ? {} : { container: redactDescriptor(d.container, secrets) }),
  };
}

function redactAnswer(a: TranscriptAnswer, secrets: readonly string[]): TranscriptAnswer {
  const r = (v: string): string => redactText(v, secrets);
  return {
    text: r(a.text),
    accepted: a.accepted,
    evidence: a.evidence.map((e) => ({
      ...e,
      claim: r(e.claim),
      quote: r(e.quote),
      url: e.url === null ? null : r(redactUrl(e.url)),
      ...(e.why === undefined ? {} : { why: r(e.why) }),
    })),
  };
}

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
  /** For a message sent into a composer (`send`, or a typed field then its Send): the text sent. */
  readonly message?: string;
  /** The conversational reply awaited after the message was sent (redacted, bounded). */
  readonly reply?: TranscriptReply;
  /** True when this step typed into a `type=password` field: its value is never recorded, even synthetic. */
  readonly redacted?: boolean;
  /** For a `report` (#101): the proposed answer, whether code accepted it, and each claim's evidence. */
  readonly answer?: TranscriptAnswer;
  /**
   * The value a `type`/`select` step entered (#98), redacted: registered secrets are masked, a
   * bound secret field shows only its placeholder, and a `type=password` field's value is never
   * recorded (the mask stands in, even for a synthetic value).
   */
  readonly value?: string;
  /**
   * The chosen control's durable, replay-valid descriptor (redacted, same as
   * every other field here) — additive (#81/#85): a failed action never
   * becomes a Recording step (only successful ones are), so this is the only
   * place a blocked/disabled target's structural identity survives the run.
   * Consumed by `regression capture --result` to build a failure oracle and
   * by offline `ux --result` to see the same blocked-action evidence a live
   * usability run sees.
   */
  readonly descriptor?: TargetDescriptor;
  /** The acted control's resolved `href` (redacted, path only), when it was a link. #127. */
  readonly href?: string | null;
  /** The acted control's raw `aria-current` attribute, or null. #127. */
  readonly ariaCurrent?: string | null;
}

/** What came back after a message was sent. */
export interface TranscriptReply {
  readonly received: boolean;
  readonly text: string;
  readonly waitedMs: number;
  /** Why the reply wait ended (#93): the reply held still, the page went idle, or the ceiling passed. */
  readonly endedBy?: "reply" | "idle" | "ceiling";
}

/** A reported answer as the transcript keeps it (redacted). */
export interface TranscriptAnswer extends RunAnswer {
  readonly accepted: boolean;
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
  readonly message?: string;
  readonly reply?: TranscriptReply;
  readonly redacted?: boolean;
  /** The value typed/selected (redacted by `record`; see `TranscriptEntry.value`). */
  readonly value?: string;
  readonly answer?: TranscriptAnswer;
}

/**
 * Receives every entry the moment it is recorded — the incremental-flush seam: a caller persists
 * the transcript step by step so a run that dies mid-way (browser crash, killed process) still
 * leaves every step up to the failure on disk.
 */
export type TranscriptListener = (entry: TranscriptEntry, all: readonly TranscriptEntry[]) => void;

function isPasswordControl(c: Control | null): boolean {
  return c !== null && (c.inputType ?? "").toLowerCase() === "password";
}

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
      ...(step.message === undefined ? {} : { message: redactText(step.message, this.#secrets) }),
      ...(step.reply === undefined ? {} : { reply: { ...step.reply, text: redactText(step.reply.text, this.#secrets) } }),
      ...(step.redacted === true ? { redacted: true } : {}),
      ...(step.value === undefined
        ? {}
        : { value: step.redacted === true || isPasswordControl(step.control) ? REDACTION_MASK : redactText(step.value, this.#secrets) }),
      ...(step.answer === undefined ? {} : { answer: redactAnswer(step.answer, this.#secrets) }),
      ...(step.control === null ? {} : { descriptor: redactDescriptor(step.control.descriptor, this.#secrets) }),
      ...(step.control?.href === undefined ? {} : { href: step.control.href }),
      ...(step.control?.ariaCurrent === undefined ? {} : { ariaCurrent: step.control.ariaCurrent }),
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
