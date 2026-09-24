import type { GenerationPort } from "@jevitate/ai-core";
import { redactContext, redactUrl } from "./redact.js";

/**
 * fill: the generative-text helper discipline for a `type` op (guardrail #3).
 *
 * On `type`, the loop asks the generation gateway for a value for the chosen
 * field. Three disciplines are enforced here:
 *
 *  1. **Redact first.** Every string handed to the model (field label, goal,
 *     visible context, history) is scrubbed of registered secrets and proven
 *     clean (`redactContext`), and the context is bounded to the gateway's
 *     4000-char ceiling.
 *  2. **Reuse only while the input is identical.** A value is regenerated only
 *     when the helper input changes; re-asking for the same field/goal/context
 *     returns the cached value rather than paying for a second round-trip and
 *     risking a different answer mid-retry.
 *  3. **Discard after a successful mutation.** Once the value has been typed
 *     and the step succeeded, the caller calls `commit()` and the cache is
 *     dropped — a value is never silently carried into a different field.
 *
 * The gateway itself only ever returns text (never a real recipient), and may
 * return `{ text: null }` for a required value it cannot honestly supply; the
 * helper passes that through (the loop then blocks rather than typing a guess).
 */

export interface FillRequest {
  readonly fieldLabel: string;
  readonly goal: string;
  readonly visibleContext: string;
  readonly history?: readonly string[];
  readonly secrets?: readonly string[];
  /** A `<select>`'s actual option labels: the value must be one of them (checked by the caller). */
  readonly options?: readonly string[];
}

/** Guidance sent with a select's options. */
export const SELECT_OPTION_INSTRUCTIONS =
  "This field is a dropdown: answer with exactly one of `options`, copied verbatim — the one that best serves `goal`.";

export interface FillResult {
  readonly text: string | null;
}

/** The generation gateway's documented input ceiling for `visibleContext`. */
const CONTEXT_CEILING = 4000;

export class FillHelper {
  #cacheKey: string | null = null;
  #cacheValue: string | null = null;
  #calls = 0;

  constructor(private readonly gen: GenerationPort) {}

  /** How many times the underlying gateway was actually called (for tests). */
  get generateCalls(): number {
    return this.#calls;
  }

  async valueFor(req: FillRequest): Promise<FillResult> {
    const secrets = req.secrets ?? [];
    const input = {
      fieldLabel: redactContext(req.fieldLabel, secrets),
      goal: redactContext(req.goal, secrets),
      visibleContext: redactContext(req.visibleContext, secrets).slice(0, CONTEXT_CEILING),
      history: (req.history ?? []).map((h) => redactContext(redactUrl(h), secrets)),
      ...(req.options === undefined
        ? {}
        : { options: req.options.map((o) => redactContext(o, secrets).slice(0, 200)), instructions: SELECT_OPTION_INSTRUCTIONS }),
    };
    const key = JSON.stringify(input);
    if (this.#cacheKey === key) {
      return { text: this.#cacheValue };
    }
    this.#calls += 1;
    const res = await this.gen.generate("form.value", input);
    this.#cacheKey = key;
    this.#cacheValue = res.output.text;
    return { text: res.output.text };
  }

  /** Drop the reused value after a successful mutation. */
  commit(): void {
    this.#cacheKey = null;
    this.#cacheValue = null;
  }
}

/**
 * The option a generated select value names — exact, then case/whitespace-insensitive. `null` when
 * it names none: the caller never selects a guessed option.
 */
export function matchOption(text: string, options: readonly string[]): string | null {
  const n = (s: string): string => s.replace(/\s+/g, " ").trim().toLowerCase();
  const exact = options.find((o) => o === text);
  if (exact !== undefined) return exact;
  const t = n(text);
  return options.find((o) => n(o) === t) ?? null;
}

/**
 * Bounds a generated chat message to `maxChars` (the configured cap): whitespace collapsed, markdown
 * emphasis/heading marks dropped, and — when over the cap — cut at the last sentence end that fits
 * (else the last word). Independent code: the cap holds whatever the model returned.
 */
export function capMessage(text: string, maxChars: number): string {
  const flat = text
    .replace(/^#+\s*/gm, "")
    .replace(/\*\*|__/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (flat.length <= maxChars) return flat;
  const head = flat.slice(0, maxChars);
  const sentence = Math.max(head.lastIndexOf(". "), head.lastIndexOf("? "), head.lastIndexOf("! "));
  if (sentence >= maxChars / 3) return head.slice(0, sentence + 1);
  const word = head.lastIndexOf(" ");
  return (word >= maxChars / 3 ? head.slice(0, word) : head).trim();
}

export interface ChatReplyRequest {
  readonly goal: string;
  readonly fieldLabel: string;
  readonly latestReply: string | null;
  readonly sentMessages: readonly string[];
  readonly maxChars: number;
  readonly secrets?: readonly string[];
}

/** Bound on each conversation string handed to the generator. */
const CHAT_CONTEXT_CHARS = 2000;

/**
 * The next user message for a conversation (`chat.reply`): redacted input, then the configured cap
 * applied to whatever came back. `null` when the generator will not honestly supply one.
 */
export async function chatReply(gen: GenerationPort, req: ChatReplyRequest): Promise<string | null> {
  const secrets = req.secrets ?? [];
  const bound = (s: string): string => redactContext(s, secrets).slice(0, CHAT_CONTEXT_CHARS);
  const res = await gen.generate("chat.reply", {
    goal: redactContext(req.goal, secrets),
    fieldLabel: redactContext(req.fieldLabel, secrets),
    latestReply: req.latestReply === null ? null : bound(req.latestReply),
    sentMessages: req.sentMessages.slice(-50).map(bound),
    maxChars: req.maxChars,
  });
  const text = res.output.text;
  if (text === null) return null;
  const capped = capMessage(text, req.maxChars);
  return capped === "" ? null : capped;
}
