import type { Page } from "playwright";
import { contentHash } from "@jevitate/domain";
import { redactUrl } from "@jevitate/ai-core";
import type { Box } from "@jevitate/interpreter";
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

/** A rendered box, in viewport CSS-px coordinates — `@jevitate/interpreter`'s shared geometry type
 *  (#148), reused here rather than duplicated: the same `getBoundingClientRect()` shape every
 *  visual-state/geometry check already uses. */
export type OverflowRect = Box;

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

// ── Vertical clipping (#302) ──────────────────────────────────────────────────────────────────

/**
 * Why a text-bearing element's text is cut off vertically:
 *  - `overflow-hidden`: its nearest ancestor with `overflow-y: hidden | clip` (a fixed-height box)
 *    is shorter than its content (`scrollHeight > clientHeight`) and text lines fall outside it;
 *  - `above-page-top`: text that spilled out of a too-short box ABOVE the top of the page (a
 *    centred `flex-wrap` chip in a fixed-height header) — no scroll position ever shows it.
 */
export type ClippingCause = "overflow-hidden" | "above-page-top";

export interface ClippingFinding {
  readonly kind: "vertical-clipping";
  readonly cause: ClippingCause;
  /** How far (CSS px) the most-clipped text line extends outside what shows it. */
  readonly clippedPx: number;
  /** Route template (#95) — stable across instances. */
  readonly route: string;
  readonly url: string;
  /** The clipping container (`overflow-hidden`) or the cut-off text's element (`above-page-top`). */
  readonly element: OverflowElement;
  readonly viewport: { readonly width: number; readonly height: number };
  readonly device?: string;
  /** route + element descriptor, hashed: one finding per element across states and runs. */
  readonly fingerprint: string;
}

export interface DetectClippingOptions {
  /** Tolerance (CSS px) a text line may extend past the box (line-box rounding, descenders). Default 2. */
  readonly toleranceCss?: number;
  /** `--ignore-overflow <selector>` (repeatable): elements (and their descendants) never reported. */
  readonly ignoreSelectors?: readonly string[];
  readonly viewport: { readonly width: number; readonly height: number };
  readonly device?: string;
  readonly secrets?: readonly string[];
  /** At most this many findings per check (the most clipped first). Default 10. */
  readonly maxFindings?: number;
}

interface RawClipping {
  readonly cause: ClippingCause;
  readonly clippedPx: number;
  readonly descriptor: string;
  readonly rect: OverflowRect;
}

/**
 * BROWSER CODE — serialized by `page.evaluate`: no imports, no closure over module scope.
 *
 * Walks the page's non-blank text nodes (capped), and for each line box (a Range's client rects):
 *  1. finds its nearest ancestor with `overflow-y: hidden | clip` — never `<html>`/`<body>` or the
 *     scrolling element (a scroll-locked body is not a clipped box); a line extending more than
 *     `tolerance` px above/below that box's padding box is clipped by it (`overflow-hidden`), and only
 *     when the box really is short (`scrollHeight > clientHeight + tolerance`);
 *  2. otherwise, a line that starts above the page top yet is partly on the page (`above-page-top`)
 *     — measured in document coordinates, or viewport coordinates inside a `position: fixed` box.
 * NOT reported (noise control, documented in docs/exploration.md):
 *  - INTENTIONAL truncation: a `line-clamp`/`-webkit-line-clamp` or `text-overflow: ellipsis` on the
 *    container or between it and the text — the app chose to truncate and shows that it did;
 *  - the sr-only / visually-hidden idiom: a box ≤1px, or one hidden by `clip`/`clip-path`;
 *  - a collapsed box (`clientHeight < 1`: accordions, closed menus) and text pulled off on purpose
 *    (skip links: an absolutely/fixed-positioned box entirely above the page top, or ≥1000px off);
 *  - invisible text (`visibility: hidden`, `display: none`, `opacity: 0` on the way up);
 *  - `--ignore-overflow <selector>` matches (and their descendants).
 * One entry per element (the container, or the cut-off text's element), with its worst line.
 */
