/**
 * Goal-area focus (#338): once a goal run has reached the goal's area — it clicked a navigation
 * control the goal names, or it is on a URL whose path names a goal term — the navigation controls
 * leading to sections the goal never names are OFF-GOAL. Independent, lexical code (no model call):
 * the decision lists them last and marks them, so the model prefers staying; they are never removed
 * (a goal may legitimately cross sections — "Connections, then Pricing" names both).
 *
 * "Named" is conservative: a control whose name shares any stemmed content word with the goal (or
 * has no content word at all — an icon) is never off-goal.
 */

import type { Control } from "../snapshot.js";
import type { ChromeTracker } from "../feature/relevance.js";

/** Words that say nothing about which section a goal is about. */
const STOP = new Set(
  ("a an the and or but to of in on for with at by from as is are was were be been it its this that these those " +
    "your my our me us we you i then just not no do does did have has had if into up out about via all any each " +
    "page section tab screen app")
    .split(" "),
);

/** A rough stem: "Connections" / "connect", "Pricing" / "price", "Settings" / "setting" meet. */
export function stem(word: string): string {
  let w = word.toLowerCase();
  if (w.length > 3 && w.endsWith("s") && !w.endsWith("ss")) w = w.slice(0, -1);
  for (const suffix of ["ation", "ion", "ing", "ed", "e"]) {
    if (w.length - suffix.length >= 3 && w.endsWith(suffix)) return w.slice(0, -suffix.length);
  }
  return w;
}

/** The stemmed content words of a text (a goal, a control name, a URL path segment). */
export function terms(text: string): Set<string> {
  const out = new Set<string>();
  for (const w of text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []) {
    if (w.length < 3 || STOP.has(w) || /^\d+$/.test(w)) continue;
    out.add(stem(w));
  }
  return out;
}

const NAV_ROLES = new Set(["link", "tab", "menuitem", "treeitem"]);

/** A control that leads to another section: a nav/header link, a tab, a sidebar item, a nav button. */
export function isNavigation(control: Control, chrome?: ChromeTracker): boolean {
  if (control.role === "tab") return true;
  if (control.role === "button") return control.landmark === "navigation";
  if (!NAV_ROLES.has(control.role)) return false;
  return control.landmark === "navigation" || control.landmark === "banner" || (chrome?.isChrome(control) ?? false);
}

export class GoalFocus {
  readonly #goal: Set<string>;
  #reached: string | null = null;

  constructor(goal: string) {
    this.#goal = terms(goal);
  }

  /** Does the goal name this text (any shared stemmed content word)? Text without content words: unknown → true. */
  names(text: string): boolean {
    const t = terms(text);
    if (t.size === 0) return true;
    return [...t].some((w) => this.#goal.has(w));
  }

  /** What reached the goal's area (null: not yet). */
  get reached(): string | null {
    return this.#reached;
  }

  /** A successful click: on a goal-named navigation control, the run is in the goal's area. */
  noteClicked(control: Control, chrome?: ChromeTracker): void {
    if (this.#reached !== null || !isNavigation(control, chrome)) return;
    const name = control.name.trim();
    if (name !== "" && terms(name).size > 0 && this.names(name)) this.#reached = `opened ${JSON.stringify(name.slice(0, 60))}`;
  }

  /** The current page: a URL path segment the goal names puts the run in the goal's area. */
  noteUrl(url: string): void {
    if (this.#reached !== null) return;
    let path: string;
    try {
      path = new URL(url).pathname;
    } catch {
      return;
    }
    for (const seg of path.split("/")) {
      const t = terms(seg.replace(/[-_.]+/g, " "));
      if (t.size > 0 && [...t].some((w) => this.#goal.has(w))) {
        this.#reached = `on ${path.slice(0, 80)}`;
        return;
      }
    }
  }

  /** The indexes of navigation controls leading to sections the goal never names (empty until reached). */
  offGoal(controls: readonly Control[], chrome?: ChromeTracker): Set<number> {
    const out = new Set<number>();
    if (this.#reached === null || this.#goal.size === 0) return out;
    for (const c of controls) {
      if (!isNavigation(c, chrome)) continue;
      if (!this.names(c.name)) out.add(c.index);
    }
    return out;
  }
}
