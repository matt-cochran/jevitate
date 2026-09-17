import type { Locator, Page } from "playwright";
import type { Assertion, RecordedStep, Step, TargetDescriptor, ValueOrVar } from "@doit/recording";
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
    case "extract": {
      const page = actor.ability(BrowseTheWebToken).session.page;
      const locator = descriptorToTarget(step.target).resolve(page);
      const value = step.attr ? await locator.getAttribute(step.attr) : await locator.innerText();
      if (value === null) {
        throw new Error(`extract: attribute "${step.attr}" not found on target`);
      }
      vars.set(step.as, value);
      if (!(await checkAssertion(actor, step.expect))) {
        throw new PostconditionFailed(step.expect, "extract");
      }
      return;
    }
    case "forEach": {
      const page = actor.ability(BrowseTheWebToken).session.page;
      const itemsLocator = descriptorToTarget(step.items).resolve(page);
      const count = await itemsLocator.count();
      for (let i = 0; i < count; i++) {
        const rowLocator = itemsLocator.nth(i);
        vars.set(`${step.as}.__index`, String(i));
        for (const childStep of step.steps) {
          await runRowScopedChildStep(actor, childStep, rowLocator, vars);
        }
      }
      return;
    }
    default:
      throw new Error(`not yet supported: ${step.kind}`);
  }
}

/**
 * Runs one `forEach` child step scoped to a single row's `Locator`, per the
 * A.1 design ruling: only `extract` and `click` are supported row-scoped
 * (no nested `forEach`, no other kinds). Target resolution is re-rooted at
 * `rowLocator` via `resolveInRoot` rather than at the page, since Task 2's
 * `descriptorToTarget`/`Target` are page-only and cannot be re-rooted.
 */
async function runRowScopedChildStep(
  actor: Actor,
  childStep: Step,
  rowLocator: Locator,
  vars: Map<string, string>,
): Promise<void> {
  switch (childStep.kind) {
    case "click": {
      await resolveInRoot(rowLocator, childStep.target).click();
      if (!(await checkAssertionInRow(actor, childStep.expect, rowLocator))) {
        throw new PostconditionFailed(childStep.expect, "forEach click");
      }
      return;
    }
    case "extract": {
      const target = resolveInRoot(rowLocator, childStep.target);
      const value = childStep.attr ? await target.getAttribute(childStep.attr) : await target.innerText();
      if (value === null) {
        throw new Error(`extract: attribute "${childStep.attr}" not found on target`);
      }
      vars.set(childStep.as, value);
      if (!(await checkAssertionInRow(actor, childStep.expect, rowLocator))) {
        throw new PostconditionFailed(childStep.expect, "forEach extract");
      }
      return;
    }
    default:
      throw new Error(`forEach child step kind not supported in A.1: ${childStep.kind}`);
  }
}

/**
 * Mirrors `descriptor.ts`'s exact selector priority ladder (testId >
 * role+name > label > text > css) but resolves against an arbitrary root —
 * a `Page` or, for row-scoped `forEach` children, a `Locator` — since
 * Playwright's `Locator` implements the same `getByTestId`/`getByRole`/
 * `getByLabel`/`getByText`/`locator` methods as `Page`.
 *
 * This duplicates `descriptor.ts`'s ladder logic rather than reshaping its
 * page-only `Target`/`descriptorToTarget` API to accept a `Locator` root —
 * a deliberate, accepted tradeoff (see task design ruling).
 */
function resolveInRoot(root: Page | Locator, d: TargetDescriptor): Locator {
  if (d.testId) {
    return root.getByTestId(d.testId);
  }
  if (d.role && d.name) {
    return root.getByRole(d.role as any, { name: d.name });
  }
  if (d.label) {
    return root.getByLabel(d.label);
  }
  if (d.text) {
    return root.getByText(d.text);
  }
  if (d.css) {
    return root.locator(d.css);
  }
  throw new Error(`TargetDescriptor has no usable selector: ${JSON.stringify(d)}`);
}

/**
 * Row-scoped counterpart to `checkAssertion` (src/assertion.ts): evaluates
 * an `Assertion` against a single row's `Locator` rather than the page.
 * `urlIncludes` is inherently page-global (not row-scoped), so it delegates
 * to the same page-level check `checkAssertion` uses, ignoring `rowLocator`.
 */
async function checkAssertionInRow(actor: Actor, a: Assertion, rowLocator: Locator): Promise<boolean> {
  switch (a.kind) {
    case "visible":
      return resolveInRoot(rowLocator, a.target).isVisible();
    case "urlIncludes": {
      const page = actor.ability(BrowseTheWebToken).session.page;
      return page.url().includes(a.text);
    }
    case "textIncludes": {
      const text = await resolveInRoot(rowLocator, a.target).innerText();
      return text.includes(a.text);
    }
    case "count": {
      const n = await resolveInRoot(rowLocator, a.target).count();
      return (a.min === undefined || n >= a.min) && (a.max === undefined || n <= a.max);
    }
  }
}
