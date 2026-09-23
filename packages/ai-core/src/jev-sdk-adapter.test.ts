import { describe, expect, test } from "vitest";
import { choice, noul, score } from "@typesafe-ai/sdk";
import type { Question } from "./judgment.js";
import {
  JevResponseError,
  apiKeyFromAuthHeader,
  fromSdkAnswers,
  toSdkQuestions,
} from "./jev-sdk-adapter.js";

/**
 * Regression: the live Jev seam called `sdk.createClient({ authHeader })`, which
 * `@typesafe-ai/sdk` v0.6 does not export (it is `new TypeSafeClient({ apiKey })` +
 * `systemOne({ state, questions })` with `{type, criteria}` questions and
 * `{type, choice|noul|score, ...}` answers) — so `explore --real` failed on its first
 * decision. These tests pin the translation, and the contract tests below compare our
 * question objects against the REAL SDK builders so an SDK wire-shape change breaks here.
 */

const questions: Record<string, Question> = {
  op: { kind: "choice", options: ["click", "type", "done"] },
  stuck: { kind: "noul" },
  progress: { kind: "score" },
};

describe("toSdkQuestions", () => {
  test("matches the real SDK builders' wire shape (contract)", () => {
    const sdk = toSdkQuestions(questions);
    expect(sdk.op).toEqual(choice("op", { click: null, type: null, done: null }));
    expect(sdk.stuck).toEqual(noul("stuck"));
    expect(sdk.progress).toEqual(score("progress", ["low", "high"]));
  });
});

describe("fromSdkAnswers", () => {
  const good = {
    op: { type: "choice", choice: "type", confidence: 0.82, probabilities: { click: 0.1, type: 0.82, done: 0.08 } },
    stuck: { type: "noul", noul: 0.31 },
    progress: { type: "score", score: 0.64, confidence: 0.7, legend: {}, probabilities: {} },
  };

  test("maps choice / noul / score to jevitate answers", () => {
    expect(fromSdkAnswers(questions, good)).toEqual({
      op: { kind: "choice", value: "type", confidence: 0.82 },
      stuck: { kind: "noul", value: false, probability: 0.31 },
      progress: { kind: "score", value: 0.64 },
    });
  });

  test("noul probability >= 0.5 is a yes", () => {
    const yes = fromSdkAnswers({ stuck: { kind: "noul" } }, { stuck: { type: "noul", noul: 0.5 } });
    expect(yes.stuck).toEqual({ kind: "noul", value: true, probability: 0.5 });
  });

  test("fails closed on a missing answer", () => {
    const { stuck: _omit, ...rest } = good;
    expect(() => fromSdkAnswers(questions, rest)).toThrow(JevResponseError);
  });

  test("fails closed on a choice label that was not offered", () => {
    expect(() => fromSdkAnswers(questions, { ...good, op: { ...good.op, choice: "delete_everything" } })).toThrow(
      /not offered/,
    );
  });

  test("fails closed on a wrong answer type", () => {
    expect(() => fromSdkAnswers(questions, { ...good, stuck: { type: "score", score: 1 } })).toThrow(/expected noul/);
  });

  test("fails closed on a non-numeric confidence", () => {
    expect(() => fromSdkAnswers(questions, { ...good, op: { ...good.op, confidence: "high" } })).toThrow(
      JevResponseError,
    );
  });

  test("fails closed when there is no answers object", () => {
    expect(() => fromSdkAnswers(questions, null)).toThrow(JevResponseError);
  });
});

describe("apiKeyFromAuthHeader", () => {
  test("extracts the bare key from a Bearer header", () => {
    expect(apiKeyFromAuthHeader("Bearer ts-abc123")).toBe("ts-abc123");
  });
  test("rejects a non-Bearer header", () => {
    expect(() => apiKeyFromAuthHeader("Basic abc")).toThrow(JevResponseError);
  });
});
