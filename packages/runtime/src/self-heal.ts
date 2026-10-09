import type { Step, Recording, RecordedStep } from "@jevitate/recording";
import type { Actor } from "@jevitate/screenplay";
import type { BreakExplanation } from "./change-scope-explain.js";
import type { ChangeEvidenceRef } from "./heal-attempt.js";

/**
 * #453 change-aware self-heal — the deterministic floor and the proof invariant.
 *
 * A heal is a ONE-FOR-ONE retarget of a single broken step: only the step's `target` (a navigate
 * step's `url`) may change. The step's proof — `expect`/`check`/`waitFor`/`state`/`value`, its
 * recorded `expectRequests`, `objective`, every other step and the Journey's end state — is never
 * altered, so a healed run proves exactly what the reviewed Journey proved.
 */

/**
 * Where a broken step stands before any healing:
 *  - `proof`        — the step IS proof (`assert`, `handback`, `forEach`, `waitFor`): never healed.
 *  - `write`        — a write step that is never healed (`select`, `upload`, `editText`, `press`), or a
 *                     click/fill whose recorded `expectRequests` expects a non-GET request.
 *  - `irreversible` — a click/fill whose control the safety classification calls risky (or none was wired).
 *  - `healable`     — may be retargeted. A click/fill is healable only GUARDED (`isGuardedStep`): its
 *                     probe runs under a write blocker and is rejected on any mutating request.
 */
export type HealFloor = "proof" | "write" | "irreversible" | "healable";

/**
 * The risky/irreversible classification of a step's control — the CLI wires `@jevitate/explore`'s
 * `SafetyPolicy` here (runtime stays upstream of explore). Returns the risk ("destructive",
 * "session-end", "paid", "denied", …) or null when the control is not risky.
 */
export type StepRiskClassifier = (step: Step) => string | null;

const PROOF_KINDS = new Set<Step["kind"]>(["assert", "handback", "forEach", "waitFor"]);
const FLOORED_WRITE_KINDS = new Set<Step["kind"]>(["select", "upload", "editText", "press"]);
const GUARDED_KINDS = new Set<Step["kind"]>(["click", "fill"]);
const READ_METHODS = new Set(["GET", "HEAD"]);

/**
 * Mirrors `@jevitate/sources`'s `classifyRisk` per-step-kind judgment (duplicated: runtime stays
 * upstream of sources). The site gate's throttle class reads it; the heal floor is `healFloor`.
 */
const READ_ONLY_STEP_KINDS = new Set<Step["kind"]>(["navigate", "waitFor", "extract", "assert"]);

/** True for every step kind that is not read-only (a click, a fill, a submit…). */
export function isWriteStep(step: Step): boolean {
  return !READ_ONLY_STEP_KINDS.has(step.kind);
}

/** A click/fill: healable only under a write-blocking probe. */
export function isGuardedStep(step: Step): boolean {
  return GUARDED_KINDS.has(step.kind);
}

/** The floor of a broken step, with why. Pure. */
export function healFloor(recorded: RecordedStep, riskOf?: StepRiskClassifier): { floor: HealFloor; reason: string } {
  const step = recorded.step;
  if (PROOF_KINDS.has(step.kind)) return { floor: "proof", reason: `a ${step.kind} step is proof — it is never healed` };
  if (FLOORED_WRITE_KINDS.has(step.kind)) return { floor: "write", reason: `a ${step.kind} step writes — it is never healed` };
  if (isGuardedStep(step)) {
    const write = (recorded.expectRequests ?? []).find((r) => !READ_METHODS.has(r.method.toUpperCase()));
    if (write !== undefined) return { floor: "write", reason: `the step expects a ${write.method.toUpperCase()} ${write.pathGlob} request — a write is never healed` };
    if (riskOf === undefined) return { floor: "irreversible", reason: `no risky-control classification is wired — a ${step.kind} step is not healed` };
    const risk = riskOf(step);
    if (risk !== null) return { floor: "irreversible", reason: `the control is ${risk} — it is never healed` };
  }
  return { floor: "healable", reason: "" };
}

/** A broken proof invariant: why a candidate (or a whole proposed recording) may not replace the original. */
export interface ProofViolation {
  readonly code: "proof-field-changed" | "shape-changed";
  readonly detail: string;
}

