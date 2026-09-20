import { describe, it, expect } from "vitest";
import {
  FakeJudgmentGateway,
  JevJudgmentGateway,
  envCredentialStore,
  MissingCredentialError,
  type JevClientCall,
  type Answer,
  type JudgmentState,
} from "./index.js";

const state: JudgmentState = { goal: "log in", url: "https://example.com", controls: [], history: [] };

describe("FakeJudgmentGateway", () => {
  it("returns scripted answers for each requested question", async () => {
    const scripted: Record<string, Answer> = {
      proceed: { kind: "noul", value: true, probability: 0.9 },
      strategy: { kind: "choice", value: "retry", confidence: 0.8 },
    };
    const g = new FakeJudgmentGateway(scripted);
    const out = await g.systemOne({
      state,
      questions: { proceed: { kind: "noul" }, strategy: { kind: "choice", options: ["retry", "abort"] } },
    });
    expect(out).toEqual(scripted);
  });

  it("throws when a question has no scripted answer", async () => {
    const g = new FakeJudgmentGateway({});
    await expect(
      g.systemOne({ state, questions: { proceed: { kind: "noul" } } }),
    ).rejects.toThrow(/no scripted answer/);
  });
});

describe("JevJudgmentGateway (key-at-call-only, fail-closed)", () => {
  it("refuses when TYPESAFE_API_KEY is absent", async () => {
    const store = envCredentialStore({}, {});
    const call: JevClientCall = async () => ({});
    const g = new JevJudgmentGateway(store, call);
    await expect(
      g.systemOne({ state, questions: { proceed: { kind: "noul" } } }),
    ).rejects.toBeInstanceOf(MissingCredentialError);
  });

  it("passes the key only in the auth header, never in state/questions", async () => {
    const store = envCredentialStore({ TYPESAFE_API_KEY: "ts-SECRET" }, {});
    let seenAuthHeader = "";
    const call: JevClientCall = async (args) => {
      expect(JSON.stringify({ state: args.state, questions: args.questions })).not.toContain("ts-SECRET");
      seenAuthHeader = args.authHeader;
      return { proceed: { kind: "noul", value: true, probability: 1 } };
    };
    const g = new JevJudgmentGateway(store, call);
    const out = await g.systemOne({ state, questions: { proceed: { kind: "noul" } } });
    expect(seenAuthHeader).toBe("Bearer ts-SECRET");
    expect(out.proceed).toEqual({ kind: "noul", value: true, probability: 1 });
  });
});
