/**
 * The frontier's seed load (#82, #128, #149, #150, #186, #213): instrument the page, load the start
 * URL, fingerprint the seed state, read the budget baseline, and enqueue the seed's controls — every
 * way the run can end before its first action. Moved out of `runInductionFrontier` unchanged (#232).
 */

import { Navigate } from "@jevitate/screenplay";
import { chromeClassifier } from "../../coverage/chrome.js";
import { stateFingerprint } from "../../coverage/fingerprint.js";
import { Frontier } from "../../coverage/frontier.js";
import { targetCandidates, type Control, type Snapshot } from "../../index.js";
import { assertSeedReachable, describeUnreachable, isUnreachableTarget } from "../../mission-failure.js";
import { monitorFor } from "../../page-monitor.js";
import { seedRedirectReason } from "../../seed-redirect.js";
import { summarizeTimings } from "../../timing.js";
import type { InductionRunResult } from "../induction.js";
import type { FrontierState } from "./context.js";
import { FRONTIER_OPS, enqueueFrom, refusalRisk, withSeed } from "./helpers.js";

/** Loads the seed and seeds the frontier; the run's result when it ends there, else null. */
export async function loadSeed(ctx: FrontierState): Promise<InductionRunResult | null> {
  const { params, safety, budget } = ctx;
  ctx.watchdog.during("loading the seed");
  await ctx.guard(monitorFor(ctx.sessions.page).instrument());
  safety.attach(monitorFor(ctx.sessions.page));
  // #128: real network evidence for the FIRST navigation — a refused connection can still
  // surface as a bare navigation timeout.
  let firstNavNetError: string | null = null;
  const onFirstNavRequestFailed = (req: { failure(): { errorText: string } | null }): void => {
    const text = req.failure()?.errorText;
    if (text !== undefined) firstNavNetError = text;
  };
  ctx.sessions.page.on("requestfailed", onFirstNavRequestFailed);
  try {
    if (params.startInPlace !== true) {
      await ctx.guard(assertSeedReachable(ctx.sessions.actor, params.seedUrl));
      await ctx.guard(ctx.sessions.actor.attemptsTo(Navigate.to(params.seedUrl)));
    }
  } catch (e) {
    const message = e instanceof Error ? (e.message.split("\n")[0] ?? e.message) : String(e);
    if (!isUnreachableTarget(message) && !isUnreachableTarget(firstNavNetError ?? "")) throw e;
    // The seed itself could not be loaded: never a defect in the app, never a bug in jevitate —
    // a configuration problem. `inconclusive`, never `crashed`; no crash report/issue drafted.
    return ctx.ended("scope-unreachable", {
      kind: "target-unreachable",
      message: `target unreachable (${describeUnreachable(message, firstNavNetError)})`,
    });
  } finally {
    ctx.sessions.page.off("requestfailed", onFirstNavRequestFailed);
  }
  ctx.snap = await ctx.guard(ctx.takeSnapshot());

  // The seed redirected elsewhere (a lost `--storage-state` session bounced to a login page, most
  // often) — the run cannot test what it was asked to, so it is never `clean` (#82).
  const redirect = seedRedirectReason(params.seedUrl, ctx.snap.url);
  if (redirect !== null) {
    ctx.transcript.record({
      op: null,
      control: null,
      confidence: null,
      chosenBy: "strategy",
      strategy: "seed-load",
      actOk: false,
      reason: `${redirect.reason} (inconclusive)`,
      snapshot: ctx.snap,
    });
    return {
      outcome: "scope-unreachable",
      coverage: ctx.report(false),
      recordings: [],
      transcript: ctx.transcript.entries(),
      timing: summarizeTimings(ctx.timings),
      hangs: [...ctx.hangs.values()],
      failure: { kind: "target-unreachable", message: redirect.reason },
    };
  }

  ctx.currentFingerprint = stateFingerprint(ctx.snap);
  ctx.visited.add(ctx.currentFingerprint);
  ctx.observe(ctx.snap);

  // #150 — a budget's baseline is read once, on the seed's settled snapshot, before any action.
  // An unreadable baseline fails closed by default (`onUnreadable: "stop"`): the run stops before
  // it ever acts against a budget it cannot see.
  if (budget !== null) {
    const b = await ctx.guard(budget.baseline(ctx.sessions.page));
    if (b.crossed) {
      ctx.transcript.record({
        op: null,
        control: null,
        confidence: null,
        chosenBy: "strategy",
        strategy: "budget",
        actOk: false,
        reason: b.reason ?? "budget observable unreadable at run start",
        snapshot: ctx.snap,
      });
      return {
        outcome: "budget",
        coverage: ctx.report(false),
        recordings: [...ctx.statePaths.values()],
        transcript: ctx.transcript.entries(),
        timing: summarizeTimings(ctx.timings),
        hangs: [...ctx.hangs.values()],
      };
    }
  }

  // A candidate the safety policy refuses is withheld at enqueue time (#186), its refusal recorded once.
  ctx.withheld = (control: Control, on: Snapshot): boolean =>
    safety.withholds("click", control, (reason) => {
      // #213: kept (name + category) to explain a run that took no action.
      ctx.refusedControls.set(control.name.replace(/\s+/g, " ").trim() || control.role, refusalRisk(reason));
      ctx.transcript.record({
        op: null,
        control,
        confidence: null,
        chosenBy: "strategy",
        strategy: "safety-policy",
        origin: "engine",
        actOk: false,
        reason,
        snapshot: on,
      });
    });

  ctx.frontier = new Frontier({
    order: params.strategy === "exploratory" ? "novelty" : "breadth",
    classify: chromeClassifier({ chrome: ctx.chrome, inScope: ctx.inScope }),
  });
  ctx.frontierRef = ctx.frontier;
  /** The last transition left the target scope — the next reset is a return after a departure. */
  ctx.departed = false;

  ctx.seedRecording = { version: "1", site: ctx.site, pages: [] };
  ctx.statePaths.set(ctx.currentFingerprint, ctx.seedRecording);
  ctx.seedCandidates = targetCandidates(ctx.snap.controls, { ops: FRONTIER_OPS, enabledOnly: true }).length;
  enqueueFrom(ctx.frontier, ctx.currentFingerprint, ctx.seedRecording, ctx.snap.controls, (c) => ctx.withheld(c, ctx.snap));
  // #149: checked on the seed page too — a defect that only shows up on first paint, never revisited.
  await ctx.guard(ctx.checkOverflow(ctx.currentFingerprint, ctx.snap.url, withSeed(ctx.seedRecording, params.seedUrl)));
  return null;
}