/** Deterministic JSON (object keys sorted, undefined dropped) — two values are identical when these agree. */
function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (v !== null && typeof v === "object") {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o)
      .filter((k) => o[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(v) ?? "undefined";
}

/** The step fields a retarget may change: the locator only. */
function retargetableFields(step: Step): ReadonlySet<string> {
  if (step.kind === "navigate") return new Set(["url"]);
  if (step.kind === "click" || step.kind === "fill" || step.kind === "extract") return new Set(["target"]);
  return new Set();
}

/**
 * Null when `after` is a pure retarget of `before`: same kind, and every field but the locator
 * (`target`, or a navigate `url`) identical — `expect`, `check`, `waitFor`, `value`, `label`, ….
 * Otherwise the violation (`shape-changed` for a kind change or a step that cannot be retargeted).
 */
export function assertProofUntouched(before: Step, after: Step): ProofViolation | null {
  if (before.kind !== after.kind) return { code: "shape-changed", detail: `the candidate is a ${after.kind} step; the broken step is a ${before.kind} step` };
  const free = retargetableFields(before);
  if (free.size === 0) return { code: "shape-changed", detail: `a ${before.kind} step cannot be retargeted` };
  const b = before as unknown as Record<string, unknown>;
  const a = after as unknown as Record<string, unknown>;
  for (const k of new Set([...Object.keys(b), ...Object.keys(a)])) {
    if (free.has(k)) continue;
    if (canonical(b[k]) !== canonical(a[k])) return { code: "proof-field-changed", detail: `the candidate changes the step's \`${k}\`` };
  }
  return null;
}

/**
 * As `assertProofUntouched`, for a recorded step: every `RecordedStep` field but `step` must also be
 * identical — #467: including its `stepId` (a retarget never renames, adds or drops a step id).
 */
export function assertRecordedProofUntouched(before: RecordedStep, after: RecordedStep): ProofViolation | null {
  const b = before as unknown as Record<string, unknown>;
  const a = after as unknown as Record<string, unknown>;
  for (const k of new Set([...Object.keys(b), ...Object.keys(a)])) {
    if (k === "step") continue;
    if (canonical(b[k]) !== canonical(a[k])) return { code: "proof-field-changed", detail: `the candidate changes the recorded step's \`${k}\`` };
  }
  return canonical(before.step) === canonical(after.step) ? null : assertProofUntouched(before.step, after.step);
}

/**
 * Null when `proposed` differs from `base` only by retargets: same recording fields, same pages
 * (every page field), the same number of steps on each, each step identical or a pure retarget.
 * What a proposal writer and an accept re-check before a revision may replace a stored recording.
 */
export function assertRecordingProofUntouched(base: Recording, proposed: Recording): ProofViolation | null {
  const { pages: bp, ...bRest } = base;
  const { pages: pp, ...pRest } = proposed;
  if (canonical(bRest) !== canonical(pRest)) return { code: "proof-field-changed", detail: "the revision changes the recording's own fields" };
  if (bp.length !== pp.length) return { code: "shape-changed", detail: `the revision has ${pp.length} pages; the Journey has ${bp.length}` };
  let flat = 0;
  for (let i = 0; i < bp.length; i++) {
    const { steps: bs, ...bPage } = bp[i]!;
    const { steps: ps, ...pPage } = pp[i]!;
    if (canonical(bPage) !== canonical(pPage)) return { code: "proof-field-changed", detail: `the revision changes page ${i + 1}` };
    if (bs.length !== ps.length) return { code: "shape-changed", detail: `the revision has ${ps.length} steps on page ${i + 1}; the Journey has ${bs.length}` };
    for (let j = 0; j < bs.length; j++, flat++) {
      const v = assertRecordedProofUntouched(bs[j]!, ps[j]!);
      if (v !== null) return { code: v.code, detail: `step ${flat + 1}: ${v.detail}` };
    }
  }
  return null;
}

/** Flattens a Recording's pages into a page-then-step-ordered list — the interpreter's flat `at` order. */
export function flattenRecording(rec: Recording): { step: Step; recorded: RecordedStep }[] {
  return rec.pages.flatMap((p) => p.steps.map((s) => ({ step: s.step, recorded: s })));
}

/**
 * `base` with the step at `flatIndex` replaced one-for-one by `step` (its other RecordedStep fields
 * kept — #467: its `stepId` too, so a healed step keeps its id).
 */
export function retargetRecording(base: Recording, flatIndex: number, step: Step): Recording {
  let seen = 0;
  let hit = false;
  const pages = base.pages.map((page) => ({
    ...page,
    steps: page.steps.map((rs) => {
      if (seen++ !== flatIndex) return rs;
      hit = true;
      return { ...rs, step };
    }),
  }));
  if (!hit) throw new Error(`retargetRecording: index ${flatIndex} out of range for a ${seen}-step recording`);
  return { ...base, pages };
}

/** A model-proposed candidate. */
export interface HealerCandidate {
  readonly step: Step;
  readonly hypothesis: string;
}

export interface HealerRequest {
  /** Sitting in the live state right after the last good step. */
  readonly actor: Actor;
  readonly brokenStep: Step;
  /** Why the change explains the break (its deterministic candidates were already tried). */
  readonly explanation: BreakExplanation;
  /** The change facts only (`{kind, before, after, file, line}`) — never a raw hunk. */
  readonly evidence: readonly ChangeEvidenceRef[];
  /** Candidates already tried for this step (sanitised), so the healer proposes something new. */
  readonly tried: readonly Step[];
  readonly allowedOrigins?: readonly string[];
  /**
   * #399: the run's secret parameter values (e.g. a token a navigate URL carried — the live page
   * URL may still hold it). The healer redacts them from everything it sends a model.
   */
  readonly secrets?: readonly string[];
  /** `clock.now()` instant by which the healer must return. */
  readonly deadlineAtMs: number;
  /** The most model calls this request may make. */
  readonly maxModelCalls: number;
}

export interface HealerProposal {
  /** Single-step replacements of the broken step, best first. The runner adjudicates each. */
  readonly candidates: readonly HealerCandidate[];
  readonly usage: { readonly modelCalls: number; readonly tokens?: number };
  readonly reason?: string;
}

/**
 * The model side of a self-heal: proposes single-step candidates for one change-explained broken
 * step. Advisory only — the runner adjudicates every candidate (proof invariant, change evidence,
 * floor, write blocker, the probe). Never consulted for an unexplained break.
 */
export interface SelfHealer {
  /**
   * True when proposing acts on the live page (e.g. a goal mission that clicks). Such a healer is
   * never consulted for a guarded click/fill step: its actions would run outside the write blocker.
   */
  readonly actsOnPage: boolean;
  proposeCandidates(req: HealerRequest): Promise<HealerProposal>;
}
