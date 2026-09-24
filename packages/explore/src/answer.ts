import type { GenerationPort } from "@jevitate/ai-core";
import { redactContext, redactUrl } from "./redact.js";

/**
 * The `report` op (#101): a find-out / understand goal ("find out which plan you are on…") ends with
 * an ANSWER, not a page state. The model proposes `report`; the answer is generated from the text the
 * run observed, as claims each quoting the page verbatim; then INDEPENDENT CODE grounds it — every
 * claim's quote must be on a page the run saw, and every figure the answer states must come from a
 * grounded quote. An ungrounded answer is rejected, never recorded as the run's result.
 */

/** Bound on the observed text handed to the answer generator. */
export const ANSWER_PAGES_CHARS = 8_000;
/** Distinct observed page texts kept for grounding (oldest dropped first). */
const MAX_OBSERVED_PAGES = 30;
/** Bound on each observed page text kept. */
const OBSERVED_PAGE_CHARS = 20_000;
/** A quote shorter than this (non-space chars) proves nothing. */
const MIN_QUOTE_CHARS = 3;

/** One observed page: its (redacted) URL and visible text. */
export interface ObservedPage {
  readonly url: string;
  readonly text: string;
}

/**
 * The visible text of every page state the run observed — redacted when added, so nothing kept here
 * (or handed to the generator) carries a run secret. Grounding is against exactly this text.
 */
export class ObservedPages {
  readonly #pages: ObservedPage[] = [];
  constructor(private readonly secrets: readonly string[] = []) {}

  add(url: string, text: string): void {
    const page = {
      url: redactContext(redactUrl(url), this.secrets),
      text: redactContext(text, this.secrets).slice(0, OBSERVED_PAGE_CHARS),
    };
    if (page.text.trim() === "") return;
    const i = this.#pages.findIndex((p) => p.url === page.url && p.text === page.text);
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

/** Figures (with thousands separators folded): "1,200" and "1200" are the same number. */
function numbersIn(s: string): string[] {
  return (s.match(/\d+(?:[.,]\d+)*/g) ?? []).map((n) => n.replace(/,(?=\d{3}\b)/g, ""));
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

/** Grounds one claim against the observed pages. */
function groundClaim(claim: string, quote: string, pages: readonly ObservedPage[]): AnswerEvidence {
  const q = bareQuote(quote);
  const base = { claim, quote };
  if (q.replace(/\s/g, "").length < MIN_QUOTE_CHARS) return { ...base, url: null, grounded: false, why: "no quote" };
  const page = pages.find((p) => fold(p.text).includes(q));
  if (page === undefined) return { ...base, url: null, grounded: false, why: "quote not found on any observed page" };
  const quoted = new Set(numbersIn(q));
  const missing = numbersIn(claim).filter((n) => !quoted.has(n));
  if (missing.length > 0) {
    return { ...base, url: page.url, grounded: false, why: `figure ${missing.join(", ")} is not in its quote` };
  }
  const words = contentWords(claim);
  if (words.length > 0 && quoted.size === 0 && !words.some((w) => q.includes(w))) {
    return { ...base, url: page.url, grounded: false, why: "the quote does not say what the claim says" };
  }
  return { ...base, url: page.url, grounded: true };
}

/**
 * Independent code's verdict on a reported answer: accepted only when there is an answer, it states
 * at least one claim, EVERY claim's quote is on an observed page (with the claim's figures in it),
 * and every figure the answer text states comes from a grounded quote.
 */
export function groundAnswer(
  proposed: { readonly answer: string | null; readonly claims: ReadonlyArray<{ readonly claim: string; readonly quote: string }> },
  pages: readonly ObservedPage[],
): AnswerVerdict {
  const text = (proposed.answer ?? "").trim();
  if (text === "") return { accept: false, reason: "no answer was found on the pages seen", answer: null };
  const evidence = proposed.claims.map((c) => groundClaim(c.claim, c.quote, pages));
  const answer: RunAnswer = { text, evidence };
  if (evidence.length === 0) return { accept: false, reason: "the answer cites no page text", answer };
  const bad = evidence.find((e) => !e.grounded);
  if (bad !== undefined) {
    return { accept: false, reason: `the answer is not grounded: "${bad.claim}" — ${bad.why ?? "ungrounded"}`, answer };
  }
  const grounded = new Set(evidence.flatMap((e) => numbersIn(e.quote)));
  const invented = numbersIn(text).filter((n) => !grounded.has(n));
  if (invented.length > 0) {
    return { accept: false, reason: `the answer states ${invented.join(", ")}, which no observed page shows`, answer };
  }
  return { accept: true, answer };
}

/** The observed pages as the generator's `pages` input: current page first, bounded. */
export function pagesContext(pages: readonly ObservedPage[], limit = ANSWER_PAGES_CHARS): string {
  let out = "";
  for (const p of pages) {
    const block = `URL: ${p.url}\n${p.text.replace(/[ \t]+/g, " ").replace(/\n{2,}/g, "\n").trim()}\n\n`;
    if (out.length + block.length > limit) {
      out += block.slice(0, Math.max(0, limit - out.length));
      break;
    }
    out += block;
  }
  return out;
}

/**
 * Proposes the answer to a find-out goal from the observed pages (`goal.answer`), then grounds it.
 * The generator's answer is a proposal; `groundAnswer` is the verdict.
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
  const res = await gen.generate("goal.answer", {
    goal: redactContext(input.goal, secrets),
    url: redactContext(redactUrl(input.url), secrets),
    pages: pagesContext(input.pages),
    history: input.history.slice(-20).map((h) => redactContext(h, secrets)),
  });
  return groundAnswer(res.output, input.pages);
}
