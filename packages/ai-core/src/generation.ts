import { z } from "zod";
import { contentHash } from "@jevitate/domain";

/** Text-only generation tasks (form values / triage). Closed set. */
export const FormValueInput = z.object({
  fieldLabel: z.string(),
  goal: z.string(),
  visibleContext: z.string().max(4000),
  history: z.array(z.string()).default([]),
}).strict();
export const FormValueOutput = z.object({ text: z.string().nullable() }).strict();

export const TriageInput = z.object({ failureSummary: z.string(), url: z.string() }).strict();
export const TriageOutput = z.object({ summary: z.string(), likelyCause: z.string() }).strict();

/** UX finding → a concrete, cited remediation. Generated FROM the judgment +
 *  citation + already-redacted evidence refs only — never raw copy (@jevitate/ux). */
export const UxRecommendationInput = z
  .object({
    principle: z.string(),
    citationSource: z.string(),
    citationRef: z.string(),
    judgmentSummary: z.string().max(2000),
    evidenceSummary: z.string().max(4000),
    appClass: z.string(),
  })
  .strict();
export const UxRecommendationOutput = z.object({ recommendation: z.string() }).strict();

export const GEN_TASKS = {
  "form.value": { input: FormValueInput, output: FormValueOutput, promptVersion: "1" },
  "triage.narrative": { input: TriageInput, output: TriageOutput, promptVersion: "1" },
  "ux.recommendation": { input: UxRecommendationInput, output: UxRecommendationOutput, promptVersion: "1" },
} as const;
export type GenTaskKind = keyof typeof GEN_TASKS;
export type GenInput<K extends GenTaskKind> = z.input<(typeof GEN_TASKS)[K]["input"]>;
export type GenOutput<K extends GenTaskKind> = z.output<(typeof GEN_TASKS)[K]["output"]>;

export interface GenerationProvenance {
  adapter: "openrouter" | "fake";
  model: string;             // the chosen model id — recorded per run
  promptVersion: string;
  latencyMs: number;
  responseHash: string;      // contentHash(output) — never any key
}
export interface GenerationResult<K extends GenTaskKind> {
  output: GenOutput<K>;
  provenance: GenerationProvenance;
}

/** The mockable port. Every consumer depends only on this. */
export interface GenerationPort {
  generate<K extends GenTaskKind>(kind: K, input: GenInput<K>): Promise<GenerationResult<K>>;
}

/** Deterministic fake — used by ALL CI tests; no network, no key. */
export class FakeGenerationGateway implements GenerationPort {
  constructor(private readonly canned?: Partial<Record<GenTaskKind, unknown>>) {}
  async generate<K extends GenTaskKind>(kind: K, input: GenInput<K>): Promise<GenerationResult<K>> {
    const parsed = GEN_TASKS[kind].input.parse(input);
    const raw = this.canned?.[kind] ?? this.defaultFor(kind, parsed);
    const output = GEN_TASKS[kind].output.parse(raw) as GenOutput<K>;
    return {
      output,
      provenance: {
        adapter: "fake", model: "fake",
        promptVersion: GEN_TASKS[kind].promptVersion,
        latencyMs: 0, responseHash: contentHash(output),
      },
    };
  }
  private defaultFor(kind: GenTaskKind, input: unknown): unknown {
    if (kind === "form.value") return { text: `value:${(input as { fieldLabel: string }).fieldLabel}` };
    if (kind === "ux.recommendation") {
      const i = input as { principle: string };
      return { recommendation: `Improve "${i.principle}" on this screen.` };
    }
    return { summary: "fake triage", likelyCause: "unknown" };
  }
}
