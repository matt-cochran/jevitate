import { randomBytes } from "node:crypto";
import { readFile, rm } from "node:fs/promises";
import type { BrowserContext, Frame, Locator, Page } from "playwright";
import { REVEALED_SECRET_SELECTORS, REVEALED_SECRET_SHAPES, revealedSecretsIn, secretForms } from "@jevitate/ai-core";
import { DEMO_OVERLAY_ATTR, DEMO_OVERLAY_HIDE_STYLE, hideDemoOverlayForCapture } from "@jevitate/explore";
import { decodePng } from "./png-pixels.js";
import { descriptorToLocator } from "@jevitate/recorder";
import type { TargetDescriptor } from "@jevitate/recording";
import type { BrowserPort } from "@jevitate/playwright";
import { clock } from "@jevitate/domain";

/**
 * #248 — the ONE place a demo screenshot is taken. The overlay is always hidden (#336: through its
 * shadow root's adopted sheets, applied only for the capture: the page's DOM is never touched), and the
 * capture is built from LAYERS so later safety passes plug in without touching the callers: pixel
 * masking of secret fields (#250/#251) is a layer contributing `mask` locators and/or extra `style`.
 * A layer cannot un-hide the overlay: its styles are added to the capture, never replacing the hide.
 *
 * #250/#251 — the pixel mask ({@link SecretPixelMask}): every registered secret value the page
 * shows (text nodes, non-password input/textarea/select values, attribute-rendered text such as a
 * `title`) is painted over by a DISPLAY-ONLY layer — the #245 overlay's technique: a CLOSED shadow
 * root on a `<jevitate-mask>` host appended to `<html>`, pointer-events none, inert, aria-hidden;
 * the page's own nodes are never changed. The layer re-measures on every animation frame (before
 * each paint) and re-scans on every DOM mutation / input, so a video frame never shows a secret the
 * mask has not caught. Screenshots and videos FAIL CLOSED: a capture whose mask cannot be proven
 * (every occurrence covered by a painted box, the layer attached, visible and on top) is not written.
 */

/** What a layer adds to one capture. */
export interface CaptureContribution {
  /** Extra CSS applied only while capturing (appended after the overlay-hiding style). */
  readonly style?: string;
  /** Elements painted over in the image (Playwright `mask`). */
  readonly mask?: readonly Locator[];
  /** The mask colour (Playwright `maskColor`); the last layer that sets one wins. */
  readonly maskColor?: string;
}

/** Where in the demo a capture is taken. */
export interface CaptureContext {
  /** 1-based step number. */
  readonly step: number;
}

/** A capture layer: consulted just before each screenshot. It must not change the page. */
export interface CaptureLayer {
  readonly name: string;
  prepare(page: Page, ctx: CaptureContext): Promise<CaptureContribution | void>;
  /**
   * #250: re-checked right AFTER the screenshot; a throw deletes the file just written (fail
   * closed: the page may have changed between `prepare` and the capture).
   */
  confirm?(page: Page, ctx: CaptureContext, shot?: CapturedShot): Promise<void>;
}

/** #471: the file a capture just wrote, for a layer that checks the pixels themselves. */
export interface CapturedShot {
  readonly path: string;
  readonly clip?: { readonly x: number; readonly y: number; readonly width: number; readonly height: number };
}

/**
 * The screenshot options a set of layers produces. #336: the overlay is no longer hidden with a
 * `style` (see {@link captureStepScreenshot}); `style` is only what layers add, and is empty
 * (omitted from the screenshot call) when none does.
 */
export async function captureOptions(
  page: Page,
  ctx: CaptureContext,
  layers: readonly CaptureLayer[],
): Promise<{ style: string; mask: Locator[]; maskColor?: string }> {
  const styles: string[] = [];
  const mask: Locator[] = [];
  let maskColor: string | undefined;
  for (const layer of layers) {
    const c = await layer.prepare(page, ctx);
    if (c === undefined) continue;
    if (c.style !== undefined && c.style !== "") styles.push(c.style);
    if (c.mask !== undefined) mask.push(...c.mask);
    if (c.maskColor !== undefined) maskColor = c.maskColor;
  }
  return { style: styles.join("\n"), mask, ...(maskColor === undefined ? {} : { maskColor }) };
}

/**
 * Writes one step's PNG at `path`: the viewport (or `clip`, a page-coordinate region — #198's cropped
 * finding shots), overlay hidden, every layer applied. Throws on failure.
 */
export async function captureStepScreenshot(
  page: Page,
  path: string,
  ctx: CaptureContext,
  layers: readonly CaptureLayer[] = [],
  clip?: { readonly x: number; readonly y: number; readonly width: number; readonly height: number },
): Promise<void> {
  const { style: layerStyle, mask, maskColor } = await captureOptions(page, ctx, layers);
  // #336: the overlay is hidden through the CSSOM, never an inline <style> a strict CSP blocks (and
  // the console-error oracle then filed as an app defect). Only if that fails is the style used.
  const hidden = await hideDemoOverlayForCapture(page, true);
  const style = [hidden ? "" : DEMO_OVERLAY_HIDE_STYLE, layerStyle].filter((x) => x !== "").join("\n");
  try {
    await page.screenshot({
      path,
      type: "png",
      animations: "disabled",
      ...(style === "" ? {} : { style }),
      ...(clip === undefined ? {} : { clip: { ...clip } }),
      ...(mask.length === 0 ? {} : { mask }),
      ...(maskColor === undefined ? {} : { maskColor }),
    });
  } finally {
    await hideDemoOverlayForCapture(page, false);
  }
  try {
    for (const layer of layers) await layer.confirm?.(page, ctx, { path, ...(clip === undefined ? {} : { clip }) });
  } catch (err) {
    await rm(path, { force: true });
    throw err;
  }
}

// ── #250/#251: the pixel mask ────────────────────────────────────────────────────────────────────

/** The solid colour a secret is painted over with (the usability capture's mask colour, pinned). */
export const PIXEL_MASK_COLOR = "#FF00FF";

/** The attribute marking the mask layer's host element (never hidden by the capture style). */
export const PIXEL_MASK_ATTR = "data-jevitate-mask-layer";

/**
 * #298 — a secret the app REVEALS mid-run (a freshly minted API key, a one-time reveal panel, an
 * invite or reset link) is not known in advance, so it cannot be registered with `--secret`. The
 * pixel mask also covers, with no registration:
 *
 *  - elements the target marks as secret: these selectors (a target opts in with the
 *    `data-jevitate-mask` attribute; the rest are common one-time-secret markers);
 *  - text and field values shaped like a credential ({@link REVEALED_SECRET_SHAPES}).
 *
 * A value found either way is LEARNED for the rest of the run: masked wherever it appears later
 * (another screen, a frame) and redacted from the screenshot index. Learned values live only in
 * memory (the run's mask), never on disk. Limits (docs/safety.md): a secret with no marker and
 * no credential shape (a short code, a plain word) is not masked; a password field shows dots.
 */
