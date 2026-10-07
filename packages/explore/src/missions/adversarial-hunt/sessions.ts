/**
 * The hunt's page and session handling (#203, #230, #293, #300): perception, a hang's recording and
 * reproduction, restarting at the seed in a new Recording segment, resetting after a hang and
 * restoring the original identity — moved out of `runAdversarialHunt` unchanged (#232), installed
 * on `ctx` as the same closures.
 */

import { Navigate } from "@jevitate/screenplay";
import { clearAuthState, identityChange, readIdentity } from "../../adversarial/identity.js";
import { isAuthorizedExploreTarget } from "../../authorized-targets.js";
import { sampleHeap } from "../../crash-report.js";
import { NOT_REPLAYED, hangFinding, reproduceHang, type HangReproduction } from "../../hang-repro.js";
import { hangFingerprint, type HangSignal } from "../../hang.js";
import { assertTargetAnswering } from "../../mission-failure.js";
import { monitorFor } from "../../page-monitor.js";
import { perceive } from "../../perceive.js";
import { RunRecorder } from "../../record.js";
import type { Snapshot } from "../../snapshot.js";
import type { PageTiming } from "../../timing.js";
import type { AdversarialMissionParams, AdversarialStop } from "../adversarial.js";
import type { HuntState } from "./context.js";

