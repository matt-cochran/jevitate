import { describe, expect, test } from "vitest";
import { choice, noul, score } from "@typesafe-ai/sdk";
import type { Question } from "./judgment.js";
import { UsageTracker } from "./usage.js";
import {
  JevResponseError,
  apiKeyFromAuthHeader,
  fromSdkAnswers,
  realJevClientCall,
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

  test("a choice's descriptions become SDK criteria and its instructions the SDK instructions (contract)", () => {
    const described: Record<string, Question> = {
      action: {
        kind: "choice",
        options: ["click:0", "type:1", "done"],
        descriptions: { "click:0": 'click button "Sign in"', "type:1": 'type into textbox "Username"' },
        instructions: "Which single action best advances the goal?",
      },
    };
    const sdk = toSdkQuestions(described);
    expect(sdk.action).toEqual(
      choice("Which single action best advances the goal?", {
        "click:0": 'click button "Sign in"',
        "type:1": 'type into textbox "Username"',
        done: null, // an undescribed option stays a bare criterion
      }),
    );
  });

  test("a noul/score's instructions (and score criteria) reach the SDK — never just the question key (contract)", () => {
    const sdk = toSdkQuestions({
      "nielsen-1::status": { kind: "noul", instructions: "Does the screen show system status?" },
      "load::burden": { kind: "score", instructions: "Rate decision burden.", criteria: ["overloaded", "focused"] },
    });
    expect(sdk["nielsen-1::status"]).toEqual(noul("Does the screen show system status?"));
    expect(sdk["load::burden"]).toEqual(score("Rate decision burden.", ["overloaded", "focused"]));
  });
});

describe("realJevClientCall — the lazy live seam (SDK loader injected)", () => {
  test("constructs the client with the bare key and round-trips through the adapter", async () => {
    const seen: { apiKey?: string; questions?: unknown } = {};
    const fakeSdk = {
      TypeSafeClient: class {
        constructor(config: { apiKey: string }) {
          seen.apiKey = config.apiKey;
        }
        async systemOne(req: { questions: unknown }): Promise<{ answers: unknown }> {
          seen.questions = req.questions;
          return { answers: { op: { type: "choice", choice: "done", confidence: 0.7 } } };
        }
      },
    };
    const call = await realJevClientCall(async () => fakeSdk);
    const answers = await call({
      state: { goal: "g", url: "u", controls: [], history: [] },
      questions: { op: { kind: "choice", options: ["click", "done"] } },
      authHeader: "Bearer sk-test",
    });
    expect(seen.apiKey).toBe("sk-test");
    expect(seen.questions).toEqual({ op: choice("op", { click: null, done: null }) });
    expect(answers).toEqual({ op: { kind: "choice", value: "done", confidence: 0.7 } });
  });

  test("fails closed with an install hint when the SDK cannot be loaded", async () => {
    await expect(realJevClientCall(async () => Promise.reject(new Error("MODULE_NOT_FOUND")))).rejects.toThrow(
      /requires @typesafe-ai\/sdk/,
    );
  });

  test("fails closed on an SDK without TypeSafeClient (unsupported version)", async () => {
    await expect(realJevClientCall(async () => ({ createClient: () => undefined }))).rejects.toThrow(
      /unsupported SDK version/,
    );
  });

  test("the default loader resolves the installed SDK", async () => {
    await expect(realJevClientCall()).resolves.toBeTypeOf("function");
  });

  test("#100: a supplied usage sink records the SDK's own token counts, and retries count (each call)", async () => {
    const fakeSdk = {
      TypeSafeClient: class {
        async systemOne(): Promise<{ answers: unknown; usage: { input_tokens: number; output_tokens: number } }> {
          return {
            answers: { op: { type: "choice", choice: "done", confidence: 0.7 } },
            usage: { input_tokens: 120, output_tokens: 30 },
          };
        }
      },
    };
    const usage = new UsageTracker();
    const call = await realJevClientCall(async () => fakeSdk, usage);
    const args = {
      state: { goal: "g", url: "u", controls: [], history: [] },
      questions: { op: { kind: "choice" as const, options: ["click", "done"] } },
      authHeader: "Bearer sk-test",
    };
    await call(args);
    await call(args); // a second attempt (e.g. RetryingJudgmentPort re-invoking this same seam) counts too
    expect(usage.snapshot()).toEqual({ judgments: 2, generations: 0, inputTokens: 240, outputTokens: 60, priced: "none" });
  });

  test("#100: a missing/malformed usage on the SDK response counts as 0 tokens rather than throwing", async () => {
    const fakeSdk = {
      TypeSafeClient: class {
        async systemOne(): Promise<{ answers: unknown }> {
          return { answers: { op: { type: "choice", choice: "done", confidence: 0.7 } } };
        }
      },
    };
    const usage = new UsageTracker();
    const call = await realJevClientCall(async () => fakeSdk, usage);
    await call({
      state: { goal: "g", url: "u", controls: [], history: [] },
      questions: { op: { kind: "choice", options: ["click", "done"] } },
      authHeader: "Bearer sk-test",
    });
    expect(usage.snapshot()).toEqual({ judgments: 1, generations: 0, inputTokens: 0, outputTokens: 0, priced: "none" });
  });

  test("#136: a provider-reported per-call cost (a future SDK) is recorded as jevUsd, no unit price needed", async () => {
    const fakeSdk = {
      TypeSafeClient: class {
        async systemOne(): Promise<{ answers: unknown; usage: { input_tokens: number; output_tokens: number; cost: number } }> {
          return {
            answers: { op: { type: "choice", choice: "done", confidence: 0.7 } },
            usage: { input_tokens: 120, output_tokens: 30, cost: 0.0012 },
          };
        }
      },
    };
    const usage = new UsageTracker();
    const call = await realJevClientCall(async () => fakeSdk, usage);
    await call({
      state: { goal: "g", url: "u", controls: [], history: [] },
      questions: { op: { kind: "choice", options: ["click", "done"] } },
      authHeader: "Bearer sk-test",
    });
    const s = usage.snapshot();
    expect(s.jevUsd).toBeCloseTo(0.0012, 10);
    expect(s.jevPriceSource).toBeUndefined();
    expect(s.priced).toBe("full");
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
