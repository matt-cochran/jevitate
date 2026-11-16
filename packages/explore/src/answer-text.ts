import { errorPageReason, fold } from "./answer-observed.js";

import type { ObservedPage } from "./answer-observed.js";

/** A quote shorter than this (non-space chars) proves nothing. */
export const MIN_QUOTE_CHARS = 3;

/** A quote with the wrapping quotation marks / trailing punctuation a model tends to add removed. */
export function bareQuote(q: string): string {
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

export function numbersIn(s: string): string[] {
  return figuresIn(s).map((f) => f.value);
}

/**
 * #236: an ordinal list marker at a line's start — `1.`, `2)`, `**3.**`, `- 4.` — is formatting, not a
 * figure the text states. Only at a line's start and only when followed by a space, so "2.5 GB" and
 * "$300." stay figures.
 */
const LIST_MARKER = /^([ \t]*(?:[-*+•][ \t]+)?(?:\*\*|__)?)\d{1,3}[.)](?:\*\*|__)?(?=[ \t])/gm;

/** A text with its numbered-list markers removed (#236). */
function withoutListMarkers(s: string): string {
  return s.replace(LIST_MARKER, "$1");
}

/** The figures a claim / an answer STATES (#157, #236): numbered-list markers are not stated figures. */
export function statedFigures(s: string): Figure[] {
  return figuresIn(withoutListMarkers(s));
}

/** "3" or `5 (in "5GB")` — the offending token quoted so the model can repair its answer. */
export function describeFigures(figs: readonly Figure[]): string {
  return figs.map((f) => (f.token === f.value ? f.value : `${f.value} (in "${f.token}")`)).join(", ");
}

const STOPWORDS = new Set([
  "that", "this", "with", "have", "your", "what", "which", "from", "they", "their", "there", "then", "than",
  "will", "would", "need", "must", "should", "into", "about", "each", "every", "also", "only", "just", "been",
  "were", "when", "where", "shows", "show", "page", "says", "said", "currently", "current",
]);

