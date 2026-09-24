import type { Dialog, Page } from "playwright";
import type { Actor } from "@jevitate/screenplay";
import { BrowseTheWebToken, Click, Enter, Target } from "@jevitate/screenplay";
import { descriptorToLocator } from "@jevitate/recorder";
import type { TargetDescriptor } from "@jevitate/recording";
import type { Op } from "./actions.js";
import type { Control } from "./snapshot.js";
import { occluderOf } from "./occlusion.js";
import { monitorFor } from "./page-monitor.js";
import { isSubmitControl } from "./conversation.js";

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
  /**
   * The snapshot's controls — for `send`, the pool its Send/Submit control is chosen from (the one
   * nearest the field in the DOM), so a click is always on a control the snapshot described.
   */
  readonly candidates?: readonly Control[];
}

/** How a `send` submitted its message. */
export type SubmittedVia = { readonly kind: "click"; readonly control: Control } | { readonly kind: "enter" };

export interface ActResult {
  /** True when the op executed successfully (gate passed, action ran). */
  readonly ok: boolean;
  /** True when the action changed page state (click/type/select/reload). */
  readonly mutated: boolean;
  /** Why the gate/op failed, when `ok` is false. */
  readonly reason?: string;
  /** For `send`: how the typed message was submitted. */
  readonly submittedVia?: SubmittedVia;
  /** What the action observed on the way (e.g. the page asked to confirm leaving with unsaved changes). */
  readonly note?: string;
}

/** Bound (ms) on a reload reaching its new document. The page's settling is perception's job. */
export const RELOAD_TIMEOUT_MS = 15_000;

/**
 * Reloads the page. A `beforeunload` "leave the page? changes you made may not be saved" prompt is
 * ACCEPTED (the user chose to reload) and reported in `note`; any other dialog raised meanwhile is
 * dismissed, exactly as Playwright does when nobody listens. A reload that cannot commit (blocked,
 * timed out, the page died) is a failed act — data, never a throw.
 */
export async function reloadPage(page: Page): Promise<ActResult> {
  let prompted = false;
  const onDialog = (dialog: Dialog): void => {
    if (dialog.type() === "beforeunload") {
      prompted = true;
      void dialog.accept().catch(() => undefined);
    } else {
      void dialog.dismiss().catch(() => undefined);
    }
  };
  page.on("dialog", onDialog);
  monitorFor(page).markAction();
  try {
    await page.reload({ waitUntil: "commit", timeout: RELOAD_TIMEOUT_MS });
    return {
      ok: true,
      mutated: true,
      ...(prompted ? { note: "the page asked to confirm leaving (unsaved changes)" } : {}),
    };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return { ok: false, mutated: false, reason: `reload failed: ${message.split("\n")[0]}` };
  } finally {
    page.off("dialog", onDialog);
  }
}

/** How long a `wait` op yields for async settling. Bounded; never a postcondition. */
const WAIT_MS = 250;
/** Bound (ms) on selecting an option. */
const SELECT_TIMEOUT_MS = 5_000;
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
  // Occlusion: a visible, enabled element can still be covered (a modal overlay, a sticky bar).
  // Clicking it would wait out Playwright's actionability timeout and then throw — so refuse it
  // up front, naming what covers it, exactly as a user could not click it either.
  // The SAME predicate the snapshot filter uses (./occlusion.ts), so the two never disagree.
  const cover = await locator.evaluate(occluderOf);
  if (cover !== null) return `target obscured by ${cover}`;
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

/**
 * Runs one page-mutating action. A browser/automation error (an element detached mid-action, a
 * navigation race, an actionability timeout) is reported as a failed act — data the loop records
 * and the model sees in its history — never an exception that kills the whole run.
 */
async function attempt(action: () => Promise<void>): Promise<ActResult> {
  try {
    await action();
    return { ok: true, mutated: true };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return { ok: false, mutated: false, reason: `action failed: ${message.split("\n")[0]}` };
  }
}

/** BROWSER CODE — tree distance between two elements (through their lowest common ancestor). */
function treeDistance(a: Element, b: Element): number {
  const up = (el: Element): Element[] => {
    const out: Element[] = [];
    for (let cur: Element | null = el; cur !== null; cur = cur.parentElement) out.push(cur);
    return out;
  };
  const pa = up(a);
  const pb = up(b);
  for (let i = 0; i < pa.length; i++) {
    const j = pb.indexOf(pa[i] as Element);
    if (j >= 0) return i + j;
  }
  return Number.MAX_SAFE_INTEGER;
}

/** Composer and Send control further apart than this in the DOM tree are not one composer. */
const MAX_SUBMIT_DISTANCE = 12;

/**
 * The composer's own submit control: among the snapshot's Send/Submit-named controls, the one
 * nearest the field in the DOM (within `MAX_SUBMIT_DISTANCE`). Enabled-ness is checked live, AFTER
 * typing — a Send button is commonly disabled until the composer has text.
 */
