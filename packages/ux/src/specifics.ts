// specifics.ts — the structured-output step that turns a flagged Jev judgment into a concrete,
// grounded observation. ONE generation call per screen-state covers every rubric item Jev
// flagged there. Accepts ONLY `RedactedEvidence` (branded) — raw evidence cannot reach the
// model. The output is advisory: `adjudicate.ts` checks every cited control/quote in code.
import { assertNoSecretInPayload, type GenerationPort, type GenOutput } from "@jevitate/ai-core";
import type { RubricEntry } from "./types.js";
import type { RedactedEvidence } from "./redact.js";
import { fillTemplate } from "./judge.js";
import { UX_PROMPTS } from "./prompts.js";

export type UxSpecifics = GenOutput<"ux.specifics">;
export type UxSpecificsItem = UxSpecifics["items"][number];

const MAX_TEXT = 6000;
const MAX_CONTROLS = 200;

/** The specifics instructions (versioned asset `assets/ux-prompts.json`). */
export const SPECIFICS_INSTRUCTIONS = UX_PROMPTS.specifics.join("\n");

/** Generates the specifics for the flagged entries of one redacted screen-state. */
export async function generateSpecifics(
  gen: GenerationPort,
  evidence: RedactedEvidence,
  flagged: readonly RubricEntry[],
  secrets: readonly string[] = [],
): Promise<UxSpecifics> {
  const input = {
    instructions: SPECIFICS_INSTRUCTIONS,
    appClass: evidence.appContext.appClass,
    job: (evidence.job ?? evidence.appContext.job ?? "(unspecified)").slice(0, 1000),
    ...(evidence.appContext.persona ? { persona: evidence.appContext.persona.slice(0, 500) } : {}),
    url: evidence.url,
    controls: evidence.controls.slice(0, MAX_CONTROLS).map((c) => ({ index: c.index, summary: c.summary.slice(0, 500) })),
    visibleText: evidence.visibleText.slice(0, MAX_TEXT),
    items: flagged.map((e) => ({
      rubricItemId: e.id,
      principle: e.principle,
      criteria: e.questions.map((q) => fillTemplate(q.criteria, evidence)).join(" ").slice(0, 2000),
      citation: `${e.citation.source}: ${e.citation.ref}`,
    })),
  };
  // Belt-and-suspenders: prove the outbound payload is secret-free before it goes.
  assertNoSecretInPayload(input, secrets);
  const result = await gen.generate("ux.specifics", input);
  return result.output;
}
