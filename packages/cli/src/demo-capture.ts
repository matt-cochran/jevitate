import { randomBytes } from "node:crypto";
import { rm } from "node:fs/promises";
import type { BrowserContext, Frame, Locator, Page } from "playwright";
import { REVEALED_SECRET_SELECTORS, REVEALED_SECRET_SHAPES, revealedSecretsIn, secretForms } from "@jevitate/ai-core";
import { DEMO_OVERLAY_HIDE_STYLE } from "@jevitate/explore";
import { descriptorToLocator } from "@jevitate/recorder";
import type { TargetDescriptor } from "@jevitate/recording";
import type { BrowserPort } from "@jevitate/playwright";

/**
 * #248 — the ONE place a demo screenshot is taken. The overlay is always hidden (Playwright's
 * `screenshot({ style })`, applied only for the capture: the page's DOM is never touched), and the
 * capture is built from LAYERS so later safety passes plug in without touching the callers: pixel
 * masking of secret fields (#250/#251) is a layer contributing `mask` locators and/or extra `style`.
 * A layer cannot drop the overlay-hiding style: styles are concatenated, never replaced.
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
  confirm?(page: Page, ctx: CaptureContext): Promise<void>;
}

/** The screenshot options a set of layers produces (the overlay-hiding style always first). */
export async function captureOptions(
  page: Page,
  ctx: CaptureContext,
  layers: readonly CaptureLayer[],
): Promise<{ style: string; mask: Locator[]; maskColor?: string }> {
  const styles = [DEMO_OVERLAY_HIDE_STYLE];
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
  const { style, mask, maskColor } = await captureOptions(page, ctx, layers);
  await page.screenshot({
    path,
    type: "png",
    animations: "disabled",
    style,
    ...(clip === undefined ? {} : { clip: { ...clip } }),
    ...(mask.length === 0 ? {} : { mask }),
    ...(maskColor === undefined ? {} : { maskColor }),
  });
  try {
    for (const layer of layers) await layer.confirm?.(page, ctx);
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
  const CSS = ":host{all:initial}*{pointer-events:none !important;box-sizing:border-box}[hidden]{display:none !important}" +
    ".m{position:fixed;background:" + cfg.fill + ";border-radius:2px}" +
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
    while (boxes.length < rects.length) {
      const d = document.createElement("div");
      d.className = "m";
      layer.appendChild(d);
      boxes.push(d);
    }
    for (let i = 0; i < boxes.length; i++) {
      const d = boxes[i];
      if (i < rects.length) { place(d, rects[i], PAD); d.hidden = false; } else d.hidden = true;
    }
    drawn = rects;
    if (highlightEl !== null && highlightEl.isConnected) {
      place(hiBox, highlightEl.getBoundingClientRect(), 5);
      hiBox.hidden = false;
    } else hiBox.hidden = true;
  };
  const tick = () => {
    try { update(); lastError = ""; } catch (e) { lastError = String((e && e.message) || e).slice(0, 200); }
    requestAnimationFrame(tick);
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
  const covers = (b, r) => b.left <= r.left + 0.5 && b.top <= r.top + 0.5 && b.right >= r.right - 0.5 && b.bottom >= r.bottom - 0.5;
  const api = {
    verify() {
      dirty = true;
      try { update(); } catch (e) {
        return { ok: false, occurrences: 0, masked: 0, reason: "the mask update failed: " + String((e && e.message) || e).slice(0, 200), rects: [] };
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
      return out;
    },
    learn(values) { if (Array.isArray(values)) for (const v of values) learn(v); dirty = true; return true; },
    learned() { return LEARNED.slice(); },
    highlight(el) { highlightEl = el || null; try { update(); } catch (e) { /* presentation only */ } return highlightEl !== null; },
    clearHighlight() { highlightEl = null; try { update(); } catch (e) { /* presentation only */ } return true; },
  };
  Object.defineProperty(window, cfg.name, { value: Object.freeze(api), enumerable: false, configurable: false, writable: false });
  requestAnimationFrame(tick);
  return true;
})(__CFG__)`;

/** Bound on one mask round-trip (ms). */
const MASK_CALL_MS = 5_000;

async function within<T>(p: Promise<T>, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new MaskUnavailableError(`${what} timed out after ${MASK_CALL_MS}ms`)), MASK_CALL_MS);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function errText(e: unknown): string {
  return (e instanceof Error ? e.message : String(e)).split("\n")[0] ?? "unknown error";
}

type MaskApi = {
  verify(): MaskCheck;
  learn(values: string[]): boolean;
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
  /** Secrets the app revealed mid-run (#298), learned by the page mask — in memory only, never written. */
  readonly #learned = new Set<string>();
  /**
   * Always true (#298): even with no registered secret, a secret the app reveals mid-run (a marked
   * element, a credential-shaped value) is masked, so every capture installs and proves the mask.
   */
  readonly active: boolean = true;

  constructor(secrets: readonly string[]) {
    const forms = [...new Set(secrets.filter((s) => typeof s === "string" && s.trim() !== "").flatMap((s) => [...secretForms(s)]))];
    this.#name = `__jevitateMask_${randomBytes(8).toString("hex")}`;
    // JSON inside a JS expression (valid JS since ES2019); `<` escaped so no value can close a script context.
    const cfg = JSON.stringify({
      name: this.#name,
      secrets: forms,
      shapes: REVEALED_SECRET_SHAPES,
      markers: REVEALED_SECRET_SELECTORS,
      fill: PIXEL_MASK_COLOR,
      attr: PIXEL_MASK_ATTR,
    }).replace(/</g, "\\u003c");
    this.#source = MASK_RUNTIME.replace("__CFG__", () => cfg);
  }

  /** Installs the live mask in `page`'s context (every future document/frame) and every current frame. Throws when it cannot. */
  async install(page: Page): Promise<void> {
    const ctx = page.context();
    if (!this.#contexts.has(ctx)) {
      try {
        await within(ctx.addInitScript({ content: this.#source }), "installing the pixel mask");
      } catch (e) {
        throw new MaskUnavailableError(`could not install the pixel mask: ${errText(e)}`);
      }
      this.#contexts.add(ctx);
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
        ([name, known]: [string, string[]]) => {
          const api = (window as unknown as Record<string, MaskApi | undefined>)[name];
          if (api === undefined) return null;
          api.learn(known);
          return api.learned();
        },
        [this.#name, [...this.#learned]] as [string, string[]],
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
        if (frame === page.mainFrame()) rects = r.rects;
        if (!r.ok) reasons.push(r.reason ?? "the mask could not be proven");
        await this.#sync(frame);
      } catch (e) {
        if (frame.isDetached()) continue;
        reasons.push(errText(e));
      }
    }
    return { ok: reasons.length === 0, occurrences, masked, rects, ...(reasons.length === 0 ? {} : { reason: reasons.join("; ") }) };
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
