import type { RecordedStep, ValueOrVar } from "@doit/recording";
import type { Actor } from "@doit/screenplay";
import { BrowseTheWebToken, Click, Enter, Navigate } from "@doit/screenplay";
import { checkAssertion, PostconditionFailed } from "./assertion.js";
import { descriptorToTarget } from "./descriptor.js";

/**
 * Resolves a `ValueOrVar` to a plain string ready for typing.
 *
 * A `{var}` reference is looked up in `vars`; a missing variable throws
 * rather than silently typing an empty string, since a step recorded to
 * type a specific captured value must never be replayed with the wrong
 * (empty) one.
 *
 * A redacted constant (`{redacted:true, length}`) has no plaintext to type
 * by construction — it was scrubbed at recording time — so resolving one
 * outside a variable binding is a Poka-Yoke guardrail failure, not a
 * postcondition failure: it always throws.
 */
export function resolveValue(value: ValueOrVar, vars: Map<string, string>): string {
  if ("var" in value) {
    const v = vars.get(value.var);
    if (v === undefined) throw new Error(`unknown variable: ${value.var}`);
    return v;
  }
  if (value.redacted) {
    throw new Error(
      "cannot fill with a redacted constant value; use a variable or an unredacted value",
    );
  }
  return value.value;
}

/**
 * Performs one recorded step's action (if any) and enforces its
 * postcondition, throwing `PostconditionFailed` when the postcondition does
 * not hold. This is the fail-closed guardrail at the heart of RxD replay:
 * an action whose expected outcome didn't materialize must never be
 * swallowed.
 *
 * Handles `navigate | click | fill | waitFor | assert`. The remaining `Step`
 * kinds (`extract`, `forEach`, `handback`) are out of scope for this task
 * and throw rather than silently no-op.
 */
export async function runStep(
  actor: Actor,
  rec: RecordedStep,
  vars: Map<string, string>,
): Promise<void> {
  const step = rec.step;
  switch (step.kind) {
    case "navigate": {
      await Navigate.to(step.url).performAs(actor);
      if (!(await checkAssertion(actor, step.expect))) {
        throw new PostconditionFailed(step.expect, `navigate to ${step.url}`);
      }
      return;
    }
    case "click": {
      await Click.on(descriptorToTarget(step.target)).performAs(actor);
      if (!(await checkAssertion(actor, step.expect))) {
        throw new PostconditionFailed(step.expect, "click");
      }
      return;
    }
    case "fill": {
      const text = resolveValue(step.value, vars);
      await Enter.theText(text).into(descriptorToTarget(step.target)).performAs(actor);
      if (!(await checkAssertion(actor, step.expect))) {
        throw new PostconditionFailed(step.expect, "fill");
      }
      return;
    }
    case "waitFor": {
      const page = actor.ability(BrowseTheWebToken).session.page;
      await descriptorToTarget(step.target).resolve(page).waitFor({ state: step.state });
      return;
    }
    case "assert": {
      if (!(await checkAssertion(actor, step.check))) {
        throw new PostconditionFailed(step.check, "assert");
      }
      return;
    }
    default:
      throw new Error(`not yet supported: ${step.kind}`);
  }
}
