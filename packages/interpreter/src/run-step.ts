import { access } from "node:fs/promises";
import type { Locator, Page } from "playwright";
import type { Assertion, RecordedStep, Step, TargetDescriptor, ValueOrVar } from "@jevitate/recording";
import type { Actor } from "@jevitate/screenplay";
import { BrowseTheWebToken, Click, Enter, Navigate } from "@jevitate/screenplay";
import { checkAssertion, pollUntil, PostconditionFailed } from "./assertion.js";
import { descriptorToTarget } from "./descriptor.js";
import type { StepOutcome } from "./outcome.js";

/**
 * NOTE (deferred to a future milestone, documentation-only): every step
 * below invokes its Screenplay `Activity` directly via `.performAs(actor)`
 * (e.g. `Click.on(...).performAs(actor)`), never via
 * `actor.attemptsTo(...)`. That means `PaceInteractionsToken`-based
 * humanization/pacing (inter-interaction delays) never applies to
 * interpreter-run steps. A future milestone wiring a Recording-backed
 * action into the paced production runner needs to explicitly add this —
 * it will not happen automatically just by reusing `runStep`.
 */

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
 * Handles all 11 `Step` kinds: `navigate | click | fill | waitFor | assert |
 * extract | select | upload | press | forEach` resolve to `{kind:"done"}` on success
 * (or throw); `handback` performs no action and resolves to
 * `{kind:"awaiting_human"}` without checking its `resume` assertion — see
 * that case below.
 *
 * `select` and `press` deliberately follow the same direct-resolve pattern
 * as `waitFor` (resolve the target/page and call the Playwright method
 * directly) rather than going through a Screenplay `Activity` wrapper like
 * `click`/`fill` do — a ruling made for this task, not an oversight.
 *
 * The optional `index` (default `0`) is not consumed by any postcondition
 * or assertion logic here — it exists solely to be echoed into a
 * `handback` step's `StepOutcome.awaiting_human.index`. `runStep` is only
 * ever given one `RecordedStep` at a time and has no visibility into that
 * step's position within a whole `Recording`; the future
 * `RecordingInterpreter` (which sequences a full recording) will call
 * `runStep(actor, rec, vars, globalIndex)` per step, passing the
 * recording-global flat step index.
 */
