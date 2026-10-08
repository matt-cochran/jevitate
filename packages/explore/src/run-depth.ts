/**
 * #424 — how deep a goal run went, and the minimum exploration effort an open-ended find-out must
 * spend before it may conclude.
 *
 * An open-ended find-out ("use this tool's main features … report what works and every error") used
 * to end after one or two pages with "answer not found": the model tried a couple of actions, could
 * not ground a summary, and gave up. Code now records the depth every goal run reached (distinct page
 * states, actions, forms submitted) and, when a minimum effort applies, refuses the model's early
 * conclusions — a `report`, a `blocked`, a `done` without success checks — until the minimum is met,
 * steering the budget to breadth (unvisited navigation, untried controls) instead.
 *
 * The minimum is never a new way to end a run: it only defers the model's own ending. The action and
 * decision budgets still bound the run, and the model may insist (`MAX_MIN_EFFORT_REFUSALS` refusals
 * in a row with no action between them) — then its ending stands.
 */
import type { Control } from "./snapshot.js";
import { redactUrl } from "./redact.js";

/** Default minimum actions for an open-ended find-out goal (scaled down to half a smaller budget). */
export const OPEN_ENDED_MIN_ACTIONS = 12;
/** Default minimum distinct page states for an open-ended find-out goal (scaled down likewise). */
export const OPEN_ENDED_MIN_DISTINCT_STATES = 5;
/** Refusals of the model's ending in a row (no action between them) before its ending stands. */
export const MAX_MIN_EFFORT_REFUSALS = 3;

/**
 * #424: a goal that asks for a broad survey rather than one fact — "the main features", "what works",
 * "every error", "explore / try out / exercise …", "an overview". Code-side and deliberately narrow: a
 * question with one answer ("find out how many contacts …", "which plan am I on") is not one, so it
 * keeps concluding as soon as the answer is grounded.
 */
const OPEN_ENDED_GOAL =
  /\b(?:main|key|core|all(?: of)?(?: the)?|every|each|various)\s+(?:(?:of\s+)?(?:its|the|their|this\s+\w+'s)\s+)?(?:features?|functions?|functionality|capabilit(?:y|ies)|pages?|sections?|tabs?|areas?|screens?|views?|flows?|tools?)\b|\bwhat (?:works|does ?n[o']t work|is broken|breaks|fails|you (?:can )?(?:find|found|see|saw))\b|\b(?:every|all(?: the)?|any) (?:errors?|issues?|problems?|bugs?)\b|\b(?:explore|tour|survey|try out|exercise|look around|walk through)\b|\boverview\b/i;

export function goalIsOpenEnded(goal: string): boolean {
  return OPEN_ENDED_GOAL.test(goal);
}

/** The minimum exploration a goal run must spend before the model may conclude (#424). */
export interface MinEffort {
  /** Executed actions (clicks, typing, selections, uploads, reloads) before a conclusion is accepted. */
  readonly minActions: number;
  /** Distinct page states (URL + visible controls) observed before a conclusion is accepted. */
  readonly minDistinctStates: number;
  /**
   * Where the minimums came from: `flags` (`--min-actions` / `--min-distinct-states`), `open-ended`
   * (the default for an open-ended find-out goal), or `flags+open-ended` (one flag, one default).
   */
  readonly source: "flags" | "open-ended" | "flags+open-ended";
}

/** The explicit minimums a caller asked for (CLI `--min-actions` / `--min-distinct-states`). */
export interface MinEffortRequest {
  readonly minActions?: number;
  readonly minDistinctStates?: number;
}

/**
 * #424 — the run's minimum effort, by code. Explicit values always win (each replaces its own
 * default). Without one, the default applies only to an open-ended find-out (`answerIsVerdict`: no
 * success check decides the run, and `goalIsOpenEnded`) — every other goal concludes as before. A
 * default is scaled to the budget (at most half of it); an explicit value above the budget is capped
 * at it (the run can never spend more) and the cap is named in a warning, never an error.
 */
export function resolveMinEffort(input: {
  readonly goal: string;
  readonly answerIsVerdict: boolean;
  readonly request?: MinEffortRequest;
  readonly maxActions: number;
  readonly maxDecisions: number;
}): { readonly minEffort: MinEffort | null; readonly warnings: string[] } {
  const warnings: string[] = [];
  const req = input.request ?? {};
  const openEnded = input.answerIsVerdict && goalIsOpenEnded(input.goal);
  const budget = Math.min(input.maxActions, input.maxDecisions);
  const half = Math.max(1, Math.ceil(budget / 2));
  const explicitActions = req.minActions !== undefined && req.minActions > 0 ? req.minActions : undefined;
  const explicitStates = req.minDistinctStates !== undefined && req.minDistinctStates > 0 ? req.minDistinctStates : undefined;
  if (explicitActions === undefined && explicitStates === undefined && !openEnded) return { minEffort: null, warnings };

  let minActions = explicitActions ?? (openEnded ? Math.min(OPEN_ENDED_MIN_ACTIONS, half) : 0);
  if (explicitActions !== undefined && explicitActions > budget) {
    warnings.push(
      `--min-actions ${explicitActions} exceeds the run's budget (${input.maxActions} actions, ${input.maxDecisions} decisions): capped at ${budget} — raise --max-actions / --max-decisions to explore further`,
    );
    minActions = budget;
  }
  // Each action reaches at most one new state; the start page is the first.
  const stateCap = budget + 1;
  let minDistinctStates = explicitStates ?? (openEnded ? Math.min(OPEN_ENDED_MIN_DISTINCT_STATES, half + 1) : 0);
  if (explicitStates !== undefined && explicitStates > stateCap) {
    warnings.push(
      `--min-distinct-states ${explicitStates} cannot be reached within the run's budget (${budget} action(s) reach at most ${stateCap} states): capped at ${stateCap}`,
    );
    minDistinctStates = stateCap;
  }
  const flags = explicitActions !== undefined || explicitStates !== undefined;
  const defaults = openEnded && (explicitActions === undefined || explicitStates === undefined);
  return {
    minEffort: { minActions, minDistinctStates, source: flags && defaults ? "flags+open-ended" : flags ? "flags" : "open-ended" },
    warnings,
  };
}

