import type { Page } from "playwright";
import { snapshot, type Snapshot } from "./snapshot.js";
import { monitorFor, SETTLE_QUIET_MS, type SettleResult } from "./page-monitor.js";
import { measurePageTiming, unreadablePageTiming, type PageTiming } from "./timing.js";
import {
  classifyHang,
  hangDetail,
  hangRoute,
  pendingEvidence,
  probeResponsive,
  visibleBusyIndicator,
  type HangSignal,
} from "./hang.js";
import { contentHash } from "@jevitate/domain";
import { textMatcher, type HangConfig, type SettleConfig, type TimingConfig } from "./settle-config.js";
import { redactUrl } from "@jevitate/ai-core";
import { resourceSettleFactor } from "@jevitate/playwright";

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
  /** #192: keep a long list's options the goal names past its per-list cap (see `SnapshotOptions`). */
  readonly mentioned?: (name: string) => boolean;
  /**
   * #219: the run's registered secret values — the snapshot's page content is redacted of them as
   * it is read (see `SnapshotOptions.secrets`). Default none.
   */
  readonly secrets?: readonly string[];
  /** Ceiling on the render + settle wait (ms). Default `RENDER_WAIT_MS`; 0 disables waiting. */
  readonly renderWaitMs?: number;
  /** Quiet window for "settled" (ms). Default `SETTLE_QUIET_MS` (500). */
  readonly quietMs?: number;
  /** Bound (ms) on the main-thread probe (a trivial evaluate). Default `HANG_PROBE_MS` (5s). */
  readonly hangProbeMs?: number;
  /** A request pending longer than this (ms) is stuck. Default: half the ceiling. */
  readonly requestBoundMs?: number;
  /** The target's settle configuration (background requests, long-poll threshold). */
  readonly settleConfig?: SettleConfig;
  /** The target's hang configuration (`ui-no-progress` ignores). */
  readonly hangConfig?: HangConfig;
  /** The target's timing configuration (API path prefixes). */
  readonly timingConfig?: TimingConfig;
}

/** Default bound on the main-thread responsiveness probe (ms). */
export const HANG_PROBE_MS = 5_000;

interface PerceptionBase {
  readonly snapshot: Snapshot;
  readonly settle: SettleResult;
  /** How the page got here: navigation/transition timing and its network (owner ruling 6). */
  readonly timing: PageTiming;
  /** A hang detected while perceiving (owner ruling 7), or null. */
  readonly hang: HangSignal | null;
  /**
   * #288: what the page did while a busy indicator outlasted the ceiling (present only then) — the
   * app's requests that completed during the wait (a job-status poll) and whether the indicator's
   * own description changed (live progress text). Evidence a caller weighs to tell an app visibly
   * working on a long job from a frozen one; perception itself still reports the hang.
   */
  readonly busyWait?: { readonly requestsCompleted: number; readonly indicatorChanged: boolean };
}

export type Perception =
  | (PerceptionBase & { readonly rendered: true })
  | (PerceptionBase & { readonly rendered: false; readonly reason: string });

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

/** A document (a navigation) is among the pending requests. */
function documentPending(pending: readonly { readonly resourceType: string }[]): boolean {
  return pending.some((r) => r.resourceType === "document");
}