/** Content words of a claim (≥4 letters, not a stopword). */
export function contentWords(s: string): string[] {
  return (fold(s).match(/[a-z][a-z'-]{3,}/g) ?? []).filter((w) => !STOPWORDS.has(w));
}

/**
 * #236: a content word's stem — its inflection cut, never below 5 letters — so "subscribed" is said
 * by a quote "No subscription". A word of 5 letters or fewer is its own stem.
 */
export function stemOf(w: string): string {
  return w.slice(0, Math.max(5, w.length - 3));
}

/** Where a quote was found: the page, its URL, and the source (page text / a control's value). */
interface Located {
  readonly page: ObservedPage;
  readonly url: string;
  readonly source: "page-text" | "control-value";
  readonly control?: string;
  /** For a control-value: the control's whole current value. */
  readonly value?: string;
}

/**
 * Where a quote is observed: first in a page's visible text; else (#207) in a form control's current
 * value — the quote must be (part of) the value itself, or the value as the answer generator saw it
 * (`<label>: <value>`) while containing the whole value. A quote of only a control's LABEL is not a
 * value quote (a label is the control's name, not what it holds).
 */
export function locateQuote(q: string, pages: readonly ObservedPage[]): Located | null {
  const page = pages.find((p) => fold(p.text).includes(q));
  if (page !== undefined) return { page, url: page.url, source: "page-text" };
  // A quote copied from a control summary: `value="ada@example.test"`.
  const v = q.replace(/^value\s*=\s*["'`]?/, "");
  for (const p of pages) {
    for (const f of p.fields ?? []) {
      const value = fold(f.value);
      if (value === "") continue;
      const line = fold(`${f.label}: ${f.value}`);
      // #223: the quote lost the value's own trailing punctuation to `bareQuote` ("Bio: Loves tea." →
      // "bio: loves tea"), so the whole value is compared in the same bare form.
      const whole = bareQuote(f.value);
      if (value.includes(v) || ((q.includes(value) || (whole !== "" && q.includes(whole))) && line.includes(q))) {
        return { page: p, url: p.url, source: "control-value", control: f.label, value: f.value };
      }
    }
  }
  return null;
}

/** The non-empty lines of a multi-line quote, each in comparable bare form (#234). */
function quoteLines(quote: string): string[] {
  return quote
    .split(/\r?\n/)
    .map((l) => bareQuote(l))
    .filter((l) => l.replace(/\s/g, "") !== "");
}

/**
 * #234: a multi-line quote whose EVERY line is on the same observed page's visible text, in the
 * quote's order — the natural evidence of a list answer (a page's section headings, tabs, options),
 * whose entries are real but not contiguous on the page. Every line must be a quote in its own right
 * (≥ `MIN_QUOTE_CHARS`); a line found nowhere, or out of order, grounds nothing.
 */
export function locateLines(quote: string, pages: readonly ObservedPage[]): Located | null {
  const lines = quoteLines(quote);
  if (lines.length < 2 || lines.some((l) => l.replace(/\s/g, "").length < MIN_QUOTE_CHARS)) return null;
  for (const page of pages) {
    const text = fold(page.text);
    let at = 0;
    let inOrder = true;
    for (const line of lines) {
      const i = text.indexOf(line, at);
      if (i < 0) {
        inOrder = false;
        break;
      }
      at = i + line.length;
    }
    if (inOrder) return { page, url: page.url, source: "page-text" };
  }
  return null;
}

/**
 * Why a quote was found nowhere (#234): a multi-line quote is told what a quote must be — one
 * contiguous passage, or lines that each appear on ONE page in that order — so the model can repair it
 * instead of resubmitting the same stitched text.
 */
export function notFoundWhy(quote: string, claim = ""): string {
  // #447: a negative claim has no text to quote — the model is told how to state an absence instead.
  const absence = NEGATIVE_CLAIM.test(claim)
    ? " — to state that something is NOT there, set `absent` to its name and leave `quote` empty (code checks the observed controls and text)"
    : "";
  if (quoteLines(quote).length < 2) return `quote not found on any observed page${absence}`;
  return `quote not found on any observed page: its lines are not all on one page in that order — quote one contiguous passage, or give one claim per list entry, each quoting that entry${absence}`;
}

/** #447: a claim that says something is not there ("No controls allow…", "there is no Launch button"). */
const NEGATIVE_CLAIM = /\b(?:no|not|none|never|nothing|without|lacks?|absent|missing)\b|n't\b/i;

/** #447: words that name a KIND of thing ("the Launch control"), not the thing an absence claim is about. */
const KIND_WORDS = new Set([
  "control", "controls", "button", "buttons", "link", "links", "option", "options", "action", "actions", "menu", "menus",
  "item", "items", "field", "fields", "icon", "icons", "toggle", "toggles", "tab", "tabs", "entry", "entries", "element",
  "elements", "the", "and", "any", "for", "all", "can", "not", "nor", "its",
  "you", "are", "has", "was", "one", "none", "such",
]);

/** #447: a name's words in comparable form (folded; letters and digits). */
function wordsOf(s: string): string[] {
  return fold(s).match(/[\p{L}\p{N}]+/gu) ?? [];
}

/** #447: the tokens of an absent name that name the thing itself (≥3 characters, no kind / filler words). */
export function absentTokens(name: string): string[] {
  return [...new Set(wordsOf(name).filter((w) => w.length >= 3 && !STOPWORDS.has(w) && !KIND_WORDS.has(w)))];
}

/** #447: one word is (an inflection of) the other — equal, or one starts with the other's stem (≥4 characters). */
function sameWord(a: string, b: string): boolean {
  if (a === b) return true;
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  const stem = stemOf(short);
  return stem.length >= 4 && long.startsWith(stem);
}

/** #447: the first absent-name token that `text` says (a word of it is that token or an inflection), or null. */
export function saysToken(text: string, tokens: readonly string[]): string | null {
  for (const w of wordsOf(text)) {
    if (w.length < 3) continue;
    const t = tokens.find((x) => sameWord(w, x));
    if (t !== undefined) return t;
  }
  return null;
}

/** Occurrences of `needle` in `hay` (non-overlapping). */
function occurrences(hay: string, needle: string): number {
  if (needle === "") return 0;
  let n = 0;
  for (let i = hay.indexOf(needle); i >= 0; i = hay.indexOf(needle, i + needle.length)) n += 1;
  return n;
}

/**
 * #223: true when a page-text quote is made only of the page's action / label names (`controls`: a
 * button, a field's label, a chrome link — never a content link, whose text may be the answer), as
 * in "Title Create item", and says nothing else. A quote a control
 * repeats but the page ALSO shows as content (an h1 that a breadcrumb link repeats) is content: it
 * occurs in the page text more often than the controls' names account for.
 */
export function quoteIsOnlyControlNames(quote: string, page: ObservedPage): boolean {
  const q = bareQuote(quote);
  const names = (page.controls ?? []).map((n) => bareQuote(n)).filter((n) => n.replace(/[^\p{L}\p{N}]/gu, "").length > 0);
  if (q === "" || names.length === 0) return false;
  let rest = q;
  for (const n of [...new Set(names)].sort((a, b) => b.length - a.length)) rest = rest.split(n).join(" ");
  if (rest.replace(/[^\p{L}\p{N}]/gu, "").length > 0) return false;
  const inControls = names.reduce((sum, n) => sum + occurrences(n, q), 0);
  // Several controls' names run together: no single control holds it — never content.
  if (inControls === 0) return true;
  return occurrences(fold(page.text), q) <= inControls;
}

/** #229: a goal about one entry of a list or several ("the first item", "the 3rd row", "all items"). */
const LIST_GOAL =
  /\b(?:first|second|third|fourth|fifth|last|next|previous|top|bottom|\d+(?:st|nd|rd|th)|each|every|all|any|list(?:ed|s)?|how many|which (?:one|of)|among)\b/i;

/** #229: a goal about the ONE thing a page shows: "this item", "the current page", "this record". */
const SINGLE_GOAL = /\b(?:this|the current|the open(?:ed)?|the shown|the displayed)\s+([a-z][a-z-]*)\b/i;

/**
 * #395: "this text" / "this snippet" name content the goal supplies or types, not an entity a page shows.
 * Nouns that can also be a page's one entity ("this note", "this message", "this comment") stay out.
 */
const INPUT_CONTENT_NOUNS = new Set(["text", "value", "content", "input", "string", "prompt", "snippet", "paragraph", "sentence", "word", "words"]);

/** "item" → ["items"], "entry" → ["entries"], "box" → ["boxes"]: the plural forms a list heading uses. */
function plurals(noun: string): string[] {
  const n = noun.toLowerCase();
  if (/[^aeiou]y$/.test(n)) return [`${n.slice(0, -1)}ies`];
  if (/(?:s|x|z|ch|sh)$/.test(n)) return [`${n}es`];
  return [`${n}s`];
}

/**
 * #216 / #229: the retry hint for a `null` (or not-an-answer) report — the current page's main heading
 * and/or document title — or `null` when there is none to give. Only for a goal about the ONE thing the
 * page shows ("the title of this item"), never a list or ordinal goal ("the first item"), never on an
 * error page, and never when the heading names a list of the goal's things ("Items" for "this item").
 * The hint is page data: it never says the heading IS the answer.
 */
export function headingHint(page: ObservedPage | undefined, goal: string): string | null {
  if (page === undefined) return null;
  // #223: an error page's heading ("Item not found") is not the title of anything asked about.
  if (errorPageReason(page) !== null) return null;
  const single = SINGLE_GOAL.exec(goal);
  if (single === null || LIST_GOAL.test(goal)) return null;
  // #395: "import this text" supplies content; the page heading is not that content's title.
  if (INPUT_CONTENT_NOUNS.has(single[1]!.toLowerCase())) return null;
  const listOf = plurals(single[1]!);
  const namesList = (h: string | undefined): boolean => h !== undefined && (fold(h).match(/[a-z][a-z'-]*/g) ?? []).some((w) => listOf.includes(w));
  if (namesList(page.heading) || (page.heading === undefined && namesList(page.title))) return null;
  const parts: string[] = [];
  if (page.heading !== undefined) parts.push(`The current page's main heading is "${page.heading}".`);
  if (page.title !== undefined && page.title !== page.heading) parts.push(`Its document title is "${page.title}".`);
  if (parts.length === 0) return null;
  const noun = single[1]!.toLowerCase();
  return `${parts.join(" ")} On a page that shows one ${noun}, its main heading is that ${noun}'s title or name: if the goal asks for this ${noun}'s title or name, answer with that heading, quoted verbatim from \`pages\`; otherwise it is not the answer.`;
}
