// judge.ts — the batched Jev adapter (spec Cost control / task invariant #7).
//
// Independent rubric judgments over ONE screen-state are sent to Jev as parallel
// questions in a SINGLE `systemOne` request — never one call per rubric item.
// The evidence is already `RedactedEvidence` (branded), so raw evidence cannot
// reach the model here: the signature enforces it at compile time.
import type { Answer, JudgmentPort, JudgmentState, Question } from "@jevitate/ai-core";
import type { JevQuestionSpec, RubricEntry } from "./types.js";
import { UX_PROMPTS } from "./prompts.js";
import type { RedactedEvidence } from "./redact.js";

/** Namespaced key so questions from different rubric entries never collide. */
export function questionKey(entryId: string, questionId: string): string {
  return `${entryId}::${questionId}`;
}

/** The per-entry applicability question's id (asked alongside the entry's own questions). */
export const APPLIES_QUESTION_ID = "__applies";

/** Max page text sent to Jev per screen (already redacted). */
const MAX_JUDGED_TEXT = 4000;

/** Fills the rubric's `{persona}` / `{appClass}` placeholders from the calibration context. */
export function fillTemplate(text: string, evidence: Pick<RedactedEvidence, "appContext">): string {
  const persona = evidence.appContext.persona ?? "first-time user";
  return text.replaceAll("{persona}", persona).replaceAll("{appClass}", evidence.appContext.appClass);
}

/** Builds the calibrated, redacted `JudgmentState` Jev sees for one screen-state. */
export function buildState(evidence: RedactedEvidence): JudgmentState {
  const { appClass, persona } = evidence.appContext;
  const goalParts = [
    evidence.job ? `job: ${evidence.job}` : "job: (unspecified)",
    `app-class: ${appClass}`,
    ...(persona ? [`persona: ${persona}`] : []),
  ];
  return {
    goal: goalParts.join(" | "),
    url: evidence.url,
    controls: evidence.controls.map((c) => c.summary),
    history: evidence.history.map((h) => `${h.screenId} ${h.url}`),
    ...(evidence.visibleText.trim().length > 0 ? { visibleText: evidence.visibleText.slice(0, MAX_JUDGED_TEXT) } : {}),
  };
}

/**
 * The rubric question as Jev sees it: the filled instruction PLUS its criteria. (Previously only
 * the namespaced key reached the model — Jev judged "nielsen-1::status-visible" blind.)
 */
function toQuestion(spec: JevQuestionSpec, evidence: RedactedEvidence): Question {
  const instructions = `${fillTemplate(spec.instruction, evidence)} Criteria: ${fillTemplate(spec.criteria, evidence)}`;
  if (spec.kind === "choice") return { kind: "choice", options: [...(spec.choices ?? [])], instructions };
  if (spec.kind === "score") return { kind: "score", instructions };
  return { kind: "noul", instructions };
}

/** Rubric applicability as a Jev judgment — a heuristic that does not apply must not score high. */
function appliesQuestion(entry: RubricEntry): Question {
  return {
    kind: "noul",
    instructions: UX_PROMPTS.applicability.replace("{principle}", entry.principle),
  };
}

/**
 * Judges every question of every entry — plus one applicability question per entry — for one
 * screen-state in ONE request. Returns answers keyed by `questionKey(entryId, questionId)`
 * (applicability under `APPLIES_QUESTION_ID`). Throws whatever the port throws (the analyzer
 * turns that into a `failed` outcome — never `[]`).
 */
export async function judgeScreen(
  port: JudgmentPort,
  evidence: RedactedEvidence,
  entries: readonly RubricEntry[],
): Promise<Record<string, Answer>> {
  const questions: Record<string, Question> = {};
  for (const entry of entries) {
    for (const q of entry.questions) {
      questions[questionKey(entry.id, q.id)] = toQuestion(q, evidence);
    }
    questions[questionKey(entry.id, APPLIES_QUESTION_ID)] = appliesQuestion(entry);
  }
  const state = buildState(evidence);
  return port.systemOne({ state, questions });
}
