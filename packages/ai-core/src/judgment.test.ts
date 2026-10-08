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

  it("#429: with only an OpenRouter key, the call goes the OpenRouter route with that key", async () => {
    const store = envCredentialStore({ OPENROUTER_API_KEY: "sk-or-SECRET" }, {});
    const seen: Array<{ auth: string; provider: string | undefined }> = [];
    const call: JevClientCall = async (args) => {
      expect(JSON.stringify({ state: args.state, questions: args.questions })).not.toContain("sk-or-SECRET");
      seen.push({ auth: args.authHeader, provider: args.provider });
      return { proceed: { kind: "noul", value: true, probability: 1 } };
    };
    await new JevJudgmentGateway(store, call).systemOne({ state, questions: { proceed: { kind: "noul" } } });
    expect(seen).toEqual([{ auth: "Bearer sk-or-SECRET", provider: "openrouter" }]);
  });

  it("#429: a pinned provider uses its key even when the other is set", async () => {
    const store = envCredentialStore({ OPENROUTER_API_KEY: "sk-or-SECRET", TYPESAFE_API_KEY: "ts-SECRET" }, {});
    let seen = "";
    const call: JevClientCall = async (args) => {
      seen = `${args.provider ?? ""} ${args.authHeader}`;
      return { proceed: { kind: "noul", value: true, probability: 1 } };
    };
    await new JevJudgmentGateway(store, call, "openrouter").systemOne({ state, questions: { proceed: { kind: "noul" } } });
    expect(seen).toBe("openrouter Bearer sk-or-SECRET");
  });
});
