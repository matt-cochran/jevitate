import { z } from "zod";
import type { RecordedStep, Step } from "@jevitate/recording";
import { describeNavigateUrl } from "@jevitate/recording";
import type { Journey } from "./journey.js";

/**
 * #246 — Journey intent helpers: step coverage, which parameters are secret, and the annotation
 * DRAFT a model proposes on playback (`jevitate journey annotate`) — a sidecar file that a human
 * reviews and approves before anything is written into the Journey.
 */

/** One top-level step as the interpreter numbers it: `index` is its 0-based flat position. */
export interface FlatJourneyStep {
  readonly index: number;
  readonly page: number;
  readonly recorded: RecordedStep;
}

/** The Journey's top-level steps in replay order (page 0's first), the interpreter's flat index. */
export function flatJourneySteps(journey: Journey): FlatJourneyStep[] {
  const out: FlatJourneyStep[] = [];
  journey.recording.pages.forEach((p, page) => {
    for (const recorded of p.steps) out.push({ index: out.length, page, recorded });
  });
  return out;
}

export interface IntentCoverage {
  readonly steps: number;
  readonly withObjective: number;
  readonly withoutObjective: number;
  readonly withExpectedResult: number;
  readonly hasGoal: boolean;
}

/** How much of the Journey says why (informational only — never a failure). */
export function intentCoverage(journey: Journey): IntentCoverage {
  const steps = flatJourneySteps(journey);
  const withObjective = steps.filter((s) => (s.recorded.objective ?? "").trim() !== "").length;
  return {
    steps: steps.length,
    withObjective,
    withoutObjective: steps.length - withObjective,
    withExpectedResult: steps.filter((s) => (s.recorded.expectedResult ?? "").trim() !== "").length,
    hasGoal: (journey.metadata.goal ?? "").trim() !== "",
  };
}

/**
 * A parameter NAME that reads as a credential. Defense in depth for Journeys that declare no
 * `parameters`: such a `--param` value is redacted as if it were marked `secret: true`.
 */
export const SECRET_PARAM_NAME_RE = /pass(word|code|phrase)?|secret|token|api[_-]?key|otp|pin\b|credential|session|cookie/i;

/** The parameter names whose values are secret: declared `secret: true`, or a credential-like name. */
export function secretParamNames(journey: Journey, params: Readonly<Record<string, string>> = {}): string[] {
  const names = new Set<string>();
  for (const p of journey.metadata.parameters ?? []) {
    if (p.secret === true || SECRET_PARAM_NAME_RE.test(p.name)) names.add(p.name);
  }
  for (const n of [...journey.metadata.params, ...Object.keys(params)]) {
    if (SECRET_PARAM_NAME_RE.test(n)) names.add(n);
  }
  return [...names].sort();
}

/** The non-blank VALUES of the secret parameters in `params` — what every sink redacts. */
export function secretParamValues(journey: Journey, params: Readonly<Record<string, string>>): string[] {
  return secretParamNames(journey, params)
    .map((n) => params[n])
    .filter((v): v is string => typeof v === "string" && v.trim() !== "");
}

/** A short, value-free description of a step for people and models (a fill shows `<param x>`, never a secret). */
export function describeStep(step: Step): string {
  const label = step.label === undefined ? "" : ` (${step.label})`;
  switch (step.kind) {
    case "navigate":
      return `navigate to ${describeNavigateUrl(step.url)}${label}`;
    case "click":
      return `click ${describeTarget(step.target)}${label}`;
    case "fill":
      return `fill ${describeTarget(step.target)} with ${describeValue(step.value)}${label}`;
    case "select":
      return `select ${describeValue(step.value)} in ${describeTarget(step.target)}${label}`;
    case "upload":
      return `upload a file to ${describeTarget(step.target)}${label}`;
    case "press":
      return `press ${step.key}${label}`;
    case "editText":
      return `edit text in ${describeTarget(step.target)} (${step.action})${label}`;
    case "waitFor":
      return `wait for ${describeTarget(step.target)} to be ${step.state}${label}`;
    case "extract":
      return `read ${describeTarget(step.target)} as ${step.as}${label}`;
    case "forEach":
      return `for each ${describeTarget(step.items)}: ${step.steps.length} step(s)${label}`;
    case "assert":
      return `check ${step.check.kind}${label}`;
    case "handback":
      return `hand back to a person${label}`;
  }
}

function describeTarget(t: { testId?: string; role?: string; name?: string; label?: string; text?: string; css?: string }): string {
  if (t.role !== undefined && t.name !== undefined) return `${t.role} "${t.name}"`;
  if (t.label !== undefined) return `field "${t.label}"`;
  if (t.text !== undefined) return `"${t.text}"`;
  if (t.testId !== undefined) return `[data-testid=${t.testId}]`;
  if (t.role !== undefined) return t.role;
  return t.css ?? "an element";
}

function describeValue(v: { var: string } | { redacted: true; length: number } | { redacted: false; value: string }): string {
  if ("var" in v) return `<param ${v.var}>`;
  if (v.redacted) return "«redacted»";
  return `"${v.value}"`;
}

// ── The annotation draft (sidecar) ────────────────────────────────────────────────────────────

const DRAFT_TEXT = z.string().max(2000);

const PageEvidenceSchema = z.object({ url: z.string().max(2000), heading: z.string().max(500) }).strict();