export { REVEALED_SECRET_SELECTORS, REVEALED_SECRET_SHAPES, revealedSecretsIn };

/** The mask could not be applied or proven: the capture is skipped (fail closed), never written. */
export class MaskUnavailableError extends Error {
  readonly code = "E_PIXEL_MASK" as const;
  constructor(message: string) {
    super(message);
    this.name = "MaskUnavailableError";
  }
}

/** One proof of the mask at capture time, across every frame of the page. */
export interface MaskCheck {
  readonly ok: boolean;
  /** Visible occurrences of a registered secret (text ranges, fields, attribute-bearing elements). */
  readonly occurrences: number;
  /** Of those, how many a painted mask box fully covers. */
  readonly masked: number;
  /** Why the proof failed (never contains a secret). */
  readonly reason?: string;
  /** The covered occurrences' viewport rects (top frame only) — what a pixel check can sample. */
  readonly rects: ReadonlyArray<{ readonly x: number; readonly y: number; readonly width: number; readonly height: number }>;
  /** #471: the jz-mask-v1 proof of the top document, when the mask enforces jz-mask-v1. */
  readonly jz?: JzMaskCheck;
}

/** #471: a jz-mask-v1 region kind — masked, replaced by a placeholder, or left out (an empty box). */
export type JzRegionKind = "mask" | "placeholder" | "block";

/** #471: one proof of jz-mask-v1 over the top document, now. */
export interface JzMaskCheck {
  readonly ok: boolean;
  /** Region boxes painted (masked + placeholders + left out), overflowing descendants included. */
  readonly regions: number;
  readonly rects: ReadonlyArray<{ readonly x: number; readonly y: number; readonly width: number; readonly height: number; readonly kind: JzRegionKind }>;
  /** The CSS viewport the rects are in (a screenshot's pixels map onto it). */
  readonly viewport: { readonly width: number; readonly height: number };
  /** Why the proof failed. */
  readonly reason?: string;
  /** A frame of this document the layer could not prove (sticky; "" when none) — voids a video. */
  readonly breach: string;
}

/**
 * BROWSER CODE (a string: evaluated as-is, never transpiled). `__CFG__` is replaced by the JSON
 * config `{ name, secrets, fill, attr }`. Idempotent per document; installs `window[name]`
 * (non-enumerable, non-writable, non-configurable — a random name per run, so a page cannot
 * pre-empt or fake it). Secret values live only inside this closure.
 */
