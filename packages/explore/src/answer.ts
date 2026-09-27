import type { GenerationPort } from "@jevitate/ai-core";
import { redactContext, redactUrl } from "./redact.js";

/**
 * The `report` op (#101): a find-out / understand goal ("find out which plan you are on…") ends with
 * an ANSWER, not a page state. The model proposes `report`; the answer is generated from the text the
 * run observed, as claims each quoting the page verbatim; then INDEPENDENT CODE grounds it — every
 * claim's quote must be on a page the run saw, and every figure the answer states must come from a
 * grounded quote. An ungrounded answer is rejected, never recorded as the run's result.
 *
 * #207: a form field's current value (an `<input value="…">`) is page content too, but not in the
 * page's visible text (`innerText` never includes it). Each observed page also keeps its controls'
 * non-secret current values; a quote not in the page text grounds on one of them — and its evidence
 * says so (`source: "control-value"`, naming the control), never passing it off as page text.
 */

/** Bound on the observed text handed to the answer generator. */
export const ANSWER_PAGES_CHARS = 8_000;
/** Distinct observed page texts kept for grounding (oldest dropped first). */
const MAX_OBSERVED_PAGES = 30;
/** Bound on each observed page text kept. */
const OBSERVED_PAGE_CHARS = 20_000;
/** A quote shorter than this (non-space chars) proves nothing. */
const MIN_QUOTE_CHARS = 3;
/** Control values kept per observed page (#207). */
const MAX_OBSERVED_FIELDS = 40;
/** Bound on each kept control value / label. */
const OBSERVED_FIELD_CHARS = 500;

/** A form control's current value as observed (#207): the control's label and what it holds. */
export interface ObservedField {
  readonly label: string;
  readonly value: string;
}

/** One observed page: its (redacted) URL, visible text, and its controls' current values. */
export interface ObservedPage {
  readonly url: string;
  readonly text: string;
  /** Non-secret current values of the page's form controls (#207); absent when none. */
  readonly fields?: readonly ObservedField[];
  /** #216: the page's main heading (first `<h1>`) and document `<title>`; absent when none. */
  readonly heading?: string;
  readonly title?: string;
}

/** #216: a page's main heading and document title, as read from the page. */
export interface PageHeadings {
  readonly heading?: string;
  readonly title?: string;
}

/** Bound on a kept heading / title. */
const HEADING_CHARS = 200;

/**
 * The current values a page's controls hold (#207), as grounding sources: only controls whose value
 * the snapshot exposes (`Control.value` — never a password / one-time-code / bound secret field),
 * labelled by their accessible name. Buttons are excluded: their "value" is their label, already text.
 */
export function controlFields(
  controls: ReadonlyArray<{ readonly name: string; readonly role: string; readonly tag: string; readonly value?: string | null }>,
): ObservedField[] {
  const out: ObservedField[] = [];
  for (const c of controls) {
    const value = (c.value ?? "").trim();
    if (value === "" || c.role === "button" || c.role === "link") continue;
    out.push({ label: c.name.trim() || c.role || c.tag, value });
  }
  return out;
}

/**
 * The visible text of every page state the run observed — redacted when added, so nothing kept here
 * (or handed to the generator) carries a run secret. Grounding is against exactly this text.
 */
export class ObservedPages {
  readonly #pages: ObservedPage[] = [];
  constructor(private readonly secrets: readonly string[] = []) {}

