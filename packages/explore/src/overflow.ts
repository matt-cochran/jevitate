import type { Page } from "playwright";
import { contentHash } from "@jevitate/domain";
import { redactUrl } from "@jevitate/ai-core";
import { redactText } from "./redact.js";
import { normalizeRoute } from "./adversarial/defect-fingerprint.js";

/**
 * Horizontal-overflow hard signal (#149) — `document.scrollingElement.scrollWidth > innerWidth`,
 * attributed to the element that CAUSES it, never a model judgment (pure DOM geometry, the same
 * "code decides" discipline as `occlusion.ts`).
 *
 * Dogfood evidence: Allumata's `/settings/api-keys` scrolled 156px sideways at 375px (A12) — no
 * mission ever checked, because every mission ran at Playwright's default (desktop) viewport.
 *
 * Kept in its own module (own scope from #148's geometry/style assertions): a caller (coverage,
 * adversarial, usability) decides WHEN to run it (`shouldCheckOverflow`) and what to do with a
 * finding (defect vs. signal finding); this module only detects and attributes.
 */

export interface OverflowRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface OverflowElement {
  /** testId / role+name / short CSS path — clipped and redacted (an aria-label can carry PII, #149/A12). */
  readonly descriptor: string;
  readonly rect: OverflowRect;
}

export interface OverflowFinding {
  readonly kind: "horizontal-overflow";
  /** `scrollWidth - innerWidth`, in CSS px. */
  readonly overflowPx: number;
  /** Route template (#95: identifier segments normalized to `:id`) — stable across instances. */
  readonly route: string;
  readonly url: string;
  readonly element: OverflowElement;
  readonly viewport: { readonly width: number; readonly height: number };
  /** The `--device` name, when the run used one. */
  readonly device?: string;
  /** route + element descriptor, hashed — the same defect across states/runs, one finding per element. */
  readonly fingerprint: string;
}

export interface DetectOverflowOptions {
  /** Tolerance (CSS px) below which overflow is not reported. Default 1. */
  readonly toleranceCss?: number;
  /** `--ignore-overflow <selector>` (repeatable): elements (and their descendants) never attributed. */
  readonly ignoreSelectors?: readonly string[];
  readonly viewport: { readonly width: number; readonly height: number };
  readonly device?: string;
  /** Registered run secrets: redacted out of the element descriptor (an aria-label can hold one, #149/A12). */
  readonly secrets?: readonly string[];
}

/** The emulated viewport width below which the signal runs by default (`--check-overflow` opts in above it). */
export const DEFAULT_OVERFLOW_VIEWPORT_THRESHOLD = 1024;

/** Whether the overflow check should run this step: an emulated viewport narrower than the threshold, or explicit opt-in. */
export function shouldCheckOverflow(viewportWidth: number | undefined, checkOverflow: boolean): boolean {
  return checkOverflow || (viewportWidth !== undefined && viewportWidth < DEFAULT_OVERFLOW_VIEWPORT_THRESHOLD);
}

interface RawAttribution {
  readonly overflowPx: number;
  readonly descriptor: string;
  readonly rect: OverflowRect;
}

/**
 * BROWSER CODE — serialized by `page.evaluate`: no imports, no closure over module scope.
 *
 * 1. `overflowPx = scrollingElement.scrollWidth - innerWidth`; null (no finding) at or under tolerance.
 * 2. Attribution walks every element, excluding:
 *    - inside an ancestor with `overflow-x: auto | scroll | hidden | clip` (contained, not page-level);
 *    - `position: fixed` entirely off the visible viewport on purpose;
 *    - the sr-only/clipped idiom (`act.ts`'s `isClippedOrPulledOffscreen`: ≤1px box, or pulled ≥1000px
 *      off by a negative offset) — never what a user sees overflow from;
 *    - `--ignore-overflow <selector>` matches (and their descendants).
 * 3. Among the remaining "root" offenders (no offending ancestor), each is narrowed to the deepest
 *    element whose own right edge its offending children don't ALL reproduce — the element that
 *    actually SETS the width, not a wrapper that merely inherits it. The widest of those is reported.
 */