const MASK_RUNTIME = String.raw`((cfg) => {
  if (window[cfg.name]) return true;
  const SECRETS = cfg.secrets.filter((s) => typeof s === "string" && s.trim().length > 0);
  // #298: secrets the app reveals mid-run — marked elements and credential-shaped values — are
  // learned into SECRETS (masked everywhere after) and reported to the run's mask via learned().
  const SHAPES = cfg.shapes.map((src) => new RegExp(src, "g"));
  const MARKERS = cfg.markers.join(",");
  const LEARNED = [];
  const learn = (v) => {
    if (typeof v !== "string") return;
    const t = v.trim();
    if (t.length < 8 || SECRETS.includes(t)) return;
    SECRETS.push(t);
    LEARNED.push(t);
  };
  const learnShapes = (v) => {
    if (typeof v !== "string" || v.length < 8) return;
    for (const re of SHAPES) { re.lastIndex = 0; for (const m of v.matchAll(re)) learn(m[0]); }
  };
  // A marked element is masked whole; what is LEARNED from it (masked elsewhere too) is its field
  // value, or its credential-like words: 12+ chars, no space, letters and digits (never a label
  // word like "Generate", which would then be masked on every screen).
  const learnMarked = (el) => {
    const tag = el.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA") { if (!/\s/.test(el.value)) learn(el.value); learnShapes(el.value); return; }
    const text = el.textContent || "";
    learnShapes(text);
    for (const tok of text.split(/\s+/)) if (tok.length >= 12 && /[0-9]/.test(tok) && /[A-Za-z]/.test(tok)) learn(tok.replace(/^['"(]+|['")\].,;:]+$/g, ""));
  };
  const SKIP = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "HEAD", "TITLE", "META", "LINK"]);
  const PAD = 2;
  // Captured at install (an init script runs before any page script), so a page that later replaces
  // requestAnimationFrame cannot stop the mask from re-measuring before each paint.
  const raf = window.requestAnimationFrame.bind(window);
  const CSS = ":host{all:initial}*{pointer-events:none !important;box-sizing:border-box}[hidden]{display:none !important}" +
    ".m{position:fixed;background:" + cfg.fill + ";border-radius:2px}" +
    ".jm{position:fixed;background:" + cfg.jzFill.mask + "}" +
    ".jp{position:fixed;background:" + cfg.jzFill.placeholder + "}" +
    ".jb{position:fixed;background:" + cfg.jzFill.block + "}" +
    ".h{position:fixed;border:3px solid #f59e0b;border-radius:6px;box-shadow:0 0 0 4px rgba(245,158,11,.35)}";
  let host = null;
  let layer = null;
  let hiBox = null;
  let dirty = true;
  let targets = [];
  const boxes = [];
  let drawn = [];
  let highlightEl = null;
  let lastError = "";
  const holds = (s) => typeof s === "string" && s.length > 0 && SECRETS.some((x) => s.includes(x));
  const ensureHost = () => {
    const root = document.documentElement;
    if (!root) return false;
    if (host === null) {
      host = document.createElement("jevitate-mask");
      host.setAttribute(cfg.attr, "");
      host.setAttribute("aria-hidden", "true");
      host.setAttribute("inert", "");
      const st = { display: "block", visibility: "visible", opacity: "1", position: "fixed", top: "0", left: "0",
        width: "0", height: "0", overflow: "visible", "pointer-events": "none", "z-index": "2147483647",
        transform: "none", filter: "none", "clip-path": "none", margin: "0", padding: "0", border: "0" };
      for (const k of Object.keys(st)) host.style.setProperty(k, st[k], "important");
      const shadow = host.attachShadow({ mode: "closed" });
      try {
        const sheet = new CSSStyleSheet();
        sheet.replaceSync(CSS);
        shadow.adoptedStyleSheets = [sheet];
      } catch (e) {
        const s = document.createElement("style");
        s.textContent = CSS;
        shadow.appendChild(s);
      }
      layer = document.createElement("div");
      hiBox = document.createElement("div");
      hiBox.className = "h";
      hiBox.hidden = true;
      shadow.append(layer, hiBox);
    }
    // The last child of <html>: painted after (above) every same-z-index page layer.
    if (host.parentNode !== root || root.lastElementChild !== host) root.appendChild(host);
    return true;
  };
  const collect = () => {
    const out = [];
    const roots = [document];
    // Marked elements first (#298): masked whole, and their secret learned before the text scan.
    const marked = new Set();
    const markRoot = (r) => {
      if (MARKERS === "") return;
      for (const el of Array.from(r.querySelectorAll(MARKERS))) {
        if (el === host || SKIP.has(el.tagName) || marked.has(el)) continue;
        marked.add(el);
        learnMarked(el);
        out.push({ kind: "el", el });
      }
    };
    markRoot(document);
    const perSecretRanges = new Map();
    for (let i = 0; i < roots.length; i++) {
      const w = document.createTreeWalker(roots[i], NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT);
      for (let n = w.nextNode(); n !== null; n = w.nextNode()) {
        if (n.nodeType === 3) {
          const p = n.parentElement;
          if (p !== null && SKIP.has(p.tagName)) continue;
          const v = n.nodeValue;
          if (!v) continue;
          learnShapes(v);
          for (const s of SECRETS) {
            let at = v.indexOf(s);
            while (at >= 0) {
              out.push({ kind: "range", node: n, start: at, end: at + s.length });
              perSecretRanges.set(s, (perSecretRanges.get(s) || 0) + 1);
              at = v.indexOf(s, at + s.length);
            }
          }
          continue;
        }
        const el = n;
        if (el === host) continue;
        if (el.shadowRoot) { roots.push(el.shadowRoot); markRoot(el.shadowRoot); }
        if (SKIP.has(el.tagName)) continue;
        if (marked.has(el)) continue;
        let hit = false;
        const tag = el.tagName;
        if (tag === "INPUT" || tag === "TEXTAREA") {
          const type = (el.getAttribute("type") || "").toLowerCase();
          if (!(tag === "INPUT" && type === "password")) learnShapes(el.value);
          if (!(tag === "INPUT" && type === "password") && holds(el.value)) hit = true;
        } else if (tag === "SELECT") {
          const t = Array.from(el.selectedOptions || []).map((o) => o.text).join(" ");
          if (holds(t) || holds(el.value)) hit = true;
        }
        if (!hit) for (const a of Array.from(el.attributes)) if (holds(a.value)) { hit = true; break; }
        if (hit) out.push({ kind: "el", el });
      }
    }
    // A secret split across text nodes (e.g. "sec<b>ret</b>"): mask the deepest element holding it whole.
    const body = document.body;
    if (body) {
      const text = body.textContent || "";
      for (const s of SECRETS) {
        let total = 0;
        for (let at = text.indexOf(s); at >= 0; at = text.indexOf(s, at + s.length)) total++;
        if (total <= (perSecretRanges.get(s) || 0)) continue;
        const walk = (el) => {
          let child = false;
          for (const c of Array.from(el.children)) {
            if (SKIP.has(c.tagName)) continue;
            if ((c.textContent || "").includes(s)) { child = true; walk(c); }
          }
          if (!child && !out.some((t) => t.kind === "range" && el.contains(t.node))) out.push({ kind: "el", el });
        };
        walk(body);
      }
    }
    return out;
  };
  // ── #471: jz-mask-v1 (journeeze-saas docs/contract/journey-import-v1.md "Recording references and
  // masking"), top document only — every frame below it is an iframe/frame the policy replaces whole.
  //  - masked: input, textarea, select, every editable element (contenteditable in any spelling, or
  //    inherited; designMode) and [data-jz-mask], each with its subtree;
  //  - placeholder: iframe, frame, object, embed, video, audio, canvas;
  //  - left out: [data-jz-block] and its subtree (an empty box of its size).
  // A region is its element's box; a descendant painting outside that box gets a box of its own, so
  // "with its subtree" holds for overflowing content too. Content is never read: only geometry.
  const JZ = cfg.jz === true && window === window.top;
  const LATE = document.readyState !== "loading";
  const JZ_FIELDS = new Set(["input", "textarea", "select"]);
  const JZ_PLACEHOLDERS = new Set(["iframe", "frame", "object", "embed", "video", "audio", "canvas"]);
  const JZ_SKIP = new Set(["script", "style", "noscript", "template", "head", "title", "meta", "link"]);
  const JZ_MAX_NODES = 50000;
  const JZ_CLASS = { mask: "jm", placeholder: "jp", block: "jb" };
  let jzTargets = [];
  let jzTopLayer = [];
  let jzDrawn = [];
  let jzTooBig = false;
  let jzPseudo = false;
  let jzFirst = true;
  let breach = "";
  const own = (el) => el === host || (el.hasAttribute && (el.hasAttribute(cfg.attr) || el.hasAttribute(cfg.overlayAttr)));
  const jzCollect = () => {
    const out = [];
    const top = [];
    let nodes = 0;
    jzTooBig = false;
    jzPseudo = false;
    // A positioned ::before/::after can paint generated content outside every box measured here.
    const escapes = (el) => {
      for (const pseudo of ["::before", "::after"]) {
        const cs = getComputedStyle(el, pseudo);
        if (cs.content !== "none" && cs.content !== "normal" && (cs.position === "absolute" || cs.position === "fixed")) return true;
      }
      return false;
    };
    // Every descendant (elements, text, open shadow trees) of a region root, as overflow candidates.
    const subtree = (rootEl, kind) => {
      out.push({ kind, el: rootEl });
      // A placeholder's fallback children are never rendered: only masked and left-out subtrees paint.
      const painted = kind !== "placeholder";
      if (painted && escapes(rootEl)) jzPseudo = true;
      const stack = [rootEl];
      if (rootEl.shadowRoot) stack.push(rootEl.shadowRoot);
      while (stack.length > 0) {
        const n = stack.pop();
        for (let c = n.firstChild; c !== null; c = c.nextSibling) {
          if (++nodes > JZ_MAX_NODES) { jzTooBig = true; return; }
          if (c.nodeType === 3) { if (c.nodeValue && c.nodeValue.trim() !== "") out.push({ kind, node: c, within: rootEl }); continue; }
          if (c.nodeType !== 1 || own(c)) continue;
          out.push({ kind, el: c, within: rootEl });
          // A modal dialog or popover inside a region leaves its box for the top layer.
          if (c.localName === "dialog" || c.hasAttribute("popover")) top.push(c);
          if (painted && escapes(c)) jzPseudo = true;
          stack.push(c);
          if (c.shadowRoot) stack.push(c.shadowRoot);
        }
      }
    };
    if (document.designMode === "on" && document.documentElement) subtree(document.documentElement, "mask");
    else {
      const stack = [document];
      while (stack.length > 0 && !jzTooBig) {
        const n = stack.pop();
        for (let c = n.firstChild; c !== null && !jzTooBig; c = c.nextSibling) {
          if (c.nodeType !== 1) continue;
          if (++nodes > JZ_MAX_NODES) { jzTooBig = true; break; }
          if (own(c)) continue;
          const name = (c.localName || "").toLowerCase();
          if (JZ_SKIP.has(name)) continue;
          if (name === "dialog" || c.hasAttribute("popover")) top.push(c);
          if (c.hasAttribute("data-jz-block")) { subtree(c, "block"); continue; }
          if (c.hasAttribute("data-jz-mask") || JZ_FIELDS.has(name) || c.isContentEditable === true) { subtree(c, "mask"); continue; }
          if (JZ_PLACEHOLDERS.has(name)) { subtree(c, "placeholder"); continue; }
          stack.push(c);
          if (c.shadowRoot) stack.push(c.shadowRoot);
        }
      }
    }
    jzTopLayer = top;
    return out;
  };
  const covers = (b, r) => b.left <= r.left + 0.5 && b.top <= r.top + 0.5 && b.right >= r.right - 0.5 && b.bottom >= r.bottom - 0.5;
  const nodeRects = (node) => {
    if (!node.isConnected) return null;
    const r = document.createRange();
    try { r.selectNodeContents(node); } catch (e) { return null; }
    return Array.from(r.getClientRects());
  };
  // This frame's jz regions: [{ r, kind }] (a target that left the document has no box).
  const jzRegions = () => {
    const out = [];
    const rootBox = new Map();
    for (const t of jzTargets) {
      let rs;
      if (t.node !== undefined) rs = nodeRects(t.node);
      else rs = t.el.isConnected ? [t.el.getBoundingClientRect()] : null;
      if (rs === null) continue;
      let within = null;
      if (t.within !== undefined) {
        within = rootBox.get(t.within);
        if (within === undefined) { within = t.within.isConnected ? t.within.getBoundingClientRect() : null; rootBox.set(t.within, within); }
      }
      for (const r of rs) {
        if (!(r.width > 0 || r.height > 0)) continue;
        if (within !== null && within !== undefined && covers(within, r)) continue;
        out.push({ r, kind: t.kind });
      }
    }
    return out;
  };
  const topLayerOpen = () => {
    if (document.fullscreenElement) return true;
    for (const el of jzTopLayer) {
      try { if (el.isConnected && el.matches(":modal, :popover-open")) return true; } catch (e) { return true; }
    }
    return false;
  };
  // An animation on a region, an ancestor or a descendant may move it on the compositor between two
  // main-thread frames: the video cannot be proven for that stretch. One that only changes paint
  // (a colour, an outline, a shadow, opacity) moves nothing and is ignored.
  const PAINT_ONLY = /^(color|background-color|border(-top|-right|-bottom|-left)?-color|outline(-color|-offset|-width|-style)?|box-shadow|opacity|text-decoration-color|fill|stroke|caret-color|accent-color|visibility)$/;
  const kebab = (k) => k.replace(/[A-Z]/g, (c) => "-" + c.toLowerCase());
  const movesGeometry = (a) => {
    try {
      if (typeof a.transitionProperty === "string") return !PAINT_ONLY.test(a.transitionProperty);
      const frames = a.effect && typeof a.effect.getKeyframes === "function" ? a.effect.getKeyframes() : null;
      if (frames === null) return true;
      for (const f of frames) for (const k of Object.keys(f)) {
        if (k === "offset" || k === "computedOffset" || k === "easing" || k === "composite") continue;
        if (!PAINT_ONLY.test(kebab(k))) return true;
      }
      return false;
    } catch (e) { return true; }
  };
  const animatedRegion = () => {
    if (typeof document.getAnimations !== "function") return false;
    const els = jzTargets.filter((t) => t.el !== undefined && t.within === undefined).map((t) => t.el);
    if (els.length === 0) return false;
    for (const a of document.getAnimations()) {
      if (a.playState !== "running" || !movesGeometry(a)) continue;
      const tg = a.effect && a.effect.target;
      if (!tg) continue;
      for (const el of els) if (tg === el || (tg.contains && tg.contains(el)) || (el.contains && el.contains(tg))) return true;
    }
    return false;
  };
  const report = (reason) => {
    if (breach !== "") return;
    breach = String(reason).slice(0, 200);
    try { const f = window[cfg.report]; if (typeof f === "function") f(breach); } catch (e) { /* the sticky breach is read at the next verify */ }
  };
  const jzWatch = () => {
    if (!JZ) return;
    if (jzFirst) {
      jzFirst = false;
      if (LATE && jzDrawn.length > 0) report("the jz-mask-v1 layer was installed after the page had painted");
    }
    if (jzTooBig) report("the page is too large to prove jz-mask-v1");
    if (jzPseudo) report("a positioned ::before/::after in a jz-mask-v1 region can paint outside it");
    if (jzDrawn.length > 0 && topLayerOpen()) report("a top-layer element (modal dialog, popover or fullscreen) could paint over jz-mask-v1 regions");
    if (jzDrawn.length > 0 && animatedRegion()) report("an animation moved a jz-mask-v1 region");
    if (lastError !== "") report("the mask loop failed");
  };
  if (JZ) {
    window.addEventListener("scroll", (e) => {
      if (jzDrawn.length === 0) return;
      const t = e.target === document || e.target === window ? document.scrollingElement : e.target;
      try { if (t && getComputedStyle(t).scrollBehavior === "smooth") report("a smooth scroll can move jz-mask-v1 regions on the compositor"); } catch (e2) { report("a scroll could not be checked"); }
    }, true);
  }
  const rectsOf = (t) => {
    if (t.kind === "range") {
      if (!t.node.isConnected) return null;
      const r = document.createRange();
      try { r.setStart(t.node, t.start); r.setEnd(t.node, t.end); } catch (e) { return null; }
      return Array.from(r.getClientRects());
    }
    if (!t.el.isConnected) return null;
    return [t.el.getBoundingClientRect()];
  };
  const fieldText = (el) => el.tagName === "SELECT" ? Array.from(el.selectedOptions || []).map((o) => o.text).join(" ") + " " + el.value : el.value;
  const shaped = (v) => typeof v === "string" && v.length >= 8 && SHAPES.some((re) => { re.lastIndex = 0; return re.test(v); });
  const inputsChanged = () => {
    const flagged = new Set(targets.filter((t) => t.kind === "el").map((t) => t.el));
    for (const el of Array.from(document.querySelectorAll("input, textarea, select"))) {
      if (el.tagName === "INPUT" && (el.getAttribute("type") || "").toLowerCase() === "password") continue;
      if ((holds(fieldText(el)) || shaped(fieldText(el))) && !flagged.has(el)) return true;
    }
    return false;
  };
  const place = (d, r, pad) => {
    d.style.left = (r.left - pad) + "px";
    d.style.top = (r.top - pad) + "px";
    d.style.width = (r.width + 2 * pad) + "px";
    d.style.height = (r.height + 2 * pad) + "px";
  };
  const update = () => {
    if (!ensureHost()) return;
    if (dirty || inputsChanged()) { targets = collect(); dirty = false; }
    const rects = [];
    for (const t of targets) {
      const rs = rectsOf(t);
      if (rs === null) { dirty = true; continue; }
      for (const r of rs) if (r.width > 0 || r.height > 0) rects.push(r);
    }
    let jz = [];
    if (JZ) {
      // Re-collected on EVERY frame, not only on a mutation: a field can appear where no observer
      // sees it (inside a shadow root attached later, an element upgraded by customElements.define).
      jzTargets = jzCollect();
      jz = jzRegions();
    }
    const all = rects.map((r) => ({ r, cls: "m" })).concat(jz.map((x) => ({ r: x.r, cls: JZ_CLASS[x.kind] })));
    while (boxes.length < all.length) {
      const d = document.createElement("div");
      d.className = "m";
      layer.appendChild(d);
      boxes.push(d);
    }
    for (let i = 0; i < boxes.length; i++) {
      const d = boxes[i];
      if (i < all.length) {
        if (d.className !== all[i].cls) d.className = all[i].cls;
        place(d, all[i].r, PAD);
        d.hidden = false;
      } else d.hidden = true;
    }
    drawn = rects;
    jzDrawn = jz;
    if (highlightEl !== null && highlightEl.isConnected) {
      place(hiBox, highlightEl.getBoundingClientRect(), 5);
      hiBox.hidden = false;
    } else hiBox.hidden = true;
  };
  const tick = () => {
    try { update(); lastError = ""; } catch (e) { lastError = String((e && e.message) || e).slice(0, 200); }
    try { jzWatch(); } catch (e) { report("the jz-mask-v1 watch failed"); }
    raf(tick);
  };
  const mo = new MutationObserver((records) => {
    for (const r of records) {
      if (r.type === "attributes" && (r.attributeName === "style" || r.attributeName === "class")) continue;
      if (r.type === "childList" && r.target === document.documentElement &&
        Array.from(r.addedNodes).concat(Array.from(r.removedNodes)).every((x) => x === host)) continue;
      dirty = true;
      return;
    }
  });
  mo.observe(document, { subtree: true, childList: true, characterData: true, attributes: true });
  const mark = () => { dirty = true; };
  window.addEventListener("input", mark, true);
  window.addEventListener("change", mark, true);
  const api = {
    verify() {
      dirty = true;
      try { update(); } catch (e) {
        return { ok: false, occurrences: 0, masked: 0, reason: "the mask update failed: " + String((e && e.message) || e).slice(0, 200), rects: [],
          ...(JZ ? { jz: { ok: false, regions: 0, rects: [], reason: "the mask update failed", breach: breach || "the mask update failed", viewport: { width: window.innerWidth, height: window.innerHeight } } } : {}) };
      }
      const problems = [];
      {
        if (host === null || !host.isConnected) problems.push("the mask layer is not attached");
        else {
          const cs = getComputedStyle(host);
          if (cs.display === "none" || cs.visibility !== "visible" || Number(cs.opacity) < 1) problems.push("the mask layer is hidden");
          if (document.documentElement.lastElementChild !== host) problems.push("the mask layer is not the last layer");
        }
      }
      if (drawn.length > 0 && document.querySelector(":modal, :popover-open, :fullscreen") !== null) {
        problems.push("a top-layer element (modal dialog, popover or fullscreen) could paint over the mask");
      }
      let masked = 0;
      const live = boxes.filter((d) => !d.hidden).map((d) => d.getBoundingClientRect());
      for (const r of drawn) if (live.some((b) => covers(b, r))) masked++;
      if (masked < drawn.length) problems.push((drawn.length - masked) + " occurrence(s) not covered by a mask box");
      if (lastError !== "") problems.push("the mask loop failed: " + lastError);
      const out = { ok: problems.length === 0, occurrences: drawn.length, masked, rects: drawn.map((r) => ({ x: r.left, y: r.top, width: r.width, height: r.height })) };
      if (problems.length > 0) out.reason = problems.join("; ");
      if (JZ) {
        const jp = problems.filter((p) => p.indexOf("mask layer") >= 0);
        if (jzTooBig) jp.push("the page is too large to prove jz-mask-v1");
        if (jzPseudo) jp.push("a positioned ::before/::after in a jz-mask-v1 region can paint outside it");
        if (jzDrawn.length > 0 && topLayerOpen()) jp.push("a top-layer element (modal dialog, popover or fullscreen) could paint over jz-mask-v1 regions");
        let jzMasked = 0;
        for (const x of jzDrawn) if (live.some((b) => covers(b, x.r))) jzMasked++;
        if (jzMasked < jzDrawn.length) jp.push((jzDrawn.length - jzMasked) + " jz-mask-v1 region(s) not covered by a box");
        if (lastError !== "") jp.push("the mask loop failed");
        out.jz = {
          ok: jp.length === 0,
          regions: jzDrawn.length,
          rects: jzDrawn.map((x) => ({ x: x.r.left, y: x.r.top, width: x.r.width, height: x.r.height, kind: x.kind })),
          viewport: { width: window.innerWidth, height: window.innerHeight },
          breach,
        };
        if (jp.length > 0) out.jz.reason = jp.join("; ");
      }
      return out;
    },
    learn(values) { if (Array.isArray(values)) for (const v of values) learn(v); dirty = true; return true; },
    // #360: a secret the run itself read mid-run (a cmd: secret source): masked from now on, whatever its length.
    add(values) { if (Array.isArray(values)) for (const v of values) if (typeof v === "string" && v.trim() !== "" && !SECRETS.includes(v)) SECRETS.push(v); dirty = true; return true; },
    learned() { return LEARNED.slice(); },
    highlight(el) { highlightEl = el || null; try { update(); } catch (e) { /* presentation only */ } return highlightEl !== null; },
    clearHighlight() { highlightEl = null; try { update(); } catch (e) { /* presentation only */ } return true; },
  };
  Object.defineProperty(window, cfg.name, { value: Object.freeze(api), enumerable: false, configurable: false, writable: false });
  raf(tick);
  return true;
})(__CFG__)`;

