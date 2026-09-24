import { FORM_VALUE_INSTRUCTIONS, type GenerationPort } from "@jevitate/ai-core";
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
 *  4. **One field, one value (#71).** For a text field, a value the goal states verbatim for that
 *     field is taken without the model (`valueStatedInGoal`); otherwise the model gets the
 *     field-scoped `FORM_VALUE_INSTRUCTIONS`, and its answer is checked in code
 *     (`checkFieldValue`) — an essay, a JSON map of every field or a `Label:` echo is rejected,
 *     never typed.
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
  /**
   * The text field being typed into (#71). With it the value is field-scoped: a value the goal
   * states verbatim for this field is taken without the model, and whatever comes back is checked
   * (`checkFieldValue`) before it may be typed.
   */
  readonly field?: FieldShape;
}

/** Guidance sent with a select's options. */
export const SELECT_OPTION_INSTRUCTIONS =
  "This field is a dropdown: answer with exactly one of `options`, copied verbatim — the one that best serves `goal`.";

export interface FillResult {
  readonly text: string | null;
  /** Why the generated value may not be typed into the field (a failed act, fed back to the model). */
  readonly rejected?: string;
  /** Where the value came from: stated verbatim in the goal (no model call), or generated. */
  readonly source?: "goal" | "model";
}

/** What `checkFieldValue` needs to know about the field. */
export interface FieldShape {
  readonly tag: string;
  readonly inputType: string | null;
}

/** Longest value accepted for a single-line `<input>` (dogfood: ~900-char essays in a name field). */
export const SINGLE_LINE_MAX_CHARS = 256;

