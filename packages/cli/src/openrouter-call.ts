import { failureClass, openRouterProviderSettings, type OpenRouterCall, type UsageSink } from "@jevitate/ai-core";

/** The slice of the AI SDK's `generateObject` result/error this seam reads for usage accounting. */
interface TokenUsage {
  readonly inputTokens?: number;
  readonly outputTokens?: number;
}

function tokensOf(v: unknown): { inputTokens: number; outputTokens: number } | undefined {
  if (typeof v !== "object" || v === null) return undefined;
  const u = v as TokenUsage;
  const inputTokens = typeof u.inputTokens === "number" && Number.isFinite(u.inputTokens) ? u.inputTokens : 0;
  const outputTokens = typeof u.outputTokens === "number" && Number.isFinite(u.outputTokens) ? u.outputTokens : 0;
  return { inputTokens, outputTokens };
}

/** OpenRouter's usage-accounting cost (`providerMetadata.openrouter.usage.cost`), when reported. */
export function openRouterReportedCost(providerMetadata: unknown): number | undefined {
  const cost = (providerMetadata as { openrouter?: { usage?: { cost?: unknown } } } | undefined)?.openrouter?.usage?.cost;
  return typeof cost === "number" && Number.isFinite(cost) ? cost : undefined;
}

/** The AI SDK's `generateObject` — injectable so the accounting is testable without a network. */
export type GenerateObjectFn = (args: Record<string, unknown>) => Promise<{ object: unknown; usage?: unknown; providerMetadata?: unknown }>;

/**
 * Wraps a `generateObject` into the OpenRouter seam with usage accounting (#100, #163). Every
 * attempt is recorded — including one that throws (the AI SDK's own retries are disabled with
 * `maxRetries: 0`, so `RetryingGenerationPort`'s re-invocations are the only retries and each is
 * counted here). A failed attempt carries its token usage when the SDK error reports one (a model
 * response that failed schema validation was still billed), and is otherwise recorded unpriced.
 * Usage accounting never itself breaks a call: a malformed usage/metadata counts as 0 tokens.
 */
export function openRouterCallWith(generateObject: GenerateObjectFn, createOpenRouter: (s: { apiKey: string }) => (model: string) => unknown, usage?: UsageSink): OpenRouterCall {
  return async ({ model, schema, body, authHeader, temperature, task }) => {
    const openrouter = createOpenRouter(openRouterProviderSettings(authHeader));
    const start = Date.now();
    const label = { model, ...(task === undefined ? {} : { task }) };
    let out: Awaited<ReturnType<GenerateObjectFn>>;
    try {
      out = await generateObject({
        model: openrouter(model),
        schema,
        prompt: JSON.stringify(body),
        maxRetries: 0,
        // Asks OpenRouter to include usage accounting (incl. `cost`) in providerMetadata.openrouter.usage.
        providerOptions: { openrouter: { usage: { include: true } } },
        ...(temperature === undefined ? {} : { temperature }),
      });
    } catch (e) {
      const tokens = tokensOf((e as { usage?: unknown } | null)?.usage) ?? { inputTokens: 0, outputTokens: 0 };
      usage?.recordGeneration({ ...tokens, ...label, failure: failureClass(e) });
      throw e;
    }
    const cost = openRouterReportedCost(out.providerMetadata);
    usage?.recordGeneration({
      ...(tokensOf(out.usage) ?? { inputTokens: 0, outputTokens: 0 }),
      ...label,
      ...(cost === undefined ? {} : { usd: cost }),
    });
    return { object: out.object, latencyMs: Date.now() - start };
  };
}

/** Real OpenRouter seam (lazy import) — the key reaches the provider only as `apiKey`. */
export async function realOpenRouterCall(usage?: UsageSink): Promise<OpenRouterCall> {
  const { generateObject } = await import("ai");
  const { createOpenRouter } = await import("@openrouter/ai-sdk-provider");
  return openRouterCallWith(
    generateObject as unknown as GenerateObjectFn,
    (s) => {
      const provider = createOpenRouter(s);
      return (model: string) => provider(model);
    },
    usage,
  );
}
