import type { Control } from "./snapshot.js";

/**
 * Keeps a decision's candidate actions within the judgment API's choice cap (#192). A page with a
 * long picker open (≈250 countries, timezones, currencies) plus the rest of the page overflows the
 * cap, and the whole run would end on a `400 Too many choices`. Instead, code ranks the candidates
 * and keeps the most useful ones, in their page order:
 *
 *  - what the latest action just revealed (a picker that opened), and anything the goal or recent
 *    history names;
 *  - primary controls (buttons, fields, links) before the options of a long list;
 *  - within one long option list, the options the goal names, then the first few;
 *  - page chrome (navigation, header, footer) last.
 *
 * The model is told how many were left out and how to reach them (type into the list's filter, or
 * scroll), so a control it needs is never silently unreachable.
 */
export interface BudgetedCandidate {
  readonly control: Pick<Control, "index" | "role" | "name" | "summary" | "landmark" | "scope">;
  readonly description: string;
}

/** How many options of one list are kept, beyond the ones the goal names, when a budget applies. */
export const LIST_HEAD = 8;

const OPTION_ROLES = new Set(["option", "menuitem", "menuitemradio", "menuitemcheckbox", "treeitem", "gridcell"]);

function words(text: string): Set<string> {
  return new Set(text.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? []);
}

export interface BudgetResult<T> {
  readonly kept: T[];
  /** How many candidates were left out (0: all fit). */
  readonly omitted: number;
}

export function boundCandidates<T extends BudgetedCandidate>(
  candidates: readonly T[],
  opts: { readonly limit: number; readonly goal: string; readonly history: readonly string[]; readonly offered: ReadonlySet<number> },
): BudgetResult<T> {
  if (candidates.length <= opts.limit) return { kept: [...candidates], omitted: 0 };
  const recent = opts.history.slice(-6).join(" ");
  const context = words(`${opts.goal} ${recent}`);
  const goalText = `${opts.goal} ${recent}`.toLowerCase();
  // Position of each option within its own list (its scope, else its role), for the "first few" rule.
  const listPos = new Map<number, number>();
  const seen = new Map<string, number>();
  candidates.forEach((c, i) => {
    if (!OPTION_ROLES.has(c.control.role)) return;
    const key = `${c.control.scope ?? ""}|${c.control.role}`;
    const n = seen.get(key) ?? 0;
    listPos.set(i, n);
    seen.set(key, n + 1);
  });
  const score = (c: T, i: number): number => {
    const name = c.control.name.toLowerCase();
    let s = 0;
    if (opts.offered.has(c.control.index)) s += 100;
    if (name.length >= 2 && goalText.includes(name)) s += 400; // the goal names this exact control
    else if ([...words(c.control.name)].some((w) => context.has(w))) s += 60;
    const pos = listPos.get(i);
    if (pos === undefined) s += 40; // a primary control, not one option of a long list
    else if (pos < LIST_HEAD) s += 20;
    if (c.control.landmark !== undefined && c.control.landmark !== null) s -= 30;
    return s;
  };
  const ranked = candidates
    .map((c, i) => ({ c, i, s: score(c, i) }))
    .sort((a, b) => b.s - a.s || a.i - b.i)
    .slice(0, Math.max(0, opts.limit));
  const keep = new Set(ranked.map((r) => r.i));
  return { kept: candidates.filter((_, i) => keep.has(i)), omitted: candidates.length - keep.size };
}
