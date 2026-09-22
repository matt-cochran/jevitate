// judge.ts — the batched Jev adapter (spec Cost control / task invariant #7).
//
// Independent rubric judgments over ONE screen-state are sent to Jev as parallel
// questions in a SINGLE `systemOne` request — never one call per rubric item.
// The evidence is already `RedactedEvidence` (branded), so raw evidence cannot
// reach the model here: the signature enforces it at compile time.
import type { Answer, JudgmentPort, JudgmentState, Question } from "@jevitate/ai-core";
import type { RubricEntry } from "./types.js";
import type { RedactedEvidence } from "./redact.js";

/** Namespaced key so questions from different rubric entries never collide. */
export function questionKey(entryId: string, questionId: string): string {
  return `${entryId}::${questionId}`;
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
  };
}

function toQuestion(kind: "choice" | "noul" | "score", choices?: readonly string[]): Question {
  if (kind === "choice") return { kind: "choice", options: [...(choices ?? [])] };
  if (kind === "score") return { kind: "score" };
  return { kind: "noul" };
}

/**
 * Judges every question of every entry for one screen-state in ONE request.
 * Returns answers keyed by `questionKey(entryId, questionId)`. Throws whatever
 * the port throws (the analyzer turns that into a `failed` outcome — never `[]`).
 */
export async function judgeScreen(
  port: JudgmentPort,
  evidence: RedactedEvidence,
  entries: readonly RubricEntry[],
): Promise<Record<string, Answer>> {
  const questions: Record<string, Question> = {};
  for (const entry of entries) {
    for (const q of entry.questions) {
      questions[questionKey(entry.id, q.id)] = toQuestion(q.kind, q.choices);
    }
  }
  const state = buildState(evidence);
  return port.systemOne({ state, questions });
}
