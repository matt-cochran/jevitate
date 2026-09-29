import type { Control } from "../snapshot.js";

/**
 * A control that NAVIGATES to a different route than the current page — a global header/nav link
 * (Allumata / Activity / Projects / …, present unchanged on every page) is the common case. Used by
 * the coverage sufficiency check (#75): "no non-nav control was exercised" means the run only ever
 * followed navigation and never touched a page's own content — proof of nothing.
 *
 * Deliberately narrow: an `<a>`/`role=link` whose destination is the SAME path (a same-page anchor,
 * a query-only or hash-only link, a tab implemented as a link) is NOT nav — it stays a legitimate
 * in-page control.
 */
export function isNavControl(control: Pick<Control, "tag" | "role" | "href">, currentUrl: string): boolean {
  if (control.tag !== "a" && control.role !== "link") return false;
  if (control.href === null || control.href === undefined || control.href === "") return false;
  try {
    const linkPath = new URL(control.href).pathname;
    const curPath = new URL(currentUrl).pathname;
    return linkPath !== curPath;
  } catch {
    return false;
  }
}
