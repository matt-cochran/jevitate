import type { Page } from "playwright";
import { redactUrl } from "@jevitate/ai-core";
import { contentHash } from "@jevitate/domain";
import { messageClass, normalizeRoute } from "./adversarial/defect-fingerprint.js";
import { endpointOf } from "./timing.js";
import type { InflightRequest, SettleResult } from "./page-monitor.js";
import type { HostPressure } from "./host-pressure.js";

/**
 * Hangs (owner ruling 7) — an unresponsive app under test is its own first-class finding, never
 * folded into a generic no-progress or timeout. Four kinds, decided from evidence:
 *
 *  - `main-thread-unresponsive` — a trivial `page.evaluate` probe did not return within its bound;
 *  - `request-pending`          — a request is still pending past its bound;
 *  - `never-settled`            — the page never settled within the ceiling (DOM/network churn);
 *  - `ui-no-progress`           — the page is alive but the UI makes no progress after an action:
 *                                 a busy indicator that never ends, or an action whose result is a
 *                                 page stuck in an earlier state (the stalled-import pattern).
 *
 * Portable: Playwright + standard DOM only; the classification rule is pure and clock-free.
 */

export type HangKind = "main-thread-unresponsive" | "request-pending" | "never-settled" | "ui-no-progress";

export interface PendingRequestEvidence {
  readonly endpoint: string;
  readonly url: string;
  readonly ageMs: number;
}

export interface HangSignal {
  readonly kind: HangKind;
  readonly detail: string;
  readonly route: string;
  /** Redacted page URL. */
  readonly url: string;
  /** Requests pending when the hang was detected (redacted, with their age). */
  readonly pending: PendingRequestEvidence[];
  /** The last DOM state seen: its freshness signature and control summaries (may be empty). */
  readonly lastState: { readonly signature: string; readonly controls: string[] };
  /**
   * The offending element's identity (role, accessible name, testid or stable anchor — see
   * `visibleBusyIndicator`), when the hang is attributable to one: a stuck busy indicator
   * (`ui-no-progress`). Undefined for hang kinds with no single element to name (#87).
   */
  readonly element?: string;
  /** The page's used JS heap (bytes), when it could be read. */
  readonly heapBytes?: number;
  /** The host's resource pressure sampled when the hang was detected. */
  readonly host?: HostPressure;
}

/**
 * Stable identity of a hang: kind + route (+ the stuck endpoint for a pending request) — EXCEPT
 * `ui-no-progress`, whose identity is the offending ELEMENT, not the route (#87). A stuck busy
 * indicator is usually a page-local bug, but the same widget (a shared layout gauge, a global nav
 * spinner) can appear on every route: fingerprinting by element means that is ONE finding across
 * every route it hangs on, not a new finding per route. The element string is normalized the same
 * way a defect message is (`messageClass`), so incidental differences (ids, counts) still collapse.
 */
export function hangFingerprint(h: Pick<HangSignal, "kind" | "route" | "pending" | "element">): string {
  if (h.kind === "ui-no-progress" && h.element !== undefined) {
    return contentHash(`hang|${h.kind}|element|${messageClass(h.element)}`).slice(0, 16);
  }
  const endpoint = h.kind === "request-pending" ? (h.pending[0]?.endpoint ?? "") : "";
  return contentHash(`hang|${h.kind}|${h.route}|${endpoint}`).slice(0, 16);
}

export interface HangEvidence {
  /** Did the main-thread probe answer within its bound? */
  readonly responsive: boolean;
  readonly settle: SettleResult;
  /** Now − each pending request's start (ms). */
  readonly pendingAgesMs: readonly number[];
  /** A visible busy indicator that did not go away within the ceiling (description), or null. */
  readonly stuckBusyIndicator: string | null;
  /** A pending request older than this is stuck (ms). */
  readonly requestBoundMs: number;
}

/**
 * The pure classification rule. Order matters: an unresponsive main thread explains everything
 * else; a stuck request explains a page that never settled; a page that settled but still shows a
 * busy indicator is making no progress. Null ⇔ no hang.
 */
export function classifyHang(e: HangEvidence): HangKind | null {
  if (!e.responsive) return "main-thread-unresponsive";
  if (!e.settle.settled) {
    return e.pendingAgesMs.some((age) => age >= e.requestBoundMs) ? "request-pending" : "never-settled";
  }
  if (e.stuckBusyIndicator !== null) return "ui-no-progress";
  return null;
}

