import type { Page } from "playwright";
import type { Actor } from "@jevitate/screenplay";
import type { HangSignal } from "./hang.js";
import type { VerifySession } from "./verify-fix.js";

/**
 * The live browser session an EXPLORING mission works in, and how it resets to a known state after
 * a hang so the mission can keep hunting (owner follow-up to ruling 7).
 *
 * A hung page may be unusable (a busy main thread will not even navigate), so a reset opens a FRESH
 * session when the mission was given a way to (the caller's `openFreshSession`); the mission then
 * re-navigates to its start URL there. Without one, the same page is reused — except after a
 * `main-thread-unresponsive` hang, where that is not possible and the mission has to stop.
 *
 * Sessions this holder opened are its own and are closed by `closeOwned()`; the caller's original
 * session is never closed here.
 */
export class MissionSessions {
  #page: Page;
  #actor: Actor;
  readonly #openFresh: (() => Promise<VerifySession>) | undefined;
  readonly #owned: VerifySession[] = [];
  readonly #listeners: Array<(page: Page) => void> = [];
  #resets = 0;

  constructor(initial: { page: Page; actor: Actor }, openFresh?: () => Promise<VerifySession>) {
    this.#page = initial.page;
    this.#actor = initial.actor;
    this.#openFresh = openFresh;
  }

  get page(): Page {
    return this.#page;
  }

  get actor(): Actor {
    return this.#actor;
  }

  /** How many times the mission reset after a hang. */
  get resets(): number {
    return this.#resets;
  }

  /** Called with the new page after each reset — to attach the mission's page listeners there. */
  onReset(listener: (page: Page) => void): void {
    this.#listeners.push(listener);
  }

  /**
   * Resets after `hang`. Returns false when the mission cannot continue (an unresponsive page and no
   * way to open a fresh one). The caller re-navigates to its start URL afterwards.
   */
  async reset(hang: HangSignal): Promise<boolean> {
    if (this.#openFresh === undefined) return hang.kind !== "main-thread-unresponsive";
    const fresh = await this.#openFresh();
    this.#owned.push(fresh);
    this.#page = fresh.page;
    this.#actor = fresh.actor;
    this.#resets += 1;
    for (const l of this.#listeners) l(fresh.page);
    return true;
  }

  /** Closes the sessions this holder opened (never the caller's original one). */
  async closeOwned(): Promise<void> {
    for (const s of this.#owned.splice(0)) await s.close().catch(() => undefined);
  }
}
