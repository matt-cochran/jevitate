import type { GenerationPort, JudgmentPort, Question } from "@jevitate/ai-core";
import { assertNoSecretInPayload } from "@jevitate/ai-core";
import { PROMPT_INJECTION_GUARD } from "./decide.js";
import { REDACTION_MASK, buildJudgmentState, redactContext, redactText, redactUrl } from "./redact.js";

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
 *
 * #223: a quote being ON a page is not the same as it ANSWERING the question. Code also rejects an
 * answer grounded only on action / label names (a button, a field label, a nav / header / footer or
 * repeated link is not content, unless the goal asks about controls; a link in the content is) and an answer grounded on an error page (HTTP status ≥ 400, or a
 * "not found" / "404" / error heading or title). An independent Jev yes/no — "does this answer the
 * goal's question?" — may then VETO an answer code accepted; it never approves one on its own.
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
  /** #223: the main document's HTTP status, when observed for this URL. */
  readonly status?: number;
  /**
   * #223: the names of the page's actions and labels (one per control: buttons, form fields, chrome
   * links — never a link in the page's content); absent when none.
   */
  readonly controls?: readonly string[];
  /**
   * #229: the text of the links in the page's content (a list's / table's / card's entries), in page
   * order; absent when none. Shown to the answer generator so "the first item" reads as the list's
   * first entry, not the form label beside it.
   */
  readonly contentLinks?: readonly string[];
}

/** #216: a page's main heading and document title, as read from the page. */
export interface PageHeadings {
  readonly heading?: string;
  readonly title?: string;
}

/** #223: what else is known of an observed page — its document status and its controls' names. */
export interface PageFacts extends PageHeadings {
  readonly status?: number;
  readonly controlNames?: readonly string[];
  /** #229: the text of the page's content links, in page order. */
  readonly contentLinks?: readonly string[];
  /**
   * #238: where the page's navigation links lead (their resolved hrefs: a `<nav>` / page header's
   * links) — the first page that has any sets the run's top-level navigation, its absence-answer floor.
   */
  readonly navLinks?: readonly string[];
}