/** #471: the jz-mask-v1 fills — masked, placeholder, left out (opaque, never a page colour by intent). */
export const JZ_MASK_FILLS: Readonly<Record<JzRegionKind, string>> = { mask: "#4B5563", placeholder: "#9CA3AF", block: "#E5E7EB" };

/** #471: a jz-mask-v1 capture could not be proven: that screenshot is left out (and the demo's video with it). */
export class JzMaskUnprovenError extends Error {
  readonly code = "E_JZ_MASK" as const;
  constructor(message: string) {
    super(message);
    this.name = "JzMaskUnprovenError";
  }
}

/** Bound on one mask round-trip (ms). */
const MASK_CALL_MS = 5_000;

async function within<T>(p: Promise<T>, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<T>((_, reject) => {
        timer = clock.setTimeout(() => reject(new MaskUnavailableError(`${what} timed out after ${MASK_CALL_MS}ms`)), MASK_CALL_MS);
      }),
    ]);
  } finally {
    if (timer !== undefined) clock.clearTimeout(timer);
  }
}

function errText(e: unknown): string {
  return (e instanceof Error ? e.message : String(e)).split("\n")[0] ?? "unknown error";
}

type MaskApi = {
  verify(): MaskCheck;
  learn(values: string[]): boolean;
  add(values: string[]): boolean;
  learned(): string[];
  highlight(e: Element): boolean;
  clearHighlight(): boolean;
};

