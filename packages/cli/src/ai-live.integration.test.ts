// Live AI smoke tests (opt-in). These call PAID APIs and are SKIPPED unless both the flag and the
// key are set in the environment:
//   - OpenRouter live: RUN_OPENROUTER_TESTS=1 + OPENROUTER_API_KEY
//   - Jev live:        RUN_TYPESAFE_TESTS=1 + TYPESAFE_API_KEY
// Each builds the PRODUCTION client exactly as the CLI does (see cli-shared.ts) and makes one tiny
// real request. Keys are read only by envCredentialStore and are never logged or asserted on.
import { describe, expect, it } from "vitest";
import {
  JevJudgmentGateway,
  OpenRouterGenerationGateway,
  envCredentialStore,
  realJevClientCall,
  type JudgmentState,
} from "@jevitate/ai-core";
import { DEFAULT_EXPLORE_CATALOG, DEFAULT_EXPLORE_CONSTRAINTS } from "./cli-shared.js";
import { realOpenRouterCall } from "./openrouter-call.js";

const OPENROUTER_LIVE = process.env.RUN_OPENROUTER_TESTS === "1" && !!process.env.OPENROUTER_API_KEY;
const JEV_LIVE = process.env.RUN_TYPESAFE_TESTS === "1" && !!process.env.TYPESAFE_API_KEY;

describe.skipIf(!OPENROUTER_LIVE)("OpenRouter live (opt-in)", () => {
  it("generates a non-empty form value through the production OpenRouter gateway", async () => {
    const gateway = new OpenRouterGenerationGateway({
      store: envCredentialStore(process.env),
      catalog: DEFAULT_EXPLORE_CATALOG,
      constraints: DEFAULT_EXPLORE_CONSTRAINTS,
      call: await realOpenRouterCall(),
    });
    const result = await gateway.generate("form.value", {
      fieldLabel: "Title",
      goal: "Create a short note titled Hello",
      visibleContext: "A simple note form with one text field.",
      history: [],
    });
    expect(result.output.text).toBeTruthy();
  }, 60_000);
});

describe.skipIf(!JEV_LIVE)("Jev live (opt-in)", () => {
  it("answers a trivially true noul question through the production Jev gateway", async () => {
    const state: JudgmentState = {
      goal: "Answer a trivially true yes/no question",
      url: "https://example.com",
      controls: [],
      history: [],
    };
    const gateway = new JevJudgmentGateway(envCredentialStore(process.env), await realJevClientCall());
    const answers = await gateway.systemOne({
      state,
      questions: { alwaysTrue: { kind: "noul", instructions: "Is it true that one plus one equals two?" } },
    });
    expect(answers.alwaysTrue).toMatchObject({ kind: "noul", value: expect.any(Boolean) });
  }, 60_000);
});
