import type { ChromeTracker } from "../feature/relevance.js";
import { controlIdentity } from "./fingerprint.js";
import type { FrontierClass, FrontierItem } from "./frontier.js";

/**
 * The frontier classifier shared by the coverage, exploratory and feature missions (#115): which
 * queued items are deferred until the target's own content is exhausted.
 *
 * Deferred ("chrome"): a control inside a page-chrome landmark (`<nav>`, a page-level `<header>` /
 * `<footer>`), or one the run's `ChromeTracker` has seen unchanged on 2+ pathnames. Chrome whose
 * link leaves the mission's scope is also capped (see `Frontier`). A deferred item's destination is its link target
 * (full URL, so `?tab=` links stay distinct), else its control identity — the frontier tries each
 * destination at most once per run.
 */
export function chromeClassifier(opts: {
  readonly chrome: ChromeTracker;
  readonly inScope: (url: string) => boolean;
}): (item: FrontierItem) => FrontierClass {
  return (item) => {
    const c = item.control;
    const href = c.href ?? null;
    const isLink = href !== null && href !== "";
    const leavesScope = isLink && !opts.inScope(href);
    // A plain content link out of scope (a list row opening a detail page) is NOT chrome: it is taken
    // in order and recorded as a departure/boundary edge. Only chrome is deferred.
    const deferred = (c.landmark ?? null) !== null || opts.chrome.isChrome(c);
    return { deferred, leavesScope, destination: isLink ? href : `control:${controlIdentity(c)}` };
  };
}
