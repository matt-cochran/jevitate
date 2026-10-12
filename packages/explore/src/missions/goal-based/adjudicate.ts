/**
 * `adjudicatedRun`'s adjudicate phase (#500: moved verbatim out of `goal-based.ts`): the oracle's
 * results under `held` / `each` and the vacuous-check rules (#174, #202, #337), the warnings, and
 * the truthful outcome (#209).
 */
import type { MissionFailure } from "@jevitate/domain";
import type { SuccessCheckResult } from "../../success-checks.js";
import type { ExploreRun } from "../../explore.js";
import type { GoalBasedOutcome } from "../goal-based.js";
import { REPORT_CHECK, isPageCheck } from "./checks.js";
import { vacuousCheckMessage } from "./vacuous-message.js";
import type { Adjudication } from "./setup.js";

/** The final verdict, before it is reported. */
export interface Verdict {
  readonly results: SuccessCheckResult[];
  readonly warnings: string[];
  readonly assertionPassed: boolean;
  readonly outcome: GoalBasedOutcome;
  readonly failure: MissionFailure | undefined;
}

export function adjudicate(ctx: Adjudication, run: ExploreRun, evaluated: SuccessCheckResult[], vacuousNetwork: string[]): Verdict {
  const {
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
    stateChecks,
    answerRequired,
    effort,
  } = ctx;
  let results = evaluated;
  // `held`: a page check that failed on the final page passes when every page check held together
  // at a settled step of the run — and says so. Never on a run that could not be evaluated (above).
  if (state.heldAtStep !== null) {
    const step = state.heldAtStep;
    results = results.map((r) =>
      !r.passed && isPageCheck(r, pageChecks)
        ? { ...r, passed: true, detail: `held at settled step ${step} (--success-when held); ${r.detail}` }
        : r,
    );
  }
  // #337 `each`: a page check that failed on the final page passes when it went from not holding to
  // holding at a settled step of the run (each at its own) — and says so. One that held on the start
  // page and never stopped holding is vacuous (as under `held`), unless --allow-vacuous-checks.
  if (each) {
    results = results.map((r) => {
      const i = pageIndexOf(r);
      if (i === -1) return r;
      const at = eachHeldAt[i];
      if (!r.passed && at !== null && at !== undefined) return { ...r, passed: true, detail: `held at settled step ${at} (--success-when each); ${r.detail}` };
      if (r.passed && eachHeldAtStart[i] === true && eachSawNot[i] !== true && !allowVacuous) {
        return { ...r, passed: false, detail: "vacuous: already held on the start page before any action and never changed (--success-when each needs it to go from not holding to holding)" };
      }
      return r;
    });
  }
  // #174: under `held`, page checks that already held on the start page and never stopped holding
  // prove nothing was done — vacuous, never a pass (not even on the final page).
  const vacuous = held && state.heldAtStart && !state.sawNotHolding && !allowVacuous;
  if (vacuous) {
    results = results.map((r) =>
      r.passed && isPageCheck(r, pageChecks)
        ? {
            ...r,
            passed: false,
            // #209: the passing detail ("held on the final page") is not appended — it read as a pass.
            detail: "vacuous: already held on the start page before any action and never changed (--success-when held needs it to go from not holding to holding)",
          }
        : r,
    );
  }
  const warnings: string[] = held && state.heldAtStart && (vacuous || state.sawNotHolding)
    ? [
        vacuous
          ? "--success-when held: the page checks already held on the start page, before any action, and never changed — vacuous, not counted"
          : "--success-when held: the page checks already held on the start page, before any action (vacuous there); they counted only once they went from not holding to holding",
      ]
    : [];
  // #202 — the general rule: a page/reloadThen check that held on the seed page and never stopped
  // holding, or a network check matched only before the first action, cannot verify the goal. It
  // fails (a run that proved nothing is never clean) unless --allow-vacuous-checks downgrades it to
  // a warning. Named in `warnings` either way.
  const vacuousState = stateChecks.filter(([i]) => seedHeld.has(i) && !changedSinceSeed.has(i)).map(([i]) => i);
  for (const i of vacuousState) {
    const r = results[i];
    // Failed on the final verdict anyway (it changed after the last settled step, or #174 failed it).
    if (r === undefined || !r.passed) continue;
    warnings.push(`${vacuousCheckMessage(r.check)}${allowVacuous ? " (allowed by --allow-vacuous-checks)" : ""}`);
    if (!allowVacuous) {
      results[i] = {
        ...r,
        passed: false,
        // #209: the passing detail ("held on the final page") is not appended — it read as a pass.
        detail: "vacuous: held on the seed page at step 0, before any action, and never stopped holding — it cannot verify the goal (--allow-vacuous-checks downgrades this to a warning)",
      };
    }
  }
  for (const spec of vacuousNetwork) {
    warnings.push(
      `${vacuousCheckMessage(spec)}: only request(s) sent before the run's first action (page load, polling) matched${
        allowVacuous ? " (allowed by --allow-vacuous-checks)" : ""
      }`,
    );
  }
  warnings.push(...effort.warnings);
  // #286: the goal asked for a report — without a grounded answer the checks alone are not the goal.
  if (answerRequired && run.answer === undefined) {
    results = [...results, { check: REPORT_CHECK, passed: false, detail: "the goal asks to report what was found, but the run reported no grounded answer" }];
  }
  const assertionPassed = results.every((r) => r.passed);
  // #209 — a truthful ending for a miss. `blocked` means the loop gave up; it is never used for a run
  // whose model claimed the goal (`done`) and whose independent check then failed — that is `failed`,
  // naming the check. A run whose ONLY failing checks are vacuous (#202) proved nothing either way:
  // `inconclusive`, never a verdict about the app.
  const failing = results.filter((r) => !r.passed);
  const onlyVacuous = failing.length > 0 && failing.every((r) => r.detail.startsWith("vacuous:"));
  const modelClaimedDone = run.stop === "done" || run.doneRejected === true;
  const outcome: GoalBasedOutcome = assertionPassed
    ? "succeeded"
    : onlyVacuous
      ? "inconclusive"
      : run.stop === "exhausted"
        ? "exhausted"
        : modelClaimedDone
          ? "failed"
          : "blocked";
  const named = failing.map((r) => `'${r.check}'`).join(", ");
  const failure: MissionFailure | undefined =
    outcome === "inconclusive"
      ? {
          kind: "vacuous-check",
          message: `success check ${named} was satisfied before the run's first action (vacuous) — it cannot verify the goal, so the run proved nothing; use a check that only holds once the goal's work is done, or --allow-vacuous-checks to accept it`,
        }
      : outcome === "failed"
        ? {
            kind: "success-check-failed",
            message: `the model said done, but success check ${failing.map((r) => `'${r.check}' ${r.detail}`).join("; ")}`,
          }
        : undefined;
  return { results, warnings, assertionPassed, outcome, failure };
}