  add(url: string, text: string, fields: readonly ObservedField[] = [], headings: PageHeadings = {}): void {
    const kept = fields.slice(0, MAX_OBSERVED_FIELDS).map((f) => ({
      label: redactContext(f.label, this.secrets).slice(0, OBSERVED_FIELD_CHARS),
      value: redactContext(f.value, this.secrets).slice(0, OBSERVED_FIELD_CHARS),
    }));
    const clip = (h: string | undefined): string => redactContext((h ?? "").replace(/\s+/g, " ").trim(), this.secrets).slice(0, HEADING_CHARS);
    const heading = clip(headings.heading);
    const title = clip(headings.title);
    const page: ObservedPage = {
      url: redactContext(redactUrl(url), this.secrets),
      text: redactContext(text, this.secrets).slice(0, OBSERVED_PAGE_CHARS),
      ...(kept.length === 0 ? {} : { fields: kept }),
      ...(heading === "" ? {} : { heading }),
      ...(title === "" ? {} : { title }),
    };
    if (page.text.trim() === "" && kept.length === 0) return;
    const same = (p: ObservedPage): boolean =>
      JSON.stringify(p.fields ?? []) === JSON.stringify(page.fields ?? []) && p.heading === page.heading && p.title === page.title;
    const i = this.#pages.findIndex((p) => p.url === page.url && p.text === page.text && same(p));
    if (i >= 0) this.#pages.splice(i, 1);
    this.#pages.push(page);
    if (this.#pages.length > MAX_OBSERVED_PAGES) this.#pages.shift();
  }

  /** Most recent first. */
  pages(): readonly ObservedPage[] {
    return [...this.#pages].reverse();
  }
}

/** One claim of an answer and the page text it rests on. */
export interface AnswerEvidence {
  readonly claim: string;
  readonly quote: string;
  /** The observed page the quote was found on; `null` when it was not found (ungrounded). */
  readonly url: string | null;
  readonly grounded: boolean;
  /**
   * What the quote was found in (#207): the page's visible text, or a form control's current value
   * (`control` names it). Absent when the quote was found nowhere.
   */
  readonly source?: "page-text" | "control-value";
  /** For `source: "control-value"`: the control whose current value the quote is. */
  readonly control?: string;
  /** Why the claim is not grounded. */
  readonly why?: string;
}

/** A reported answer and its evidence. */
export interface RunAnswer {
  readonly text: string;
  readonly evidence: readonly AnswerEvidence[];
}

export type AnswerVerdict =
  | { readonly accept: true; readonly answer: RunAnswer }
  | { readonly accept: false; readonly reason: string; readonly answer: RunAnswer | null };

/** Comparable form: lowercase, typographic quotes/dashes folded, whitespace collapsed. */
function fold(s: string): string {
  return s
    .toLowerCase()
    .replace(/[‘’‚‛]/g, "'")
    .replace(/[“”„‟]/g, '"')
    .replace(/[–—]/g, "-")
    .replace(/ /g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** A quote with the wrapping quotation marks / trailing punctuation a model tends to add removed. */
function bareQuote(q: string): string {
  return fold(q)
    .replace(/^["'`\s]+|["'`\s]+$/g, "")
    .replace(/[.,;:!?…]+$/, "")
    .replace(/^\.\.\.|\.\.\.$/g, "")
    .trim();
}

/**
 * Unit suffixes a figure may carry and still be a stated figure ("5GB", "30s", "24h", "10x", "3rd").
 * Any OTHER letters glued to digits make the token a word, not a figure ("2FA", "v2", "no2fa", "S3").
 */
const FIGURE_UNITS = new Set([
  "k", "m", "b", "bn", "mm", "kb", "mb", "gb", "tb", "pb", "x", "h", "hr", "hrs", "min", "mins", "s", "sec", "secs", "ms",
  "d", "w", "wk", "wks", "mo", "mos", "y", "yr", "yrs", "st", "nd", "rd", "th", "am", "pm", "px", "pt", "em", "rem",
  "kg", "g", "lb", "lbs", "km", "cm", "mi", "ft", "in", "usd", "eur", "gbp",
]);

/**
 * A free-standing figure (#157): digits (with `.`/`,` groups) that do not sit inside a word — a
 * letter, digit or `_` may not precede them, and anything glued after them must be a unit
 * (`FIGURE_UNITS`). Currency/percent marks around a figure are not letters: "$25", "25%", "€1,234".
 */
const FIGURE = /(?<![\p{L}\p{N}_])(\d+(?:[.,]\d+)*)([\p{L}\p{N}_]*)/gu;

/** One figure a text states: its value (thousands separators folded) and the token it came from. */
interface Figure {
  readonly value: string;
  readonly token: string;
}

/** Figures (with thousands separators folded): "1,200" and "1200" are the same number. */
function figuresIn(s: string): Figure[] {
  const out: Figure[] = [];
  for (const m of s.matchAll(FIGURE)) {
    const digits = m[1]!.replace(/[.,]$/, "");
    const suffix = m[2] ?? "";
    if (suffix !== "" && !FIGURE_UNITS.has(suffix.toLowerCase())) continue;
    out.push({ value: digits.replace(/,(?=\d{3}\b)/g, ""), token: m[0] });
  }
  return out;
}

function numbersIn(s: string): string[] {
  return figuresIn(s).map((f) => f.value);
}

/** "3" or `5 (in "5GB")` — the offending token quoted so the model can repair its answer. */
function describeFigures(figs: readonly Figure[]): string {
  return figs.map((f) => (f.token === f.value ? f.value : `${f.value} (in "${f.token}")`)).join(", ");
}

const STOPWORDS = new Set([
  "that", "this", "with", "have", "your", "what", "which", "from", "they", "their", "there", "then", "than",
  "will", "would", "need", "must", "should", "into", "about", "each", "every", "also", "only", "just", "been",
  "were", "when", "where", "shows", "show", "page", "says", "said", "currently", "current",
]);

/** Content words of a claim (≥4 letters, not a stopword). */
function contentWords(s: string): string[] {
  return (fold(s).match(/[a-z][a-z'-]{3,}/g) ?? []).filter((w) => !STOPWORDS.has(w));
}

/**
 * Where a quote is observed: first in a page's visible text; else (#207) in a form control's current
 * value — the quote must be (part of) the value itself, or the value as the answer generator saw it
 * (`<label>: <value>`) while containing the whole value. A quote of only a control's LABEL is not a
 * value quote (a label is the control's name, not what it holds).
 */
function locateQuote(
  q: string,
  pages: readonly ObservedPage[],
): { readonly url: string; readonly source: "page-text" | "control-value"; readonly control?: string } | null {
  const page = pages.find((p) => fold(p.text).includes(q));
  if (page !== undefined) return { url: page.url, source: "page-text" };
  // A quote copied from a control summary: `value="ada@example.test"`.
  const v = q.replace(/^value\s*=\s*["'`]?/, "");
  for (const p of pages) {
    for (const f of p.fields ?? []) {
      const value = fold(f.value);
      if (value === "") continue;
      const line = fold(`${f.label}: ${f.value}`);
      if (value.includes(v) || (q.includes(value) && line.includes(q))) return { url: p.url, source: "control-value", control: f.label };
    }
  }
  return null;
}

/** Grounds one claim against the observed pages. */
function groundClaim(claim: string, quote: string, pages: readonly ObservedPage[], given: ReadonlySet<string>): AnswerEvidence {
  const q = bareQuote(quote);
  const base = { claim, quote };
  if (q.replace(/\s/g, "").length < MIN_QUOTE_CHARS) return { ...base, url: null, grounded: false, why: "no quote" };
  const found = locateQuote(q, pages);
  if (found === null) return { ...base, url: null, grounded: false, why: "quote not found on any observed page" };
  const page = { url: found.url };
  const where = found.control === undefined ? { source: found.source } : { source: found.source, control: found.control };
  const quoted = new Set(numbersIn(q));
  const missing = figuresIn(claim).filter((f) => !quoted.has(f.value) && !given.has(f.value));
  if (missing.length > 0) {
    return { ...base, url: page.url, grounded: false, ...where, why: `figure ${describeFigures(missing)} is not in its quote` };
  }
  const words = contentWords(claim);
  // A control-value quote is checked against the value together with its label ("Email" + the address).
  const said = found.control === undefined ? q : `${fold(found.control)} ${q}`;
  if (words.length > 0 && quoted.size === 0 && !words.some((w) => said.includes(w))) {
    return { ...base, url: page.url, grounded: false, ...where, why: "the quote does not say what the claim says" };
  }
  return { ...base, url: page.url, grounded: true, ...where };
}

/** An "answer" that only says there is none — the generator's `null` rendered as text (#207). */
const NO_ANSWER_TEXT = /^(?:null|none|n\/a|unknown|undefined|not (?:found|shown|available|stated)|no answer(?: found)?)\.?$/i;

/** The reason a report found no answer on the pages seen. */
export const NO_ANSWER_REASON = "no answer was found on the pages seen";

/**
 * Independent code's verdict on a reported answer: accepted only when there is an answer, it states
 * at least one claim, EVERY claim's quote is on an observed page (with the claim's figures in it),
 * and every figure the answer text states comes from a grounded quote. A figure the GOAL itself states
 * (the operator supplied it: "a key named 'key-42'") needs no page to show it (#157).
 */
export function groundAnswer(
  proposed: { readonly answer: string | null; readonly claims: ReadonlyArray<{ readonly claim: string; readonly quote: string }> },
  pages: readonly ObservedPage[],
  opts: { readonly goal?: string } = {},
): AnswerVerdict {
  const text = (proposed.answer ?? "").trim();
  if (text === "" || (NO_ANSWER_TEXT.test(text) && proposed.claims.length === 0)) return { accept: false, reason: NO_ANSWER_REASON, answer: null };
  const given = new Set(numbersIn(opts.goal ?? ""));
  const evidence = proposed.claims.map((c) => groundClaim(c.claim, c.quote, pages, given));
  const answer: RunAnswer = { text, evidence };
  if (evidence.length === 0) return { accept: false, reason: "the answer cites no page text", answer };
  const bad = evidence.find((e) => !e.grounded);
  if (bad !== undefined) {
    return { accept: false, reason: `the answer is not grounded: "${bad.claim}" — ${bad.why ?? "ungrounded"}`, answer };
  }
  const grounded = new Set(evidence.flatMap((e) => numbersIn(e.quote)));
  const invented = figuresIn(text).filter((f) => !grounded.has(f.value) && !given.has(f.value));
  if (invented.length > 0) {
    return { accept: false, reason: `the answer states ${describeFigures(invented)}, which no observed page shows`, answer };
  }
  return { accept: true, answer };
}

/** A reply noun/verb in a goal: "wait for its reply", "report the response", "what it responds". */
const REPLY_WORD = /\b(?:repl(?:y|ies|ied)|respon(?:se|ses|ds?|ded))\b/i;
/** "answer" names a reply only next to a conversational counterpart ("the assistant's answer"). */
const ANSWER_WORD = /\banswer(?:s|ed)?\b/i;
/** Someone/something the goal converses with, or the act of messaging it. */
const COUNTERPART = /\b(?:assistant|chat ?bot|chat|bot|agent|copilot|ai)\b/i;
const MESSAGING = /\b(?:ask|asks|send|message|say|tell)\b/i;

/**
 * True when a goal asks about a conversational REPLY (#200) — "ask the assistant X, wait for its
 * reply, and report the reply". Code-side and conservative (independent adjudication, no model): a
 * reply word ("reply", "response", "responds") together with a counterpart or the act of messaging,
 * or "answer" together with a named counterpart ("the assistant's answer"). Such a goal's report may
 * be grounded ONLY on text that appeared after the run's own send — never on copy (a chat panel's
 * intro / placeholder) that was on screen before the conversation.
 */
export function goalAsksForReply(goal: string): boolean {
  if (REPLY_WORD.test(goal)) return COUNTERPART.test(goal) || MESSAGING.test(goal);
  return ANSWER_WORD.test(goal) && COUNTERPART.test(goal);
}

/** The observed pages as the generator's `pages` input: current page first, bounded. */
export function pagesContext(pages: readonly ObservedPage[], limit = ANSWER_PAGES_CHARS): string {
  let out = "";
  for (const p of pages) {
    // #207: the page's form controls' current values, marked as such (quotable like page text).
    const fields =
      p.fields === undefined || p.fields.length === 0
        ? ""
        : `FORM FIELD VALUES:\n${p.fields.map((f) => `${f.label}: ${f.value.replace(/\s+/g, " ")}`).join("\n")}\n`;
    const block = `URL: ${p.url}\n${p.text.replace(/[ \t]+/g, " ").replace(/\n{2,}/g, "\n").trim()}\n${fields}\n`;
    if (out.length + block.length > limit) {
      out += block.slice(0, Math.max(0, limit - out.length));
      break;
    }
    out += block;
  }
  return out;
}

/**
 * #216: the retry hint for a `null` answer — the current page's main heading and/or document title,
 * or `null` when it has neither (then there is nothing to retry with).
 */
export function headingHint(page: ObservedPage | undefined): string | null {
  if (page === undefined) return null;
  const parts: string[] = [];
  if (page.heading !== undefined) parts.push(`The current page's main heading is "${page.heading}".`);
  if (page.title !== undefined && page.title !== page.heading) parts.push(`Its document title is "${page.title}".`);
  if (parts.length === 0) return null;
  return `${parts.join(" ")} That heading/title is the title or name of the item or page shown: if the goal asks for it, answer with it and quote it verbatim from \`pages\`.`;
}

/**
 * Proposes the answer to a find-out goal from the observed pages (`goal.answer`), then grounds it.
 * The generator's answer is a proposal; `groundAnswer` is the verdict.
 *
 * #216: when the generator says there is no answer while the current page has a main heading or a
 * document title, it is asked ONCE more with that heading as a hint (gpt-4o-mini answered `null` to
 * "the title of this item" over an h1). The retry's answer is grounded exactly like the first.
 */
export async function reportAnswer(
  gen: GenerationPort,
  input: {
    readonly goal: string;
    readonly url: string;
    readonly pages: readonly ObservedPage[];
    readonly history: readonly string[];
    readonly secrets?: readonly string[];
  },
): Promise<AnswerVerdict> {
  const secrets = input.secrets ?? [];
  const ask = {
    goal: redactContext(input.goal, secrets),
    url: redactContext(redactUrl(input.url), secrets),
    pages: pagesContext(input.pages),
    history: input.history.slice(-20).map((h) => redactContext(h, secrets)),
  };
  const res = await gen.generate("goal.answer", ask);
  const verdict = groundAnswer(res.output, input.pages, { goal: input.goal });
  if (verdict.accept || verdict.answer !== null || verdict.reason !== NO_ANSWER_REASON) return verdict;
  const hint = headingHint(input.pages[0]);
  if (hint === null) return verdict;
  const retry = await gen.generate("goal.answer", { ...ask, hint: redactContext(hint, secrets) });
  return groundAnswer(retry.output, input.pages, { goal: input.goal });
}

/** Paths named in an "answer not found" reason (the rest are counted). */
const NOT_FOUND_PATHS = 8;

/**
 * The end reason of a run whose report found no answer (#207): "answer not found (pages seen: …)" —
 * the observed pages' paths in the order first seen, so an unanswerable find-out says what was
 * searched instead of a generic "no progress" / "blocked".
 */
export function answerNotFoundReason(pages: readonly ObservedPage[]): string {
  const paths: string[] = [];
  for (const p of [...pages].reverse()) {
    let path: string;
    try {
      const u = new URL(p.url);
      path = `${u.pathname}${u.search}`;
    } catch {
      path = p.url;
    }
    if (!paths.includes(path)) paths.push(path);
  }
  if (paths.length === 0) return "answer not found (no page text was observed)";
  const shown = paths.slice(0, NOT_FOUND_PATHS).join(", ");
  const more = paths.length > NOT_FOUND_PATHS ? `, +${paths.length - NOT_FOUND_PATHS} more` : "";
  return `answer not found (pages seen: ${shown}${more})`;
}
