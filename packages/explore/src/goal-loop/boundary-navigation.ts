/**
 * 0.30.0 (#807) navigation boundaries (design §6.2): a click that would take the top frame off the
 * allowlist (`off-allowlist`, signal `write-refused`: the run's own guard refused the navigation),
 * or that opens a new tab the run cannot follow (`new-tab`, signal `tab-opened`). Both name the
 * origin the stop is about, and both end the run as a boundary (exit 2): neither proves anything
 * about the app. A tab a click opened is closed, never followed.
 */
import type { Page } from "playwright";
import { clock } from "@jevitate/domain";
import { isAuthorizedExploreTarget } from "../authorized-targets.js";
import type { BoundaryEvidence } from "./boundary.js";

export type NavigationBoundary = BoundaryEvidence & { readonly reason: string };

/** How long a click is given to show the tab it opens (the popup event follows the click closely). */
const POPUP_WAIT_MS = 150;

/** The http(s) origin a link would leave the allowlist for, or null for a destination that stays. */
export function offAllowlistOrigin(href: string | null | undefined, allowlist: readonly string[]): string | null {
  if (typeof href !== "string" || href === "") return null;
  try {
    const url = new URL(href);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return isAuthorizedExploreTarget(url.href, allowlist) ? null : url.origin;
  } catch {
    return null;
  }
}

export function offAllowlistBoundary(step: number, origin: string): NavigationBoundary {
  return {
    kind: "off-allowlist",
    step: Math.max(1, step),
    origin,
    signal: "write-refused",
    reason: `the only way on leaves the allowlist, to ${origin}: the run stopped before following it`,
  };
}

export function newTabBoundary(step: number, origin: string): NavigationBoundary {
  return {
    kind: "new-tab",
    step: Math.max(1, step),
    origin,
    signal: "tab-opened",
    reason: `the click opened a new tab (${origin}) the run cannot follow: the tab was closed`,
  };
}

/** Watches the page for a tab its next click opens. */
export interface NewTabWatch {
  /** The origin of a tab opened since the watch began (that tab is closed), or null. `hint` is a link's own href. */
  opened(hint: string | null | undefined): Promise<string | null>;
  dispose(): void;
}

export function watchNewTab(page: Pick<Page, "on" | "off">): NewTabWatch {
  let popup: { url(): string; close(): Promise<void> } | null = null;
  const onPopup = (p: { url(): string; close(): Promise<void> }): void => {
    popup = p;
  };
  page.on("popup", onPopup);
  return {
    async opened(hint) {
      if (popup === null) await clock.sleep(POPUP_WAIT_MS);
      const tab = popup;
      if (tab === null) return null;
      popup = null;
      const originOf = (u: string | null | undefined): string | null => {
        try {
          const url = new URL(u ?? "");
          return url.protocol === "http:" || url.protocol === "https:" ? url.origin : null;
        } catch {
          return null;
        }
      };
      // The link's own destination is preferred: the tab itself is never waited on or followed.
      const origin = originOf(hint) ?? originOf(tab.url());
      await tab.close().catch(() => undefined);
      return origin ?? "about:blank";
    },
    dispose() {
      page.off("popup", onPopup);
    },
  };
}
