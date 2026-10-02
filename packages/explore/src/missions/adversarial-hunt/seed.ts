/**
 * The hunt's seed load (#82, #128, #150, #208, #300): instrument the page, load the start URL, and
 * adjudicate the seed page itself (step 1) — every way the run can end before its first misuse.
 * Moved out of `runAdversarialHunt` unchanged (#232).
 */

import { redactUrl } from "@jevitate/ai-core";
import { Navigate } from "@jevitate/screenplay";
import { readIdentity } from "../../adversarial/identity.js";
import { assertSeedReachable, describeUnreachable, isUnreachableTarget } from "../../mission-failure.js";
import { monitorFor } from "../../page-monitor.js";
import { seedRedirectReason } from "../../seed-redirect.js";
import type { AdversarialMissionParams, AdversarialOutcome } from "../adversarial.js";
import type { HuntState } from "./context.js";

/** Loads the seed page; the run's outcome when it ends there, else null (the hunt starts). */
export async function loadSeed(ctx: HuntState, params: AdversarialMissionParams): Promise<AdversarialOutcome | null> {
  // The page monitor observes network + DOM from BEFORE the first navigation (the settle rule).
  await monitorFor(ctx.sessions.page).instrument();
  ctx.safety.attach(monitorFor(ctx.sessions.page));
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
      await assertSeedReachable(ctx.sessions.actor, params.seedUrl);
      await Navigate.to(params.seedUrl).performAs(ctx.sessions.actor);
    }
  } catch (e) {
    const message = e instanceof Error ? (e.message.split("\n")[0] ?? e.message) : String(e);
    if (!isUnreachableTarget(message) && !isUnreachableTarget(firstNavNetError ?? "")) throw e;
    // The seed itself could not be loaded: never a defect in the app, never a bug in jevitate —
    // a configuration problem. `inconclusive`, never `crashed`; no crash report/issue drafted.
    return ctx.finish("inconclusive", "scope-unreachable", {
      kind: "target-unreachable",
      message: `target unreachable (${describeUnreachable(message, firstNavNetError)})`,
    });
  } finally {
    ctx.sessions.page.off("requestfailed", onFirstNavRequestFailed);
  }
  ctx.recorder.navigate(params.seedUrl, ctx.now());
  ctx.started = ctx.now();

  const seed = await ctx.perceiveNow();
  if (seed.hang !== null) {
    await ctx.recordHang(seed.hang, seed.snapshot, seed.timing);
    return ctx.finish(ctx.verdict(), "hang");
  }
  if (!seed.rendered) {
    // Nothing to misuse. #208: the page's own load is still adjudicated — a start page that
    // answered 5xx (or threw) IS a defect, found by the hard-signal oracle before any misuse, and
    // wins over "inconclusive". With no signal, the run proves nothing (never `clean`).
    const seedVerdict = await ctx.adjudicate();
    const step = ctx.transcript.nextStep;
    const why = seed.reason ?? "page did not render";
    ctx.transcript.record({
      op: null,
      control: null,
      confidence: null,
      chosenBy: "strategy",
      strategy: "seed-load",
      actOk: false,
      reason: seedVerdict === null ? `${why} (inconclusive)` : `${why}; ${seedVerdict.reason}`,
      snapshot: seed.snapshot,
      timing: seed.timing,
    });
    if (seedVerdict !== null) {
      await ctx.fold(step, seedVerdict.findings);
      ctx.foldAdvisories(step, seedVerdict.advisories);
    }
    // `failure` explains a broken run only: a found defect is the run's result, not its failure.
    if (ctx.defects.size > 0) return ctx.finish("defects-found", "not-rendered");
    return ctx.finish("inconclusive", "not-rendered", {
      kind: "exception",
      message: `${why}${seedVerdict === null ? "" : `: ${seedVerdict.reason}`}`,
    });
  }
  // The seed redirected to a login-like page — most often a lost/expired `--storage-state`
  // session (#82). Checked BEFORE the general scope check below (which already catches ANY
  // out-of-scope landing) so THIS specific, actionable cause gets its own reason; every other
  // departure keeps the existing generic "left the target scope" message unchanged.
  const redirect = seedRedirectReason(params.seedUrl, seed.snapshot.url);
  if (redirect !== null && redirect.loginLike) {
    ctx.transcript.record({
      op: null,
      control: null,
      confidence: null,
      chosenBy: "strategy",
      strategy: "seed-load",
      actOk: false,
      reason: `${redirect.reason} (inconclusive)`,
      snapshot: seed.snapshot,
      timing: seed.timing,
    });
    return ctx.finish("inconclusive", "scope-unreachable", { kind: "target-unreachable", message: redirect.reason });
  }
  if (!ctx.inScope(seed.snapshot.url)) {
    // The start URL did not stay on the target (another route, off-allowlist): the run cannot
    // test what it was asked to — it proves nothing, so it is never `clean`.
    const message = `the start URL left the target scope (landed on ${redactUrl(seed.snapshot.url)})`;
    ctx.transcript.record({
      op: null,
      control: null,
      confidence: null,
      chosenBy: "strategy",
      strategy: "seed-load",
      actOk: false,
      reason: `${message} (inconclusive)`,
      snapshot: seed.snapshot,
      timing: seed.timing,
    });
    return ctx.finish("inconclusive", "scope-unreachable", { kind: "target-unreachable", message });
  }
  // #300: who the run is signed in as (or that it is signed out), before any action.
  ctx.baseline = await readIdentity(ctx.sessions.page);
  ctx.snap = seed.snapshot;
  // A perception's timing is reported ONCE — on the first step decided on it — so a run whose
  // strategies found nothing to do on a page does not count that page's load several times.
  ctx.snapTiming = seed.timing;
  ctx.recorder.observed(ctx.snap.url, ctx.now(), seed.timing);

  // Step 1 is the seed load itself: an AMBIENT defect (a 5xx fired while the page loads, before
  // any misuse) is attributed to loading the page, and its repro is just the navigation.
  {
    const verdict = await ctx.adjudicate();
    const step = ctx.transcript.nextStep;
    ctx.transcript.record({
      op: null,
      control: null,
      confidence: null,
      chosenBy: "strategy",
      strategy: "seed-load",
      actOk: true,
      reason: verdict === null ? "seed page loaded" : verdict.reason,
      snapshot: ctx.snap,
      timing: seed.timing,
    });
    ctx.snapTiming = undefined;
    if (verdict !== null) {
      await ctx.fold(step, verdict.findings);
      ctx.foldAdvisories(step, verdict.advisories);
    }
  }

  // #150 — a budget's baseline is read once, on the seed's settled snapshot, before any action.
  // An unreadable baseline fails closed by default (`onUnreadable: "stop"`). A defect found on the
  // seed load itself (just above) still wins over the budget stop.
  if (ctx.budget !== null) {
    const b = await ctx.budget.baseline(ctx.sessions.page);
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
      return ctx.finish(ctx.budgetVerdict(), "budget");
    }
  }
  return null;
}
