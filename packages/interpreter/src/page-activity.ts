import type { Page } from "playwright";
import { clock, currentClock, realClock } from "@jevitate/domain";

/**
 * #852: wait for the page to change, bounded by `ms`. Resolves on the FIRST of:
 *  - a DOM mutation (an in-page `MutationObserver` over the whole document: nodes, attributes, text);
 *  - a request finishing or failing, a frame navigating, or the page's `load`;
 *  - `ms` elapsing (the polling fallback: a change no event reports, such as a form control's
 *    `.value` set from script or a computed-style change, is still sampled at the same interval).
 *
 * It never decides anything: the caller re-samples its check after every wake, so a wake can only make
 * a check be re-read sooner, never make it pass. A failed in-page observer (navigation, closed page) is
 * not a wake on its own: navigation is reported by its event, and the timer bounds the rest.
 */
export type ActivityWaker = (ms: number) => Promise<void>;

const MUTATIONS: MutationObserverInit = { subtree: true, childList: true, attributes: true, characterData: true };

/**
 * At most ONE in-page observer per page at a time: a wait that starts while an earlier observer is still
 * pending shares it instead of starting another. Under a fast loop (or a test clock that skips Node
 * time while page time is real) a fresh `evaluate` per wait would pile up observers and CDP calls. A
 * shared observer that saw a mutation since it started still means "the page changed": the caller only
 * re-samples, so a shared wake can make a check be read sooner, never pass.
 */
const pending = new WeakMap<Page, Promise<"mutation" | "bound" | "failed">>();

function observeOnce(page: Page, ms: number): Promise<"mutation" | "bound" | "failed"> {
  const current = pending.get(page);
  if (current !== undefined) return current;
  const next = page
    .evaluate(
      ({ bound, init }) =>
        new Promise<"mutation" | "bound">((done) => {
          const observer = new MutationObserver(() => {
            observer.disconnect();
            done("mutation");
          });
          observer.observe(document, init);
          // BROWSER CODE: bounded in the page too, so the observer never outlives the wait.
          setTimeout(() => {
            observer.disconnect();
            done("bound");
          }, bound);
        }),
      { bound: Math.max(0, ms), init: MUTATIONS },
    )
    // An evaluate that failed (the page navigated or closed) is not a wake on its own: navigation has its
    // event, and the caller's timer bounds the rest. Never a busy loop.
    .catch(() => "failed" as const)
    .finally(() => {
      if (pending.get(page) === next) pending.delete(page);
    });
  pending.set(page, next);
  return next;
}

/**
 * The page's event listeners are installed ONCE per page and fan out to the current waiters. Adding and
 * removing a `request*` listener on every wait makes Playwright toggle its event subscription over the
 * protocol each time; a long poll would pay that round trip per sample.
 */
const waitersOf = new WeakMap<Page, Set<() => void>>();

function waiters(page: Page): Set<() => void> {
  let set = waitersOf.get(page);
  if (set === undefined) {
    const created = new Set<() => void>();
    const wakeAll = (): void => {
      for (const w of [...created]) w();
    };
    page.on("requestfinished", wakeAll);
    page.on("requestfailed", wakeAll);
    page.on("framenavigated", wakeAll);
    page.on("load", wakeAll);
    waitersOf.set(page, created);
    set = created;
  }
  return set;
}

export function pageActivityWaker(page: Page): ActivityWaker {
  const set = waiters(page);
  return (ms) =>
    new Promise<void>((resolve) => {
      let settled = false;
      const finish = (): void => {
        if (settled) return;
        settled = true;
        clock.clearTimeout(timer);
        set.delete(finish);
        resolve();
      };
      const timer = clock.setTimeout(finish, Math.max(0, ms));
      set.add(finish);
      void observeOnce(page, ms).then((outcome) => {
        if (outcome === "mutation") finish();
      });
    });
}

/**
 * The waker for an actor's page, or undefined when there is no live Playwright page to listen to, or when
 * a test clock is installed. A fake or time-skipping clock advances only while nothing real is in flight,
 * and the in-page observer is always in flight, so under one the waker would turn instant (skipped)
 * polling into real-time polling. A wake only changes WHEN a check is re-read, never its verdict, so test
 * clocks keep plain interval polling; `[realtime]` suites and production get the waker.
 */
export function activityWakerFor(page: unknown): ActivityWaker | undefined {
  if (currentClock() !== realClock) return undefined;
  const p = page as Partial<Page> | undefined;
  if (p === undefined || typeof p.on !== "function" || typeof p.off !== "function" || typeof p.evaluate !== "function") return undefined;
  if (typeof p.isClosed === "function" && p.isClosed()) return undefined;
  return pageActivityWaker(p as Page);
}