export async function perceive(page: Page, opts: PerceiveOptions = {}): Promise<Perception> {
  // #205: while the host is throttled (loaded/low on memory) the DEFAULT settle windows are longer
  // (`resourceSettleFactor`, 2x) — a starved renderer is slow, not hung; explicit values are kept.
  const settleFactor = resourceSettleFactor();
  const ceiling = opts.renderWaitMs ?? RENDER_WAIT_MS * settleFactor;
  const quietMs = opts.quietMs ?? SETTLE_QUIET_MS * settleFactor;
  if (!Number.isFinite(ceiling) || ceiling < 0) {
    throw new Error(`perceive: renderWaitMs must be a non-negative number, got ${String(ceiling)}`);
  }
  if (!Number.isFinite(quietMs) || quietMs < 0) {
    throw new Error(`perceive: quietMs must be a non-negative number, got ${String(quietMs)}`);
  }
  const snapOpts = {
    ...(opts.maxCandidates === undefined ? {} : { maxCandidates: opts.maxCandidates }),
    ...(opts.mentioned === undefined ? {} : { mentioned: opts.mentioned }),
    ...(opts.secrets === undefined ? {} : { secrets: opts.secrets }),
  };
  const hangProbeMs = opts.hangProbeMs ?? HANG_PROBE_MS;
  // Half the ceiling by default: a request that started a little AFTER this perception began (the
  // page an action opened) is still recognised as the stuck one when the ceiling passes, instead of
  // the verdict flipping between request-pending and never-settled on timing alone.
  const requestBoundMs = opts.requestBoundMs ?? ceiling / 2;
  const monitor = monitorFor(page);
  monitor.configure(opts.settleConfig);
  const ignoreNoProgress = textMatcher(opts.hangConfig?.ignoreNoProgress);

  // 1. Is the page's main thread answering at all? If not, nothing else can be read (every page
  //    API would block too): that is a hang of its own kind.
  let responsive = await probeResponsive(page, hangProbeMs);
  // #226: a probe that got no answer while a DOCUMENT is still loading is the page waiting on the app
  // (a navigation the server has not answered), not a stuck main thread. Give that navigation the
  // render ceiling: answered → probe again and perceive as usual; still unanswered → the app's own
  // request hang (`request-pending` on the document), never `main-thread-unresponsive`.
  if (!responsive && documentPending(monitor.pending())) {
    const deadline = Date.now() + ceiling;
    while (Date.now() < deadline && documentPending(monitor.pending()) && !page.isClosed()) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    const stillPending = monitor.pending();
    if (documentPending(stillPending)) {
      const now = Date.now();
      const win = monitor.window();
      const settle: SettleResult = { settled: false, waitedMs: now - (deadline - ceiling), pending: stillPending };
      const timing = unreadablePageTiming(page.url(), monitor.completedSince(win.start), stillPending, now);
      monitor.closeWindow(now, null);
      const evidence = pendingEvidence(stillPending.filter((r) => r.resourceType === "document"), now);
      const url = redactUrl(page.url());
      const snap: Snapshot = { url: page.url(), controls: [], truncated: false, signature: contentHash({ url, navigationPending: true }) };
      return {
        rendered: false,
        snapshot: snap,
        settle,
        timing,
        reason: `the app did not answer the navigation to ${evidence[0]?.endpoint ?? "a page"} within ${ceiling}ms`,
        hang: {
          kind: "request-pending",
          detail: hangDetail("request-pending", { pending: evidence, ceilingMs: ceiling, busy: null, probeMs: hangProbeMs }),
          route: hangRoute(page.url()),
          url,
          pending: evidence,
          lastState: { signature: snap.signature, controls: [] },
        },
      };
    }
    responsive = await probeResponsive(page, hangProbeMs);
  }
  if (!responsive) {
    const now = Date.now();
    const win = monitor.window();
    const pending = monitor.pending();
    const settle: SettleResult = { settled: false, waitedMs: hangProbeMs, pending };
    const timing = unreadablePageTiming(page.url(), monitor.completedSince(win.start), pending, now);
    monitor.closeWindow(now, null);
    const evidence = pendingEvidence(pending, now);
    const url = redactUrl(page.url());
    const snap: Snapshot = { url: page.url(), controls: [], truncated: false, signature: contentHash({ url, unresponsive: true }) };
    return {
      rendered: false,
      snapshot: snap,
      settle,
      timing,
      reason: "the page's main thread is unresponsive",
      hang: {
        kind: "main-thread-unresponsive",
        detail: hangDetail("main-thread-unresponsive", { pending: evidence, ceilingMs: ceiling, busy: null, probeMs: hangProbeMs }),
        route: hangRoute(page.url()),
        url,
        pending: evidence,
        lastState: { signature: snap.signature, controls: [] },
      },
    };
  }

  // 2. Render + settle (event-driven; one ceiling).
  const started = Date.now();
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

  // 3. A settled page that still shows a busy indicator: give it the rest of the ceiling to finish.
  let stuckBusy: string | null = null;
  let busyWait: { requestsCompleted: number; indicatorChanged: boolean } | undefined;
  if (settle.settled) {
    const busy = await page.evaluate(visibleBusyIndicator).catch(() => null);
    if (busy !== null) {
      const busySince = Date.now();
      const remaining = Math.max(1, ceiling - (Date.now() - started));
      const gone = await page
        .waitForFunction(`!(${visibleBusyIndicator.toString()})()`, undefined, { timeout: remaining, polling: "raf" })
        .then(
          () => true,
          () => false,
        );
      // A target can declare an indicator (or a route) where a lasting busy state is expected.
      if (!gone && !ignoreNoProgress(busy) && !ignoreNoProgress(hangRoute(page.url()))) {
        stuckBusy = busy;
        const now = await page.evaluate(visibleBusyIndicator).catch(() => null);
        busyWait = {
          // A `--settle-ignore`d beacon is no sign of the app working on the job (#284).
          requestsCompleted: monitor.completedSince(busySince).filter((r) => r.resourceType !== "document" && r.ignored !== true).length,
          indicatorChanged: now !== null && now !== busy,
        };
      }
    }
  }

  const settleEndedAt = Date.now();
  const win = monitor.window();
  const { timing, docId } = await measurePageTiming(page, {
    completed: monitor.completedSince(win.start),
    pending: settle.pending,
    lastDocId: win.lastDocId,
    actionAt: win.actionAt,
    settle,
    settleEndedAt,
    ...(opts.timingConfig?.apiPrefixes === undefined ? {} : { apiPrefixes: opts.timingConfig.apiPrefixes }),
  });
  monitor.closeWindow(settleEndedAt, docId);
  const snap = await snapshot(page, snapOpts);

  // 4. Classify (pure rule) — a hang is evidence, never a guess.
  const evidence = pendingEvidence(settle.pending, settleEndedAt);
  const kind = classifyHang({
    responsive: true,
    settle,
    pendingAgesMs: evidence.map((p) => p.ageMs),
    stuckBusyIndicator: stuckBusy,
    requestBoundMs,
  });
  const hang: HangSignal | null =
    kind === null
      ? null
      : {
          kind,
          detail: hangDetail(kind, { pending: evidence, ceilingMs: ceiling, busy: stuckBusy, probeMs: hangProbeMs }),
          route: hangRoute(page.url()),
          url: redactUrl(page.url()),
          pending: evidence,
          lastState: { signature: snap.signature, controls: snap.controls.map((c) => c.summary) },
          ...(stuckBusy === null ? {} : { element: stuckBusy }),
        };

  const waited = busyWait === undefined ? {} : { busyWait };
  if (snap.controls.length > 0) return { rendered: true, snapshot: snap, settle, timing, hang, ...waited };
  return {
    rendered: false,
    snapshot: snap,
    settle,
    timing,
    hang,
    ...waited,
    reason: settle.settled
      ? "page settled with no interactive controls"
      : `page rendered no interactive controls within ${ceiling}ms`,
  };
}
