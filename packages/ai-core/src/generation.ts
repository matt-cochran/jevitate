import { z } from "zod";
import { contentHash } from "@jevitate/domain";

/**
 * The model-facing brief for a `form.value` (#71): the value for ONE field, never the whole goal.
 * Carried in the input (the schema default) so every adapter shows it; a `<select>` sends its own.
 */
export const FORM_VALUE_INSTRUCTIONS =
  "Return in `text` ONLY the literal characters to type into the single field named `fieldLabel` " +
  "(its HTML input type is `fieldType` when given) — nothing else: no explanation, no steps, no " +
  "JSON, no other field's value, and never the field's label or a `Label:` prefix. When `goal` " +
  "states the value for this field, copy it verbatim. Otherwise invent a short, plausible value " +
  "of the right kind (an email address for an email field, an absolute URL for a url field). " +
  "Return null only when the goal gives no value and none can be invented safely.";

/** Text-only generation tasks (form values / triage). Closed set. */
export const FormValueInput = z.object({
  fieldLabel: z.string(),
  goal: z.string(),
  visibleContext: z.string().max(4000),
  history: z.array(z.string()).default([]),
  /** The field's HTML input type (`text`, `email`, `url`, `password`, `textarea`…), when known. */
  fieldType: z.string().max(40).optional(),
  /**
   * For a `<select>`: its actual option labels. The answer must be one of them verbatim — the
   * caller checks it and never selects a guessed option.
   */
  options: z.array(z.string().max(200)).max(100).optional(),
  /** Task guidance shown to the model (default `FORM_VALUE_INSTRUCTIONS`; a select sends its own). */
  instructions: z.string().max(1000).default(FORM_VALUE_INSTRUCTIONS),
}).strict();
export const FormValueOutput = z.object({ text: z.string().nullable() }).strict();

/** The model-facing brief for a `chat.reply`, carried in the input so every adapter shows it. */
export const CHAT_REPLY_INSTRUCTIONS =
  "You are the USER in a chat with a software assistant, pursuing `goal`. Write the user's next " +
  "message: a short, plain, conversational answer to `latestReply` (answer its question directly; " +
  "if it offers a choice, pick one). Speak only as the user, in the first person. Never invent the " +
  "assistant's lines, never use markdown headings or lists, never restate the goal as an essay, and " +
  "never repeat any of `sentMessages`. At most `maxChars` characters. With no `latestReply` yet, " +
  "open with one or two sentences stating what you want.";

/** The next user message in a conversation (a chat composer). */
export const ChatReplyInput = z.object({
  goal: z.string(),
  fieldLabel: z.string(),
  /** The assistant's latest reply (untrusted page text, redacted, bounded), or null before any. */
  latestReply: z.string().max(2000).nullable(),
  /** The messages already sent in this conversation (redacted, bounded), oldest first. */
  sentMessages: z.array(z.string().max(2000)).max(50).default([]),
  maxChars: z.number().int().min(20).max(2000),
  instructions: z.string().max(1000).default(CHAT_REPLY_INSTRUCTIONS),
}).strict();
export const ChatReplyOutput = z.object({ text: z.string().nullable() }).strict();

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

/**
 * UX finding specifics (@jevitate/ux semantic tier): for ONE redacted screen-state and the
 * rubric items Jev flagged on it, name WHAT is wrong — the implicated controls (by index),
 * verbatim quotes of on-screen text, the observation relative to the job, the user impact and
 * a specific fix. Structured output only; @jevitate/ux adjudicates every cited control/quote
 * against the observed screen in code before anything becomes a finding.
 */
export const UxSpecificsInput = z
  .object({
    instructions: z.string().max(4000),
    appClass: z.string(),
    job: z.string().max(1000),
    persona: z.string().max(500).optional(),
    url: z.string(),
    controls: z.array(z.object({ index: z.number().int().min(0), summary: z.string().max(500) }).strict()).max(200),
    visibleText: z.string().max(6000),
    items: z
      .array(
        z
          .object({
            rubricItemId: z.string(),
            principle: z.string(),
            criteria: z.string().max(2000),
            citation: z.string(),
          })
          .strict(),
      )
      .min(1)
      .max(40),
  })
  .strict();
