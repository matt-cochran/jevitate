import type { Locator, Page } from "playwright";

/**
 * The flash recorder (#148): a TRANSIENT visual state — a `.flash` class held for 800 ms, an
 * attribute toggled on and off, a CSS animation — is usually gone by the time the page settles and a
 * check reads it. This fixed, built-in page script (never a declared string) is installed BEFORE the
 * triggering action and records, per element, every class it GAINED, every attribute set on it and
 * every animation it started, with a timestamp — plus the time of the last trusted user input (a
 * pointer-down, key-down or click). A `flashed` check then asks, by code, whether a matching element
 * gained the state after that input (and within `withinMs` of it).
 *
 * It survives navigations (an init script) and is idempotent; a page without it answers
 * "not installed", which never holds.
 */

/** Bound on remembered entries: the oldest are dropped first. */
const MAX_ENTRIES = 5_000;

/** BROWSER CODE — installs the recorder once per document (init script and current document). */
export function flashRecorderScript(max: number): void {
  const w = window as unknown as Record<string, unknown>;
  if (w.__jevitateFlash !== undefined) return;
  interface Entry {
    el: Element;
    kind: "class" | "attr" | "animation";
    name: string;
    t: number;
  }
  const log: { lastInput: number | null; entries: Entry[] } = { lastInput: null, entries: [] };
  Object.defineProperty(window, "__jevitateFlash", { value: log, configurable: false, enumerable: false, writable: false });
  const push = (e: Entry): void => {
    log.entries.push(e);
    if (log.entries.length > max) log.entries.splice(0, log.entries.length - max);
  };
  const onInput = (ev: Event): void => {
    if (ev.isTrusted) log.lastInput = performance.now();
  };
  for (const type of ["pointerdown", "keydown", "click"]) window.addEventListener(type, onInput, true);
  document.addEventListener(
    "animationstart",
    (ev) => {
      if (ev.target instanceof Element) push({ el: ev.target, kind: "animation", name: (ev as AnimationEvent).animationName, t: performance.now() });
    },
    true,
  );
  const classes = (s: string | null): string[] => (s ?? "").split(/\s+/).filter((c) => c !== "");
  const observer = new MutationObserver((records) => {
    const t = performance.now();
    records.forEach((r, i) => {
      if (r.type === "childList") {
        r.addedNodes.forEach((n) => {
          if (n instanceof Element) for (const c of classes(n.getAttribute("class"))) push({ el: n, kind: "class", name: c, t });
        });
        return;
      }
      if (r.type !== "attributes" || !(r.target instanceof Element) || r.attributeName === null) return;
      const el = r.target;
      const name = r.attributeName;
      // The value this record changed TO: the next record's old value for the same attribute in this
      // batch, else the current value — so a class added and removed within one batch still counts.
      const next = records.slice(i + 1).find((q) => q.type === "attributes" && q.target === el && q.attributeName === name);
      const now = next === undefined ? el.getAttribute(name) : next.oldValue;
      if (name === "class") {
        const before = new Set(classes(r.oldValue));
        for (const c of classes(now)) if (!before.has(c)) push({ el, kind: "class", name: c, t });
      } else if (now !== null && now !== r.oldValue) {
        push({ el, kind: "attr", name, t });
      }
    });
  });
  observer.observe(document, { subtree: true, childList: true, attributes: true, attributeOldValue: true });
}

/**
 * Installs the recorder on `page`: for every future document (init script) and the current one.
 * Idempotent. Must run BEFORE the action whose flash a check will look for.
 */
export async function installFlashRecorder(page: Page): Promise<void> {
  await page.addInitScript(flashRecorderScript, MAX_ENTRIES);
  await page.evaluate(flashRecorderScript, MAX_ENTRIES).catch(() => undefined);
}

export interface FlashQuery {
  readonly kind: "class" | "attr" | "animation";
  /** The class or attribute name; absent for `animation` (any animation). */
  readonly name?: string | undefined;
  readonly withinMs?: number | undefined;
}

export type FlashResult =
  | { readonly installed: false; readonly matched: number }
  | {
      readonly installed: true;
      readonly matched: number;
      /** Did the page see a trusted user input at all (else the window starts at install time)? */
      readonly sawInput: boolean;
      /** Delay (ms) from the last input to the first matching gain, or null when none. */
      readonly delayMs: number | null;
      /** Matching gains that happened after the input but outside `withinMs` (evidence). */
      readonly late: number;
      /** How many gains of any kind the recorder holds (evidence). */
      readonly recorded: number;
    };

/** BROWSER CODE — asks the recorder about the elements `locator` matches. */
function queryFlashes(els: Element[], q: { kind: string; name: string | null; withinMs: number | null }): unknown {
  const log = (window as unknown as Record<string, unknown>).__jevitateFlash as
    | { lastInput: number | null; entries: Array<{ el: Element; kind: string; name: string; t: number }> }
    | undefined;
  if (log === undefined) return { installed: false, matched: els.length };
  const since = log.lastInput ?? 0;
  const hits = log.entries.filter(
    (e) => els.includes(e.el) && e.kind === q.kind && (q.name === null || e.name === q.name) && e.t >= since,
  );
  const inWindow = hits.filter((e) => q.withinMs === null || e.t - since <= q.withinMs);
  const first = inWindow[0];
  return {
    installed: true,
    matched: els.length,
    sawInput: log.lastInput !== null,
    delayMs: first === undefined ? null : Math.round(first.t - since),
    late: hits.length - inWindow.length,
    recorded: log.entries.length,
  };
}

/** What the recorder saw for the elements `locator` matches. */
export async function readFlashes(locator: Locator, q: FlashQuery): Promise<FlashResult> {
  return (await locator.evaluateAll(queryFlashes, {
    kind: q.kind,
    name: q.name ?? null,
    withinMs: q.withinMs ?? null,
  })) as FlashResult;
}
