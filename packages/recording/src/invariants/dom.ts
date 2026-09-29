import type { StyleChannel, StyleProperty, TargetDescriptor } from "../schema.js";

export interface DomObservable {
  /** A CSS selector (shorthand for `target: { css }`). Exactly one of `selector` / `target`. */
  selector?: string;
  target?: TargetDescriptor;
  /**
   * What to read: the FIRST match's text (default) or form value, the match count, or its visual
   * state (#148) — see `DomRead`.
   */
  read?: DomRead;
  /**
   * Parse the number(s) out of what was read (`"≈ 1,240 credits"` → 1240; a Unicode minus U+2212 and
   * thousands separators are handled). `true` reads the FIRST number (index 0, the default); `{
   * index }` reads the number at that 0-based position (negative counts from the end, so `-1` is the
   * LAST) — e.g. `"≈ 30–90 credits"` with `{ index: 1 }` reads 90, a range's upper bound; `"all"`
   * reads every number as a LIST observable (#147/#148's list-valued reads) — a scalar consumer (like
   * #150's `BudgetMonitor`) treats it as unreadable, same as a `[*]` network/probe read.
   */
  number?: boolean | "all" | { readonly index: number };
  /** When the element is absent the value is `null` (instead of "could not be read"). */
  optional?: boolean;
}

/**
 * A `dom` observable's read. Besides `text`/`value`/`count`:
 *  - `inViewport` — the first match's visible fraction of its box inside the viewport (0..1);
 *  - `{ style, channel?, reduce? }` — the COMPUTED value of an allowlisted CSS property, parsed by
 *    code: with a `channel` (a color's `alpha`/`r`/`g`/`b`, a length's `px`) a number, else the raw
 *    string. `reduce` picks across matches: `first` (default), `min`/`max` (numeric: need a channel);
 *  - `{ attr }` — an attribute of the first match (absent attribute → the observable is missing).
 * All are read by fixed built-in page functions — never a declared string evaluated as JS.
 */
export type DomRead =
  | "text"
  | "value"
  | "count"
  | "inViewport"
  | { style: StyleProperty; channel?: StyleChannel; reduce?: "first" | "min" | "max" }
  | { attr: string };
