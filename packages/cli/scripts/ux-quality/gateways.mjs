// gateways.mjs — live Jev + OpenRouter gateways for the quality harness (keys from env or
// ~/.jevitate/credentials.json — the same fail-closed store the CLI uses; keys never logged).
import {
  envCredentialStore,
  requireKeys,
  JevJudgmentGateway,
  OpenRouterGenerationGateway,
  RetryingGenerationPort,
  RetryingJudgmentPort,
  openRouterProviderSettings,
  realJevClientCall,
} from "@jevitate/ai-core";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const CATALOG = [
  { id: "openai/gpt-4o-mini", promptUsdPer1k: 0.15, completionUsdPer1k: 0.6, regions: [], latencyClass: "fast", capabilities: [] },
];

function localCredentials() {
  try {
    return JSON.parse(readFileSync(join(homedir(), ".jevitate", "credentials.json"), "utf8"));
  } catch {
    return {};
  }
}

export async function liveGateways() {
  const store = envCredentialStore(process.env, localCredentials());
  requireKeys("generation", store);
  requireKeys("judgment", store);
  const { generateObject } = await import("ai");
  const { createOpenRouter } = await import("@openrouter/ai-sdk-provider");
  const call = async ({ model, schema, body, authHeader, temperature }) => {
    const openrouter = createOpenRouter(openRouterProviderSettings(authHeader));
    const start = Date.now();
    const { object } = await generateObject({
      model: openrouter(model),
      schema,
      prompt: JSON.stringify(body),
      ...(temperature === undefined ? {} : { temperature }),
    });
    return { object, latencyMs: Date.now() - start };
  };
  const gen = new OpenRouterGenerationGateway({ store, catalog: CATALOG, constraints: { requiredCapabilities: [] }, call });
  const judge = new JevJudgmentGateway(store, await realJevClientCall(() => import("@typesafe-ai/sdk")));
  return { judge: new RetryingJudgmentPort(judge), gen: new RetryingGenerationPort(gen) };
}
