import type { Page } from "playwright";
import type { TargetDescriptor } from "@jevitate/recording";
import { descriptorToLocator } from "@jevitate/recorder";
import type { Control } from "./snapshot.js";
import { redactText } from "./redact.js";

/**
 * #245 — the demo overlay: an on-page panel that shows an audience what jevitate is about to do and
 * why (step, strategy, op + target, reason), a brief highlight box around the target just before
 * the action, and a final outcome banner. Opt-in (`demoOverlay: true`); absent/false injects NOTHING.
 * `journey demo` (#248) drives the same overlay with captions (a step's objective) and cards (the
 * Journey's goal as a title card, the outcome at the end).
 *
 * INVISIBLE TO JEVITATE, by construction (one central exclusion, not per-reader special cases):
 *  - everything renders inside a CLOSED shadow root, so no DOM reader (`querySelectorAll`,
 *    Playwright CSS/role/text selectors — they pierce only OPEN roots) can reach its content;
 *  - the host is a custom `<jevitate-overlay data-jevitate-overlay>` element appended to
 *    `<html>`, OUTSIDE `<body>`: it has no light-DOM children or text, matches no control selector,
 *    and is not part of `body.innerText` (visible text, reply waits, answers, page status);
 *  - the host is `aria-hidden` + `inert` (out of the accessibility tree, never focusable) and it and
 *    every shadow element are `pointer-events: none` — never a hit target for `elementFromPoint`,
 *    Playwright's actionability hit-test, or a click; the host box is 0×0 (no overflow, no occlusion);
 *  - its later updates happen INSIDE the shadow root, which a document `MutationObserver` does not
 *    see (settle/quiet windows are unaffected); the highlight follows its target with
 *    `requestAnimationFrame` + a CSS fade — never a page timer (the page monitor wraps `setTimeout`);
 *  - screenshots hide it with {@link DEMO_OVERLAY_HIDE_STYLE} (Playwright's `screenshot({ style })`).
 * All text is redacted with the run's secrets before it reaches the page, and set via `textContent`.
 * Every overlay call is best-effort and bounded: a failure never changes the run.
 */

/** The attribute marking the overlay's host element. */
export const DEMO_OVERLAY_ATTR = "data-jevitate-overlay";

/** CSS that hides the overlay; pass as `page.screenshot({ style })` so captures never contain it. */
export const DEMO_OVERLAY_HIDE_STYLE = `[${DEMO_OVERLAY_ATTR}]{display:none !important;visibility:hidden !important}`;

/** How long the target is highlighted before the action is dispatched (ms). */
export const DEMO_HIGHLIGHT_MS = 400;

/** Bound on any one overlay round-trip (ms): the overlay never holds a run up. */
const OVERLAY_CALL_MS = 1_500;

/** What the panel says: the step about to run and why. */
export interface DemoOverlayIntent {
  readonly step: number;
  /** The strategy driving the step, e.g. `goal`, `coverage`, `adversarial:empty-submit`. */
  readonly strategy: string;
  readonly op: string;
  /** The target's accessible name (or summary), when the op has one. */
  readonly target?: string | null;
  /** Why this step (the goal, the strategy's note). */
  readonly why?: string | null;
}

interface PanelState {
  readonly head: string;
  readonly action: string;
  readonly target: string;
  readonly why: string;
}

/** A card's look: `title` (the Journey goal, #248), `ok` / `bad` (the outcome). */
export type DemoCardTone = "title" | "ok" | "bad";

interface BannerState {
  readonly text: string;
  readonly tone: DemoCardTone;
}

/** A narrated caption (#248): a small heading (e.g. `step 2 of 5`), the caption, an optional detail line. */
export interface DemoCaption {
  readonly head: string;
  readonly text: string;
  readonly detail?: string | null;
}

/**
 * BROWSER CODE (a string: evaluated as-is, never transpiled). Idempotent per document: installs
 * `window.__jevitateOverlay` (non-enumerable); the host element is created lazily on first use.
 */
