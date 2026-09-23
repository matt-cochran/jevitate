import type { Page } from "playwright";
import { snapshot, type Snapshot } from "./snapshot.js";
import { monitorFor, SETTLE_QUIET_MS, type SettleResult } from "./page-monitor.js";

/**
 * perceive: the ONE "look at a rendered page" step every mission loop uses (goal/usability
 * explore, adversarial, induction/coverage, feature, verify-fix). It composes:
 *
 *  - an EVENT-DRIVEN render wait: a Playwright `waitForFunction` predicate that resolves the moment
 *    an interactive control is rendered — no fixed poll;
 *  - the shared SETTLE rule (`PageMonitor`): no requests in flight and no DOM mutations for a quiet
 *    window (default 500ms). A page with no controls is judged BLANK only once it has settled —
 *    a settled signal, not a time guess — so a genuine leaf state (a message view, a confirmation)
 *    is recognised in about the quiet window, while a slow SPA transition is waited for; a page
 *    whose controls appeared is read once it settles too, so a transition is never snapshotted
 *    half-way;
 *  - `snapshot()` — which drops occluded on-screen controls (the shared occlusion predicate).
 *
 * One ceiling (default 15s) bounds everything, for every mission. It never guesses: a page that
 * shows no controls is reported `rendered: false` with a reason, and each caller decides how to
 * fail closed. Portable: Playwright + standard DOM APIs only (Linux, WSL, Windows, macOS).
 */

/** Ceiling (ms) on waiting for a page to render and settle — the same for every mission. */
export const RENDER_WAIT_MS = 15_000;

export interface PerceiveOptions {
  readonly maxCandidates?: number;
  /** Ceiling on the render + settle wait (ms). Default `RENDER_WAIT_MS`; 0 disables waiting. */
  readonly renderWaitMs?: number;
  /** Quiet window for "settled" (ms). Default `SETTLE_QUIET_MS` (500). */
  readonly quietMs?: number;
}

export type Perception =
  | { readonly rendered: true; readonly snapshot: Snapshot; readonly settle: SettleResult }
  | { readonly rendered: false; readonly snapshot: Snapshot; readonly reason: string; readonly settle: SettleResult };

/** The interactive-control selector the render predicate waits for (kept in step with snapshot). */
const RENDERED_CONTROL = [
  "a[href]",
  "button",
  "input:not([type=hidden])",
  "select",
  "textarea",
  "[role=button]",
  "[role=link]",
  "[role=textbox]",
  "[role=checkbox]",
  "[role=combobox]",
  "[contenteditable=true]",
].join(",");

/** BROWSER CODE — true once any interactive control has a rendered box. */
function hasRenderedControl(selector: string): boolean {
  for (const el of Array.from(document.querySelectorAll(selector))) {
    const r = (el as HTMLElement).getBoundingClientRect();
    const style = window.getComputedStyle(el as HTMLElement);
    if (r.width > 0 && r.height > 0 && style.visibility !== "hidden" && style.display !== "none") return true;
  }
  return false;
}

export async function perceive(page: Page, opts: PerceiveOptions = {}): Promise<Perception> {
  const ceiling = opts.renderWaitMs ?? RENDER_WAIT_MS;
  const quietMs = opts.quietMs ?? SETTLE_QUIET_MS;
  if (!Number.isFinite(ceiling) || ceiling < 0) {
    throw new Error(`perceive: renderWaitMs must be a non-negative number, got ${String(ceiling)}`);
  }
  if (!Number.isFinite(quietMs) || quietMs < 0) {
    throw new Error(`perceive: quietMs must be a non-negative number, got ${String(quietMs)}`);
  }
  const snapOpts = opts.maxCandidates === undefined ? {} : { maxCandidates: opts.maxCandidates };
  const monitor = monitorFor(page);

  const settledP = monitor.waitSettled({ quietMs, ceilingMs: ceiling });
  // Resolves as soon as a control renders (event-driven); a timeout/navigation just means "not yet".
  const controlsP = page
    .waitForFunction(hasRenderedControl, RENDERED_CONTROL, { timeout: Math.max(1, ceiling), polling: "raf" })
    .then(
      (handle) => {
        void handle.dispose().catch(() => undefined);
        return true;
      },
      () => false,
    );

  const first = await Promise.race([
    controlsP.then(() => ({ kind: "controls" as const })),
    settledP.then((settle) => ({ kind: "settled" as const, settle })),
  ]);
  const settle = first.kind === "settled" ? first.settle : await settledP;
  const snap = await snapshot(page, snapOpts);

  if (snap.controls.length > 0) return { rendered: true, snapshot: snap, settle };
  return {
    rendered: false,
    snapshot: snap,
    settle,
    reason: settle.settled
      ? "page settled with no interactive controls"
      : `page rendered no interactive controls within ${ceiling}ms`,
  };
}
