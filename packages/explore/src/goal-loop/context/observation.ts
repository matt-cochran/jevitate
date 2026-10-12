/** `createRunContext`: timings, write classification, safety (#116), first-party origins (#194), side effects (#92), documents (#223), focus (#338) and deltas (#303) (#500: moved verbatim out of `context.ts`). */
import { writeClassifier } from "@jevitate/recording";
import { monitorFor } from "../../page-monitor.js";
import { urlMatcher } from "../../settle-config.js";
import { SideEffectGuard, SideEffectLog } from "../../side-effects.js";
import { ChromeTracker } from "../../feature/relevance.js";
import { GoalFocus } from "../goal-focus.js";
import { SafetyPolicy } from "../../safety.js";
import { FirstPartyOrigins } from "../../third-party.js";
import { ActionDeltas } from "../../action-delta.js";
import type { ExploreConfig } from "../../explore.js";
import type { MutableRunContext } from "./types.js";

export function initObservation(ctx: MutableRunContext, cfg: ExploreConfig): void {
  /** Every perception's full timing (with request samples), once each — the run summary's input. */
  ctx.timings = [];
  // A write is classified by the shared classifier (#110): a gRPC-web/Connect read is never guarded.
  ctx.isWrite = writeClassifier(cfg.safety?.readRequests === undefined ? {} : { readRequests: cfg.safety.readRequests });
  /** The shared safety policy (#116): session-ending / destructive / paid / denied controls. */
  ctx.safety = new SafetyPolicy(cfg.safety, { goal: cfg.goal });
  /** The writes the run's actions fire (#116: the result's `sideEffects`). */
  /**
   * #194 — which origins are the app's: the allowlist's sites, plus every origin the page sends API
   * credentials to (observed on every request below). A write elsewhere is `thirdParty`.
   */
  ctx.firstParty = new FirstPartyOrigins(cfg.allowlist);
  ctx.onRequestSeen = (r: { url(): string; headers(): Record<string, string> }): void => {
    ctx.firstParty.observe(r.url(), r.headers());
  };
  ctx.page.on("request", ctx.onRequestSeen);
  /**
   * The repeated-side-effect guard (#92): a click that fired a write is not blindly re-fired. A
   * third-party beacon or a `--settle-ignore`d request is never a control's side effect (#274/#284).
   */
  ctx.sideEffects = new SideEffectGuard(monitorFor(ctx.page), {
    isWrite: ctx.isWrite,
    allowlist: cfg.allowlist,
    firstParty: ctx.firstParty,
    ignoreRequests: urlMatcher(cfg.settle?.ignoreRequests),
  });
  /** The writes earlier clicks fired that are still in flight, named (#283). */
  ctx.inflightWrites = (): string =>
    [...new Set(ctx.sideEffects.inflight().map((w) => `${w.method} ${w.path}`))].join(", ");
  // #223: the main document's HTTP status per URL — an answer on a 404 / error page is no answer.
  ctx.documentStatus = new Map<string, number>();
  /** #223: controls repeated across pages (global chrome) — their link text is not page content. */
  ctx.chrome = new ChromeTracker();
  /** #338: the goal's area — once reached, navigation to sections the goal never names is off-goal. */
  ctx.goalFocus = new GoalFocus(cfg.goal);
  ctx.docKey = (u: string): string => u.split("#")[0] ?? u;
  ctx.onDocumentResponse = (r: { url(): string; status(): number; request(): { isNavigationRequest(): boolean; frame(): unknown } }): void => {
    try {
      if (!r.request().isNavigationRequest() || r.request().frame() !== ctx.page.mainFrame()) return;
      if (ctx.documentStatus.size >= 500) ctx.documentStatus.clear();
      ctx.documentStatus.set(ctx.docKey(r.url()), r.status());
    } catch {
      // a response whose frame is gone: nothing to record
    }
  };
  ctx.page.on("response", ctx.onDocumentResponse);
  // #194: a write to a third-party origin is listed with its full URL and `thirdParty: true`.
  ctx.effectLog = new SideEffectLog({ isWrite: ctx.isWrite, now: ctx.now, allowlist: cfg.allowlist, firstParty: ctx.firstParty });
  /** #303: what each action changed on the page (null when turned off). */
  ctx.deltas = cfg.actionDeltas === undefined || cfg.actionDeltas === false
      ? null
      : new ActionDeltas(ctx.page, {
          secrets: ctx.secrets,
          goal: cfg.goal,
          judge: typeof cfg.actionDeltas === "object" && cfg.actionDeltas.jev === true ? cfg.judge : null,
          ...(typeof cfg.actionDeltas === "object" && cfg.actionDeltas.volatilityGapMs !== undefined ? { volatilityGapMs: cfg.actionDeltas.volatilityGapMs } : {}),
          ownWrites: () => ctx.turnWrites,
          isWrite: ctx.isWrite,
          ignoreRequest: urlMatcher(cfg.settle?.ignoreRequests),
        });
  /** #303: write steps whose changes did not survive a reload (saved but not stored — evidence). */
  ctx.notPersisted = [];
  /** #303: the verdict of the last action's delta, until the no-progress check reads it. */
  ctx.deltaVerdict = null;
}