const OVERLAY_RUNTIME = String.raw`(() => {
  if (window.__jevitateOverlay) return;
  const CSS = ":host{all:initial}" +
    "*{pointer-events:none !important;box-sizing:border-box}" +
    "[hidden]{display:none !important}" +
    ".panel{position:fixed;right:16px;bottom:16px;max-width:min(380px,calc(100vw - 32px));padding:10px 14px;border-radius:10px;" +
    "background:rgba(17,24,39,.92);color:#f9fafb;font:13px/1.45 system-ui,-apple-system,Segoe UI,sans-serif;box-shadow:0 6px 24px rgba(0,0,0,.35)}" +
    ".head{font-size:11px;letter-spacing:.04em;text-transform:uppercase;color:#93c5fd;margin-bottom:4px}" +
    ".act b{color:#fde68a;font-weight:600}.why{color:#d1d5db;margin-top:2px}" +
    ".box{position:fixed;border:3px solid #f59e0b;border-radius:6px;box-shadow:0 0 0 4px rgba(245,158,11,.25);animation:jev-fade 2.2s ease-out forwards}" +
    "@keyframes jev-fade{0%,70%{opacity:1}100%{opacity:0}}" +
    ".banner{position:fixed;left:50%;top:16px;transform:translateX(-50%);max-width:calc(100vw - 32px);padding:10px 18px;border-radius:10px;" +
    "font:600 14px/1.4 system-ui,-apple-system,Segoe UI,sans-serif;color:#fff;background:rgba(21,128,61,.94);box-shadow:0 6px 24px rgba(0,0,0,.35)}" +
    ".banner.bad{background:rgba(185,28,28,.94)}.banner.title{background:rgba(30,58,138,.94);font-size:18px;padding:14px 22px}";
  let host = null;
  let parts = null;
  let tracking = 0;
  const ensure = () => {
    if (host !== null && host.isConnected && parts !== null) return parts;
    const root = document.documentElement;
    if (!root) return null;
    host = document.createElement("jevitate-overlay");
    host.setAttribute("${DEMO_OVERLAY_ATTR}", "");
    host.setAttribute("aria-hidden", "true");
    host.setAttribute("inert", "");
    // Never display/visibility (nor all) inline-important: the capture style must be able to hide it.
    const st = { position: "fixed", top: "0", left: "0", width: "0", height: "0",
      overflow: "visible", "pointer-events": "none", "z-index": "2147483647" };
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
    const mk = (cls) => { const d = document.createElement("div"); d.className = cls; d.hidden = true; shadow.appendChild(d); return d; };
    const panel = mk("panel");
    const head = document.createElement("div"); head.className = "head";
    const act = document.createElement("div"); act.className = "act";
    const verb = document.createElement("span");
    const target = document.createElement("b");
    act.append(verb, target);
    const why = document.createElement("div"); why.className = "why";
    panel.append(head, act, why);
    parts = { panel, head, verb, target, why, box: mk("box"), banner: mk("banner") };
    root.appendChild(host);
    return parts;
  };
  const api = {
    panel(s) {
      const p = ensure();
      if (p === null) return false;
      p.head.textContent = s.head;
      p.verb.textContent = s.action + (s.target === "" ? "" : " ");
      p.target.textContent = s.target === "" ? "" : "“" + s.target + "”";
      p.why.textContent = s.why === "" ? "" : "— " + s.why;
      p.why.hidden = s.why === "";
      p.panel.hidden = false;
      p.box.hidden = true;
      p.banner.hidden = true; // a new step replaces a card (the title card, #248)
      return true;
    },
    track(el) {
      const p = ensure();
      if (p === null || !el) return false;
      const id = ++tracking;
      const box = p.box;
      box.hidden = true;
      box.style.animation = "none";
      void box.offsetWidth;
      box.style.animation = "";
      const until = performance.now() + 2200;
      const place = () => {
        if (id !== tracking || !el.isConnected || performance.now() > until) { if (id === tracking) box.hidden = true; return; }
        const r = el.getBoundingClientRect();
        box.style.left = (r.left - 5) + "px";
        box.style.top = (r.top - 5) + "px";
        box.style.width = (r.width + 10) + "px";
        box.style.height = (r.height + 10) + "px";
        box.hidden = r.width === 0 && r.height === 0;
        requestAnimationFrame(place);
      };
      place();
      return true;
    },
    banner(s) {
      const p = ensure();
      if (p === null) return false;
      tracking++;
      p.box.hidden = true;
      p.banner.textContent = s.text;
      p.banner.className = s.tone === "ok" ? "banner" : "banner " + s.tone;
      p.banner.hidden = false;
      return true;
    },
  };
  Object.defineProperty(window, "__jevitateOverlay", { value: api, enumerable: false, configurable: false });
})()`;

const VERBS: Readonly<Record<string, string>> = {
  click: "click",
  type: "type into",
  send: "send a message in",
  select: "choose an option in",
  upload: "upload a file to",
  edit_text: "edit",
  scroll_down: "scroll down",
  scroll_up: "scroll up",
  wait: "wait for the page",
  reload: "reload the page",
};

function cut(s: string, n: number): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length <= n ? t : `${t.slice(0, n - 1)}…`;
}