function clippingAttribution(args: { tolerance: number; ignoreSelectors: string[]; maxTextNodes: number }): RawClipping[] {
  const tol = args.tolerance;
  const ignored: Element[] = [];
  for (const sel of args.ignoreSelectors) {
    try {
      document.querySelectorAll(sel).forEach((el) => ignored.push(el));
    } catch {
      // an invalid selector is never fatal to the check
    }
  }
  const isIgnored = (el: Element): boolean => ignored.some((ig) => ig === el || ig.contains(el));
  const styles = new Map<Element, CSSStyleDeclaration>();
  const style = (el: Element): CSSStyleDeclaration => {
    let s = styles.get(el);
    if (s === undefined) {
      s = window.getComputedStyle(el);
      styles.set(el, s);
    }
    return s;
  };
  const root = document.scrollingElement || document.documentElement;
  const isPageRoot = (el: Element): boolean => el === document.documentElement || el === document.body || el === root;
  const truncates = (s: CSSStyleDeclaration): boolean => {
    const clamp = s.getPropertyValue("-webkit-line-clamp") || s.getPropertyValue("line-clamp");
    return (clamp !== "" && clamp !== "none") || s.textOverflow === "ellipsis";
  };
  const visuallyHidden = (el: Element, s: CSSStyleDeclaration): boolean => {
    const r = el.getBoundingClientRect();
    if (r.width <= 1 || r.height <= 1) return true;
    return (s.clip !== "" && s.clip !== "auto") || (s.clipPath !== "" && s.clipPath !== "none");
  };
  const scrollY = window.scrollY;
  const out = new Map<Element, RawClipping>();
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
  const record = (el: Element, cause: ClippingCause, px: number): void => {
    const prev = out.get(el);
    if (prev !== undefined && prev.clippedPx >= px) return;
    const r = el.getBoundingClientRect();
    out.set(el, { cause, clippedPx: Math.round(px), descriptor: describe(el), rect: { x: r.x, y: r.y, width: r.width, height: r.height } });
  };

  const walker = document.createTreeWalker(document.body ?? document.documentElement, NodeFilter.SHOW_TEXT);
  let seen = 0;
  for (let node = walker.nextNode(); node !== null && seen < args.maxTextNodes; node = walker.nextNode()) {
    if ((node.textContent ?? "").trim() === "") continue;
    const parent = node.parentElement;
    if (parent === null || isIgnored(parent)) continue;
    seen += 1;
    // The text's ancestors, nearest first: visibility, intentional truncation and the clipping box.
    let clipper: Element | null = null;
    let intentional = false;
    let hidden = false;
    let fixed = false;
    let pulled = false;
    for (let el: Element | null = parent; el !== null; el = el.parentElement) {
      const s = style(el);
      if (s.display === "none" || s.visibility === "hidden" || s.visibility === "collapse" || s.opacity === "0") {
        hidden = true;
        break;
      }
      if (clipper === null && truncates(s)) intentional = true;
      if (s.position === "fixed") fixed = true;
      if (s.position === "absolute" || s.position === "fixed") pulled = true;
      if (clipper === null && !isPageRoot(el) && /^(hidden|clip)$/.test(s.overflowY)) clipper = el;
    }
    if (hidden || intentional) continue;
    const range = document.createRange();
    range.selectNodeContents(node);
    const lines = Array.from(range.getClientRects()).filter((r) => r.width > 0 && r.height > 0);
    if (lines.length === 0) continue;
    if (clipper !== null) {
      const box = clipper as HTMLElement;
      const cs = style(clipper);
      if (box.clientHeight < 1 || visuallyHidden(clipper, cs) || isIgnored(clipper)) continue;
      if (box.scrollHeight <= box.clientHeight + tol) continue;
      const r = box.getBoundingClientRect();
      const top = r.top + box.clientTop;
      const bottom = top + box.clientHeight;
      let worst = 0;
      for (const l of lines) worst = Math.max(worst, top - l.top, l.bottom - bottom);
      if (worst > tol) record(clipper, "overflow-hidden", worst);
      continue;
    }
    // No clipping box: text spilled above the page top (never reachable by scrolling).
    const offset = fixed ? 0 : scrollY;
    let worst = 0;
    for (const l of lines) {
      const top = l.top + offset;
      const bottom = l.bottom + offset;
      // Pulled far off on purpose, or a positioned box (a skip link) sitting entirely above the
      // page: never a cut-off line. An IN-FLOW line entirely above the page is spilled text and
      // counts — its glyph box, not the line box, is measured, so ignoring it would make the
      // result hinge on where the font's ascent/descent gaps fall relative to y=0.
      if (top <= -1_000 || (bottom <= 0 && pulled)) continue;
      worst = Math.max(worst, -top);
    }
    if (worst > tol) record(parent, "above-page-top", worst);
  }
  return [...out.values()];
}

/**
 * Runs the vertical-clipping check (#302) on `page`'s CURRENT settled state: one finding per element
 * whose text is cut off vertically (most clipped first, at most `maxFindings`); `[]` when none is.
 */
export async function detectClipping(page: Page, opts: DetectClippingOptions): Promise<ClippingFinding[]> {
  const raw = await page.evaluate(clippingAttribution, {
    tolerance: opts.toleranceCss ?? 2,
    ignoreSelectors: [...(opts.ignoreSelectors ?? [])],
    maxTextNodes: 5_000,
  });
  const secrets = opts.secrets ?? [];
  const url = redactUrl(page.url());
  const route = normalizeRoute(page.url());
  const byFingerprint = new Map<string, ClippingFinding>();
  for (const r of [...raw].sort((a, b) => b.clippedPx - a.clippedPx)) {
    const descriptor = redactText(r.descriptor.slice(0, 120), secrets);
    const fingerprint = contentHash(`vertical-clipping|${route}|${descriptor}`).slice(0, 16);
    if (byFingerprint.has(fingerprint)) continue;
    byFingerprint.set(fingerprint, {
      kind: "vertical-clipping",
      cause: r.cause,
      clippedPx: r.clippedPx,
      route,
      url,
      element: { descriptor, rect: r.rect },
      viewport: opts.viewport,
      ...(opts.device === undefined ? {} : { device: opts.device }),
      fingerprint,
    });
  }
  return [...byFingerprint.values()].slice(0, opts.maxFindings ?? 10);
}

/** A one-line summary of a clipping finding (defect reason / signal detail). */
export function clippingSummary(f: ClippingFinding): string {
  return f.cause === "overflow-hidden"
    ? `vertical-clipping: ${f.element.descriptor} cuts off its text by ${f.clippedPx}px (overflow hidden, content taller than the box) at ${f.route}`
    : `vertical-clipping: ${f.element.descriptor} is cut off ${f.clippedPx}px above the top of the page at ${f.route}`;
}
