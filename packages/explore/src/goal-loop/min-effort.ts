/**
 * #424 — the minimum-effort gate on the model's endings (`report`, `blocked`, an answerless `done`):
 * while the run has spent less than its minimum (actions, distinct page states) and still has budget
 * to act, the ending is deferred and the model is steered to breadth instead. See `run-depth.ts`.
 */
import { absenceCoverage } from "../answer.js";
import { MAX_MIN_EFFORT_REFUSALS, breadthHint, shortfall } from "../run-depth.js";
import type { RunContext } from "./context.js";
import type { Step } from "./step.js";

/**
 * The steering note when `ending` is deferred for the minimum effort (also pushed to the model's
 * history), or null when it stands: no minimum applies, it is met, the action budget is spent, or
 * the model insisted `MAX_MIN_EFFORT_REFUSALS` times in a row without acting in between.
 */
export function deferEnding(ctx: RunContext, step: Step, ending: string): string | null {
  const min = ctx.minEffort;
  if (min === null) return null;
  const missing = shortfall(min, ctx.tracker.actions, ctx.depth.distinctStates);
  if (missing === null || !ctx.tracker.mayAct()) return null;
  if (ctx.minEffortRefusedAt !== ctx.tracker.actions) {
    ctx.minEffortRefusedAt = ctx.tracker.actions;
    ctx.minEffortRefusals = 0;
  }
  if (ctx.minEffortRefusals >= MAX_MIN_EFFORT_REFUSALS) {
    ctx.history.push(`${ending} accepted below the minimum exploration effort (${missing}): it was deferred ${ctx.minEffortRefusals} times in a row with no action taken`);
    return null;
  }
  ctx.minEffortRefusals += 1;
  const unseen = absenceCoverage(ctx.observed.pages(), ctx.observed.topNavigation()).unseen;
  const hint = breadthHint({ url: step.snap.url, controls: step.modelControls, unseenNav: unseen, depth: ctx.depth });
  const note = `${ending} deferred (${ctx.minEffortRefusals}/${MAX_MIN_EFFORT_REFUSALS}): the minimum exploration effort is not met yet — ${missing} so far; spend the budget on breadth before concluding (${hint})`;
  ctx.history.push(note);
  return note;
}