async function bounded<T>(p: Promise<T>): Promise<T | undefined> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<undefined>((r) => {
        timer = setTimeout(() => r(undefined), OVERLAY_CALL_MS);
      }),
    ]);
  } catch {
    return undefined; // best-effort display only: an overlay failure never changes the run
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * One run's overlay. Create with {@link demoOverlayFor} (null when disabled); every call is
 * best-effort and bounded, and re-applies the latest panel/banner after each navigation.
 */
export class DemoOverlay {
  readonly #secrets: readonly string[];
  readonly #pages = new WeakSet<Page>();
  #panel: PanelState | null = null;
  #banner: BannerState | null = null;
  #lastPage: Page | null = null;

  constructor(secrets: readonly string[]) {
    this.#secrets = secrets;
  }

  #clean(s: string, n: number): string {
    return cut(redactText(s, this.#secrets), n);
  }

  /** The (redacted) panel text for an intent — what the page is shown. */
  panelFor(intent: DemoOverlayIntent): PanelState {
    const target = intent.target === undefined || intent.target === null ? "" : this.#clean(intent.target, 80);
    return {
      head: this.#clean(`jevitate · step ${intent.step} · ${intent.strategy}`, 80),
      action: VERBS[intent.op] ?? this.#clean(intent.op, 40),
      target,
      why: intent.why === undefined || intent.why === null ? "" : this.#clean(intent.why, 200),
    };
  }

  #watch(page: Page): void {
    if (this.#pages.has(page)) return;
    this.#pages.add(page);
    // Re-applied across navigations: a new document gets the latest panel/banner back.
    page.on("domcontentloaded", () => {
      void this.#render(page);
    });
  }

  async #render(page: Page): Promise<void> {
    const panel = this.#panel;
    const banner = this.#banner;
    if (panel === null && banner === null) return;
    await bounded(
      (async () => {
        // A string expression (CDP `Runtime.evaluate`): installs the runtime once per document.
        await page.evaluate(OVERLAY_RUNTIME);
        await page.evaluate(
          ([p, b]) => {
            const api = (window as unknown as { __jevitateOverlay?: { panel(s: unknown): boolean; banner(s: unknown): boolean } }).__jevitateOverlay;
            if (api === undefined) return false;
            if (p !== null) api.panel(p);
            if (b !== null) api.banner(b);
            return true;
          },
          [panel, banner] as const,
        );
      })(),
    );
  }

  /**
   * Shows what is about to happen; with a target control, highlights it and waits
   * {@link DEMO_HIGHLIGHT_MS} so the audience sees it before the action is dispatched.
   */
  async announce(page: Page, intent: DemoOverlayIntent, control: Control | null = null): Promise<void> {
    this.#watch(page);
    this.#lastPage = page;
    this.#panel = this.panelFor(intent);
    this.#banner = null;
    await this.#render(page);
    if (control === null) return;
    if (await this.#highlight(page, control.descriptor)) await new Promise((r) => setTimeout(r, DEMO_HIGHLIGHT_MS));
  }

  /** Boxes the element `descriptor` finds (its first match); true when it was shown. */
  async #highlight(page: Page, descriptor: TargetDescriptor): Promise<boolean> {
    const shown = await bounded(
      descriptorToLocator(page, descriptor)
        .first()
        .evaluate(
          (el) => (window as unknown as { __jevitateOverlay?: { track(e: Element): boolean } }).__jevitateOverlay?.track(el) === true,
          undefined,
          { timeout: OVERLAY_CALL_MS },
        ),
    );
    return shown === true;
  }

  /** The (redacted) panel text for a caption — what the page is shown. */
  captionFor(caption: DemoCaption): PanelState {
    return {
      head: this.#clean(caption.head, 80),
      action: this.#clean(caption.text, 240),
      target: "",
      why: caption.detail === undefined || caption.detail === null ? "" : this.#clean(caption.detail, 200),
    };
  }

  /**
   * #248: shows a narrated caption (replacing any card) and, with a `target`, highlights it. The
   * caller paces the step; this never waits beyond its bounded round-trips. True when highlighted.
   */
  async caption(page: Page, caption: DemoCaption, target: TargetDescriptor | null = null): Promise<boolean> {
    this.#watch(page);
    this.#lastPage = page;
    this.#panel = this.captionFor(caption);
    this.#banner = null;
    await this.#render(page);
    return target === null ? false : this.#highlight(page, target);
  }

  /** #248: a card over the page — the Journey's goal as a title card, or the outcome. */
  async card(page: Page, text: string, tone: DemoCardTone): Promise<void> {
    if (page.isClosed()) return;
    this.#watch(page);
    this.#lastPage = page;
    this.#banner = { text: this.#clean(text, 200), tone };
    await this.#render(page);
  }

  /** Re-applies the latest caption/card now (e.g. right after a navigation, before a capture). */
  async refresh(page: Page): Promise<void> {
    if (!page.isClosed()) await this.#render(page);
  }

  /** The final banner with the run's outcome — on `page`, else the page last announced on. */
  async finish(text: string, ok: boolean, page: Page | null = this.#lastPage): Promise<void> {
    if (page === null || page.isClosed()) return;
    this.#watch(page);
    this.#banner = { text: this.#clean(text, 200), tone: ok ? "ok" : "bad" };
    await this.#render(page);
  }
}

/** The run's overlay when `demoOverlay` is on — else null, and nothing is ever injected. */
export function demoOverlayFor(enabled: boolean | undefined, secrets: readonly string[]): DemoOverlay | null {
  return enabled === true ? new DemoOverlay(secrets) : null;
}
