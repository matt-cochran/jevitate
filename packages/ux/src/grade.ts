// grade.ts — the independent QUALITY pass over candidate findings.
//
// A separate Jev judgment (its own question + label criteria from the prompt asset — never the
// call that generated the finding) grades each finding as actionable / relevant-minor /
// generic / wrong, grounded in the finding, its cited evidence and the screen the user saw.
// The grade is ADVISORY: it is recorded on the finding, and a code-side policy
// (`QualityPolicy`, applied in report.ts) decides what is shown; everything else goes to the
// suppressed summary with counts. By default (#133) the policy shows every grade: an
// uncalibrated grader labels findings, it does not hide them. One batched request per screen-state.
import type { Answer, JudgmentPort, Question } from "@jevitate/ai-core";
import type { RedactedEvidence } from "./redact.js";
import { graderMayFilterByDefault } from "./calibration.js";
import { buildState } from "./judge.js";
import { QUALITY_LABELS, UX_PROMPTS, type QualityLabel, type UxPrompts } from "./prompts.js";

export interface QualityGrade {
  readonly label: QualityLabel;
  /** Jev's confidence in the chosen label. */
  readonly confidence: number;
}

/** What a grade is grounded in (a legacy finding may lack observation/impact/recommendation). */
export interface GradeCandidate {
  readonly key: string;
  readonly principle: string;
  readonly observation?: string;
  readonly userImpact?: string;
  readonly recommendation?: string;
  readonly controls: readonly string[];
  readonly quotes: readonly string[];
}

/**
 * Which grades are shown. #133: the grader is not calibrated (calibration.ts), so by DEFAULT it
 * filters nothing — every finding is shown with its grade. Filtering is an explicit opt-in
 * (`--show actionable,relevant-minor`, `JEVITATE_UX_SHOW`, config `ux.show`), and the default only
 * narrows for an app class whose calibration evidence clears `GRADER_FILTER_KAPPA_GATE`.
 */
export interface QualityPolicy {
  readonly show: readonly QualityLabel[];
}
/** Every grade shown (the grade is displayed on each finding, never used to hide it). */
export const DEFAULT_QUALITY_POLICY: QualityPolicy = { show: [...QUALITY_LABELS] };
/** The filter the grader was designed for — applied by default only where calibration backs it. */
export const CALIBRATED_QUALITY_POLICY: QualityPolicy = { show: ["actionable", "relevant-minor"] };
export const QUALITY_SHOW_ENV = "JEVITATE_UX_SHOW";

/** Does this policy hide any grade (i.e. does the grader decide what is seen)? */
export function policyFilters(policy: QualityPolicy): boolean {
  return QUALITY_LABELS.some((l) => !policy.show.includes(l));
}

/** The default for an app class: no filtering until its calibration clears the κ gate (#133). */
export function defaultQualityPolicy(appClass?: string): QualityPolicy {
  return graderMayFilterByDefault(appClass) ? CALIBRATED_QUALITY_POLICY : DEFAULT_QUALITY_POLICY;
}

export class QualityPolicyError extends Error {
  readonly code = "E_UX_QUALITY_POLICY" as const;
}

/** Parses "actionable,relevant-minor" (flag/env/config). Unknown labels throw — never ignored. */
export function parseQualityPolicy(raw: string | readonly string[], source: string): QualityPolicy {
  const parts = (typeof raw === "string" ? raw.split(",") : [...raw]).map((s) => s.trim()).filter((s) => s.length > 0);
  if (parts.length === 0) throw new QualityPolicyError(`${source} must list at least one of ${QUALITY_LABELS.join(", ")}`);
  const bad = parts.filter((p) => !(QUALITY_LABELS as readonly string[]).includes(p));
  if (bad.length > 0) throw new QualityPolicyError(`${source}: unknown quality label(s) ${bad.join(", ")} (allowed: ${QUALITY_LABELS.join(", ")})`);
  return { show: [...new Set(parts)] as QualityLabel[] };
}

/** Precedence: flag > `JEVITATE_UX_SHOW` > config `ux.show` > `defaultQualityPolicy(appClass)` (#133: all grades). */
export function resolveQualityPolicy(
  flag: string | undefined,
  env: Readonly<Record<string, string | undefined>>,
  configValue?: readonly string[],
  appClass?: string,
): QualityPolicy {
  if (flag !== undefined) return parseQualityPolicy(flag, "--show");
  const fromEnv = env[QUALITY_SHOW_ENV];
  if (fromEnv !== undefined) return parseQualityPolicy(fromEnv, QUALITY_SHOW_ENV);
  if (configValue !== undefined) return parseQualityPolicy(configValue, "config ux.show");
  return defaultQualityPolicy(appClass);
}

const MAX_FIELD = 600;

/** The finding as the grader reads it (bounded; evidence already redacted). */
export function describeCandidate(c: GradeCandidate): string {
  const parts = [`principle: ${c.principle}`];
  if (c.observation) parts.push(`observation: ${c.observation.slice(0, MAX_FIELD)}`);
  if (c.userImpact) parts.push(`user impact: ${c.userImpact.slice(0, MAX_FIELD)}`);
  if (c.recommendation) parts.push(`recommendation: ${c.recommendation.slice(0, MAX_FIELD)}`);
  parts.push(`cited controls: ${c.controls.length > 0 ? c.controls.join("; ").slice(0, MAX_FIELD) : "(none)"}`);
  parts.push(`quoted text: ${c.quotes.length > 0 ? c.quotes.map((q) => JSON.stringify(q)).join("; ").slice(0, MAX_FIELD) : "(none)"}`);
  if (!c.observation) parts.push("(no observation was given: judge whether this principle is violated on this screen in a way worth fixing)");
  return parts.join(" | ");
}

export function gradeQuestion(c: GradeCandidate, prompts: UxPrompts = UX_PROMPTS): Question {
  return {
    kind: "choice",
    options: [...QUALITY_LABELS],
    descriptions: { ...prompts.grader.labels },
    instructions: prompts.grader.instructions.replace("{finding}", describeCandidate(c)),
  };
}

/**
 * Grades candidates for ONE screen-state in one batched Jev request. Throws on a port error or
 * an answer that is not a label (the analyzer turns that into `failed`, never a silent pass).
 */
export async function gradeCandidates(
  port: JudgmentPort,
  evidence: RedactedEvidence,
  candidates: readonly GradeCandidate[],
  prompts: UxPrompts = UX_PROMPTS,
): Promise<Map<string, QualityGrade>> {
  const out = new Map<string, QualityGrade>();
  if (candidates.length === 0) return out;
  const questions: Record<string, Question> = {};
  candidates.forEach((c, i) => {
    questions[`grade::${i}`] = gradeQuestion(c, prompts);
  });
  const answers: Record<string, Answer> = await port.systemOne({ state: buildState(evidence), questions });
  candidates.forEach((c, i) => {
    const a = answers[`grade::${i}`];
    if (!a || a.kind !== "choice" || !(QUALITY_LABELS as readonly string[]).includes(a.value)) {
      throw new Error(`quality grader returned no valid label for finding '${c.key}'`);
    }
    out.set(c.key, { label: a.value as QualityLabel, confidence: a.confidence });
  });
  return out;
}
