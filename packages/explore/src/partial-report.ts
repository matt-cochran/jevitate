/**
 * #424 — the grounded PARTIAL report of a find-out that could not ground a final answer.
 *
 * "answer not found (pages seen: /, /settings)" said what was searched, not what was seen. A run that
 * explored but could not ground a summary now also returns, per page state it visited, what it saw
 * there and what it tried. Everything in it is observed evidence, never the model's words:
 *
 *  - `seen`: lines of the page's own visible text, each re-checked by the same grounding code a
 *    reported answer passes (`groundAnswer`: the quote is on that page, is content rather than a
 *    control's label, and is not an error page — unless the goal asks about errors);
 *  - `controls`: the page's control names as the snapshot read them;
 *  - `tried`: the run's own transcript — each action taken there and its result as code recorded it;
 *  - `claims`: the claims of the run's rejected reports that code DID ground (each with its quote and
 *    page) — the parts of a rejected answer that were true, never its ungrounded rest.
 */
import { groundAnswer, type AnswerEvidence, type ObservedPage } from "./answer.js";
import type { TranscriptEntry } from "./transcript.js";

/** One action the run took on a state, and what came of it. */
export interface PartialReportAction {
  readonly op: string;
  readonly control: string | null;
  readonly ok: boolean;
  /** What code recorded: the page it led to, or why it failed / was refused. */
  readonly result: string;
}

/** One page the run visited: what it showed, and what was tried there. */
export interface PartialReportState {
  /** The page's path (redacted). */
  readonly url: string;
  readonly title?: string;
  readonly heading?: string;
  /** Verbatim lines of the page's visible text, each grounded on it. */
  readonly seen: readonly string[];
  /** The page's control names, as observed. */
  readonly controls: readonly string[];
  /** The actions the run took on this page, in order. */
  readonly tried: readonly PartialReportAction[];
}

/** #424: a find-out's grounded partial report — present when the run ended without a grounded answer. */
export interface PartialReport {
  readonly states: readonly PartialReportState[];
  /** Claims of the run's rejected reports that code grounded (true as far as they go). */
  readonly claims: readonly AnswerEvidence[];
  /** Why this is partial: the run's own end reason. */
  readonly note: string;
}

/** Bounds: states listed, lines / controls / actions per state, grounded claims kept. */
const MAX_STATES = 12;
const SEEN_PER_STATE = 8;
const CONTROLS_PER_STATE = 12;
const TRIED_PER_STATE = 10;
const MAX_CLAIMS = 12;
/** A seen line shorter (non-space) than this says nothing; longer is clipped by not being taken. */
const MIN_LINE_CHARS = 4;
const MAX_LINE_CHARS = 200;

/** Target ops (the ones a partial report lists as tried). */
const TRIED_OPS: ReadonlySet<string> = new Set(["click", "type", "send", "select", "upload", "edit_text", "reload"]);

function pathOf(url: string): string {
  try {
    const u = new URL(url);
    return `${u.pathname}${u.search}`;
  } catch {
    return url;
  }
}

function clip(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

/** The page's own text lines worth listing: not a control's name, not a duplicate, a sensible length. */
function candidateLines(page: ObservedPage, already: Set<string>): string[] {
  const controls = new Set((page.controls ?? []).map((c) => c.toLowerCase()));
  const out: string[] = [];
  for (const raw of page.text.split(/\n+/)) {
    const line = raw.replace(/\s+/g, " ").trim();
    if (line.replace(/\s/g, "").length < MIN_LINE_CHARS || line.length > MAX_LINE_CHARS) continue;
    const key = line.toLowerCase();
    if (controls.has(key) || already.has(key)) continue;
    already.add(key);
    out.push(line);
    if (out.length >= SEEN_PER_STATE * 2) break;
  }
  return out;
}

/** The lines `groundAnswer` grounds on this one page (each its own claim, quoting itself). */
function groundedLines(lines: readonly string[], page: ObservedPage, goal: string): string[] {
  if (lines.length === 0) return [];
  const verdict = groundAnswer({ answer: "partial report", claims: lines.map((l) => ({ claim: l, quote: l })) }, [page], { goal });
  const evidence = verdict.answer?.evidence ?? [];
  return evidence.filter((e) => e.grounded).map((e) => e.claim).slice(0, SEEN_PER_STATE);
}

/** What one transcript entry's action came to: the next state's page, or its recorded reason. */
function resultOf(entry: TranscriptEntry, next: TranscriptEntry | undefined): string {
  if (!entry.actOk) return clip(entry.reason ?? "failed", 160);
  if (next !== undefined && pathOf(next.url) !== pathOf(entry.url)) return `led to ${pathOf(next.url)}`;
  if (next !== undefined && next.signature !== entry.signature) return "the page changed";
  return clip(entry.reason ?? "done", 160);
}

/**
 * #424 — builds the partial report from what the run observed (`pages`, most recent first, as
 * `ObservedPages.pages()` gives them), its transcript, and the grounded claims of its rejected
 * reports. Pages are listed in the order first visited.
 */
export function buildPartialReport(input: {
  readonly goal: string;
  readonly pages: readonly ObservedPage[];
  readonly transcript: readonly TranscriptEntry[];
  readonly claims: readonly AnswerEvidence[];
  readonly note: string;
}): PartialReport {
  const byPath = new Map<string, ObservedPage>();
  // Oldest first; a later observation of the same path replaces the earlier (it is what the page showed last).
  for (const p of [...input.pages].reverse()) byPath.set(pathOf(p.url), p);
  const order: string[] = [];
  for (const e of input.transcript) {
    const path = pathOf(e.url);
    if (!order.includes(path)) order.push(path);
  }
  for (const path of byPath.keys()) if (!order.includes(path)) order.push(path);

  const tried = new Map<string, PartialReportAction[]>();
  input.transcript.forEach((e, i) => {
    if (e.op === null || !TRIED_OPS.has(e.op)) return;
    const path = pathOf(e.url);
    const list = tried.get(path) ?? [];
    list.push({ op: e.op, control: e.target, ok: e.actOk, result: resultOf(e, input.transcript[i + 1]) });
    tried.set(path, list);
  });

  const already = new Set<string>();
  const states: PartialReportState[] = [];
  for (const path of order) {
    const page = byPath.get(path);
    const actions = (tried.get(path) ?? []).slice(0, TRIED_PER_STATE);
    if (page === undefined && actions.length === 0) continue;
    states.push({
      url: path,
      ...(page?.title === undefined ? {} : { title: page.title }),
      ...(page?.heading === undefined ? {} : { heading: page.heading }),
      seen: page === undefined ? [] : groundedLines(candidateLines(page, already), page, input.goal),
      controls: (page?.controls ?? []).slice(0, CONTROLS_PER_STATE).map((c) => clip(c, 60)),
      tried: actions,
    });
    if (states.length >= MAX_STATES) break;
  }
  const seenClaims = new Set<string>();
  const claims = input.claims
    .filter((c) => c.grounded)
    .filter((c) => {
      const k = `${c.claim}|${c.quote}`;
      if (seenClaims.has(k)) return false;
      seenClaims.add(k);
      return true;
    })
    .slice(0, MAX_CLAIMS);
  return { states, claims, note: input.note };
}