function overflowAttribution(args: { tolerance: number; ignoreSelectors: string[] }): RawAttribution | null {
  const innerWidth = window.innerWidth;
  const scrollingEl = document.scrollingElement || document.documentElement;
  const overflowPx = scrollingEl.scrollWidth - innerWidth;
  if (overflowPx <= args.tolerance) return null;

  const ignored = new Set<Element>();
  for (const sel of args.ignoreSelectors) {
    try {
      document.querySelectorAll(sel).forEach((el) => ignored.add(el));
    } catch {
      // an invalid selector is never fatal to the check
    }
  }
  const isIgnored = (el: Element): boolean => {
    for (const ig of ignored) if (ig === el || ig.contains(el)) return true;
    return false;
  };
  const isContained = (el: Element): boolean => {
    let node = el.parentElement;
    while (node !== null) {
      const s = window.getComputedStyle(node);
      if (/^(auto|scroll|hidden|clip)$/.test(s.overflowX)) return true;
      node = node.parentElement;
    }
    return false;
  };
  const isClippedOrPulledOffscreen = (el: Element): boolean => {
    const r = (el as HTMLElement).getBoundingClientRect();
    if (r.width <= 1 && r.height <= 1) return true;
    return r.left <= -1_000 || r.top <= -1_000;
  };
  const isFixedOffscreenOnPurpose = (el: Element): boolean => {
    const s = window.getComputedStyle(el);
    if (s.position !== "fixed") return false;
    const r = (el as HTMLElement).getBoundingClientRect();
    return r.left >= innerWidth || r.right <= 0;
  };
  const isOffender = (el: Element): boolean => {
    if (isIgnored(el)) return false;
    const s = window.getComputedStyle(el);
    if (s.display === "none" || s.visibility === "hidden") return false;
    const r = (el as HTMLElement).getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return false;
    if (r.right <= innerWidth + args.tolerance) return false;
    if (isClippedOrPulledOffscreen(el)) return false;
    if (isFixedOffscreenOnPurpose(el)) return false;
    if (isContained(el)) return false;
    return true;
  };

  const all = Array.from(document.querySelectorAll("*"));
  const offenders = all.filter(isOffender);
  if (offenders.length === 0) return null;
  const offenderSet = new Set(offenders);

  const rootOffenders = offenders.filter((el) => {
    let p = el.parentElement;
    while (p !== null) {
      if (offenderSet.has(p)) return false;
      p = p.parentElement;
    }
    return true;
  });

  const explain = (el: Element): Element => {
    const own = (el as HTMLElement).getBoundingClientRect();
    const kids = Array.from(el.children).filter((c) => offenderSet.has(c));
    if (kids.length > 0 && kids.every((k) => Math.abs((k as HTMLElement).getBoundingClientRect().right - own.right) <= 2)) {
      return explain(kids[0]!);
    }
    return el;
  };

  const candidates = rootOffenders.map(explain);
  let best = candidates[0]!;
  for (const c of candidates) {
    if ((c as HTMLElement).getBoundingClientRect().width > (best as HTMLElement).getBoundingClientRect().width) best = c;
  }

  const describe = (el: Element): string => {
    const testId = el.closest("[data-testid]")?.getAttribute("data-testid");
    if (testId !== null && testId !== undefined) return `[data-testid=${testId}]`;
    const role = el.getAttribute("role");
    const name = el.getAttribute("aria-label") ?? (el as HTMLElement).innerText?.trim().slice(0, 80) ?? "";
    if (role !== null && name !== "") return `role=${role};name=${name}`;
    if (el.id !== "") return `#${el.id}`;
    const tag = el.tagName.toLowerCase();
    const cls = typeof el.className === "string" && el.className.trim() !== "" ? `.${el.className.trim().split(/\s+/).slice(0, 2).join(".")}` : "";
    return `${tag}${cls}`;
  };

  const r = (best as HTMLElement).getBoundingClientRect();
  return {
    overflowPx,
    descriptor: describe(best),
    rect: { x: r.x, y: r.y, width: r.width, height: r.height },
  };
}

/** Runs the overflow check on `page`'s CURRENT settled state; null when the page has no page-level horizontal overflow. */
export async function detectOverflow(page: Page, opts: DetectOverflowOptions): Promise<OverflowFinding | null> {
  const tolerance = opts.toleranceCss ?? 1;
  const raw = await page.evaluate(overflowAttribution, { tolerance, ignoreSelectors: [...(opts.ignoreSelectors ?? [])] });
  if (raw === null) return null;
  const secrets = opts.secrets ?? [];
  const url = redactUrl(page.url());
  const route = normalizeRoute(page.url());
  // Clipped BEFORE redaction too: an aria-label/testId can be arbitrarily long user content (A12: a
  // ~900-char key name). 120 chars is ample for a descriptor while keeping the finding compact.
  const descriptor = redactText(raw.descriptor.slice(0, 120), secrets);
  const fingerprint = contentHash(`horizontal-overflow|${route}|${descriptor}`).slice(0, 16);
  return {
    kind: "horizontal-overflow",
    overflowPx: raw.overflowPx,
    route,
    url,
    element: { descriptor, rect: raw.rect },
    viewport: opts.viewport,
    ...(opts.device === undefined ? {} : { device: opts.device }),
    fingerprint,
  };
}
