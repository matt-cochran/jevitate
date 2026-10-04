/**
 * The goal loop's perception phase (#232): perceive the page, close the last action's windows (side
 * effects #92/#239, read-only #158), re-observe the previous action for the Recording, and read the
 * previous action's delta (#303) — moved out of `explore.ts` unchanged.
 */

import { deltaPromptLine, deltaQuotableText, deltaRecord } from "../action-delta.js";
import { hangRoute } from "../hang.js";
import { monitorFor } from "../page-monitor.js";
import { perceive } from "../perceive.js";
import { maskSecretFields } from "../secret-fields.js";
import { markTypeFixtures } from "../type-fixtures.js";
import type { RunContext } from "./context.js";
import type { Flow, Perceived } from "./step.js";
import { clock } from "@jevitate/domain";
import { dialogHistoryLine, takeDialogEvents } from "../native-dialogs.js";

/** Perceives the page and closes the previous action's windows (the start of every step). */
export async function perceiveStep(ctx: RunContext): Promise<Perceived> {
  const { cfg } = ctx;
  // Shared perception: never decide on an unrendered page (bounded render wait) and never
  // offer an occluded control (see `perceive`).
  const perceiveStartedAt = clock.now();
  const perception = await perceive(ctx.page, ctx.perceiveOpts);
  ctx.timings.push(perception.timing);
  // #334: the native dialogs the last action raised — what the run answered is told to the model
  // and kept on that action's transcript step.
  const dialogs = takeDialogEvents(ctx.page);
  if (dialogs.length > 0) {
    for (const d of dialogs) ctx.history.push(dialogHistoryLine(d));
    ctx.transcript.attachDialogs(ctx.transcript.nextStep - 1, dialogs);
  }
  // The last click's window closes here: what it wrote is now known (#92).
  ctx.sideEffects.settle();
  // #239: a click whose writes all succeeded saved what the run had typed — from here those values
  // are the app's, and the run has written (a write goal's report may settle it).
  {
    const lc = ctx.sideEffects.lastClick();
    if (lc !== null && lc !== ctx.settledClick) {
      ctx.settledClick = lc;
      if (lc.writes.length > 0 && lc.writes.every((w) => w.status !== null && w.status >= 200 && w.status < 300)) {
        ctx.observed.confirmOwnInputs();
        ctx.wroteOk = true;
      }
    }
  }
  // #158 — the action's window closes once the page settled: later writes are the app's own.
  if (ctx.readOnly?.settled() === true && ctx.readOnly.mode === "read-only") ctx.effectLog.markBackground();
  // A bound secret field shows the model its placeholder only (#72).
  const snap = markTypeFixtures(maskSecretFields(perception.snapshot, cfg.secretFields), cfg.typeFixtures);
  {
    const m = ctx.track.lastMutation;
    if (m !== null && snap.signature !== m.before && !m.seenBefore.has(snap.signature)) m.sawNewState = true;
  }
  await ctx.heap.sample(ctx.page, ctx.transcript.nextStep);
  // Re-observe the PREVIOUS action's effect: patch its postcondition + open
  // the next page segment if the URL changed (record-before-reobserve).
  const target = ctx.track.lastRecordedTarget;
  ctx.recorder.observed(
    snap.url,
    ctx.now(),
    perception.timing,
    target === null ? undefined : { lastTargetStillPresent: snap.controls.some((c) => JSON.stringify(c.descriptor) === target) },
  );
  ctx.track.lastRecordedTarget = null;
  return { perceiveStartedAt, perception, snap };
}

/** #303: the previous action's delta (and, once, its persistence re-check after a reload). */
export async function captureDelta(ctx: RunContext, step: Perceived): Promise<Flow> {
  const { cfg } = ctx;
  const { perception, snap } = step;
  // #303: what the previous action changed (code's verdict), attached to its transcript step and
  // Recording step, and told to the model; this capture is also the next action's baseline.
  if (ctx.deltas !== null) {
    // A bound secret field's value (a TOTP code, a password code types) is masked in every capture.
    for (const c of perception.snapshot.controls) if (ctx.isBound(c)) ctx.deltas.secretField(c.name);
    const d = await ctx.deltas.perceived(hangRoute(snap.url)).catch(() => null);
    if (d !== null) {
      ctx.deltaVerdict = d.delta.verdict;
      // #303 persistence: a write that went through and changed the page is re-checked after a
      // reload (a GET of the same URL — never a re-post), once, at this safe point (nothing typed
      // and unsent, no write still in flight, not a read-only run).
      let delta = d.delta;
      let reloaded = false;
      if (
        ctx.deltas.wroteLasting() &&
        cfg.readOnly !== true &&
        ctx.unsent.pending().size === 0 &&
        ctx.sideEffects.inflight().length === 0 &&
        /^https?:/i.test(ctx.page.url())
      ) {
        const url = ctx.page.url();
        const ok = await ctx.page
          .goto(url, { waitUntil: "load", timeout: 15_000 })
          .then(() => true)
          .catch(() => false);
        await monitorFor(ctx.page).waitSettled({ ceilingMs: 10_000 }).catch(() => undefined);
        const p = ok ? await ctx.deltas.persistence().catch(() => ({ persisted: "inconclusive" as const, why: "the check failed" })) : { persisted: "inconclusive" as const, why: "the reload failed" };
        delta = { ...delta, persisted: p.persisted, persistedWhy: p.why };
        if (p.persisted === "no") ctx.notPersisted.push({ step: d.step, action: delta.action, why: p.why });
        reloaded = true;
        ctx.recorder.navigate(url, ctx.now());
        ctx.history.push(`persistence check after ${delta.action}: ${p.persisted} — ${p.why}`);
      }
      ctx.transcript.attachDelta(d.step, delta);
      ctx.recorder.attachDelta(d.recordIndex, deltaRecord(delta));
      ctx.history.push(deltaPromptLine(delta));
      // #303 grounding: what the action announced or lastingly showed (a toast gone before the
      // report) is observed page text a report may quote — redacted, never a field's own value.
      const quotable = deltaQuotableText(delta);
      if (quotable !== "") ctx.observed.add(snap.url, quotable);
      if (reloaded) {
        ctx.transcript.record({
          op: "reload",
          control: null,
          confidence: null,
          chosenBy: "strategy",
          strategy: "persistence-check",
          actOk: true,
          reason: `persistence check after ${delta.action}: ${delta.persisted} — ${delta.persistedWhy ?? ""}`,
          snapshot: snap,
          timing: perception.timing,
        });
        return "continue";
      }
    }
  }
  return "next";
}
