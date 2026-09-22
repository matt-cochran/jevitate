import type { Actor } from "@jevitate/screenplay";
import { BrowseTheWebToken, Click, Enter, Target } from "@jevitate/screenplay";
import { descriptorToLocator } from "@jevitate/recorder";
import type { TargetDescriptor } from "@jevitate/recording";
import type { Op } from "./decide.js";
import type { Control } from "./snapshot.js";

/**
 * act: execute one decided op against the live page, GATED.
 *
 * The actionability gate re-checks the chosen control immediately before input
 * — it must resolve to exactly one element that is visible and enabled — so a
 * decision made against a now-stale snapshot cannot mutate the wrong thing (or
 * a vanished one). A failing gate does NOT mutate and is surfaced honestly
 * (`{ ok: false, reason }`) rather than swallowed; timing never substitutes for
 * the gate (guardrail #2, spec §6 "not detection-evasion / postconditions gate").
 *
 * The caller consumes a decision exactly once — `act` performs a single
 * action and returns; it never retries or re-decides.
 *
 * `upload` attaches the MISSION's fixture file (`ActArgs.fixture`) to the chosen
 * control. The model picks only the op and the target — it never supplies a
 * path — so a run without a fixture fails closed rather than inventing one.
 */

export interface ActArgs {
  readonly op: Op;
  /** The chosen control — required for click/type/select. */
  readonly control: Control | null;
  /** The value to type — required (non-null) for `type`. */
  readonly value?: string | null;
  /**
   * The mission's fixture file path — required for `upload`. Supplied by the
   * mission/loop (validated to exist at mission start), NEVER by the model.
   */
  readonly fixture?: string | null;
}

export interface ActResult {
  /** True when the op executed successfully (gate passed, action ran). */
  readonly ok: boolean;
  /** True when the action changed page state (click/type/select). */
  readonly mutated: boolean;
  /** Why the gate/op failed, when `ok` is false. */
  readonly reason?: string;
}

/** How long a `wait` op yields for async settling. Bounded; never a postcondition. */
const WAIT_MS = 250;
/** Pixels a scroll op moves. */
const SCROLL_PX = 600;

function targetFor(d: TargetDescriptor): Target {
  return Target.named(describe(d)).locatedBy((page) => descriptorToLocator(page, d));
}

function describe(d: TargetDescriptor): string {
  if (d.testId) return `testId=${d.testId}`;
  if (d.role && d.name) return `role=${d.role} name=${d.name}`;
  if (d.label) return `label=${d.label}`;
  if (d.text) return `text=${d.text}`;
  return `css=${d.css ?? "?"}`;
}

/** Re-checks actionability immediately before input. */
async function gate(actor: Actor, control: Control): Promise<string | null> {
  const page = actor.ability(BrowseTheWebToken).session.page;
  const locator = descriptorToLocator(page, control.descriptor);
  let count: number;
  try {
    count = await locator.count();
  } catch (e) {
    return `target did not resolve: ${(e as Error).message}`;
  }
  if (count !== 1) return `target no longer unique (count=${count})`;
  if (!(await locator.isVisible())) return "target not visible";
  if (!(await locator.isEnabled())) return "target not enabled";
  return null;
}

/**
 * The `upload` counterpart of `gate`. File inputs are routinely visually
 * hidden behind a styled label/dropzone (`opacity:0`, 1px, off-screen), so
 * requiring visibility would reject nearly every real upload control — and
 * Playwright's `setInputFiles` does not need a visible element. What still
 * protects against acting on a stale or wrong element is: exactly one match
 * (unique + attached), it IS an `<input type=file>` (never a guessed nearby
 * element), and it is enabled (a disabled input must not accept files).
 */
async function fileInputGate(actor: Actor, control: Control): Promise<string | null> {
  const page = actor.ability(BrowseTheWebToken).session.page;
  const locator = descriptorToLocator(page, control.descriptor);
  let count: number;
  try {
    count = await locator.count();
  } catch (e) {
    return `target did not resolve: ${e instanceof Error ? e.message : String(e)}`;
  }
  if (count !== 1) return `target no longer unique (count=${count})`;
  const isFileInput = await locator.evaluate(
    (el) => el instanceof HTMLInputElement && el.type.toLowerCase() === "file",
  );
  if (!isFileInput) return `no <input type=file> for target ${describe(control.descriptor)}`;
  if (!(await locator.isEnabled())) return "target not enabled";
  return null;
}

export async function act(actor: Actor, args: ActArgs): Promise<ActResult> {
  const page = actor.ability(BrowseTheWebToken).session.page;

  switch (args.op) {
    case "click": {
      if (args.control === null) return { ok: false, mutated: false, reason: "click needs a target" };
      const bad = await gate(actor, args.control);
      if (bad !== null) return { ok: false, mutated: false, reason: bad };
      await Click.on(targetFor(args.control.descriptor)).performAs(actor);
      return { ok: true, mutated: true };
    }
    case "type": {
      if (args.control === null) return { ok: false, mutated: false, reason: "type needs a target" };
      if (args.value === null || args.value === undefined) {
        return { ok: false, mutated: false, reason: "type has no value (fail-closed)" };
      }
      const bad = await gate(actor, args.control);
      if (bad !== null) return { ok: false, mutated: false, reason: bad };
      await Enter.theText(args.value).into(targetFor(args.control.descriptor)).performAs(actor);
      return { ok: true, mutated: true };
    }
    case "select": {
      if (args.control === null) return { ok: false, mutated: false, reason: "select needs a target" };
      if (args.value === null || args.value === undefined) {
        return { ok: false, mutated: false, reason: "select has no value (fail-closed)" };
      }
      const bad = await gate(actor, args.control);
      if (bad !== null) return { ok: false, mutated: false, reason: bad };
      await descriptorToLocator(page, args.control.descriptor).selectOption(args.value);
      return { ok: true, mutated: true };
    }
    case "upload": {
      if (args.control === null) return { ok: false, mutated: false, reason: "upload needs a target" };
      if (args.fixture === null || args.fixture === undefined) {
        return { ok: false, mutated: false, reason: "upload has no mission fixture (fail-closed)" };
      }
      const bad = await fileInputGate(actor, args.control);
      if (bad !== null) return { ok: false, mutated: false, reason: bad };
      await descriptorToLocator(page, args.control.descriptor).setInputFiles(args.fixture);
      return { ok: true, mutated: true };
    }
    case "scroll_up":
    case "scroll_down": {
      const dy = args.op === "scroll_down" ? SCROLL_PX : -SCROLL_PX;
      await page.mouse.wheel(0, dy);
      return { ok: true, mutated: false };
    }
    case "wait": {
      await page.waitForTimeout(WAIT_MS);
      return { ok: true, mutated: false };
    }
    case "done":
    case "blocked": {
      // No action — these are loop-terminal signals, not mutations.
      return { ok: true, mutated: false };
    }
    default: {
      const _exhaustive: never = args.op;
      return { ok: false, mutated: false, reason: `unknown op: ${String(_exhaustive)}` };
    }
  }
}