export async function runStep(
  actor: Actor,
  rec: RecordedStep,
  vars: Map<string, string>,
  index = 0,
): Promise<StepOutcome> {
  const step = rec.step;
  switch (step.kind) {
    case "navigate": {
      await Navigate.to(step.url).performAs(actor);
      if (!(await checkAssertion(actor, step.expect))) {
        throw new PostconditionFailed(step.expect, `navigate to ${step.url}`);
      }
      return { kind: "done" };
    }
    case "click": {
      await Click.on(descriptorToTarget(step.target)).performAs(actor);
      if (!(await checkAssertion(actor, step.expect))) {
        throw new PostconditionFailed(step.expect, "click");
      }
      return { kind: "done" };
    }
    case "fill": {
      const text = resolveValue(step.value, vars);
      await Enter.theText(text).into(descriptorToTarget(step.target)).performAs(actor);
      if (!(await checkAssertion(actor, step.expect))) {
        throw new PostconditionFailed(step.expect, "fill");
      }
      return { kind: "done" };
    }
    case "waitFor": {
      const page = actor.ability(BrowseTheWebToken).session.page;
      await descriptorToTarget(step.target).resolve(page).waitFor({ state: step.state });
      return { kind: "done" };
    }
    case "assert": {
      if (!(await checkAssertion(actor, step.check))) {
        throw new PostconditionFailed(step.check, "assert");
      }
      return { kind: "done" };
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
      return { kind: "done" };
    }
    case "select": {
      const value = resolveValue(step.value, vars);
      const page = actor.ability(BrowseTheWebToken).session.page;
      await descriptorToTarget(step.target).resolve(page).selectOption(value);
      if (!(await checkAssertion(actor, step.expect))) {
        throw new PostconditionFailed(step.expect, "select");
      }
      return { kind: "done" };
    }
    case "upload": {
      // Re-attach the SAME fixture the recording names (or a `{var}` binding).
      // A redacted path throws in `resolveValue`; a path that is gone fails
      // fast here with the path named, never attaching some other file.
      const file = resolveValue(step.file, vars);
      try {
        await access(file);
      } catch (err) {
        throw new Error(`fixture not found: ${file}`, { cause: err });
      }
      const page = actor.ability(BrowseTheWebToken).session.page;
      await descriptorToTarget(step.target).resolve(page).setInputFiles(file);
      if (!(await checkAssertion(actor, step.expect))) {
        throw new PostconditionFailed(step.expect, "upload");
      }
      return { kind: "done" };
    }
    case "press": {
      const page = actor.ability(BrowseTheWebToken).session.page;
      await page.keyboard.press(step.key);
      if (!(await checkAssertion(actor, step.expect))) {
        throw new PostconditionFailed(step.expect, "press");
      }
      return { kind: "done" };
    }
    case "forEach": {
      const page = actor.ability(BrowseTheWebToken).session.page;
      const target = descriptorToTarget(step.items);
      const itemsLocator = target.resolve(page);
      // The "at least one row" precondition polls on the same bound as every
      // other postcondition (`pollUntil`, 5000ms/100ms): a list still being
      // rendered asynchronously must not read as a genuinely empty one. It
      // still fails closed — a list that never gains a row throws below once
      // the bound elapses — and it costs nothing on the happy path, where the
      // first sample already sees rows and returns immediately.
      let count = 0;
      const rowsAppeared = await pollUntil(async () => {
        count = await itemsLocator.count();
        return count > 0;
      });
      if (!rowsAppeared) {
        throw new PostconditionFailed(
          { kind: "count", target: step.items, min: 1 },
          `forEach: 0 rows matched for items target ${target.description} (expected at least 1)`,
        );
      }
      for (let i = 0; i < count; i++) {
        const rowLocator = itemsLocator.nth(i);
        vars.set(`${step.as}.__index`, String(i));
        for (const childStep of step.steps) {
          await runRowScopedChildStep(actor, childStep, rowLocator, vars);
        }
      }
      return { kind: "done" };
    }
    case "handback": {
      // Deliberately performs NO action whatsoever — no `actor`/`page`/
      // locator is touched — and does NOT evaluate `step.resume` here. The
      // whole point of `awaiting_human` is that replay pauses and a human
      // acts; a future HITL runner drives the human and re-checks `resume`
      // itself before resuming. Auto-satisfying `resume` here would defeat
      // that.
      return { kind: "awaiting_human", prompt: step.prompt, resume: step.resume, index };
    }
    default: {
      const _exhaustive: never = step;
      throw new Error(`not yet supported: ${(_exhaustive as Step).kind}`);
    }
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
  if (d.frameUrl) {
    throw new Error("frameUrl is not supported in A.1");
  }

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
 *
 * Polls on exactly the same bound as `checkAssertion`, through the same
 * `pollUntil` primitive and the same 5000ms/100ms defaults, so an
 * `Assertion` behaves identically whether it is checked at the top level or
 * inside a `forEach` row. Like `checkAssertion` it still fails closed,
 * returning `false` once the bound elapses.
 */
async function checkAssertionInRow(actor: Actor, a: Assertion, rowLocator: Locator): Promise<boolean> {
  return pollUntil(() => evaluateAssertionInRowOnce(actor, a, rowLocator));
}

/** A single, non-retrying sample of `a` against one row's `Locator`. */
async function evaluateAssertionInRowOnce(
  actor: Actor,
  a: Assertion,
  rowLocator: Locator,
): Promise<boolean> {
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