/** A field label as the goal would say it: no required-marker, no trailing colon. */
function bareLabel(label: string): string {
  return label.replace(/[*:]+\s*$/g, "").replace(/\s+/g, " ").trim();
}

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Independent code (#71): why `value` is not a plausible value for this ONE field, or null when it
 * is. Rejects what the generator was seen returning instead of a field value — a multi-line essay
 * in a single-line input, a JSON object of every field, an over-long value, an echo of the field's
 * own `Label:` — and a value an email/url/number input cannot hold.
 */
export function checkFieldValue(value: string, field: FieldShape, fieldLabel: string): string | null {
  const v = value.trim();
  const singleLine = field.tag === "input";
  if (v === "") return "empty value";
  if (singleLine && /[\r\n]/.test(v)) return "multi-line text for a single-line field";
  if (/^[{[]/.test(v)) {
    let parsed: unknown = null;
    try {
      parsed = JSON.parse(v);
    } catch {
      // not JSON — a leading `{"` is still an object of fields
    }
    if ((parsed !== null && typeof parsed === "object") || /^\{\s*"/.test(v)) return "a JSON object, not a single field value";
  }
  if (singleLine && v.length > SINGLE_LINE_MAX_CHARS) return `${v.length} chars — too long for a single-line field`;
  const label = bareLabel(fieldLabel);
  if (label !== "" && new RegExp(`^${escapeRe(label).replace(/ /g, "\\s+")}\\s*[:=]`, "i").test(v)) {
    return `echoes the field's label ("${label}:")`;
  }
  const type = singleLine ? (field.inputType ?? "").toLowerCase() : "";
  if (type === "email" && !/^[^\s@,;]+@[^\s@,;]+$/.test(v)) return "not an email address";
  if (type === "url" && !/^[a-z][a-z0-9+.-]*:\/\/\S+$/i.test(v)) return "not an absolute URL";
  if (type === "number" && !Number.isFinite(Number(v))) return "not a number";
  return null;
}

/** Where an unquoted `Label: value` ends: a clause break, a sentence end, or `and`/`then`. */
const VALUE_END = String.raw`(?=\s*(?:[,;\n]|\s\.|\.(?:\s|$)|\s+(?:and|then)\s)|\s*$)`;
/** Where a bare `Label value` ends: also at a following preposition (`… Ada into the form`). */
const WORD_VALUE_END = String.raw`(?=\s*(?:[,;\n]|\s\.|\.(?:\s|$)|\s+(?:and|then|to|in|into|on|for|with)\s)|\s*$)`;

/** A value that reads as a literal (a proper noun, an address, an id) rather than prose. */
function looksLiteral(v: string): boolean {
  const words = v.split(/\s+/);
  return words.length <= 4 && words.every((w) => /^[\p{Lu}\p{N}]/u.test(w) || /[\p{N}@/._\-+]/u.test(w));
}

/**
 * Deterministic pre-pass (#71): the value the goal states verbatim for this field, or null.
 *
 *  - `Label: value` / `Label = value` / `Label field value: value` — up to the clause's end;
 *  - `Label "value"` (any quotes), and `named/called/titled "value"` for a name/title field;
 *  - `Label value` / `Label is|as|of|to value` — only when the value reads as a literal
 *    (`Ada Lovelace`, `ada@example.com`), never prose;
 *  - for an email/url input, the goal's one email address / absolute URL.
 *
 * Only an unambiguous match counts (two different values for the same field → null), and a value
 * containing a redaction mask is never used. The caller still checks it with `checkFieldValue`.
 */
export function valueStatedInGoal(goal: string, fieldLabel: string, field: FieldShape): string | null {
  const found = new Set<string>();
  const add = (raw: string | undefined): void => {
    if (raw === undefined) return;
    const v = raw.trim().replace(/[.,;:]+$/, "");
    if (v !== "" && !v.includes("«")) found.add(v);
  };
  const label = bareLabel(fieldLabel);
  if (label !== "" && label.length <= 60) {
    const l = escapeRe(label).replace(/ /g, "\\s+");
    const head = String.raw`(?<![\p{L}\p{N}])${l}(?![\p{L}\p{N}])(?:\s+(?:field|input|box))?(?:\s+value)?`;
    const quoted = String.raw`["“'‘\u0060]([^"”'’\u0060\n]{1,200})["”'’\u0060]`;
    for (const m of goal.matchAll(new RegExp(String.raw`${head}\s*(?:[:=]|\bis\b|\bas\b|\bof\b|\bto\b)?\s*${quoted}`, "giu"))) add(m[1]);
    for (const m of goal.matchAll(new RegExp(String.raw`${head}\s*[:=]\s*(?!["“'‘\u0060])(\S.{0,199}?)${VALUE_END}`, "giu"))) add(m[1]);
    if (found.size === 0) {
      for (const m of goal.matchAll(new RegExp(String.raw`${head}\s+(?:(?:is|as|of|to)\s+)?(?!["“'‘\u0060])(\S.{0,79}?)${WORD_VALUE_END}`, "giu"))) {
        if (m[1] !== undefined && looksLiteral(m[1].trim().replace(/[.,;:]+$/, ""))) add(m[1]);
      }
    }
    if (found.size === 0 && /\b(?:name|title)\b/i.test(label)) {
      for (const m of goal.matchAll(new RegExp(String.raw`\b(?:named|called|titled)\s+(?:${quoted}|(\S+?)${WORD_VALUE_END})`, "giu"))) {
        add(m[1] ?? m[2]);
      }
    }
  }
  if (found.size === 0 && field.tag === "input") {
    const type = (field.inputType ?? "").toLowerCase();
    const pattern = type === "email" ? /[^\s@,;:"'<>()]+@[^\s@,;:"'<>()]+\.[a-z]{2,}/gi : type === "url" ? /\bhttps?:\/\/[^\s"'<>]+/gi : null;
    if (pattern !== null) for (const m of goal.matchAll(pattern)) add(m[0].replace(/[.,;:)]+$/, ""));
  }
  return found.size === 1 ? [...found][0]! : null;
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
    const field = req.options === undefined ? req.field : undefined;
    const input = {
      fieldLabel: redactContext(req.fieldLabel, secrets),
      goal: redactContext(req.goal, secrets),
      visibleContext: redactContext(req.visibleContext, secrets).slice(0, CONTEXT_CEILING),
      history: (req.history ?? []).map((h) => redactContext(redactUrl(h), secrets)),
      ...(field === undefined
        ? {}
        : {
            fieldType: (field.tag === "input" ? field.inputType || "text" : field.tag === "textarea" ? "textarea" : "text").slice(0, 40),
            instructions: FORM_VALUE_INSTRUCTIONS,
          }),
      ...(req.options === undefined
        ? {}
        : { options: req.options.map((o) => redactContext(o, secrets).slice(0, 200)), instructions: SELECT_OPTION_INSTRUCTIONS }),
    };
    // A value the (redacted) goal states verbatim for this field needs no model at all.
    if (field !== undefined) {
      const stated = valueStatedInGoal(input.goal, input.fieldLabel, field);
      if (stated !== null && checkFieldValue(stated, field, input.fieldLabel) === null) return { text: stated, source: "goal" };
    }
    const key = JSON.stringify(input);
    if (this.#cacheKey === key) {
      return { text: this.#cacheValue, source: "model" };
    }
    this.#calls += 1;
    const res = await this.gen.generate("form.value", input);
    const text = res.output.text;
    if (field !== undefined && text !== null) {
      const rejected = checkFieldValue(text, field, input.fieldLabel);
      // A rejected value is never cached: the next ask (its history now carries the rejection) regenerates.
      if (rejected !== null) return { text: null, rejected, source: "model" };
      const value = field.tag === "input" ? text.trim() : text;
      this.#cacheKey = key;
      this.#cacheValue = value;
      return { text: value, source: "model" };
    }
    this.#cacheKey = key;
    this.#cacheValue = text;
    return { text, source: "model" };
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
