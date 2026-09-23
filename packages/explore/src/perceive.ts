import type { Page } from "playwright";
import { snapshot, type Snapshot } from "./snapshot.js";

/**
 * perceive: the ONE "look at a rendered page" step every mission loop uses (goal/usability
 * explore, adversarial, induction/coverage, feature). It composes:
 *
 *  - `snapshot()` — which already drops occluded on-screen controls (a control that is not the
 *    topmost element at its own centre, e.g. page chrome behind a modal overlay, is not offered);
 *  - a bounded, condition-based RENDER WAIT — an SPA right after navigation or a transition can
 *    perceive ZERO controls; deciding (or fingerprinting a state) on that blank frame is a render
 *    race, so perception re-snapshots every `pollMs` until ≥1 control appears or `renderWaitMs`
 *    elapses.
 *
 * It never guesses: a page that still shows no controls at the deadline is reported
 * `rendered: false` with a reason, and each caller decides how to fail closed (the goal loop
 * stops `blocked`; the coverage missions treat it as a leaf state with nothing to expand).
 */

/** Default bound on the render wait (ms). */
export const RENDER_WAIT_MS = 15_000;
/** Default re-snapshot interval while waiting for the page to render (ms). */
export const RENDER_POLL_MS = 250;

export interface PerceiveOptions {
  readonly maxCandidates?: number;
  /** Bound on the render wait (ms). Default `RENDER_WAIT_MS`; 0 disables waiting. */
  readonly renderWaitMs?: number;
  /** Re-snapshot interval while waiting (ms). Default `RENDER_POLL_MS`. */
  readonly pollMs?: number;
  /** Clock seam (ms). Default `Date.now`. */
  readonly now?: () => number;
}

export type Perception =
  | { readonly rendered: true; readonly snapshot: Snapshot }
  | { readonly rendered: false; readonly snapshot: Snapshot; readonly reason: string };

export async function perceive(page: Page, opts: PerceiveOptions = {}): Promise<Perception> {
  const renderWaitMs = opts.renderWaitMs ?? RENDER_WAIT_MS;
  const pollMs = opts.pollMs ?? RENDER_POLL_MS;
  if (!Number.isFinite(renderWaitMs) || renderWaitMs < 0) {
    throw new Error(`perceive: renderWaitMs must be a non-negative number, got ${String(renderWaitMs)}`);
  }
  if (!Number.isFinite(pollMs) || pollMs <= 0) {
    throw new Error(`perceive: pollMs must be a positive number, got ${String(pollMs)}`);
  }
  const now = opts.now ?? Date.now;
  const snapOpts = opts.maxCandidates === undefined ? {} : { maxCandidates: opts.maxCandidates };

  let snap = await snapshot(page, snapOpts);
  const deadline = now() + renderWaitMs;
  while (snap.controls.length === 0 && now() < deadline) {
    await page.waitForTimeout(pollMs);
    snap = await snapshot(page, snapOpts);
  }
  if (snap.controls.length === 0) {
    return {
      rendered: false,
      snapshot: snap,
      reason: `page rendered no interactive controls within ${renderWaitMs}ms`,
    };
  }
  return { rendered: true, snapshot: snap };
}