export const UxSpecificsItem = z
  .object({
    rubricItemId: z.string(),
    /** Independent re-judgment: after looking for concrete evidence, is the principle really violated? */
    violated: z.boolean(),
    /** Indexes of the controls actually implicated (from `controls[].index`). */
    implicatedControls: z.array(z.number().int()),
    /** Verbatim excerpts of on-screen text (visibleText or a control label) that show the problem. */
    quotes: z.array(z.string()),
    /** What is wrong, naming the control/label/text, relative to the job. */
    observation: z.string(),
    /** The consequence for the user pursuing the job. */
    userImpact: z.string(),
    /** A specific change to THIS control/text — not a restatement of the heuristic. */
    recommendation: z.string(),
  })
  .strict();
export const UxSpecificsOutput = z.object({ items: z.array(UxSpecificsItem) }).strict();

export const GEN_TASKS = {
  "form.value": { input: FormValueInput, output: FormValueOutput, promptVersion: "3" },
  "chat.reply": { input: ChatReplyInput, output: ChatReplyOutput, promptVersion: "1" },
  "triage.narrative": { input: TriageInput, output: TriageOutput, promptVersion: "1" },
  "ux.recommendation": { input: UxRecommendationInput, output: UxRecommendationOutput, promptVersion: "1" },
  "ux.specifics": { input: UxSpecificsInput, output: UxSpecificsOutput, promptVersion: "1", temperature: 0 },
} as const;

/** A task's sampling temperature when it pins one (run-to-run consistency); else the provider default. */
export function taskTemperature(kind: GenTaskKind): number | undefined {
  const task = GEN_TASKS[kind];
  return "temperature" in task ? task.temperature : undefined;
}
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

/** The fake's value for a field whose input type constrains its format. */
const FAKE_TYPED_VALUES: Readonly<Record<string, string>> = {
  email: "user@example.com",
  url: "https://example.com/",
  number: "1",
  tel: "5550100",
};

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
    if (kind === "form.value") {
      const i = input as { fieldLabel: string; fieldType?: string; options?: string[] };
      // A select answers with a real option (the first non-empty one), deterministically.
      const option = i.options?.find((o) => o.trim() !== "");
      if (option !== undefined) return { text: option };
      // A typed field gets a value of its kind (the loop rejects a malformed email/url/number).
      const typed = i.fieldType === undefined ? undefined : FAKE_TYPED_VALUES[i.fieldType];
      return { text: typed ?? `value:${i.fieldLabel}` };
    }
    if (kind === "chat.reply") {
      const i = input as { fieldLabel: string; sentMessages: string[]; latestReply: string | null };
      const turn = i.sentMessages.length + 1;
      return { text: turn === 1 ? `message 1 for ${i.fieldLabel}` : `message ${turn}, answering: ${(i.latestReply ?? "").slice(0, 40)}` };
    }
    if (kind === "ux.recommendation") {
      const i = input as { principle: string };
      return { recommendation: `Improve "${i.principle}" on this screen.` };
    }
    if (kind === "ux.specifics") {
      // Deterministic, grounded-by-construction: cite the first control verbatim (or none).
      const i = input as z.output<typeof UxSpecificsInput>;
      const first = i.controls[0];
      return {
        items: i.items.map((it) => ({
          rubricItemId: it.rubricItemId,
          violated: true,
          implicatedControls: first ? [first.index] : [],
          quotes: [],
          observation: first ? `${first.summary} does not satisfy "${it.principle}" for the job.` : "",
          userImpact: "The user may hesitate or take the wrong path.",
          recommendation: first ? `Revise ${first.summary} so it satisfies "${it.principle}".` : "",
        })),
      };
    }
    return { summary: "fake triage", likelyCause: "unknown" };
  }
}
