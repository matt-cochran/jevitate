import { errorPageReason, listPaths, pathsSeen } from "./answer-observed.js";

import type { AnswerEvidence, AnswerVerdict, ObservedPage } from "./answer-observed.js";

import { absentTokens, saysToken } from "./answer-text.js";

/** Bound on the observed controls an absence claim's evidence lists. */
const INVENTORY_CITED = 30;

/**
 * #447 — an absence claim ("the pages seen have no Launch control"), grounded by code on what was
 * observed instead of a quote: accepted only for a goal that asks whether something exists, with at
 * least one observed page that is not an error page, and when NO observed control (action, label,
 * content link, form field) and no page text, heading or title says any token of the absent name
 * (normalized words, inflections included). Fail-closed: any match refuses it.
 */
export function groundAbsence(claim: string, absent: string, pages: readonly ObservedPage[], goal: string): AnswerEvidence {
  const base = { claim, quote: `nothing observed matches "${absent}"`, absent };
  const no = (why: string): AnswerEvidence => ({ ...base, url: null, grounded: false, why });
  if (!goalAdmitsAbsence(goal)) return no("an absence claim answers only a goal that asks whether something exists");
  const tokens = absentTokens(absent);
  if (tokens.length === 0) return no(`the absent name "${absent}" names no particular thing to look for`);
  const content = pages.filter((p) => errorPageReason(p) === null);
  if (content.length === 0) return no(pages.length === 0 ? "no page was observed" : "every page observed is an error page");
  // Fail-closed: a control left out of the inventory (the candidate limit, behind a modal) might be it.
  const partial = pages.find((p) => p.inventoryIncomplete !== undefined);
  if (partial !== undefined) {
    return no(`the control inventory of ${partial.url} is incomplete (${partial.inventoryIncomplete}) — an absence cannot be established on it`);
  }
  for (const p of pages) {
    for (const c of [...(p.controls ?? []), ...(p.contentLinks ?? []), ...(p.fields ?? []).flatMap((f) => [f.label, f.value])]) {
      if (saysToken(c, tokens) !== null) return no(`control "${c}" matches "${absent}" on ${p.url}`);
    }
    for (const [what, text] of [["page text", p.text], ["heading", p.heading ?? ""], ["title", p.title ?? ""]] as const) {
      if (saysToken(text, tokens) !== null) return no(`${what} on ${p.url} matches "${absent}"`);
    }
  }
  const inventory = [...new Set(content.flatMap((p) => [...(p.controls ?? []), ...(p.contentLinks ?? [])]))].slice(0, INVENTORY_CITED);
  return { ...base, url: content[0]!.url, grounded: true, source: "control-inventory", inventory };
}

/**
 * #238: a goal for which "there is none" is a valid answer — it asks WHETHER something exists ("check
 * whether…", "is there…", "if any"), or says outright that none existing is an answer. Code-side and
 * narrow: any other find-out whose answer is not on the pages stays "answer not found".
 */
const ABSENCE_GOAL =
  /\bwhether\b|\b(?:is|are) there\b|\bthere (?:is|are) (?:no|not any)\b|\bif (?:there (?:is|are)|any)\b|\bif (?:it|they|you|the \w+) (?:has|have|shows?|offers?)\b|\bnone (?:exists?|is|are|at all)\b|\b(?:does ?n[o']t|do(?:es)? not) exist\b|\bno such\b/i;

export function goalAdmitsAbsence(goal: string): boolean {
  return ABSENCE_GOAL.test(goal);
}

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
export function absenceVerdict(pages: readonly ObservedPage[], topNav: readonly string[]): AnswerVerdict {
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
