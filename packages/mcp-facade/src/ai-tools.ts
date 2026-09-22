import {
  withPreflight,
  type CredentialStore,
  type GenerationPort,
  type SetupRequiredResult,
} from "@jevitate/ai-core";

export interface AiGenerateTextArgs {
  fieldLabel: string;
  goal: string;
  visibleContext: string;
  history?: string[];
}

export interface AiGenerateTextResult {
  ok: true;
  text: string | null;
}

/**
 * MCP surface for the `ai_generate_text` tool (see `tools.ts`
 * `ALLOWED_TOOLS`). Preflight-gated via `withPreflight`: a missing
 * `OPENROUTER_API_KEY` returns a typed `setup_required` result instead of
 * throwing — the agent/model sees only that setup is required and which key
 * names are missing, never a value, and the host is responsible for
 * collecting it out-of-band.
 */
export async function aiGenerateText(
  store: CredentialStore,
  gateway: GenerationPort,
  args: AiGenerateTextArgs,
): Promise<AiGenerateTextResult | SetupRequiredResult> {
  const handler = withPreflight("generation", store, async (): Promise<AiGenerateTextResult> => {
    const result = await gateway.generate("form.value", {
      fieldLabel: args.fieldLabel,
      goal: args.goal,
      visibleContext: args.visibleContext,
      history: args.history ?? [],
    });
    return { ok: true, text: result.output.text };
  });
  return handler();
}
