import { CHAT_REPLY_STUCK_INSTRUCTIONS, FORM_VALUE_INSTRUCTIONS, type GenerationPort } from "@jevitate/ai-core";
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
 *     never typed — and so is an echo of the goal itself (`echoesGoal`, the #71 reopen: the whole goal
 *     sentence typed into a name field).
 *  5. **The next item, not the first again (#123).** The values this run already submitted into the
 *     same field go to the model (`alreadyUsed`), and when the goal names several items a value
 *     identical to one of them is rejected in code.
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
  /** Values this run already submitted into this same field (#123), oldest first. */
  readonly alreadyUsed?: readonly string[];
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
 * own `Label:` — and a value an email/url/number input cannot hold. Given the `goal` (a generated
 * value), an echo of the goal (`echoesGoal`) and an essay in a name / search box are rejected too.
 */
export function checkFieldValue(value: string, field: FieldShape, fieldLabel: string, goal?: string): string | null {
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
  // A generated value (the goal is passed) must not be the goal itself (#71 reopen).
  const echo = goal === undefined ? null : echoesGoal(v, goal);
  if (echo !== null) return `echoes the goal instead of a value for this field — ${echo}`;
  const kind = fieldKind(fieldLabel, field);
  if (singleLine && (kind === "name" || kind === "search") && words(v).length > SHORT_FIELD_MAX_WORDS) {
    return `${words(v).length} words — too long for a ${kind} field`;
  }
  return null;
}

/** Longest value (in words) accepted for a single-line name / search field. */
export const SHORT_FIELD_MAX_WORDS = 10;

/** Share of distinct words a value may have in common with the goal before it counts as an echo (#71). */
export const GOAL_ECHO_OVERLAP = 0.6;
/** A run of the goal's words this long (chars, 5+ words) inside a value is the goal echoed (#71). */
export const GOAL_ECHO_RUN_CHARS = 40;

const words = (s: string): string[] => s.toLowerCase().match(/[\p{L}\p{N}$]+(?:['’][\p{L}]+)?/gu) ?? [];

/** Segments the goal puts in quotes: a value the goal quotes is a stated value, never an echo. */
function quotedSegments(goal: string): string[] {
  return [...goal.matchAll(/["“'‘\u0060]([^"”'’\u0060\n]{1,200})["”'’\u0060]/gu)].map((m) => m[1] ?? "");
}

/**
 * Independent code (#71 reopen): why `value` is the goal (or a large part of it) echoed rather than a
 * value for one field, or null. Echo = the same words as the goal; a run of 5+ of the goal's words
 * spanning `GOAL_ECHO_RUN_CHARS`+ characters; or (6+ distinct content words) more than
 * `GOAL_ECHO_OVERLAP` of the value's content words taken from the goal — a paraphrase of it. A value
 * the goal itself quotes is exempt; a short value (a name, a term) is judged by the first two only.
 */
export function echoesGoal(value: string, goal: string): string | null {
  const v = words(value);
  const g = words(goal);
  if (v.length === 0 || g.length === 0) return null;
  const flat = v.join(" ");
  const goalFlat = ` ${g.join(" ")} `;
  if (flat === g.join(" ")) return "it is the goal text";
  if (quotedSegments(goal).some((q) => words(q).join(" ") === flat)) return null;
  for (let i = 0; i < v.length; i++) {
    let j = i;
    while (j < v.length && goalFlat.includes(` ${v.slice(i, j + 1).join(" ")} `)) j++;
    const run = v.slice(i, j).join(" ");
    if (j - i >= 5 && run.length >= GOAL_ECHO_RUN_CHARS) return `it copies the goal ("${run.slice(0, 60)}")`;
  }
  const vs = new Set(v.filter((w) => !ECHO_STOP_WORDS.has(w)));
  if (vs.size >= ECHO_MIN_WORDS) {
    const gs = new Set(g);
    const overlap = [...vs].filter((w) => gs.has(w)).length / vs.size;
    if (overlap > GOAL_ECHO_OVERLAP) return `it restates the goal (${Math.round(overlap * 100)}% of its words are the goal's)`;
  }
  return null;
}

/** A value needs this many distinct content words before word overlap can call it an echo. */
const ECHO_MIN_WORDS = 6;
/** Function words: shared by any two English sentences, so never evidence of an echo. */
const ECHO_STOP_WORDS = new Set(
  ("a an the and or but to of in on for with at by from as is are was were be been it its this that these those i i'm i'll " +
    "we you your my our me us will can so then just not no do does did have has had if into up out about")
    .split(" "),
);

/** What kind of value a field wants, by its label / type (#71) — steers the generator; null = unknown. */
export type FieldKind = "name" | "search" | "title" | "reasoning";

export function fieldKind(fieldLabel: string, field: FieldShape): FieldKind | null {
  const l = bareLabel(fieldLabel).toLowerCase();
  const type = field.tag === "input" ? (field.inputType ?? "").toLowerCase() : "";
  if (type === "search" || /\b(search|find|filter|look ?up|query)\b/.test(l)) return "search";
  if (/\b(rationale|reasons?|why|notes?|comments?|description|describe|explain|explanation|justification|feedback|summary)\b/.test(l)) {
    return "reasoning";
  }
  if (/\b(title|subject|headline)\b/.test(l)) return "title";
  if (/\bname\b/.test(l) && !/\b(user ?name|file ?name|host ?name|domain)\b/.test(l)) return "name";
  if (field.tag === "textarea") return "reasoning";
  return null;
}

/**
 * True when the goal names several items of a kind (#123: "add two customers…", "each", "both",
 * "another", or several email addresses) — an add-another flow, where one field's values differ.
 */
export function goalListsSeveral(goal: string): boolean {
  // A count word inside a compound or a fixed phrase ("two-factor", "second factor", "2-step",
  // "third-party") names no items (#184): hyphen-joined words are fused into one token first, and a
  // count word before a qualifier noun ("second factor", "each time") is no count.
  const COUNT = String.raw`\b(?:two|three|four|five|six|seven|eight|nine|ten|several|multiple|each|both|another|second|third)\b`;
  const QUALIFIED = String.raw`(?!\s+(?:factors?|steps?|party|parties|hand|half|time|times|level|tier|way|place|attempt|try|opinion|thoughts?|nature|glance|look)\b)`;
  if (new RegExp(COUNT + QUALIFIED, "i").test(goal.replace(/\b\w+-(?=\w)/g, (m) => m.replace(/\W/g, "_")))) return true;
  if (/\b(?:[2-9]|1\d)\s+(?:new\s+|more\s+|separate\s+|different\s+)?[a-z]+s\b/i.test(goal)) return true;
  const emails = new Set(goal.match(/[^\s@,;:"'<>()]+@[^\s@,;:"'<>()]+\.[a-z]{2,}/gi) ?? []);
  return emails.size >= 2;
}

const sameValue = (a: string, b: string): boolean =>
  a.replace(/\s+/g, " ").trim().toLowerCase() === b.replace(/\s+/g, " ").trim().toLowerCase();

/**
 * The values this run typed into each field (#123), keyed by the field's label: a value typed and
 * then submitted (a button clicked, or the page navigated) is "used". An add-another flow asks for
 * the next item, never a used one; a correction before any submit may retype freely.
 */
export class FieldValueLog {
  readonly #pending = new Map<string, string>();
  readonly #used = new Map<string, string[]>();
  /** What the latest submit sent, per field — undone by a reload (#184). */
  readonly #lastBatch = new Map<string, string>();

  static key(label: string): string {
    return bareLabel(label).toLowerCase();
  }

  /** A value typed into `label` (not submitted yet). */
  typed(label: string, value: string): void {
    this.#pending.set(FieldValueLog.key(label), value);
  }

  /** The form was submitted (or the page navigated): every typed value is now used. */
  submitted(): void {
    if (this.#pending.size > 0) this.#lastBatch.clear();
    for (const [k, v] of this.#pending) {
      this.#lastBatch.set(k, v);
      const list = this.#used.get(k) ?? [];
      if (!list.some((u) => sameValue(u, v))) list.push(v);
      this.#used.set(k, list);
    }
    this.#pending.clear();
  }

  /**
   * The page was reloaded (#184): the last submit did not take, so what it sent is a retry, not a
   * used item — retyping the same value is allowed again.
   */
  reloaded(): void {
    for (const [k, list] of this.#used) {
      const last = this.#lastBatch.get(k);
      if (last === undefined) continue;
      const rest = list.filter((u) => !sameValue(u, last));
      if (rest.length === 0) this.#used.delete(k);
      else this.#used.set(k, rest);
    }
    this.#lastBatch.clear();
    this.#pending.clear();
  }

  /** The values already submitted into `label`, oldest first. */
  used(label: string): readonly string[] {
    return this.#used.get(FieldValueLog.key(label)) ?? [];
  }
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
  const found = valuesStatedInGoal(goal, fieldLabel, field);
  return found.length === 1 ? found[0]! : null;
}

/** Every distinct value the goal states for this field, in goal order (see `valueStatedInGoal`). */
export function valuesStatedInGoal(goal: string, fieldLabel: string, field: FieldShape): string[] {
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
  // Goal order: an add-another flow takes the items in the order the goal lists them (#123).
  return [...found].sort((a, b) => goal.indexOf(a) - goal.indexOf(b));
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
    const used = (req.alreadyUsed ?? []).map((u) => redactContext(u, secrets).slice(0, 200)).slice(-20);
    const kind = field === undefined ? null : fieldKind(req.fieldLabel, field);
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
            ...(kind === null ? {} : { fieldKind: kind }),
            ...(used.length === 0 ? {} : { alreadyUsed: used }),
          }),
      ...(req.options === undefined
        ? {}
        : { options: req.options.map((o) => redactContext(o, secrets).slice(0, 200)), instructions: SELECT_OPTION_INSTRUCTIONS }),
    };
    const several = goalListsSeveral(input.goal);
    const isUsed = (v: string): boolean => used.some((u) => sameValue(u, v));
    // A value the (redacted) goal states verbatim for this field needs no model at all. When the goal
    // lists several items for it (an add-another flow, #123), the next one not yet used.
    if (field !== undefined) {
      const stated = valuesStatedInGoal(input.goal, input.fieldLabel, field);
      const pick = several ? stated.find((v) => !isUsed(v)) : stated.length === 1 ? stated[0] : undefined;
      if (pick !== undefined && checkFieldValue(pick, field, input.fieldLabel) === null) return { text: pick, source: "goal" };
    }
    const key = JSON.stringify(input);
    if (this.#cacheKey === key) {
      return { text: this.#cacheValue, source: "model" };
    }
    this.#calls += 1;
    const res = await this.gen.generate("form.value", input);
    const text = res.output.text;
    if (field !== undefined && text !== null) {
      const rejected =
        checkFieldValue(text, field, input.fieldLabel, input.goal) ??
        (several && isUsed(text)
          ? `repeats ${JSON.stringify(text.trim().slice(0, 80))}, already submitted into this field — the goal lists several items: use the next one`
          : null);
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
  /** The assistant's last question (code-extracted from `latestReply`, #122), when it asked one. */
  readonly question?: string | null;
  /** Code found the conversation stuck on content-free turns (#122): the stuck brief is sent. */
  readonly stuck?: boolean;
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
    ...(req.question === undefined || req.question === null ? {} : { question: bound(req.question).slice(0, 500) }),
    maxChars: req.maxChars,
    ...(req.stuck === true ? { instructions: CHAT_REPLY_STUCK_INSTRUCTIONS } : {}),
  });
  const text = res.output.text;
  if (text === null) return null;
  const capped = capMessage(text, req.maxChars);
  return capped === "" ? null : capped;
}