export const AnnotationDraftStepSchema = z.object({
  index: z.number().int().nonnegative(),
  /** The step as described when drafted (review aid; never applied). */
  step: z.string().max(1000),
  objective: DRAFT_TEXT.optional(),
  expectedResult: DRAFT_TEXT.optional(),
  /** Redacted before/after page evidence the draft was made from (review aid; never applied). */
  evidence: z.object({ before: PageEvidenceSchema.nullable(), after: PageEvidenceSchema.nullable() }).strict().optional(),
}).strict();

/**
 * `<journeys>/.drafts/<id>.annotations.json` — what `journey annotate` proposes. It may be edited by
 * hand; `journey annotate <id> --approve` applies it only while `journeyHash` still matches.
 */
export const AnnotationDraftSchema = z.object({
  kind: z.literal("jevitate.journey-annotations.draft"),
  version: z.literal(1),
  journeyId: z.string(),
  /** contentHash of the Journey the draft was made from — approval refuses a changed Journey. */
  journeyHash: z.string().regex(/^[0-9a-f]{64}$/),
  createdAtIso: z.string(),
  /** Where the text came from (`fake`, `openrouter`, `human`) and the prompt version. */
  provenance: z.object({ adapter: z.string(), model: z.string(), promptVersion: z.string() }).strict(),
  replay: z.object({
    outcome: z.enum(["completed", "stopped"]),
    reachedSteps: z.number().int().nonnegative(),
    totalSteps: z.number().int().nonnegative(),
    reason: z.string().max(2000).optional(),
  }).strict(),
  goal: DRAFT_TEXT.optional(),
  successCriteria: z.array(DRAFT_TEXT).max(20).optional(),
  steps: z.array(AnnotationDraftStepSchema).max(1000),
}).strict();
export type AnnotationDraft = z.infer<typeof AnnotationDraftSchema>;
export type AnnotationDraftStep = z.infer<typeof AnnotationDraftStepSchema>;

/** One field an approval changes: `before` is absent when the Journey had none. */
export interface AnnotationChange {
  readonly field: "goal" | "successCriteria" | "objective" | "expectedResult";
  /** Flat step index (absent for Journey-level fields). */
  readonly index?: number;
  readonly step?: string;
  readonly before?: string;
  readonly after: string;
}

export class AnnotationDraftMismatchError extends Error {}

/**
 * Applies an approved draft to its Journey (pure — the caller persists). Journey-level text goes
 * into `metadata.goal` / `metadata.successCriteria` (a drafted criterion carries no `check`: the
 * code check stays the recording's own assertions); step text into each `RecordedStep`. A draft
 * naming a step the Journey does not have is refused, never partially applied. Nothing but these
 * four intent fields ever changes — not `promoted`, not a step's action or assertion.
 */
export function applyAnnotationDraft(journey: Journey, draft: AnnotationDraft): { journey: Journey; changes: AnnotationChange[] } {
  const flat = flatJourneySteps(journey);
  const byIndex = new Map(draft.steps.map((s) => [s.index, s]));
  for (const i of byIndex.keys()) {
    if (flat[i] === undefined) throw new AnnotationDraftMismatchError(`draft names step ${i}, but the Journey has ${flat.length} step(s)`);
  }
  const changes: AnnotationChange[] = [];
  const metadata = { ...journey.metadata };
  const goal = draft.goal?.trim();
  if (goal !== undefined && goal !== "" && goal !== metadata.goal) {
    changes.push({ field: "goal", ...(metadata.goal === undefined ? {} : { before: metadata.goal }), after: goal });
    metadata.goal = goal;
  }
  const criteria = (draft.successCriteria ?? []).map((c) => c.trim()).filter((c) => c !== "");
  if (criteria.length > 0) {
    const before = (metadata.successCriteria ?? []).map((c) => c.description);
    if (before.join("\n") !== criteria.join("\n")) {
      changes.push({ field: "successCriteria", ...(before.length === 0 ? {} : { before: before.join("; ") }), after: criteria.join("; ") });
      // Keep a code check a criterion already had when its text is unchanged.
      const checks = new Map((metadata.successCriteria ?? []).map((c) => [c.description, c.check]));
      metadata.successCriteria = criteria.map((description) => {
        const check = checks.get(description);
        return check === undefined ? { description } : { description, check };
      });
    }
  }
  let n = 0;
  const pages = journey.recording.pages.map((p) => ({
    ...p,
    steps: p.steps.map((rs) => {
      const index = n++;
      const d = byIndex.get(index);
      if (d === undefined) return rs;
      const next = { ...rs };
      for (const field of ["objective", "expectedResult"] as const) {
        const text = d[field]?.trim();
        if (text === undefined || text === "" || text === rs[field]) continue;
        changes.push({ field, index, step: describeStep(rs.step), ...(rs[field] === undefined ? {} : { before: rs[field] }), after: text });
        next[field] = text;
      }
      return next;
    }),
  }));
  return { journey: { metadata, recording: { ...journey.recording, pages } }, changes };
}

/** The human-readable diff an approval shows before it writes. */
export function formatAnnotationChanges(changes: readonly AnnotationChange[]): string {
  if (changes.length === 0) return "no changes: the Journey already says all of this\n";
  const lines: string[] = [];
  for (const c of changes) {
    const where = c.index === undefined ? c.field : `step ${c.index + 1} ${c.field} — ${c.step ?? ""}`;
    lines.push(`~ ${where}`);
    if (c.before !== undefined) lines.push(`  - ${c.before}`);
    lines.push(`  + ${c.after}`);
  }
  return `${lines.join("\n")}\n`;
}