async function submitControlFor(actor: Actor, field: Control, pool: readonly Control[]): Promise<Control | null> {
  const page = actor.ability(BrowseTheWebToken).session.page;
  const fieldHandle = await descriptorToLocator(page, field.descriptor).elementHandle({ timeout: 1_000 }).catch(() => null);
  if (fieldHandle === null) return null;
  let best: { control: Control; distance: number } | null = null;
  try {
    for (const c of pool) {
      if (c.index === field.index || !isSubmitControl(c)) continue;
      const loc = descriptorToLocator(page, c.descriptor);
      if ((await loc.count().catch(() => 0)) !== 1) continue;
      const distance = await loc.evaluate(treeDistance, fieldHandle).catch(() => Number.MAX_SAFE_INTEGER);
      if (distance > MAX_SUBMIT_DISTANCE) continue;
      if (best === null || distance < best.distance) best = { control: c, distance };
    }
  } finally {
    await fieldHandle.dispose().catch(() => undefined);
  }
  return best?.control ?? null;
}

export async function act(actor: Actor, args: ActArgs): Promise<ActResult> {
  const page = actor.ability(BrowseTheWebToken).session.page;
  // A page-changing action that passed its gate starts a transition: the next perception measures
  // action-to-settled with the shared settle rule.
  const dispatch = (action: () => Promise<void>): Promise<ActResult> => {
    monitorFor(page).markAction();
    return attempt(action);
  };

  switch (args.op) {
    case "click": {
      if (args.control === null) return { ok: false, mutated: false, reason: "click needs a target" };
      const bad = await gate(actor, args.control);
      if (bad !== null) return { ok: false, mutated: false, reason: bad };
      const descriptor = args.control.descriptor;
      return dispatch(() => Click.on(targetFor(descriptor)).performAs(actor));
    }
    case "type": {
      if (args.control === null) return { ok: false, mutated: false, reason: "type needs a target" };
      if (args.value === null || args.value === undefined) {
        return { ok: false, mutated: false, reason: "type has no value (fail-closed)" };
      }
      const bad = await gate(actor, args.control);
      if (bad !== null) return { ok: false, mutated: false, reason: bad };
      const text = args.value;
      const descriptor = args.control.descriptor;
      return dispatch(() => Enter.theText(text).into(targetFor(descriptor)).performAs(actor));
    }
    case "send": {
      // Type the message AND submit it — a composer left holding text is a message never sent.
      if (args.control === null) return { ok: false, mutated: false, reason: "send needs a target" };
      if (args.value === null || args.value === undefined) {
        return { ok: false, mutated: false, reason: "send has no value (fail-closed)" };
      }
      const bad = await gate(actor, args.control);
      if (bad !== null) return { ok: false, mutated: false, reason: bad };
      const text = args.value;
      const field = args.control;
      const pool = args.candidates ?? [];
      let via: SubmittedVia = { kind: "enter" };
      const r = await dispatch(async () => {
        await Enter.theText(text).into(targetFor(field.descriptor)).performAs(actor);
        // Prefer the composer's own Send control (Enter in a textarea usually inserts a newline);
        // with none, Enter submits a single-line field or its form.
        const submit = await submitControlFor(actor, field, pool);
        if (submit !== null && (await gate(actor, submit)) === null) {
          await Click.on(targetFor(submit.descriptor)).performAs(actor);
          via = { kind: "click", control: submit };
          return;
        }
        await descriptorToLocator(page, field.descriptor).press("Enter");
      });
      return r.ok ? { ...r, submittedVia: via } : r;
    }
    case "select": {
      if (args.control === null) return { ok: false, mutated: false, reason: "select needs a target" };
      if (args.value === null || args.value === undefined) {
        return { ok: false, mutated: false, reason: "select has no value (fail-closed)" };
      }
      const bad = await gate(actor, args.control);
      if (bad !== null) return { ok: false, mutated: false, reason: bad };
      const option = args.value;
      const descriptor = args.control.descriptor;
      return dispatch(async () => {
        // Bounded: an option that is not there fails in seconds, not Playwright's 30s default.
        await descriptorToLocator(page, descriptor).selectOption(option, { timeout: SELECT_TIMEOUT_MS });
      });
    }
    case "upload": {
      if (args.control === null) return { ok: false, mutated: false, reason: "upload needs a target" };
      if (args.fixture === null || args.fixture === undefined) {
        return { ok: false, mutated: false, reason: "upload has no mission fixture (fail-closed)" };
      }
      const bad = await fileInputGate(actor, args.control);
      if (bad !== null) return { ok: false, mutated: false, reason: bad };
      const file = args.fixture;
      const descriptor = args.control.descriptor;
      return dispatch(() => descriptorToLocator(page, descriptor).setInputFiles(file));
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
    case "reload":
      return reloadPage(page);
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