/** Control names kept per observed page (#223). */
const MAX_OBSERVED_CONTROLS = 120;

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
  /** #238: the top-level navigation's destinations (same-site paths), from the first page that had any. */
  #topNav: string[] | null = null;
  constructor(private readonly secrets: readonly string[] = []) {}

  /** #238: the paths the run's first navigated-from page links to in its navigation (empty when none seen). */
  topNavigation(): readonly string[] {
    return this.#topNav ?? [];
  }

  /** #239: values the run itself typed into form fields that no successful write has saved yet (folded). */
  readonly #ownInputs = new Set<string>();

  /**
   * #239: the run typed `value` into a form field. Until a write the run fired after it succeeds
   * (`confirmOwnInputs`), a field holding it shows what the run entered — never what the app recorded.
   */
  noteOwnInput(value: string): void {
    // Kept as an observed field's value is (redacted, bounded), so the two compare.
    const v = fold(redactContext(value, this.secrets).slice(0, OBSERVED_FIELD_CHARS));
    if (v !== "") this.#ownInputs.add(v);
  }

  /** #239: a submit the run clicked fired writes that all succeeded (2xx): what it typed was sent and saved. */
  confirmOwnInputs(): void {
    this.#ownInputs.clear();
  }

  /** #239: the run's own typed, not-yet-saved values (folded). */
  ownInputs(): ReadonlySet<string> {
    return this.#ownInputs;
  }

  add(url: string, text: string, fields: readonly ObservedField[] = [], headings: PageFacts = {}): void {
    const kept = fields.slice(0, MAX_OBSERVED_FIELDS).map((f) => ({
      label: redactContext(f.label, this.secrets).slice(0, OBSERVED_FIELD_CHARS),
      value: redactContext(f.value, this.secrets).slice(0, OBSERVED_FIELD_CHARS),
    }));
    const clip = (h: string | undefined): string => redactContext((h ?? "").replace(/\s+/g, " ").trim(), this.secrets).slice(0, HEADING_CHARS);
    const heading = clip(headings.heading);
    const title = clip(headings.title);
    const keep = (xs: readonly string[] | undefined): string[] =>
      (xs ?? [])
        .slice(0, MAX_OBSERVED_CONTROLS)
        .map((n) => redactContext(n.replace(/\s+/g, " ").trim(), this.secrets).slice(0, OBSERVED_FIELD_CHARS))
        .filter((n) => n !== "");
    const names = keep(headings.controlNames);
    const links = keep(headings.contentLinks);
    const status = headings.status;
    const page: ObservedPage = {
      url: redactContext(redactUrl(url), this.secrets),
      text: redactContext(text, this.secrets).slice(0, OBSERVED_PAGE_CHARS),
      ...(kept.length === 0 ? {} : { fields: kept }),
      ...(heading === "" ? {} : { heading }),
      ...(title === "" ? {} : { title }),
      ...(status === undefined || !Number.isInteger(status) ? {} : { status }),
      ...(names.length === 0 ? {} : { controls: names }),
      ...(links.length === 0 ? {} : { contentLinks: links }),
    };
    if (this.#topNav === null) {
      const nav = navPaths(url, headings.navLinks ?? []).map((p) => redactContext(p, this.secrets));
      if (nav.length > 0) this.#topNav = nav;
    }
    if (page.text.trim() === "" && kept.length === 0) return;
    const same = (p: ObservedPage): boolean =>
      JSON.stringify(p.fields ?? []) === JSON.stringify(page.fields ?? []) &&
      p.heading === page.heading &&
      p.title === page.title &&
      p.status === page.status &&
      JSON.stringify(p.controls ?? []) === JSON.stringify(page.controls ?? []) &&
      JSON.stringify(p.contentLinks ?? []) === JSON.stringify(page.contentLinks ?? []);
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

/** A URL's path (and query) for display and comparison; the URL itself when it does not parse. */
function pathOf(url: string): string {
  try {
    const u = new URL(url);
    return `${u.pathname}${u.search}`;
  } catch {
    return url;
  }
}

/** #238: the same-site paths (no query / fragment) a page's navigation links lead to, deduped, in order. */
function navPaths(pageUrl: string, hrefs: readonly string[]): string[] {
  let origin: string;
  try {
    origin = new URL(pageUrl).origin;
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const h of hrefs) {
    try {
      const u = new URL(h, pageUrl);
      if (u.origin !== origin || !/^https?:$/.test(u.protocol)) continue;
      const path = redactUrl(`${u.origin}${u.pathname}`).slice(origin.length) || "/";
      if (!out.includes(path)) out.push(path);
    } catch {
      // an unparsable href leads nowhere checkable
    }
  }
  return out;
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
  /**
   * #219: the answer rests on a registered secret (the page shows it, but it was redacted before any
   * model saw it): the answer says it cannot be disclosed instead of stating it. Absent otherwise.
   */
  readonly withheld?: true;
  /**
   * #238: an absence answer — the goal asks whether something exists, none of the pages seen shows
   * it, and the run covered enough of the app for that to be the answer. `searched` names the pages
   * seen. Absent otherwise.
   */
  readonly absent?: true;
  readonly searched?: readonly string[];
}

/** #219: what an answer whose grounds are a registered secret says in place of the value. */
export const WITHHELD_ANSWER_NOTE =
  "the answer is a registered secret value (--secret); the page shows it, but jevitate cannot disclose it";

export type AnswerVerdict =
  | { readonly accept: true; readonly answer: RunAnswer }
  | {
      readonly accept: false;
      readonly reason: string;
      readonly answer: RunAnswer | null;
      /**
       * #223: what was reported is on the pages but does not answer the question (only a control's
       * label, an error page, or Jev's veto) — for the run, an answer not found. Absent otherwise.
       */
      readonly notAnswer?: true;
      /**
       * #238: "none exists" was the answer to give, but the run has not seen enough of the app to
       * establish it (below the coverage floor) — the run proved nothing either way. Absent otherwise.
       */
      readonly absenceUncovered?: true;
    };

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
function statedFigures(s: string): Figure[] {
  return figuresIn(withoutListMarkers(s));
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
 * #236: a content word's stem — its inflection cut, never below 5 letters — so "subscribed" is said
 * by a quote "No subscription". A word of 5 letters or fewer is its own stem.
 */
function stemOf(w: string): string {
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
function locateQuote(q: string, pages: readonly ObservedPage[]): Located | null {
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
function locateLines(quote: string, pages: readonly ObservedPage[]): Located | null {
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
function notFoundWhy(quote: string): string {
  if (quoteLines(quote).length < 2) return "quote not found on any observed page";
  return "quote not found on any observed page: its lines are not all on one page in that order — quote one contiguous passage, or give one claim per list entry, each quoting that entry";
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

/** A goal that asks about the page's controls themselves ("which button…", "the label of the link"). */
const CONTROL_GOAL = /\b(?:buttons?|links?|labels?|menus?|menu items?|tabs?|controls?|options?|actions?|navigation|nav|cta)\b/i;

/** #223: a heading / title that says the page is an error page, not the thing asked about. */
const ERROR_HEADING =
  /\bnot found\b|\bpage (?:does not|doesn't) exist\b|\bno longer exists\b|\baccess denied\b|\bsomething went wrong\b|\ban error (?:has )?occurred\b|\binternal server error\b|^\s*(?:error|oops|forbidden|unauthori[sz]ed)\s*(?:$|[:!.|\-–—]|\d{3}\b)|^\s*[45]\d\d\s*(?:$|[:!.|\-–—])/i;

/** A goal that asks about an error itself ("what does the error say", "find the 404 message"). */
const ERROR_GOAL = /\b(?:errors?|404|not found|fail(?:s|ed|ure)?|warnings?|forbidden|denied)\b/i;

/**
 * #223: why an observed page is an error page — its document status is ≥ 400, or its main heading /
 * document title says not-found / 404 / error — or `null` when it is not one.
 */
export function errorPageReason(page: ObservedPage): string | null {
  if (page.status !== undefined && page.status >= 400) return `the page it is on answered HTTP ${page.status}`;
  if (page.heading !== undefined && ERROR_HEADING.test(page.heading)) return `the page it is on is an error page (heading "${page.heading}")`;
  if (page.title !== undefined && ERROR_HEADING.test(page.title)) return `the page it is on is an error page (title "${page.title}")`;
  return null;
}

/** A claim's evidence, and whether its rejection means "this does not answer the question" (#223). */
interface Grounded {
  readonly evidence: AnswerEvidence;
  readonly notAnswer: boolean;
}

/** Grounds one claim against the observed pages. */
function groundClaim(
  claim: string,
  quote: string,
  pages: readonly ObservedPage[],
  given: ReadonlySet<string>,
  goal: string,
  answer: string,
  own: ReadonlySet<string>,
): Grounded {
  const r = groundClaimOn(claim, quote, pages, given, goal, answer, own);
  return "evidence" in r ? r : { evidence: r, notAnswer: false };
}

function groundClaimOn(
  claim: string,
  quote: string,
  pages: readonly ObservedPage[],
  given: ReadonlySet<string>,
  goal: string,
  answer: string,
  own: ReadonlySet<string>,
): AnswerEvidence | Grounded {
  const q = bareQuote(quote);
  const base = { claim, quote };
  if (q.replace(/\s/g, "").length < MIN_QUOTE_CHARS) return { ...base, url: null, grounded: false, why: "no quote" };
  // #234: a list answer ("which sections are there") quotes the page's entries one per line — real
  // text, but not one contiguous passage (body text sits between the headings).
  const found = locateQuote(q, pages) ?? locateLines(quote, pages);
  if (found === null) return { ...base, url: null, grounded: false, why: notFoundWhy(quote) };
  const page = { url: found.url };
  const where = found.control === undefined ? { source: found.source } : { source: found.source, control: found.control };
  // #223: on the page is not the same as answering. An error page (404 / not found) holds no answer
  // to a question about the thing it failed to show, and a control's label is not content.
  const errorPage = ERROR_GOAL.test(goal) ? null : errorPageReason(found.page);
  if (errorPage !== null) {
    return { evidence: { ...base, url: page.url, grounded: false, ...where, why: errorPage }, notAnswer: true };
  }
  // #239: a field holding what the run itself typed (and never saved) shows what the run entered, not
  // what the app recorded: "record a decision" was accepted on its own unsubmitted form values.
  if (found.source === "control-value" && found.value !== undefined && own.has(fold(found.value))) {
    const why = `the quote is the run's own typed input in "${found.control ?? "a form field"}", never saved — it shows what the run entered, not what the app recorded (submit it, then report what the app shows)`;
    return { ...base, url: page.url, grounded: false, ...where, why };
  }
  if (found.source === "page-text" && !CONTROL_GOAL.test(goal) && quoteIsOnlyControlNames(quote, found.page)) {
    const why = "the quote is only a control's label (a button, a field label or a navigation link), not page content that answers the question";
    return { evidence: { ...base, url: page.url, grounded: false, ...where, why }, notAnswer: true };
  }
  const quoted = new Set(numbersIn(q));
  const missing = statedFigures(claim).filter((f) => !quoted.has(f.value) && !given.has(f.value));
  if (missing.length > 0) {
    return { ...base, url: page.url, grounded: false, ...where, why: `figure ${describeFigures(missing)} is not in its quote` };
  }
  // #229: the answer itself stated in the (grounded) quote is what the claim says, however the claim is
  // worded ("The bio of the profile states what the user does" over the bio's own text).
  const stated = bareQuote(answer);
  if (stated.replace(/\s/g, "").length >= MIN_QUOTE_CHARS && q.includes(stated)) return { ...base, url: page.url, grounded: true, ...where };
  const words = contentWords(claim);
  // A control-value quote is checked against the value together with its label ("Email" + the address).
  const said = found.control === undefined ? q : `${fold(found.control)} ${q}`;
  if (words.length > 0 && quoted.size === 0 && !words.some((w) => said.includes(w) || said.includes(stemOf(w)))) {
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
  opts: {
    readonly goal?: string;
    /** #239: the run's own typed, not-yet-saved form values (folded) — a field holding one grounds nothing. */
    readonly ownInputs?: ReadonlySet<string>;
  } = {},
): AnswerVerdict {
  const text = (proposed.answer ?? "").trim();
  if (text === "" || (NO_ANSWER_TEXT.test(text) && proposed.claims.length === 0)) return { accept: false, reason: NO_ANSWER_REASON, answer: null };
  const given = new Set(numbersIn(opts.goal ?? ""));
  const own = opts.ownInputs ?? new Set<string>();
  const grounded_ = proposed.claims.map((c) => groundClaim(c.claim, c.quote, pages, given, opts.goal ?? "", text, own));
  const evidence = grounded_.map((g) => g.evidence);
  const answer: RunAnswer = { text, evidence };
  if (evidence.length === 0) return { accept: false, reason: "the answer cites no page text", answer };
  const badAt = evidence.findIndex((e) => !e.grounded);
  if (badAt >= 0) {
    const bad = evidence[badAt]!;
    const reason = `the answer is not grounded: "${bad.claim}" — ${bad.why ?? "ungrounded"}`;
    return grounded_[badAt]!.notAnswer ? { accept: false, reason, answer, notAnswer: true } : { accept: false, reason, answer };
  }
  const grounded = new Set(evidence.flatMap((e) => numbersIn(e.quote)));
  const invented = statedFigures(text).filter((f) => !grounded.has(f.value) && !given.has(f.value));
  if (invented.length > 0) {
    return { accept: false, reason: `the answer states ${describeFigures(invented)}, which no observed page shows`, answer };
  }
  // #219: grounded on (or stating) a redacted value — the true answer is a registered secret. The
  // answer never quotes or matches the secret itself: it says it cannot be disclosed.
  const mask = fold(REDACTION_MASK);
  if (fold(text).includes(mask) || evidence.some((e) => fold(e.quote).includes(mask))) {
    return { accept: true, answer: { ...answer, text: `${WITHHELD_ANSWER_NOTE} (${text})`, withheld: true } };
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

/**
 * A page's text as the generator reads it: spaces collapsed, blank lines dropped — but a table row's
 * cell breaks (`innerText`'s tabs) kept as one tab (#229), so "Key\tName / k_live_1\tProduction key"
 * still says which cell is the Name. Grounding folds all whitespace, so a quote spanning cells matches.
 */
function cells(text: string): string {
  return text.replace(/[ \t]*\t[ \t]*/g, "\t").replace(/ {2,}/g, " ").replace(/\n{2,}/g, "\n").trim();
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
    const status = p.status !== undefined && p.status >= 400 ? ` (HTTP ${p.status})` : "";
    // #229: which of the page's words are its controls (a field's label, a button) and which links
    // are its content (a list's entries, in order) — so "Title Create item" is not read as a title.
    const listed = (xs: readonly string[]): string => xs.map((x) => `"${x.replace(/\s+/g, " ")}"`).join(", ");
    const actions =
      p.controls === undefined || p.controls.length === 0
        ? ""
        : `ACTIONS AND LABELS (buttons, form-field labels, navigation — not content): ${listed(p.controls)}\n`;
    const links = p.contentLinks === undefined || p.contentLinks.length === 0 ? "" : `LINKS IN THE CONTENT (in page order): ${listed(p.contentLinks)}\n`;
    const block = `URL: ${p.url}${status}\n${cells(p.text)}\n${fields}${actions}${links}\n`;
    if (out.length + block.length > limit) {
      out += block.slice(0, Math.max(0, limit - out.length));
      break;
    }
    out += block;
  }
  return out;
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

/** #223: the Jev question that may veto an answer code grounded. */
export const ANSWER_FITS_QUESTION = "quoteAnswersGoalQuestion";

export const ANSWER_FITS_INSTRUCTIONS =
  "Does the PROPOSED ANSWER, as supported by its QUOTES from the page, actually answer the question the goal " +
  "asks? Yes: the quotes state the thing asked about (the item's title, the price, the saved value…). No: " +
  "the quotes are only a button, link or field label, navigation text, a page heading of an error / not-found " +
  "page, or other text that is on the page but is not what was asked. A value shown as " +
  `${REDACTION_MASK} is hidden, not missing: judge by where it appears.`;

/** Jev's P(yes) below which it vetoes a grounded answer (#223): a confident "no", never a coin flip. */
export const ANSWER_VETO_BELOW = 0.25;

/**
 * #223: asks Jev — advisory, independent of the generator — whether a grounded answer's quotes answer
 * the goal's question. Returns P(yes), or `null` when no usable answer came back (no veto then).
 */
export async function judgeAnswerFits(
  judge: JudgmentPort,
  input: { readonly goal: string; readonly url: string; readonly answer: RunAnswer; readonly secrets?: readonly string[] },
): Promise<number | null> {
  const secrets = input.secrets ?? [];
  const r = (v: string): string => redactText(v, secrets);
  const state = buildJudgmentState({
    goal: input.goal,
    url: input.url,
    controls: [
      PROMPT_INJECTION_GUARD,
      `PROPOSED ANSWER (untrusted): ${r(input.answer.text).slice(0, 500)}`,
      ...input.answer.evidence.slice(0, 8).map((e) => {
        const from = e.source === "control-value" ? ` (the current value of the form field "${r(e.control ?? "")}")` : " (page text)";
        return `QUOTE (untrusted)${from}: ${r(e.quote).slice(0, 300)}`;
      }),
    ],
    history: [],
    secrets,
  });
  const questions: Record<string, Question> = { [ANSWER_FITS_QUESTION]: { kind: "noul", instructions: ANSWER_FITS_INSTRUCTIONS } };
  assertNoSecretInPayload({ state, questions }, secrets);
  const answers = await judge.systemOne({ state, questions });
  const a = answers[ANSWER_FITS_QUESTION];
  return a?.kind === "noul" && Number.isFinite(a.probability) ? a.probability : null;
}

/** #229: why a re-report of an answer vetoed earlier in the run is rejected. */
export const ALREADY_VETOED_REASON = "the same answer on the same quotes was already vetoed in this run: it does not answer the question";

/**
 * #229: the (answer, quotes) pairs Jev vetoed during one run. A veto stands for the rest of the run:
 * re-reporting the same answer on the same quotes is rejected by code, never re-judged (a second,
 * luckier judgment must not overturn the first "no").
 */
export class VetoedAnswers {
  readonly #keys = new Set<string>();
  static #key(answer: RunAnswer): string {
    const quotes = [...new Set(answer.evidence.map((e) => bareQuote(e.quote)))].sort();
    return JSON.stringify([bareQuote(answer.text), quotes]);
  }
  add(answer: RunAnswer): void {
    this.#keys.add(VetoedAnswers.#key(answer));
  }
  has(answer: RunAnswer): boolean {
    return this.#keys.has(VetoedAnswers.#key(answer));
  }
  /** #234: the (answer, quotes) pairs code rejected as ungrounded in this run. */
  readonly #rejected = new Set<string>();
  /** Notes a rejected answer; true when the very same answer on the same quotes was rejected before. */
  rejectedAgain(answer: RunAnswer): boolean {
    const key = VetoedAnswers.#key(answer);
    if (this.#rejected.has(key)) return true;
    this.#rejected.add(key);
    return false;
  }
  get size(): number {
    return this.#keys.size;
  }
}

/**
 * #223: Jev's veto over an answer code accepted — only ever turns an accept into a reject (a confident
 * "no"); a failed / missing / unsure judgment leaves code's verdict as it is. #229: an answer vetoed
 * earlier in the run stays rejected (`vetoes`), without asking Jev again.
 */
async function vetoed(
  verdict: AnswerVerdict,
  judge: JudgmentPort | undefined,
  input: { readonly goal: string; readonly url: string; readonly secrets: readonly string[] },
  vetoes: VetoedAnswers,
): Promise<AnswerVerdict> {
  // A withheld answer (#219) rests on a value no model may see: Jev cannot judge it, code's verdict stands.
  if (!verdict.accept || verdict.answer.withheld === true) return verdict;
  if (vetoes.has(verdict.answer)) {
    return {
      accept: false,
      reason: ALREADY_VETOED_REASON,
      answer: verdict.answer,
      notAnswer: true,
    };
  }
  if (judge === undefined) return verdict;
  const p = await judgeAnswerFits(judge, { ...input, answer: verdict.answer }).catch(() => null);
  if (p === null || p >= ANSWER_VETO_BELOW) return verdict;
  vetoes.add(verdict.answer);
  return {
    accept: false,
    reason: `the quoted text is on the page but does not answer the question (Jev vetoed it, p=${p.toFixed(2)})`,
    answer: verdict.answer,
    notAnswer: true,
  };
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
    /** #223: Jev, asked whether a grounded answer answers the question — it may veto, never approve. */
    readonly judge?: JudgmentPort;
    /** #229: the run's vetoed answers — a veto stands for the whole run, across reports. */
    readonly vetoes?: VetoedAnswers;
    /**
     * #238: the run's top-level navigation (`ObservedPages.topNavigation`). Given, a goal that admits
     * "none exists" (`goalAdmitsAbsence`) and finds no answer gets an absence verdict on the pages'
     * coverage; absent (a reply goal), no answer stays no answer.
     */
    readonly topNav?: readonly string[];
    /** #239: the run's own typed, not-yet-saved form values (`ObservedPages.ownInputs`). */
    readonly ownInputs?: ReadonlySet<string>;
  },
): Promise<AnswerVerdict> {
  const secrets = input.secrets ?? [];
  const vetoes = input.vetoes ?? new VetoedAnswers();
  const vet = { goal: input.goal, url: input.url, secrets };
  const ask = {
    goal: redactContext(input.goal, secrets),
    url: redactContext(redactUrl(input.url), secrets),
    pages: pagesContext(input.pages),
    history: input.history.slice(-20).map((h) => redactContext(h, secrets)),
  };
  // #219: the generator's proposal is scrubbed like page content before grounding or keeping it — a
  // model may still state a secret-shaped value (a plausible email that IS the registered one).
  const r = (v: string): string => redactText(v, secrets);
  const scrub = (out: { answer: string | null; claims: readonly { claim: string; quote: string }[] }) => ({
    answer: out.answer === null ? null : r(out.answer),
    claims: out.claims.map((c) => ({ claim: r(c.claim), quote: r(c.quote) })),
  });
  const grounding = { goal: input.goal, ...(input.ownInputs === undefined ? {} : { ownInputs: input.ownInputs }) };
  const res = await gen.generate("goal.answer", ask);
  const verdict = await vetoed(groundAnswer(scrub(res.output), input.pages, grounding), input.judge, vet, vetoes);
  if (verdict.accept) return verdict;
  if (verdict.notAnswer !== true && verdict.answer !== null) return rejectedAgain(verdict, vetoes);
  // #238: for a goal that asks whether something exists, "no answer on the pages" IS the answer —
  // once the run has seen enough of the app (code's coverage floor).
  const absence = (v: AnswerVerdict): AnswerVerdict =>
    input.topNav !== undefined && !v.accept && v.answer === null && v.reason === NO_ANSWER_REASON && goalAdmitsAbsence(input.goal)
      ? absenceVerdict(input.pages, input.topNav)
      : v;
  // #216 / #223: a `null` answer, or one that does not answer the question, is retried once with the
  // page's main heading / document title as a hint (never an error page's heading).
  const noAnswer = verdict.answer === null && verdict.reason === NO_ANSWER_REASON;
  if (!noAnswer && verdict.notAnswer !== true) return verdict;
  const hint = headingHint(input.pages[0], input.goal);
  if (hint === null) return absence(verdict);
  const retry = await gen.generate("goal.answer", { ...ask, hint: redactContext(hint, secrets) });
  const retried = await vetoed(groundAnswer(scrub(retry.output), input.pages, grounding), input.judge, vet, vetoes);
  // The retry repeated the answer just vetoed: the veto itself (with Jev's p) is the verdict to report.
  if (!retried.accept && retried.reason === ALREADY_VETOED_REASON && verdict.notAnswer === true) return verdict;
  const final = absence(retried);
  // #395: a retry that found NO answer never replaces a first answer's rejection — that one names the
  // claim and why it was rejected (a veto, a label-only quote), so the model can correct it; "no
  // answer was found" would be false (one was) and the same report would be re-sent unchanged.
  const noneOnRetry = !final.accept && final.answer === null && final.reason === NO_ANSWER_REASON;
  return noneOnRetry && verdict.answer !== null ? verdict : final;
}

/** #234: what the reason of a re-report of an answer code already rejected in this run adds. */
export const REJECTED_AGAIN_REASON = "the same answer on the same quotes was already rejected in this run — change the quotes, resubmitting them cannot ground";

/**
 * #234: an ungrounded answer resubmitted unchanged (same answer, same quotes) is told so — the model
 * resubmitted an identical stitched quote 3× — so the rejection names the repeat, not only the cause.
 */
function rejectedAgain(verdict: Extract<AnswerVerdict, { accept: false }>, vetoes: VetoedAnswers): AnswerVerdict {
  if (verdict.answer === null || verdict.answer.evidence.length === 0 || !vetoes.rejectedAgain(verdict.answer)) return verdict;
  return { ...verdict, reason: `${verdict.reason} (${REJECTED_AGAIN_REASON})` };
}

/** Paths named in an "answer not found" reason (the rest are counted). */
const NOT_FOUND_PATHS = 8;

/** The observed pages' paths (with query), first seen first, deduped. */
function pathsSeen(pages: readonly ObservedPage[]): string[] {
  const paths: string[] = [];
  for (const p of [...pages].reverse()) {
    const path = pathOf(p.url);
    if (!paths.includes(path)) paths.push(path);
  }
  return paths;
}

/** "a, b, c, +N more" — the first `NOT_FOUND_PATHS` paths named, the rest counted. */
function listPaths(paths: readonly string[]): string {
  const shown = paths.slice(0, NOT_FOUND_PATHS).join(", ");
  return paths.length > NOT_FOUND_PATHS ? `${shown}, +${paths.length - NOT_FOUND_PATHS} more` : shown;
}

/**
 * The end reason of a run whose report found no answer (#207): "answer not found (pages seen: …)" —
 * the observed pages' paths in the order first seen, so an unanswerable find-out says what was
 * searched instead of a generic "no progress" / "blocked".
 */
export function answerNotFoundReason(pages: readonly ObservedPage[]): string {
  const paths = pathsSeen(pages);
  if (paths.length === 0) return "answer not found (no page text was observed)";
  return `answer not found (pages seen: ${listPaths(paths)})`;
}

/**
 * #238: a goal for which "there is none" is a valid answer — it asks WHETHER something exists ("check
 * whether…", "is there…", "if any"), or says outright that none existing is an answer. Code-side and
 * narrow: any other find-out whose answer is not on the pages stays "answer not found".
 */
const ABSENCE_GOAL =
  /\bwhether\b|\b(?:is|are) there\b|\bif (?:there (?:is|are)|any)\b|\bif (?:it|they|you|the \w+) (?:has|have|shows?|offers?)\b|\bnone (?:exists?|is|are|at all)\b|\b(?:does ?n[o']t|do(?:es)? not) exist\b|\bno such\b/i;

export function goalAdmitsAbsence(goal: string): boolean {
  return ABSENCE_GOAL.test(goal);
}

/**
 * #239: a goal that asks the run to WRITE something — its imperative is "record / save / create / add
 * / invite / submit / send / post / publish / register / book / schedule" at a sentence's start
 * or after "then" / "and" / "please". Code-side and narrow: "how do I add…" or "the saved decision" is
 * not one.
 */
const WRITE_GOAL =
  /(?:^\s*|[.!?;:]\s+|\b(?:then|and|please)\s+)(?:record|save|create|add|invite|submit|send|post|publish|register|book|schedule)\b/i;

export function goalAsksToWrite(goal: string): boolean {
  return WRITE_GOAL.test(goal);
}

/**
 * #286: a goal that asks the run to REPORT what it found ("Finish by reporting the price shown",
 * "report back which…"). With `--success` checks too, the checks holding is not the whole goal: the
 * run must also end with a grounded answer — a check met by an unrelated page's load-time request
 * once ended a run `succeeded` with no price reported.
 */
const REPORT_GOAL =
  /\b(?:finish|end|then|and)\s+(?:by\s+)?report(?:ing)?\b|\breport(?:ing)?\s+(?:back\s+)?(?:the|what|which|how|whether|if|its|their|your|who|when|where)\b/i;

export function goalAsksForReport(goal: string): boolean {
  return REPORT_GOAL.test(goal);
}

/** #239: why a grounded report cannot settle a write goal before any write of the run succeeded. */
export const UNSAVED_WRITE_REASON =
  "the goal asks to record / save something, but no write request of this run has succeeded yet (no submit sent a write that answered 2xx) — a report cannot settle it before the change is saved: submit it, then report what the app shows";

/** #238: pages a run without a known top-level navigation must have seen before "none exists" is an answer. */
const ABSENCE_MIN_PAGES = 2;

/** #238: whether the pages seen cover enough of the app for an absence answer, and what is still unseen. */
export interface AbsenceCoverage {
  readonly covered: boolean;
  /** The pages seen (paths, first seen first). */
  readonly seen: readonly string[];
  /** The top-level navigation's destinations not yet seen (empty when none is known). */
  readonly unseen: readonly string[];
  /** The floor, in words ("3 of the 6 top-level navigation pages", "2 distinct pages"). */
  readonly floor: string;
}

/**
 * #238 — the coverage floor for an absence answer, by code: with a known top-level navigation (the
 * links in the first page's `<nav>` / header), at least half of its destinations (never fewer than 2,
 * never more than it has) must be among the pages seen; without one, at least `ABSENCE_MIN_PAGES`
 * distinct pages. A run that answered "none" from the page it started on has not looked.
 */
export function absenceCoverage(pages: readonly ObservedPage[], topNav: readonly string[]): AbsenceCoverage {
  const seen = pathsSeen(pages);
  const seenPaths = new Set(seen.map((p) => p.split("?")[0] ?? p));
  if (topNav.length === 0) {
    return { covered: seenPaths.size >= ABSENCE_MIN_PAGES, seen, unseen: [], floor: `${ABSENCE_MIN_PAGES} distinct pages` };
  }
  const need = Math.min(topNav.length, Math.max(2, Math.ceil(topNav.length / 2)));
  const visited = topNav.filter((p) => seenPaths.has(p));
  const unseen = topNav.filter((p) => !seenPaths.has(p));
  return { covered: visited.length >= need, seen, unseen, floor: `${need} of the ${topNav.length} top-level navigation pages` };
}

/** #238: what an accepted absence answer says — the verdict and what was searched. */
function absenceAnswerText(seen: readonly string[]): string {
  return `not present — none of the pages seen shows it (pages seen: ${listPaths(seen)})`;
}

/**
 * #238 — the verdict on "there is none" for a goal that admits it (`goalAdmitsAbsence`): accepted
 * as an absence answer (`absent`, with the pages searched) once the run's coverage meets the floor;
 * else rejected as not yet established (`absenceUncovered`), naming the navigation still unseen.
 */
function absenceVerdict(pages: readonly ObservedPage[], topNav: readonly string[]): AnswerVerdict {
  const c = absenceCoverage(pages, topNav);
  if (c.covered) {
    return { accept: true, answer: { text: absenceAnswerText(c.seen), evidence: [], absent: true, searched: c.seen } };
  }
  const where = c.unseen.length > 0 ? ` — not yet seen: ${listPaths(c.unseen)}` : " — open more of the app's pages first";
  return {
    accept: false,
    reason: `"none exists" is not established yet: the run has seen ${c.seen.length === 0 ? "no page" : listPaths(c.seen)}, below the floor of ${c.floor}${where}`,
    answer: null,
    absenceUncovered: true,
  };
}
