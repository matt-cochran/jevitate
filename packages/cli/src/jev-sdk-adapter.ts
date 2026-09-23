import type { Answer, Question } from "@jevitate/ai-core";

/**
 * Pure translation between jevitate's judgment questions/answers and the
 * `@typesafe-ai/sdk` (v0.6) `systemOne` wire shapes. Kept free of the SDK import so
 * it is unit-tested without the SDK installed; the live seam (`realJevClientCall`)
 * only constructs `TypeSafeClient` and calls `systemOne` around these two functions.
 *
 * Every unexpected response shape FAILS CLOSED (throws) — a missing answer, a wrong
 * answer type, or a choice label that was not offered is never coerced into a guess.
 */

export type SdkChoiceQuestion = { type: "choice"; instructions: string; criteria: Record<string, string | null> };
export type SdkNoulQuestion = { type: "noul"; instructions: string };
export type SdkScoreQuestion = { type: "score"; instructions: string; criteria: readonly [string, string] };
export type SdkQuestion = SdkChoiceQuestion | SdkNoulQuestion | SdkScoreQuestion;

/** jevitate's score is 0..1, so a two-level rubric makes the SDK's expected score land in 0..1. */
const SCORE_RUBRIC = ["low", "high"] as const;

export class JevResponseError extends Error {}

export function toSdkQuestions(questions: Record<string, Question>): Record<string, SdkQuestion> {
  const out: Record<string, SdkQuestion> = {};
  for (const [name, q] of Object.entries(questions)) {
    switch (q.kind) {
      case "choice": {
        const criteria: Record<string, string | null> = {};
        for (const option of q.options) criteria[option] = q.descriptions?.[option] ?? null;
        out[name] = { type: "choice", instructions: q.instructions ?? name, criteria };
        break;
      }
      case "noul":
        out[name] = { type: "noul", instructions: name };
        break;
      case "score":
        out[name] = { type: "score", instructions: name, criteria: SCORE_RUBRIC };
        break;
      default: {
        const exhaustive: never = q;
        throw new JevResponseError(`unsupported question: ${JSON.stringify(exhaustive)}`);
      }
    }
  }
  return out;
}

function field(obj: object, key: string): unknown {
  return new Map<string, unknown>(Object.entries(obj)).get(key);
}

function asFiniteNumber(v: unknown, what: string): number {
  if (typeof v !== "number" || !Number.isFinite(v)) throw new JevResponseError(`${what} is not a finite number`);
  return v;
}

export function fromSdkAnswers(
  questions: Record<string, Question>,
  answers: unknown,
): Record<string, Answer> {
  if (typeof answers !== "object" || answers === null) {
    throw new JevResponseError("Jev response has no answers object");
  }
  const out: Record<string, Answer> = {};
  for (const [name, q] of Object.entries(questions)) {
    const raw = field(answers, name);
    if (typeof raw !== "object" || raw === null) throw new JevResponseError(`Jev did not answer "${name}"`);
    const type = field(raw, "type");
    if (type !== q.kind) throw new JevResponseError(`Jev answered "${name}" as ${String(type)}, expected ${q.kind}`);
    switch (q.kind) {
      case "choice": {
        const value = field(raw, "choice");
        if (typeof value !== "string" || !q.options.includes(value)) {
          throw new JevResponseError(`Jev chose "${String(value)}" for "${name}", which was not offered`);
        }
        out[name] = { kind: "choice", value, confidence: asFiniteNumber(field(raw, "confidence"), `${name}.confidence`) };
        break;
      }
      case "noul": {
        const p = asFiniteNumber(field(raw, "noul"), `${name}.noul`);
        out[name] = { kind: "noul", value: p >= 0.5, probability: p };
        break;
      }
      case "score":
        out[name] = { kind: "score", value: asFiniteNumber(field(raw, "score"), `${name}.score`) };
        break;
      default: {
        const exhaustive: never = q;
        throw new JevResponseError(`unsupported question: ${JSON.stringify(exhaustive)}`);
      }
    }
  }
  return out;
}

/** The gateway hands the seam a `Bearer <key>` header; the SDK client wants the bare key. */
export function apiKeyFromAuthHeader(authHeader: string): string {
  const match = /^Bearer\s+(\S.*)$/.exec(authHeader);
  if (!match || match[1] === undefined) throw new JevResponseError("judgment auth header is not a Bearer token");
  return match[1].trim();
}