/**
 * Does a trivial evaluate return within `boundMs`? (A busy loop in the page blocks it.) A page that
 * is GONE (closed, crashed) is not "unresponsive" — that is an engine-level failure, so the
 * evaluate's error is rethrown for the mission's crash path to classify.
 */
export async function probeResponsive(page: Page, boundMs: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const bound = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), Math.max(1, boundMs));
  });
  // An evaluate that REJECTS on a live page (the execution context was replaced by a navigation in
  // progress) means the renderer answered: not unresponsive. Only a gone page's error is rethrown.
  const probe = page.evaluate(() => true).catch((e: unknown) => {
    if (page.isClosed()) throw e;
    return true;
  });
  probe.catch(() => undefined); // observed below; never an unhandled rejection after a timeout
  try {
    return await Promise.race([probe, bound]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * BROWSER CODE — the first VISIBLE busy indicator, described, or null: `aria-busy="true"`, an
 * indeterminate progressbar (no `aria-valuenow`), or a spinner element by class name. The
 * description is a STABLE identity for the element — its testid or id (a stable anchor) when it
 * has one, else its role (explicit or implicit tag) and accessible name — so the SAME element,
 * even met on different routes (e.g. a shared layout widget), describes identically (#87).
 *
 * Self-contained on purpose: this function is serialized by its OWN source (`.toString()`) for
 * both `page.evaluate` and a `waitForFunction` predicate, so it can call no outside helper — one
 * defined elsewhere in this module would not exist in that serialized copy.
 */
export function visibleBusyIndicator(): string | null {
  const shown = (el: Element): boolean => {
    const r = (el as HTMLElement).getBoundingClientRect();
    const s = window.getComputedStyle(el as HTMLElement);
    return r.width > 0 && r.height > 0 && s.visibility !== "hidden" && s.display !== "none" && s.opacity !== "0";
  };
  const describe = (el: Element): string => {
    const testid = el.getAttribute("data-testid");
    if (testid) return `[data-testid=${testid}]`;
    const id = (el as HTMLElement).id;
    if (id) return `#${id}`;
    const role = el.getAttribute("role") ?? el.tagName.toLowerCase();
    const name = (el.getAttribute("aria-label") ?? el.textContent ?? "").trim().replace(/\s+/g, " ").slice(0, 60);
    return name ? `role=${role} "${name}"` : `role=${role} <${el.tagName.toLowerCase()}>`;
  };
  const selectors = [
    '[aria-busy="true"]',
    '[role="progressbar"]:not([aria-valuenow])',
    '[class*="spinner" i]',
    '[class*="animate-spin" i]',
  ];
  for (const sel of selectors) {
    for (const el of Array.from(document.querySelectorAll(sel))) {
      if (!shown(el)) continue;
      return describe(el);
    }
  }
  return null;
}

/** Evidence for a hang signal: redacted pending requests with their ages. */
export function pendingEvidence(pending: readonly InflightRequest[], now: number): PendingRequestEvidence[] {
  return [...pending]
    .sort((a, b) => a.startedAt - b.startedAt)
    .map((r) => ({ endpoint: endpointOf(r.method, r.url), url: redactUrl(r.url), ageMs: Math.max(0, now - r.startedAt) }));
}

/** Plain-words detail for a hang kind. */
export function hangDetail(kind: HangKind, ctx: { pending: readonly PendingRequestEvidence[]; ceilingMs: number; busy: string | null; probeMs: number }): string {
  switch (kind) {
    case "main-thread-unresponsive":
      return `the page's main thread did not answer a trivial probe within ${ctx.probeMs}ms`;
    case "request-pending": {
      const p = ctx.pending[0];
      return p === undefined ? "a request stayed pending" : `${p.endpoint} was still pending after ${Math.round(p.ageMs)}ms`;
    }
    case "never-settled":
      return `the page never settled (requests/DOM kept changing) within ${ctx.ceilingMs}ms`;
    case "ui-no-progress":
      return ctx.busy === null ? "the UI made no progress" : `a busy indicator (${ctx.busy}) never went away within ${ctx.ceilingMs}ms`;
  }
}

/** The route (normalized, redacted) of a URL — the route part of a hang's identity. */
export function hangRoute(url: string): string {
  return normalizeRoute(redactUrl(url));
}
