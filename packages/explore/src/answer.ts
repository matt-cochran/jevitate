import type { GenerationPort, JudgmentPort, Question } from "@jevitate/ai-core";
import { assertNoSecretInPayload } from "@jevitate/ai-core";
import { PROMPT_INJECTION_GUARD } from "./decide.js";
import { REDACTION_MASK, buildJudgmentState, redactContext, redactText, redactUrl } from "./redact.js";
import {
  MIN_QUOTE_CHARS,
  bareQuote,
  contentWords,
  describeFigures,
  headingHint,
  locateLines,
  locateQuote,
  notFoundWhy,
  numbersIn,
  quoteIsOnlyControlNames,
  statedFigures,
  stemOf,
} from "./answer-text.js";
import { errorPageReason, fold, listPaths, pagesContext, pathsSeen } from "./answer-observed.js";
import type { AnswerEvidence, AnswerVerdict, ObservedPage, RunAnswer } from "./answer-observed.js";
import { absenceVerdict, goalAdmitsAbsence, groundAbsence } from "./answer-absence.js";

// Re-exports: every symbol this module exported before the split.
export { ANSWER_PAGES_CHARS, ObservedPages, controlFields, errorPageReason, pagesContext } from "./answer-observed.js";
export type {
  AnswerEvidence,
  AnswerVerdict,
  ObservedField,
  ObservedPage,
  PageFacts,
  PageHeadings,
  RunAnswer,
} from "./answer-observed.js";
export { headingHint, quoteIsOnlyControlNames } from "./answer-text.js";
export { absenceCoverage } from "./answer-absence.js";
export { goalAdmitsAbsence };
export type { AbsenceCoverage } from "./answer-absence.js";

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

/** #647: the start of the reason a claim resting on the run's own, unread write is not grounded. */
const UNCONFIRMED_WRITE = "the quote shows what the run itself sent";

/** #219: what an answer whose grounds are a registered secret says in place of the value. */
export const WITHHELD_ANSWER_NOTE =
  "the answer is a registered secret value (--secret); the page shows it, but jevitate cannot disclose it";

/** A goal that asks about the page's controls themselves ("which button…", "the label of the link"). */
const CONTROL_GOAL = /\b(?:buttons?|links?|labels?|menus?|menu items?|tabs?|controls?|options?|actions?|navigation|nav|cta)\b/i;

/** A goal that asks about an error itself ("what does the error say", "find the 404 message"). */
const ERROR_GOAL = /\b(?:errors?|404|not found|fail(?:s|ed|ure)?|warnings?|forbidden|denied)\b/i;

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
  unread: ReadonlySet<string>,
  absent?: string | null,
): Grounded {
  // #447: an absence claim rests on the observed controls and text, never on a quote.
  const name = (absent ?? "").replace(/\s+/g, " ").trim();
  if (name !== "") return { evidence: groundAbsence(claim, name, pages, goal), notAnswer: false };
  const r = groundClaimOn(claim, quote, pages, given, goal, answer, own, unread);
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
  unread: ReadonlySet<string>,
): AnswerEvidence | Grounded {
  const q = bareQuote(quote);
  const base = { claim, quote };
  if (q.replace(/\s/g, "").length < MIN_QUOTE_CHARS) return { ...base, url: null, grounded: false, why: "no quote" };
  // #234: a list answer ("which sections are there") quotes the page's entries one per line — real
  // text, but not one contiguous passage (body text sits between the headings).
  const found = locateQuote(q, pages) ?? locateLines(quote, pages);
  if (found === null) return { ...base, url: null, grounded: false, why: notFoundWhy(quote, claim) };
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
  // #647: what the run sent, shown only since its write (a 2xx is not proof the app kept it): the page
  // may be rendering the run's own request. It grounds once a page loaded from the server shows it.
  const sent = [...unread].find((v) => v.length >= MIN_QUOTE_CHARS && q.includes(v));
  if (sent !== undefined) {
    const why = `${UNCONFIRMED_WRITE} ("${sent}"), and no page loaded since the write has shown it — the app may not have kept it (reload, or open the page where the app lists it, and report what that shows)`;
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
  proposed: {
    readonly answer: string | null;
    readonly claims: ReadonlyArray<{ readonly claim: string; readonly quote: string; readonly absent?: string | null }>;
  },
  pages: readonly ObservedPage[],
  opts: {
    readonly goal?: string;
    /** #239: the run's own typed, not-yet-saved form values (folded) — a field holding one grounds nothing. */
    readonly ownInputs?: ReadonlySet<string>;
    /** #647: values the run's writes sent that no page loaded since has shown (`ObservedPages.unreadWrites`). */
    readonly unreadWrites?: ReadonlySet<string>;
  } = {},
): AnswerVerdict {
  const text = (proposed.answer ?? "").trim();
  if (text === "" || (NO_ANSWER_TEXT.test(text) && proposed.claims.length === 0)) return { accept: false, reason: NO_ANSWER_REASON, answer: null };
  const given = new Set(numbersIn(opts.goal ?? ""));
  const own = opts.ownInputs ?? new Set<string>();
  const unread = opts.unreadWrites ?? new Set<string>();
  const grounded_ = proposed.claims.map((c) => groundClaim(c.claim, c.quote, pages, given, opts.goal ?? "", text, own, unread, c.absent));
  const evidence = grounded_.map((g) => g.evidence);
  const answer: RunAnswer = { text, evidence };
  if (evidence.length === 0) return { accept: false, reason: "the answer cites no page text", answer };
  const badAt = evidence.findIndex((e) => !e.grounded);
  if (badAt >= 0) {
    const bad = evidence[badAt]!;
    const reason = `the answer is not grounded: "${bad.claim}" — ${bad.why ?? "ungrounded"}`;
    if (bad.why?.startsWith(UNCONFIRMED_WRITE) === true) return { accept: false, reason, answer, unconfirmedWrite: true };
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
        if (e.source === "control-inventory") return `ABSENCE (checked by code: no observed control or text matches it, untrusted): ${r(e.absent ?? "").slice(0, 200)}`;
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
    /** #647: sent values not yet read back from a page loaded since (`ObservedPages.unreadWrites`). */
    readonly unreadWrites?: ReadonlySet<string>;
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
  const scrub = (out: { answer: string | null; claims: readonly { claim: string; quote: string; absent?: string | null }[] }) => ({
    answer: out.answer === null ? null : r(out.answer),
    claims: out.claims.map((c) => ({ claim: r(c.claim), quote: r(c.quote), ...(c.absent == null ? {} : { absent: r(c.absent) }) })),
  });
  const grounding = {
    goal: input.goal,
    ...(input.ownInputs === undefined ? {} : { ownInputs: input.ownInputs }),
    ...(input.unreadWrites === undefined ? {} : { unreadWrites: input.unreadWrites }),
  };
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
 * #239: a goal that asks the run to WRITE something — its imperative is "record / save / create / add
 * / invite / submit / send / post / publish / register / book / schedule" at a sentence's start
 * or after "then" / "and" / "please". Code-side and narrow: "how do I add…" or "the saved decision" is
 * not one.
 */
const WRITE_GOAL =
  /(?:^\s*|[.!?;:]\s+|\b(?:then|and|please)\s+)(?:record|save|create|add|invite|submit|send|post|publish|register|book|schedule|import|upload|update|change|edit|rename|delete|remove)\b/i;

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