/** Installs the session closures on `ctx`. */
export function installSessions(ctx: HuntState, params: AdversarialMissionParams): void {
  ctx.perceiveNow = async (): Promise<{
    snapshot: Snapshot;
    timing: PageTiming;
    rendered: boolean;
    reason?: string;
    hang: HangSignal | null;
  }> => {
    const p = await perceive(ctx.sessions.page, ctx.perceiveOpts);
    ctx.timings.push(p.timing);
    await ctx.heap.sample(ctx.sessions.page, ctx.transcript.nextStep);
    return p.rendered
      ? { snapshot: p.snapshot, timing: p.timing, rendered: true, hang: p.hang }
      : { snapshot: p.snapshot, timing: p.timing, rendered: false, reason: p.reason, hang: p.hang };
  };

  /**
   * A hang is recorded in the transcript, its steps are replayed in fresh contexts to reproduce it,
   * and it becomes a finding with k/N. The same hang again (by fingerprint) is one more occurrence —
   * never reproduced twice.
   */
  ctx.recordHang = async (signal: HangSignal, snapshot: Snapshot, timing: PageTiming): Promise<void> => {
    let h = signal;
    ctx.transcript.record({
      op: null,
      control: null,
      confidence: null,
      chosenBy: "strategy",
      strategy: "hang-check",
      actOk: false,
      reason: `hang (${h.kind}): ${h.detail}`,
      snapshot,
      timing,
    });
    // #230: the app stopped answering a fresh request — `target-unresponsive`, never a hang finding
    // and never blamed on a starved host.
    await assertTargetAnswering({
      pageUrl: ctx.sessions.page.url(),
      authorized: (u) => isAuthorizedExploreTarget(u, params.allowlist),
    });
    const step = ctx.transcript.nextStep - 1;
    const known = ctx.hangs.get(hangFingerprint(h));
    if (known !== undefined) {
      // Already confirmed (or being confirmed): no replay budget spent again — just one more
      // occurrence, and the route added when it is a new one ("also seen on <route>", #87).
      ctx.hangs.set(known.fingerprint, {
        ...known,
        occurrences: known.occurrences + 1,
        occurrenceSteps: [...known.occurrenceSteps, step],
        routes: known.routes.includes(h.route) ? known.routes : [...known.routes, h.route],
      });
      return;
    }
    const judged = params.hostHealth === undefined ? { host: await ctx.probeHost(), starved: null } : await params.hostHealth.judge();
    if (judged.starved !== null) {
      // #203: met while the host was starved — advisory `environment-degraded`, never a hang finding.
      params.hostHealth?.markDegraded(
        { finding: h.kind === "ui-no-progress" ? "no-progress" : "hang", detail: `${h.kind}: ${h.detail}`, step },
        judged.starved,
      );
      return;
    }
    const heapNow = await sampleHeap(ctx.sessions.page, 1_000);
    if (heapNow !== null) h = { ...h, heapBytes: heapNow.usedBytes };
    h = { ...h, host: judged.host };
    const recordingStepIndex = Math.max(0, ctx.recorder.stepCount - 1);
    const partial = ctx.recorder.tryFinish({ intent: "adversarial" });
    const reproduction: HangReproduction =
      params.openFreshSession === undefined || !partial.ok
        ? NOT_REPLAYED
        : await reproduceHang({
            recording: partial.recording,
            recordingStepIndex,
            hang: h,
            openSession: params.openFreshSession,
            ...(params.hangReplays === undefined ? {} : { attempts: params.hangReplays }),
            perceive: ctx.perceiveOpts,
            ...(params.safety === undefined ? {} : { safety: params.safety }),
          });
    const finding = hangFinding(h, ctx.transcript.entries(), recordingStepIndex, reproduction);
    const segment = ctx.segments.indexOf(ctx.recorder);
    ctx.hangs.set(
      finding.fingerprint,
      segment > 0 && partial.ok ? { ...finding, repro: { ...finding.repro, recording: partial.recording } } : finding,
    );
  };

  /**
   * Starts a NEW Recording segment at the start URL on the current session page (after a reset):
   * its findings replay from there, never through what ended the previous segment. Returns the
   * perceived start page, or why the run cannot go on (the start page hangs, or does not stay in
   * scope — e.g. the session was lost and it redirects to a login page).
   */
  /** #293: actions spent re-replaying the Journey prefix on resets (counted against `maxActions`). */
  ctx.restartSpend = 0;
  ctx.restartAtSeed = async (): Promise<
    { ok: true; snapshot: Snapshot; timing: PageTiming } | { ok: false; stop: AdversarialStop }
  > => {
    await monitorFor(ctx.sessions.page).instrument();
    ctx.safety.attach(monitorFor(ctx.sessions.page));
    await ctx.offAllowlist.arm(ctx.sessions.page);
    ctx.recorder = new RunRecorder(ctx.site, undefined, ctx.secrets);
    ctx.segments.push(ctx.recorder);
    if (params.restartAtStart !== undefined) {
      // #293: back through the Journey prefix (bounded: it spends the action budget).
      ctx.restartSpend += params.restartCost ?? 0;
      if (!(await params.restartAtStart(ctx.sessions.actor))) return { ok: false, stop: "scope-unreachable" };
    } else {
      await Navigate.to(params.seedUrl).performAs(ctx.sessions.actor);
    }
    ctx.recorder.navigate(params.seedUrl, ctx.now());
    const back = await ctx.perceiveNow();
    ctx.recorder.observed(back.snapshot.url, ctx.now(), back.timing);
    if (back.hang !== null) {
      await ctx.recordHang(back.hang, back.snapshot, back.timing);
      return { ok: false, stop: "hang" };
    }
    if (!ctx.inScope(back.snapshot.url)) return { ok: false, stop: "scope-unreachable" };
    return { ok: true, snapshot: back.snapshot, timing: back.timing };
  };

  /**
   * After a hang: reset to a known state — a fresh page when the mission can open one (a hung page
   * may not even navigate), else the same page — re-navigate to the start URL in a NEW Recording
   * segment, and keep hunting. Null when the mission cannot continue (an unresponsive page with no
   * way to open a fresh one, or a start page that itself hangs or leaves the scope).
   */
  ctx.resetAfterHang = async (
    h: HangSignal,
  ): Promise<{ ok: true; snapshot: Snapshot; timing: PageTiming } | { ok: false; stop: AdversarialStop }> => {
    if (!(await ctx.sessions.reset(h))) return { ok: false, stop: "hang" };
    return ctx.restartAtSeed();
  };

  /**
   * #300 — after an action switched the signed-in identity: a FRESH session from the original storage
   * state (the only way back to the identity the run was given), at the start URL in a new Recording
   * segment, whose identity must match the baseline again. When no fresh session can be opened, or
   * the restored one is not the original identity, the run cannot go on (`identity-changed`).
   */
  ctx.restoreIdentity = async (): Promise<
    { ok: true; snapshot: Snapshot; timing: PageTiming } | { ok: false; stop: AdversarialStop; why: string }
  > => {
    const unrestorable = (detail: string): { ok: false; stop: AdversarialStop; why: string } => ({
      ok: false,
      stop: "identity-changed",
      why: `the signed-in identity changed and the original one could not be restored (${detail})`,
    });
    if (!(await ctx.sessions.fresh())) {
      // No fresh session: only a SIGNED-OUT original identity can be restored in place, by clearing
      // the session's auth state (cookies and auth-named storage) on the current page.
      if (ctx.baseline === null || ctx.baseline.entries.size > 0) {
        return unrestorable("no fresh session can be opened from the original storage state");
      }
      await clearAuthState(ctx.sessions.page);
    }
    const back = await ctx.restartAtSeed();
    if (!back.ok) {
      return back.stop === "scope-unreachable" ? unrestorable("the start URL no longer stays in scope") : { ok: false, stop: back.stop, why: `reset after the identity change ended: ${back.stop}` };
    }
    const still = ctx.baseline === null ? null : identityChange(ctx.baseline, await readIdentity(ctx.sessions.page), { authRequest: false });
    if (still !== null) return unrestorable(`the fresh session is not the original identity: ${still}`);
    return back;
  };

}
