/**
 * `adjudicatedRun`'s act phase (#500: moved verbatim out of `goal-based.ts`): one bounded
 * exploration attempt toward the goal, with the in-run check hooks, and the #126 seed-hang retry.
 */
import { describeCheck } from "../../success-checks.js";
import { explore, type ExploreRun } from "../../explore.js";
import { hangFinding, type HangFinding } from "../../hang-repro.js";
import type { GoalBasedResult } from "../goal-based.js";
import { evaluateChecks, everyPageCheckHolds, httpCheckHoldsNow, isDeferredCheck, isPageCheck, judgeNetworkCheck } from "./checks.js";
import { hangResult, reproduceSeedHang } from "./hang.js";
import type { Adjudication } from "./setup.js";

/** One exploration attempt. A retried run (#126) resets the tracking state first. */
export async function runOnce(ctx: Adjudication): Promise<ExploreRun> {
  const {
    cfg,
    checks,
    page,
    capture,
    declared,
    state,
    pageChecks,
    held,
    each,
    eachSawNot,
    eachHeldAt,
    eachHeldAtStart,
    pageIndexOf,
    allowVacuous,
    seedHeld,
    changedSinceSeed,
    scope,
    stateChecks,
    holdsNow,
    httpChecks,
    networkChecks,
    answerRequired,
    stopWhenHeld,
    hasChecks,
    readOnly,
    noDestructiveWrites,
    effort,
    exploreBase,
  } = ctx;
  // A retried run (#126) starts over from the seed: nothing the first attempt saw carries over.
  // #293: the first attempt starts in place (on the anchored page); a retry re-replays the Journey
  // prefix when it can (`restartAtStart`), else loads the seed.
  const first = state.attempts++ === 0;
  const startInPlace = cfg.startInPlace === true && (first || (cfg.restartAtStart !== undefined && (await cfg.restartAtStart(cfg.actor))));
  state.settledSteps = 0;
  state.heldAtStep = null;
  state.sawNotHolding = false;
  state.heldAtStart = false;
  eachSawNot.fill(false);
  eachHeldAt.fill(null);
  eachHeldAtStart.fill(false);
  seedHeld.clear();
  changedSinceSeed.clear();
  state.firstActionAt = null;
  return explore({
    ...exploreBase,
    startInPlace,
    readOnly,
    noDestructiveWrites,
    ...(effort.minEffort === null ? {} : { minEffort: effort.minEffort }),
    missionContext: `${cfg.missionBrief === undefined ? "" : `${cfg.missionBrief}; `}${
      hasChecks
        ? `success is judged independently by user-supplied checks — your \`done\` is only a proposal, not the verdict${
            answerRequired ? "; the goal also asks you to report what you found: end with `report` once the page shows it" : ""
          }`
        : "no --success check was given: end with `report` once you can answer the goal from what you observed — a grounded answer is the verdict"
    }`,
    // `held`: after every settled step, a quick look at the page checks — remembered once they all
    // held together. Advisory to the loop (it never changes its control flow); the verdict below uses it.
    ...(declared === null
      ? {}
      : {
          onTranscriptEntry: declared.onTranscriptEntry,
          onRecording: declared.onRecording,
          ...(declared.onBeforeAction === undefined ? {} : { onBeforeAction: declared.onBeforeAction }),
          ...(declared.onSettled === undefined ? {} : { onSettled: declared.onSettled }),
        }),
    // #202: the run's first action starts the window network checks count requests in.
    onAction: ({ at }) => {
      state.firstActionAt ??= at;
    },
    onSnapshot: async (snap) => {
      await cfg.onSnapshot?.(snap);
      await declared?.settled().catch(() => undefined);
      state.settledSteps += 1;
      // #202: which checks already hold on the seed page, and which of them later stop holding
      // (only those are re-read — a check that holds answers at once, so this stays cheap).
      if (state.settledSteps === 1) {
        for (const [i, c] of stateChecks) if (await holdsNow(c.assertion)) seedHeld.add(i);
        // #543: an `http` check is probed ONCE here, before the first action — never per step, so
        // one that holds now stays vacuous (a fixture reset is what makes it not hold).
        if (state.firstActionAt === null) for (const [i, c] of httpChecks) if (await httpCheckHoldsNow(cfg, c)) seedHeld.add(i);
      } else {
        for (const [i, c] of stateChecks) {
          if (seedHeld.has(i) && !changedSinceSeed.has(i) && !(await holdsNow(c.assertion))) changedSinceSeed.add(i);
        }
      }
      // #337 `each`: every page check on its own — it counts once it went from not holding to holding.
      if (each) {
        for (const [i, c] of pageChecks.entries()) {
          if (c.kind !== "page" || eachHeldAt[i] !== null) continue;
          const ok = await holdsNow(c.assertion);
          if (!ok) eachSawNot[i] = true;
          else if (eachSawNot[i]) eachHeldAt[i] = state.settledSteps;
          else if (state.settledSteps === 1) {
            eachHeldAtStart[i] = true;
            // #377: --allow-vacuous-checks — a check that already held on the start page counts.
            if (allowVacuous) eachHeldAt[i] = 1;
          }
        }
        return;
      }
      if (!held || state.heldAtStep !== null) return;
      const ok = await everyPageCheckHolds(cfg.actor, pageChecks).catch(() => false);
      if (!ok) state.sawNotHolding = true;
      else if (state.sawNotHolding) state.heldAtStep = state.settledSteps;
      else if (state.settledSteps === 1) {
        state.heldAtStart = true;
        // #377: --allow-vacuous-checks — checks that already held on the start page count (the
        // run may succeed without acting), the same rule as under `final` and `each`.
        if (allowVacuous) state.heldAtStep = 1;
      }
    },
    ...(stopWhenHeld
      ? {
          successMetNow: async (): Promise<string | null> => {
            // Never before an action: the start state proves nothing was done — unless
            // --allow-vacuous-checks accepts exactly that (#377).
            if (state.settledSteps < 2 && !allowVacuous) return null;
            if (pageChecks.length > 0 && (each ? eachHeldAt.some((at) => at === null) : state.heldAtStep === null)) return null;
            const requests = capture?.sent() ?? [];
            if (!networkChecks.every((c) => judgeNetworkCheck(c, requests, capture?.truncated ?? false, scope()).passed)) return null;
            if (each && pageChecks.length > 0) {
              return `every --success check held (the page checks at settled steps ${eachHeldAt.join(", ")}; --success-when each)`;
            }
            return pageChecks.length > 0
              ? `every --success check held (the page checks at settled step ${state.heldAtStep}; --success-when held)`
              : `every --success check held (--success-when ${cfg.successWhen})`;
          },
        }
      : {}),
    // The same independent oracle grounds a proposed `done` mid-run: `done` is accepted only when
    // the checks hold, so an early `done` never ends the run silently. `reloadThen` is left to the
    // final verdict — reloading mid-run would throw away the state the run is still building.
    // Under `held`, a page check that already held (together, at a settled step) counts.
    ...(hasChecks
      ? {
          // #209: what the in-run grounding cannot judge yet — so an accepted `done` is recorded as
          // provisional, never "goal verified", while the final verdict may still fail it.
          successCheckPending: (): string | null => {
            const pending: string[] = [];
            const reloads = checks.filter((c) => c.kind === "reloadThen").map((c) => `'${describeCheck(c)}'`);
            if (reloads.length > 0) pending.push(`${reloads.join(", ")} is judged after the run (it reloads the page)`);
            const https = httpChecks.map(([, c]) => `'${describeCheck(c)}'`);
            if (https.length > 0) pending.push(`${https.join(", ")} is judged after the run (an HTTP request off the page)`);
            if (!allowVacuous) {
              const since = [...stateChecks, ...httpChecks].filter(([i]) => seedHeld.has(i) && !changedSinceSeed.has(i)).map(([, c]) => `'${describeCheck(c)}'`);
              if (since.length > 0) pending.push(`${since.join(", ")} has held since before any action (vacuous unless it changes)`);
            }
            return pending.length === 0 ? null : pending.join("; ");
          },
          ...(answerRequired ? { requireAnswer: true } : {}),
          // #235: only deferred (`reloadThen`, #543 `http`) checks — the in-run check below evaluates none of them.
          ...(checks.every(isDeferredCheck) ? { successCheckDeferred: true } : {}),
          // #377: the checks as they read now (no held/each transition rule) — a `blocked` while
          // they hold is not refused as "nothing tried yet".
          ...(checks.every(isDeferredCheck)
            ? {}
            : {
                successChecksHoldNow: () =>
                  evaluateChecks(cfg, checks.filter((c) => !isDeferredCheck(c)), page, capture, scope()).then(
                    (rs) => rs.every((r) => r.passed),
                    () => false,
                  ),
              }),
          successCheck: () =>
            evaluateChecks(cfg, checks.filter((c) => !isDeferredCheck(c)), page, capture, scope()).then(
              (rs) =>
                rs.every((r) =>
                  each && isPageCheck(r, pageChecks)
                    ? // #337: under `each` a page check counts once IT went from not holding to holding.
                      eachHeldAt[pageIndexOf(r)] !== null || (r.passed && eachSawNot[pageIndexOf(r)] === true)
                    : held && isPageCheck(r, pageChecks)
                      ? // #174: under `held` a page check counts once it went from not holding to holding.
                        state.heldAtStep !== null || (r.passed && state.sawNotHolding)
                      : r.passed,
                ),
              () => false,
            ),
        }
      : {}),
  });
}

/** The act phase's outcome: the run to adjudicate, or (a seed hang that reproduced) the mission's result. */
export type ActOutcome =
  | { readonly kind: "ended"; readonly result: GoalBasedResult }
  | { readonly kind: "ran"; readonly run: ExploreRun; readonly intermittentHangs: HangFinding[] };

/** The first attempt, then (#126) one more after a seed hang that did not reproduce. */
export async function act(ctx: Adjudication): Promise<ActOutcome> {
  const { cfg } = ctx;
  let run = await runOnce(ctx);
  /**
   * #126: a hang met on the SEED load (before any action — `recordingStepIndex === 0`) that does
   * NOT reproduce is not proof the app is stuck; it can be a single slow request on a loaded host.
   * It must not end the mission. It is recorded as an intermittent finding and the goal is tried
   * once more from a fresh navigate of the seed. A hang that DOES reproduce (or that could not be
   * replayed at all) ends the run exactly as before.
   */
  const intermittentHangs: HangFinding[] = [];
  if (run.stop === "hang" && run.hang !== undefined && run.hang.recordingStepIndex === 0 && cfg.openFreshSession !== undefined) {
    const h = run.hang;
    const reproduction = await reproduceSeedHang(cfg, run, h);
    if (reproduction.status === "intermittent") {
      intermittentHangs.push(hangFinding(h.signal, run.transcript, h.recordingStepIndex, reproduction));
      run = await runOnce(ctx);
    } else {
      return { kind: "ended", result: { ...hangResult(run, h, reproduction), ...(intermittentHangs.length === 0 ? {} : { intermittentHangs }) } };
    }
  }
  return { kind: "ran", run, intermittentHangs };
}