/** How deep a run went (#424) — on every goal run's result, so a shallow run reads as one. */
export interface RunDepth {
  /** Distinct page states observed (a state is the URL plus the page's visible controls). */
  readonly distinctStates: number;
  /** Distinct pages (URL paths, query kept) observed. */
  readonly distinctPages: number;
  /** Executed actions. */
  readonly actions: number;
  /** Model decisions made. */
  readonly decisions: number;
  /** Successful form submissions (a submit control clicked, a message sent). */
  readonly formsSubmitted: number;
  /** The minimum effort that applied (#424), and whether the run met it. Absent when none applied. */
  readonly minimum?: MinEffort & { readonly met: boolean };
}

function pathOf(url: string): string {
  try {
    const u = new URL(url);
    return `${u.pathname}${u.search}`;
  } catch {
    return url;
  }
}

/** The run's depth as code observed it (#424): states, pages, submits, and the controls tried per page. */
export class DepthLog {
  readonly #states = new Set<string>();
  readonly #pages = new Set<string>();
  readonly #tried = new Map<string, Set<string>>();
  #forms = 0;

  /** A page state the loop decided on. */
  noteState(signature: string, url: string): void {
    this.#states.add(signature);
    this.#pages.add(pathOf(redactUrl(url)));
  }

  /** A target action the loop took on `url`'s page (by the control's name), whatever its result. */
  noteTried(url: string, control: string): void {
    const path = pathOf(redactUrl(url));
    const set = this.#tried.get(path) ?? new Set<string>();
    set.add(control);
    this.#tried.set(path, set);
  }

  /** A form submission that went through (a submit control clicked, a message sent). */
  noteSubmitted(): void {
    this.#forms += 1;
  }

  get distinctStates(): number {
    return this.#states.size;
  }

  /** Whether a control named `name` was already tried on `url`'s page. */
  tried(url: string, name: string): boolean {
    return this.#tried.get(pathOf(redactUrl(url)))?.has(name) === true;
  }

  report(actions: number, decisions: number, minEffort: MinEffort | null): RunDepth {
    const base = {
      distinctStates: this.#states.size,
      distinctPages: this.#pages.size,
      actions,
      decisions,
      formsSubmitted: this.#forms,
    };
    return minEffort === null ? base : { ...base, minimum: { ...minEffort, met: shortfall(minEffort, actions, this.#states.size) === null } };
  }
}

/** What is still missing of the minimum (`"3 of 12 actions, 1 of 5 distinct page states"`), or null when met. */
export function shortfall(min: MinEffort, actions: number, distinctStates: number): string | null {
  const parts: string[] = [];
  if (actions < min.minActions) parts.push(`${actions} of ${min.minActions} actions`);
  if (distinctStates < min.minDistinctStates) parts.push(`${distinctStates} of ${min.minDistinctStates} distinct page states`);
  return parts.length === 0 ? null : parts.join(", ");
}

/** Controls named in a breadth hint. */
const HINT_CONTROLS = 6;

/**
 * #424 — where breadth is still to be had, for the steering note: the app's top-level navigation not
 * yet seen, then this page's untried controls — navigation and tabs first, then links (detail views),
 * then the primary forms' submits. Never a control the run may not use (the caller passes the
 * controls offered to the model).
 */
export function breadthHint(input: {
  readonly url: string;
  readonly controls: readonly Control[];
  readonly unseenNav: readonly string[];
  readonly depth: DepthLog;
}): string {
  const untried = input.controls.filter((c) => c.enabled && (c.name ?? "").trim() !== "" && !input.depth.tried(input.url, c.name));
  const rank = (c: Control): number =>
    (c.landmark ?? null) !== null || c.role === "tab" || c.role === "menuitem" ? 0 : c.role === "link" ? 1 : c.submits === true ? 2 : 3;
  const ordered = [...untried].sort((a, b) => rank(a) - rank(b)).slice(0, HINT_CONTROLS);
  const parts: string[] = [];
  if (input.unseenNav.length > 0) parts.push(`pages not yet seen: ${input.unseenNav.slice(0, HINT_CONTROLS).join(", ")}`);
  if (ordered.length > 0) parts.push(`untried here: ${ordered.map((c) => `"${c.name.trim().slice(0, 40)}"`).join(", ")}`);
  return parts.length === 0 ? "go back to an earlier page and try what is still untried there" : parts.join("; ");
}

/** #424: the mission-context note that tells the model the minimum effort up front. */
export function minEffortNote(min: MinEffort): string {
  const what = min.source === "flags" ? "this run has a minimum exploration effort" : "this is an open-ended goal: explore broadly before concluding";
  return `${what} — take at least ${min.minActions} action(s) across at least ${min.minDistinctStates} distinct page state(s) (the navigation tabs, detail views, the primary forms) before you report or give up; an earlier report or blocked is deferred`;
}