/**
 * One run's pixel mask over its registered secrets (raw and URL-encoded forms, as `redactText`).
 * `install` (per browser context, before its first navigation — every later document and frame gets
 * it from an init script) keeps a VIDEO masked; `verify`/`layer()` prove it at each capture and
 * `assertMasked` throws {@link MaskUnavailableError} when it cannot be proven. With no secrets there
 * is nothing to mask: `verify` is trivially ok and nothing is injected for it.
 */
export class SecretPixelMask {
  readonly #source: string;
  readonly #name: string;
  readonly #contexts = new WeakSet<BrowserContext>();
  /** The contexts the mask is installed in, to reach their frames when a secret is added mid-run (#360). */
  readonly #installed = new Set<BrowserContext>();
  /** #360: secrets the run read mid-run (a cmd: source), every form — in memory only, never written. */
  readonly #added = new Set<string>();
  /** Secrets the app revealed mid-run (#298), learned by the page mask — in memory only, never written. */
  readonly #learned = new Set<string>();
  /**
   * Always true (#298): even with no registered secret, a secret the app reveals mid-run (a marked
   * element, a credential-shaped value) is masked, so every capture installs and proves the mask.
   */
  readonly active: boolean = true;

  /** #471: the mask also enforces jz-mask-v1 on the top document (fields, editables, embeds, marked regions). */
  readonly jzMaskV1: boolean;
  /** #471: frames of a top document the jz layer could not prove (reported live by the page). */
  readonly #jzBreaches = new Set<string>();

