import { redactContext, redactUrl } from "./redact.js";

/** Bound on the observed text handed to the answer generator. */
export const ANSWER_PAGES_CHARS = 8_000;

/** Distinct observed page texts kept for grounding (oldest dropped first). */
const MAX_OBSERVED_PAGES = 30;

/** Bound on each observed page text kept. */
const OBSERVED_PAGE_CHARS = 20_000;

/** Control values kept per observed page (#207). */
const MAX_OBSERVED_FIELDS = 40;

/** Bound on each kept control value / label. */
const OBSERVED_FIELD_CHARS = 500;
/** #667: most read-back values kept for the done judgment's code fact. */
const MAX_READ_BACK_VALUES = 50;

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
  /**
   * #447: why `controls` + `contentLinks` are not the page's whole control inventory (the candidate
   * limit, controls behind a modal, the kept-names cap); absent when they are. No absence claim is
   * grounded on an incomplete inventory.
   */
  readonly inventoryIncomplete?: string;
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
  /** #447: why the control names given are not the page's whole control inventory (absent: they are). */
  readonly inventoryIncomplete?: string;
  /** #647: the identity of the page's document load (`performance.timeOrigin`): it changes on every load from the server. */
  readonly document?: number;
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

  /**
   * #647: values a 2xx write sent that no page loaded from the server has shown since. A 2xx says the
   * request was accepted, not that the app kept it: until a later document shows the value, a page
   * showing it may only be the client's own rendering of what the run sent.
   */
  readonly #unread = new Set<string>();
  /** #647: the document the last such write was sent from. */
  #writeDocument: number | null = null;

  /**
   * #239: a submit the run clicked fired writes that all succeeded (2xx): what it typed was sent. #647:
   * it is read back only when a page from a later document load (`document`) shows it.
   */
  confirmOwnInputs(document?: number): void {
    for (const v of this.#ownInputs) this.#unread.add(v);
    this.#ownInputs.clear();
    if (document !== undefined) this.#writeDocument = document;
  }

  /**
   * #649: a sent value the run did not type (a write's request body: a prefilled import's rows) that
   * a page on the write's own route already showed before the write — its source, not a copy the app
   * kept. Only a page on another route reads it back: reloading the source shows it either way.
   */
  readonly #sourceRoute = new Map<string, string>();

  /** #649: a write's body values the run did not type, decided on the next page seen (see `add`). */
  #pendingSent: { readonly route: string; readonly values: readonly string[] } | null = null;

  /**
   * #649: a successful write the run fired sent `values` in its body, from a page on `url`. One the run
   * did not type awaits read-back like a typed one only when the next page shows it as NEW text — text
   * no earlier page on that route showed (an import's rows listed from its CSV; never a form's
   * untouched prefilled fields, still only in their fields). Decided when that page is added.
   */
  noteSentValues(values: readonly string[], url: string): void {
    const own = new Set([...this.#ownInputs, ...this.#unread]);
    const fresh = values.map((value) => fold(redactContext(value, this.secrets).slice(0, OBSERVED_FIELD_CHARS))).filter((v) => v !== "" && !own.has(v));
    this.#pendingSent = fresh.length === 0 ? null : { route: routeOf(url), values: fresh };
  }

  /** #649: the pending body values `text` (the page after the write) newly shows await read-back. */
  #settleSent(text: string): void {
    const pending = this.#pendingSent;
    if (pending === null) return;
    this.#pendingSent = null;
    const now = fold(text);
    const before = this.#pages.filter((p) => routeOf(p.url) === pending.route);
    for (const v of pending.values) {
      if (!now.includes(v) || before.some((p) => fold(p.text).includes(v))) continue;
      this.#unread.add(v);
      if (before.some((p) => (p.fields ?? []).some((f) => fold(f.value).includes(v)))) this.#sourceRoute.set(v, pending.route);
    }
  }

  /**
   * #671: values the run typed into a field on one document load. A field holding one shows the run's
   * own entry, never what the app kept: retyping a sent message into its composer after a reload is
   * not a read-back.
   */
  #typedOn: { readonly document: number; readonly values: Set<string> } | null = null;

  /** #671: the run typed `value` into a field (a message composer too) on document load `document`. */
  noteTypedOn(value: string, document: number | undefined): void {
    const v = fold(redactContext(value, this.secrets).slice(0, OBSERVED_FIELD_CHARS));
    if (document === undefined || v === "") return;
    if (this.#typedOn?.document !== document) this.#typedOn = { document, values: new Set() };
    this.#typedOn.values.add(v);
  }

  /** #647: the run's sent values (folded) that no page loaded from the server since has shown. */
  unreadWrites(): ReadonlySet<string> {
    return this.#unread;
  }

  /** #647: the unread sent values (folded) that `shown` (a page's text, or field values) displays. */
  unreadShownIn(shown: string): string[] {
    const text = fold(shown);
    return [...this.#unread].filter((v) => text.includes(v));
  }

  /**
   * #647: a page from a later document load than the write shows `shown` (its visible text, or field
   * values): the sent values it contains are read back from the app. Returns those values.
   */
  readBack(document: number | undefined, shown: string, url?: string): string[] {
    if (this.#unread.size === 0 || document === undefined || document === this.#writeDocument) return [];
    const text = fold(shown);
    const route = url === undefined ? undefined : routeOf(url);
    const back = [...this.#unread].filter((v) => text.includes(v) && (route === undefined || this.#sourceRoute.get(v) !== route));
    for (const v of back) {
      this.#unread.delete(v);
      this.#sourceRoute.delete(v);
    }
    this.#readBackCount += back.length;
    for (const v of back) if (this.#readBackValues.length < MAX_READ_BACK_VALUES) this.#readBackValues.push(v);
    return back;
  }

  /** #645: how many sent values a page loaded from the server has shown again. */
  #readBackCount = 0;
  /** #667: the sent values (folded) read back so far, bounded. */
  readonly #readBackValues: string[] = [];

  /** #667: the sent values (folded) a page loaded from the server has shown again. */
  readBackValues(): readonly string[] {
    return this.#readBackValues;
  }

  /**
   * #645: the app was seen to keep what the run's writes sent — at least one value was read back and
   * none is still unread. Code evidence the page judgment lacks (see `groundDone`).
   */
  readBackConfirmed(): boolean {
    return this.#readBackCount > 0 && this.#unread.size === 0;
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
    // #447: the inventory is incomplete when the snapshot left controls out, or the cap here cut it.
    const capped = (headings.controlNames ?? []).length > MAX_OBSERVED_CONTROLS || (headings.contentLinks ?? []).length > MAX_OBSERVED_CONTROLS;
    const incomplete = [headings.inventoryIncomplete ?? "", capped ? `more than ${MAX_OBSERVED_CONTROLS} controls were kept` : ""].filter((x) => x !== "").join("; ");
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
      ...(incomplete === "" ? {} : { inventoryIncomplete: redactContext(incomplete, this.secrets) }),
    };
    if (this.#topNav === null) {
      const nav = navPaths(url, headings.navLinks ?? []).map((p) => redactContext(p, this.secrets));
      if (nav.length > 0) this.#topNav = nav;
    }
    // #649: the page right after a write decides which of its untyped body values it newly shows.
    this.#settleSent(page.text);
    // #647: a page from a later document load that shows a sent value reads it back from the app.
    // #671: a field holding what the run typed on this document load shows its own entry, not the app's.
    const typed = this.#typedOn !== null && this.#typedOn.document === headings.document ? [...this.#typedOn.values] : [];
    const appFields = kept.map((f) => f.value).filter((value) => !typed.some((t) => fold(value).includes(t)));
    this.readBack(headings.document, [page.text, ...appFields].join("\n"), url);
    if (page.text.trim() === "" && kept.length === 0) return;
    const same = (p: ObservedPage): boolean =>
      JSON.stringify(p.fields ?? []) === JSON.stringify(page.fields ?? []) &&
      p.heading === page.heading &&
      p.title === page.title &&
      p.status === page.status &&
      JSON.stringify(p.controls ?? []) === JSON.stringify(page.controls ?? []) &&
      JSON.stringify(p.contentLinks ?? []) === JSON.stringify(page.contentLinks ?? []) &&
      p.inventoryIncomplete === page.inventoryIncomplete;
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

/** #649: a URL's path alone (no query): the route a page is on. */
function routeOf(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return url.split(/[?#]/)[0] ?? url;
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
  readonly source?: "page-text" | "control-value" | "control-inventory";
  /** For `source: "control-value"`: the control whose current value the quote is. */
  readonly control?: string;
  /** #447: for an absence claim — the name of what the claim says the pages seen do not have. */
  readonly absent?: string;
  /** #447: for `source: "control-inventory"`: the observed controls the absence was checked against (bounded). */
  readonly inventory?: readonly string[];
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

export type AnswerVerdict =
  | { readonly accept: true; readonly answer: RunAnswer }
  | {
      readonly accept: false;
      readonly reason: string;
      readonly answer: RunAnswer | null;
      /** #647: the answer rests on what the run sent, not yet read back from a page loaded since. */
      readonly unconfirmedWrite?: true;
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
export function fold(s: string): string {
  return s
    .toLowerCase()
    .replace(/[‘’‚‛]/g, "'")
    .replace(/[“”„‟]/g, '"')
    .replace(/[–—]/g, "-")
    .replace(/ /g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** #223: a heading / title that says the page is an error page, not the thing asked about. */
const ERROR_HEADING =
  /\bnot found\b|\bpage (?:does not|doesn't) exist\b|\bno longer exists\b|\baccess denied\b|\bsomething went wrong\b|\ban error (?:has )?occurred\b|\binternal server error\b|^\s*(?:error|oops|forbidden|unauthori[sz]ed)\s*(?:$|[:!.|\-–—]|\d{3}\b)|^\s*[45]\d\d\s*(?:$|[:!.|\-–—])/i;

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

/** Paths named in an "answer not found" reason (the rest are counted). */
const NOT_FOUND_PATHS = 8;

/** The observed pages' paths (with query), first seen first, deduped. */
export function pathsSeen(pages: readonly ObservedPage[]): string[] {
  const paths: string[] = [];
  for (const p of [...pages].reverse()) {
    const path = pathOf(p.url);
    if (!paths.includes(path)) paths.push(path);
  }
  return paths;
}

/** "a, b, c, +N more" — the first `NOT_FOUND_PATHS` paths named, the rest counted. */
export function listPaths(paths: readonly string[]): string {
  const shown = paths.slice(0, NOT_FOUND_PATHS).join(", ");
  return paths.length > NOT_FOUND_PATHS ? `${shown}, +${paths.length - NOT_FOUND_PATHS} more` : shown;
}
