import type { Page } from "playwright";
import { clock } from "@jevitate/domain";

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

export function pageActivityWaker(page: Page): ActivityWaker {
  return (ms) =>
    new Promise<void>((resolve) => {
      let settled = false;
      const finish = (): void => {
        if (settled) return;
        settled = true;
        clock.clearTimeout(timer);
        page.off("requestfinished", finish);
        page.off("requestfailed", finish);
        page.off("framenavigated", finish);
        page.off("load", finish);
        resolve();
      };
      const timer = clock.setTimeout(finish, Math.max(0, ms));
      page.on("requestfinished", finish);
      page.on("requestfailed", finish);
      page.on("framenavigated", finish);
      page.on("load", finish);
      page
        .evaluate(
          ({ bound, init }) =>
            new Promise<string>((done) => {
              const observer = new MutationObserver(() => {
                observer.disconnect();
                done("mutation");
              });
              observer.observe(document, init);
              // Bounded in the page too, so the observer never outlives the wait.
              setTimeout(() => {
                observer.disconnect();
                done("bound");
              }, bound);
            }),
          { bound: Math.max(0, ms), init: MUTATIONS },
        )
        // Only an observed mutation wakes early. The in-page bound, or an evaluate that failed (the page
        // navigated or closed), leaves the wait to the events above and the timer: never a busy loop.
        .then(
          (outcome) => {
            if (outcome === "mutation") finish();
          },
          () => undefined,
        );
    });
}

/** The waker for an actor's page, or undefined when there is no live Playwright page to listen to. */
export function activityWakerFor(page: unknown): ActivityWaker | undefined {
  const p = page as Partial<Page> | undefined;
  if (p === undefined || typeof p.on !== "function" || typeof p.off !== "function" || typeof p.evaluate !== "function") return undefined;
  if (typeof p.isClosed === "function" && p.isClosed()) return undefined;
  return pageActivityWaker(p as Page);
}
