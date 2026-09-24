import { z } from "zod";
import { contentHash } from "@jevitate/domain";
import { GEN_TASKS, type GenTaskKind, type GenInput, type GenOutput, type GenerationPort, type GenerationResult } from "./generation.js";
import { type CredentialStore, requireKeys } from "./credentials.js";
import { assertNoOutboundCredential } from "./credential-guard.js";
import { type CatalogModel, type ModelConstraints, selectModel } from "./model-policy.js";

/** The one injectable seam. Production wires the AI SDK's generateObject; the
 *  unit test injects a fake. The key is read HERE and only HERE, and placed
 *  ONLY into the Authorization header — never in `body`. */
export interface OpenRouterCall {
  (args: {
    model: string;
    schema: z.ZodTypeAny;
    body: unknown;          // redacted, guard-checked — carries NO key
    authHeader: string;     // `Bearer <key>` — never logged, never in body
    signal?: AbortSignal;
  }): Promise<{ object: unknown; latencyMs: number }>;
}

export interface OpenRouterConfig {
  store: CredentialStore;
  catalog: CatalogModel[];
  constraints: ModelConstraints;
  call: OpenRouterCall;    // injected (real seam in bin wiring; fake in tests)
}

export class OpenRouterGenerationGateway implements GenerationPort {
  constructor(private readonly cfg: OpenRouterConfig) {}

  async generate<K extends GenTaskKind>(kind: K, input: GenInput<K>): Promise<GenerationResult<K>> {
    requireKeys("generation", this.cfg.store);                    // fail-closed precondition
    const task = GEN_TASKS[kind];
    const parsed = task.input.parse(input);                        // untrusted-in re-validated
    const model = selectModel(this.cfg.catalog, this.cfg.constraints); // deterministic pick
    const body = { model, task: kind, promptVersion: task.promptVersion, input: parsed };

    // FLOOR #6 CHOKE POINT: nothing with a key value may leave.
    assertNoOutboundCredential(body, this.cfg.store);

    const key = this.cfg.store.read("OPENROUTER_API_KEY");         // read at the call, nowhere else
    if (!key) throw new Error("unreachable: requireKeys passed but key unreadable");
    const { object, latencyMs } = await this.cfg.call({
      model, schema: task.output, body, authHeader: `Bearer ${key}`,
    });

    const output = task.output.parse(object) as GenOutput<K>;      // untrusted-out re-validated
    return {
      output,
      provenance: {
        adapter: "openrouter", model, promptVersion: task.promptVersion,
        latencyMs, responseHash: contentHash(output),              // no key anywhere
      },
    };
  }
}

// Real seam (wired in bin/host): the production OpenRouterCall lazily imports
// `ai` + `@openrouter/ai-sdk-provider`, builds the provider from
// `openRouterProviderSettings(authHeader)` and calls generateObject({ model:
// openrouter(model), schema, prompt: JSON.stringify(body) }). Lazy import keeps
// the package building/testing without the SDK installed.

/**
 * `@openrouter/ai-sdk-provider` settings for a gateway `Bearer <key>` auth header. The provider
 * reads the key ONLY from `apiKey` (or the OPENROUTER_API_KEY env var) and builds its own
 * `Authorization` header from it — a key passed as a custom header is ignored and the call fails
 * with "OpenRouter API key is missing". Fails closed on a malformed header.
 */
export function openRouterProviderSettings(authHeader: string): { apiKey: string } {
  const match = /^Bearer\s+(\S+)\s*$/.exec(authHeader);
  const key = match?.[1];
  if (key === undefined) throw new Error("generation auth header is not a Bearer token");
  return { apiKey: key };
}