  constructor(secrets: readonly string[], opts: { readonly jzMaskV1?: boolean } = {}) {
    const forms = [...new Set(secrets.filter((s) => typeof s === "string" && s.trim() !== "").flatMap((s) => [...secretForms(s)]))];
    this.#name = `__jevitateMask_${randomBytes(8).toString("hex")}`;
    this.jzMaskV1 = opts.jzMaskV1 === true;
    // JSON inside a JS expression (valid JS since ES2019); `<` escaped so no value can close a script context.
    const cfg = JSON.stringify({
      name: this.#name,
      secrets: forms,
      shapes: REVEALED_SECRET_SHAPES,
      markers: REVEALED_SECRET_SELECTORS,
      fill: PIXEL_MASK_COLOR,
      attr: PIXEL_MASK_ATTR,
      overlayAttr: DEMO_OVERLAY_ATTR,
      jz: this.jzMaskV1,
      jzFill: JZ_MASK_FILLS,
      report: `${this.#name}_jz`,
    }).replace(/</g, "\\u003c");
    this.#source = MASK_RUNTIME.replace("__CFG__", () => cfg);
  }

  /** Installs the live mask in `page`'s context (every future document/frame) and every current frame. Throws when it cannot. */
  async install(page: Page): Promise<void> {
    const ctx = page.context();
    if (!this.#contexts.has(ctx)) {
      try {
        // #471: a frame the jz layer cannot prove is reported as it happens (a document may be gone by the next check).
        if (this.jzMaskV1) {
          await within(
            ctx.exposeBinding(`${this.#name}_jz`, ({ frame }: { frame: Frame }, reason: unknown) => {
              if (frame === frame.page().mainFrame()) this.#jzBreaches.add(String(reason).slice(0, 200));
            }),
            "installing the jz-mask-v1 report",
          );
        }
        await within(ctx.addInitScript({ content: this.#source }), "installing the pixel mask");
        // #471: reduced motion, so a site's smooth scrolling and motion (which can move a region
        // on the compositor between two checked frames, voiding the video) mostly stays off.
        if (this.jzMaskV1) for (const p of ctx.pages()) await within(p.emulateMedia({ reducedMotion: "reduce" }), "emulating reduced motion");
      } catch (e) {
        throw new MaskUnavailableError(`could not install the pixel mask: ${errText(e)}`);
      }
      this.#contexts.add(ctx);
      this.#installed.add(ctx);
      ctx.once("close", () => this.#installed.delete(ctx));
      // A secret added before this context existed (#360) is masked in its documents from the first paint.
      if (this.#added.size > 0) await this.#addInitScript(ctx, [...this.#added]);
    }
    for (const p of ctx.pages()) for (const f of p.frames()) await this.#inject(f);
  }

  async #inject(frame: Frame): Promise<void> {
    if (frame.isDetached()) return;
    try {
      await within(frame.evaluate(this.#source), "injecting the pixel mask");
    } catch (e) {
      if (frame.isDetached()) return;
      throw new MaskUnavailableError(`could not apply the pixel mask to a frame: ${errText(e)}`);
    }
  }

  /**
   * #360: masks `value` from now on — a secret the run read mid-run (a `cmd:` secret source), so it
   * never had a place in the constructor's list. Every installed context gets it for its future
   * documents (an init script) and every current frame at once; each capture re-syncs it before it
   * proves the mask. Call it before the value is typed, so no frame shows it unmasked. Throws
   * {@link MaskUnavailableError} when a live frame cannot take it (the capture then fails closed).
   */
  async addSecret(value: string): Promise<void> {
    const fresh = [...secretForms(value)].filter((f) => f.trim() !== "" && !this.#added.has(f));
    if (fresh.length === 0) return;
    for (const f of fresh) this.#added.add(f);
    for (const ctx of this.#installed) {
      await this.#addInitScript(ctx, fresh);
      for (const p of ctx.pages()) for (const frame of p.frames()) await this.#addTo(frame, fresh);
    }
  }

  async #addInitScript(ctx: BrowserContext, values: readonly string[]): Promise<void> {
    // JSON inside a JS expression; `<` escaped as for the runtime's own config.
    const args = JSON.stringify([this.#name, values]).replace(/</g, "\\u003c");
    try {
      await within(ctx.addInitScript({ content: `((a) => { const api = window[a[0]]; if (api) api.add(a[1]); })(${args})` }), "adding a secret to the pixel mask");
    } catch (e) {
      throw new MaskUnavailableError(`could not add a secret to the pixel mask: ${errText(e)}`);
    }
  }

  async #addTo(frame: Frame, values: readonly string[]): Promise<void> {
    if (frame.isDetached()) return;
    try {
      await within(
        frame.evaluate(
          ([name, vals]: [string, string[]]) => (window as unknown as Record<string, MaskApi | undefined>)[name]?.add(vals) ?? false,
          [this.#name, [...values]] as [string, string[]],
        ),
        "adding a secret to the pixel mask",
      );
    } catch (e) {
      if (frame.isDetached()) return;
      throw new MaskUnavailableError(`could not add a secret to the pixel mask in a frame: ${errText(e)}`);
    }
  }

  /**
   * The secrets the app revealed during the run (#298), as learned so far — for redacting what the
   * run writes about its captures (the screenshot index). Never persisted.
   */
  revealed(): readonly string[] {
    return [...this.#learned];
  }

  /** Shares what the run learned with `frame`'s mask, and collects what that frame learned. */
  async #sync(frame: Frame): Promise<void> {
    const learned = await within(
      frame.evaluate(
        ([name, known, added]: [string, string[], string[]]) => {
          const api = (window as unknown as Record<string, MaskApi | undefined>)[name];
          if (api === undefined) return null;
          api.learn(known);
          api.add(added);
          return api.learned();
        },
        [this.#name, [...this.#learned], [...this.#added]] as [string, string[], string[]],
      ),
      "syncing the pixel mask",
    );
    for (const v of learned ?? []) this.#learned.add(v);
  }

  /** Proves the mask covers every visible secret occurrence in every frame of `page`, now. */
  async verify(page: Page): Promise<MaskCheck> {
    const known = this.#learned.size;
    const r = await this.#verifyOnce(page);
    // A secret one frame revealed (learned this pass) is re-checked in every frame once (#298).
    return this.#learned.size > known ? this.#verifyOnce(page) : r;
  }

  async #verifyOnce(page: Page): Promise<MaskCheck> {
    let occurrences = 0;
    let masked = 0;
    let rects: MaskCheck["rects"] = [];
    let jz: JzMaskCheck | undefined;
    const reasons: string[] = [];
    for (const frame of page.frames()) {
      if (frame.isDetached()) continue;
      try {
        await this.#inject(frame);
        await this.#sync(frame);
        const r = await within(
          frame.evaluate((name: string) => (window as unknown as Record<string, MaskApi | undefined>)[name]?.verify() ?? null, this.#name),
          "verifying the pixel mask",
        );
        if (r === null) {
          reasons.push("the mask is not installed in a frame");
          continue;
        }
        occurrences += r.occurrences;
        masked += r.masked;
        if (frame === page.mainFrame()) {
          rects = r.rects;
          if (r.jz !== undefined) {
            jz = r.jz;
            if (r.jz.breach !== "") this.#jzBreaches.add(r.jz.breach);
          }
        }
        if (!r.ok) reasons.push(r.reason ?? "the mask could not be proven");
        await this.#sync(frame);
      } catch (e) {
        if (frame.isDetached()) continue;
        reasons.push(errText(e));
      }
    }
    if (this.jzMaskV1 && jz === undefined) {
      jz = { ok: false, regions: 0, rects: [], viewport: { width: 0, height: 0 }, reason: `the jz-mask-v1 layer is not running in the page${reasons.length === 0 ? "" : `: ${reasons.join("; ")}`}`, breach: "" };
    }
    return { ok: reasons.length === 0, occurrences, masked, rects, ...(reasons.length === 0 ? {} : { reason: reasons.join("; ") }), ...(jz === undefined ? {} : { jz }) };
  }

  /** Throws {@link MaskUnavailableError} unless {@link verify} proves the mask. */
  async assertMasked(page: Page): Promise<MaskCheck> {
    const r = await this.verify(page);
    if (!r.ok) throw new MaskUnavailableError(`secret masking could not be proven: ${r.reason ?? "unknown"}`);
    return r;
  }

  /** The capture layer: proven before the screenshot and again after it (a failure deletes the file). */
  layer(): CaptureLayer {
    return {
      name: "secret-pixel-mask",
      prepare: async (page) => {
        await this.assertMasked(page);
      },
      confirm: async (page) => {
        await this.assertMasked(page);
      },
    };
  }

  /**
   * #471: what the jz layer could not prove in a top document during the run, in order — a video
   * recorded over such a frame is never exported. Empty when every frame was proven (or jz is off).
   */
  jzBreaches(): readonly string[] {
    return [...this.#jzBreaches];
  }

  /**
   * #471: the jz-mask-v1 capture layer (method `dom-before-capture`: the regions are painted over in
   * the page, before the screenshot). Fails closed with {@link JzMaskUnprovenError}, which leaves out
   * that screenshot — never the run. Proof per capture:
   *  1. before: the live layer proves every region covered by a box, nothing in the top layer, no
   *     closed shadow root it cannot see into (Chromium DevTools protocol, the page's own roots only);
   *  2. after: the same regions at the same places (nothing moved in between), and every pixel of
   *     every region in the written PNG is one of the jz-mask-v1 / secret fills.
   * `regions(step)` is the proven region count of that step's capture.
   */
  jzLayer(): CaptureLayer & { regions(step: number): number | undefined } {
    const before = new Map<number, JzMaskCheck>();
    const proven = new Map<number, number>();
    const fail = (step: number, why: string): never => {
      throw new JzMaskUnprovenError(`step ${step}: jz-mask-v1 could not be proven: ${why}`);
    };
    return {
      name: "jz-mask-v1",
      regions: (step) => proven.get(step),
      prepare: async (page, ctx) => {
        proven.delete(ctx.step);
        if (!this.jzMaskV1) fail(ctx.step, "the mask was made without jz-mask-v1");
        const r = await this.verify(page);
        if (r.jz === undefined || !r.jz.ok) fail(ctx.step, r.jz?.reason ?? "no proof");
        const hidden = await closedShadowRoots(page);
        if (hidden !== 0) fail(ctx.step, hidden < 0 ? "the page's shadow roots could not be inspected" : `${hidden} closed shadow root(s) it cannot see into`);
        before.set(ctx.step, r.jz as JzMaskCheck);
      },
      confirm: async (page, ctx, shot) => {
        const first = before.get(ctx.step);
        before.delete(ctx.step);
        if (first === undefined) return fail(ctx.step, "no proof before the capture");
        if (shot === undefined || shot.clip !== undefined) return fail(ctx.step, "only a whole-viewport capture can be pixel-checked");
        const r = await this.verify(page);
        if (r.jz === undefined || !r.jz.ok) return fail(ctx.step, r.jz?.reason ?? "no proof after the capture");
        if (!sameRegions(first, r.jz)) return fail(ctx.step, "a region moved or changed during the capture");
        const problem = jzPixelProblem(await readFile(shot.path), first);
        if (problem !== null) return fail(ctx.step, problem);
        proven.set(ctx.step, first.regions);
      },
    };
  }

  /** Draws a capture highlight box around `target`'s first match (display-only). True when shown. */
  async highlight(page: Page, target: TargetDescriptor): Promise<boolean> {
    return this.highlightLocator(page, descriptorToLocator(page, target));
  }

  /** #198: the same display-only highlight box around `locator`'s first match (a control or a quoted text). */
  async highlightLocator(page: Page, locator: Locator): Promise<boolean> {
    try {
      await this.#inject(page.mainFrame());
      return await within(
        locator.first().evaluate((el, name) => (window as unknown as Record<string, MaskApi | undefined>)[name]?.highlight(el) === true, this.#name, { timeout: 2_000 }),
        "highlighting the failing element",
      );
    } catch {
      return false; // a highlight is presentation only
    }
  }

  /** Removes the capture highlight (best-effort). */
  async clearHighlight(page: Page): Promise<void> {
    await within(
      page.evaluate((name: string) => (window as unknown as Record<string, MaskApi | undefined>)[name]?.clearHighlight(), this.#name),
      "clearing the highlight",
    ).catch(() => undefined);
  }
}

/**
 * A port whose every session carries the live pixel mask from before its first navigation — so a
 * `recordVideo` session's every frame is masked. A session whose mask cannot be installed is closed
 * and the open throws {@link MaskUnavailableError}: nothing is recorded unmasked.
 */
export function maskingPort(port: BrowserPort, mask: SecretPixelMask): BrowserPort {
  if (!mask.active) return port;
  return {
    open: async (o) => {
      const session = await port.open(o);
      try {
        await mask.install(session.page);
      } catch (e) {
        await session.close().catch(() => undefined);
        throw e;
      }
      return session;
    },
  };
}

// ── #471: jz-mask-v1 proof helpers ──────────────────────────────────────────────────────────────

/** Same regions, same kinds, same places (within half a CSS pixel). */
function sameRegions(a: JzMaskCheck, b: JzMaskCheck): boolean {
  if (a.rects.length !== b.rects.length) return false;
  const close = (x: number, y: number): boolean => Math.abs(x - y) <= 0.5;
  return a.rects.every((r, i) => {
    const o = b.rects[i];
    return o !== undefined && o.kind === r.kind && close(o.x, r.x) && close(o.y, r.y) && close(o.width, r.width) && close(o.height, r.height);
  });
}

function hexRgb(hex: string): readonly [number, number, number] {
  const n = Number.parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** Every fill a mask box can have: the jz-mask-v1 kinds and the secret mask (boxes may overlap). */
const MASK_FILLS_RGB = [...Object.values(JZ_MASK_FILLS), PIXEL_MASK_COLOR].map(hexRgb);

/**
 * Why `png` (a whole-viewport capture) does not show a mask fill on every pixel inside every region
 * of `check`, or null. Regions are in CSS pixels; the image is the viewport at the device scale.
 */
export function jzPixelProblem(png: Buffer, check: Pick<JzMaskCheck, "rects" | "viewport">): string | null {
  let img: ReturnType<typeof decodePng>;
  try {
    img = decodePng(png);
  } catch (e) {
    return `the capture could not be decoded: ${errText(e)}`;
  }
  if (check.rects.length === 0) return null;
  if (!(check.viewport.width > 0)) return "the viewport size is unknown";
  const scale = img.width / check.viewport.width;
  let bad = 0;
  for (const r of check.rects) {
    const x0 = Math.max(0, Math.ceil(r.x * scale));
    const y0 = Math.max(0, Math.ceil(r.y * scale));
    const x1 = Math.min(img.width, Math.floor((r.x + r.width) * scale));
    const y1 = Math.min(img.height, Math.floor((r.y + r.height) * scale));
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        const i = (y * img.width + x) * 4;
        const [pr, pg, pb, pa] = [img.rgba[i]!, img.rgba[i + 1]!, img.rgba[i + 2]!, img.rgba[i + 3]!];
        if (pa !== 255 || !MASK_FILLS_RGB.some(([fr, fg, fb]) => fr === pr && fg === pg && fb === pb)) bad++;
      }
    }
  }
  return bad === 0 ? null : `${bad} pixel(s) inside jz-mask-v1 regions are not a mask fill`;
}

interface CdpNode {
  readonly localName?: string;
  readonly attributes?: readonly string[];
  readonly children?: readonly CdpNode[];
  readonly shadowRoots?: ReadonlyArray<CdpNode & { readonly shadowRootType?: string }>;
  readonly contentDocument?: CdpNode;
}

/**
 * #471: closed shadow roots in the top document that are not jevitate's own layers — content the
 * jz layer cannot see into, so it cannot prove a field there masked. -1 when the page cannot be
 * inspected (not Chromium, a protocol failure): unprovable. Frames below (contentDocument) are
 * skipped: each is covered whole by a placeholder.
 */
export async function closedShadowRoots(page: Page): Promise<number> {
  let session: Awaited<ReturnType<BrowserContext["newCDPSession"]>> | undefined;
  try {
    session = await within(page.context().newCDPSession(page), "inspecting shadow roots");
    const { root } = (await within(session.send("DOM.getDocument", { depth: -1, pierce: true }), "inspecting shadow roots")) as { root: CdpNode };
    let closed = 0;
    const ours = (n: CdpNode): boolean => {
      const a = n.attributes ?? [];
      for (let i = 0; i < a.length; i += 2) if (a[i] === PIXEL_MASK_ATTR || a[i] === DEMO_OVERLAY_ATTR) return true;
      return false;
    };
    const stack: CdpNode[] = [root];
    while (stack.length > 0) {
      const n = stack.pop()!;
      for (const sr of n.shadowRoots ?? []) {
        if (sr.shadowRootType === "closed" && !ours(n)) closed++;
        stack.push(sr);
      }
      for (const c of n.children ?? []) stack.push(c);
    }
    return closed;
  } catch {
    return -1;
  } finally {
    await session?.detach().catch(() => undefined);
  }
}
