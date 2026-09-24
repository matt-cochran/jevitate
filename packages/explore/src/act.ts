import type { Dialog, ElementHandle, Page } from "playwright";
import type { Actor } from "@jevitate/screenplay";
import { BrowseTheWebToken, Click, Enter, Target } from "@jevitate/screenplay";
import { descriptorToLocator } from "@jevitate/recorder";
import { applyTextEdit } from "@jevitate/interpreter";
import type { TargetDescriptor, TextEdit } from "@jevitate/recording";
import type { Op } from "./actions.js";
import type { Control } from "./snapshot.js";
import { occluderOf, srOnlyLabelOf } from "./occlusion.js";
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
  /**
   * For `edit_text` (#148): the edit, already validated by code (a quote present in the target's
   * text, no secret). Placed and typed by the SAME function Recording replay uses.
   */
  readonly edit?: TextEdit | null;
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
  /**
   * For `scroll_up`/`scroll_down`: whether the scroll position (of the nearest scrollable container
   * under the pointer, else the window) actually settled to a new value within the settle window
   * (#109). Absent for every other op.
   */
  readonly moved?: boolean;
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
/**
 * Bound (ms) on `gate()`'s post-count actionability re-check (resolving an element handle, plus the
 * click itself). A target that raced out from under the gate — detached, swapped, or obscured
 * between the decision and this check — must fail fast, never wait out Playwright's 30s default
 * actionability timeout and throw (#77).
 */
const GATE_TIMEOUT_MS = 2_000;
/** Bound (ms) on the click Playwright performs after the gate has passed. */
const CLICK_TIMEOUT_MS = 5_000;
/** Pixels a scroll op moves. */
const SCROLL_PX = 600;
/**
 * Bound (ms) on how long a scroll op waits for the scroll position to settle after the wheel event
 * (#109). Playwright's `mouse.wheel` does not wait for the scroll it dispatches — reading the scroll
 * position immediately after almost always sees the pre-scroll value, so the loop is told "the page
 * did not move" even when it did. Polled, not a fixed sleep: most scrolls settle well under this.
 */
const SCROLL_SETTLE_MS = 600;
/** Poll interval (ms) while waiting for a scroll to settle. */
const SCROLL_POLL_MS = 50;

/**
 * BROWSER CODE — the scroll position a wheel dispatched at (x,y) would move: the nearest scrollable
 * ancestor under the point (an `overflow:auto`/`scroll` container whose content overflows it, e.g. an
 * inner main pane), else the window/document's own scroll position (#109). X and Y are combined into
 * one number — callers only need to know WHETHER it moved, never which axis.
 */
export function scrollPositionAt(pt: { x: number; y: number }): number {
  const scrollable = (e: Element): boolean => {
    const s = window.getComputedStyle(e);
    const y = /^(auto|scroll)$/.test(s.overflowY) && e.scrollHeight > e.clientHeight + 1;
    const x = /^(auto|scroll)$/.test(s.overflowX) && e.scrollWidth > e.clientWidth + 1;
    return x || y;
  };
  let el: Element | null = document.elementFromPoint(pt.x, pt.y);
  while (el !== null && el !== document.documentElement && el !== document.body) {
    if (scrollable(el)) return el.scrollTop + el.scrollLeft;
    el = el.parentElement;
  }
  const root = document.scrollingElement ?? document.documentElement;
  return root.scrollTop + root.scrollLeft;
}

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

/**
 * BROWSER CODE — the classic "skip link" clipping idiom (#75): pulled to near-zero size, or off the
 * viewport by a large NEGATIVE offset (`position:absolute; left:-9999px`). Deliberately narrow:
 * ordinary below-the-fold content (positive offsets, reachable by scrolling) never matches.
 */
function isClippedOrPulledOffscreen(el: Element): boolean {
  const rect = (el as HTMLElement).getBoundingClientRect();
  if (rect.width <= 1 && rect.height <= 1) return true;
  return rect.left <= -1_000 || rect.top <= -1_000;
}

/**
 * A same-page anchor (`<a href="#…">` whose target is THIS page) that is visually hidden by the
 * clip-to-nothing idiom — a "Skip to content" link is the common case. Playwright's actionability
 * treats it as clickable (non-zero-ish box, not `display:none`), so without this check the gate lets
 * it through and the mission burns its budget on a control a sighted user never sees or reaches
 * (#75). Scoped to same-page anchors only — an off-screen control elsewhere stays eligible (scroll
 * ops reach it).
 */
async function isHiddenSamePageAnchor(
  handle: ElementHandle,
  control: Control,
  pageUrl: string,
): Promise<boolean> {
  if (control.tag !== "a" || control.href === null || control.href === undefined || control.href === "") return false;
  try {
    const link = new URL(control.href);
    const current = new URL(pageUrl);
    if (link.hash === "" || link.origin !== current.origin || link.pathname !== current.pathname) return false;
  } catch {
    return false;
  }
  return handle.evaluate(isClippedOrPulledOffscreen).catch(() => false);
}

/**
 * Re-checks actionability immediately before input. `count()` is bounded/instant by construction
 * (Playwright never waits for it); everything after resolves to a SINGLE element handle and checks
 * state on IT — one bounded round trip instead of three separate locator calls — so a target that
 * detaches between the decision and this check (a click that swaps in a form, a toast that closes:
 * #77) is caught here as a failed act, never left to wait out an actionability timeout and throw.
 */
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
  let handle: ElementHandle<SVGElement | HTMLElement>;
  try {
    handle = await locator.elementHandle({ timeout: GATE_TIMEOUT_MS });
  } catch (e) {
    return `target no longer present: ${(e as Error).message.split("\n")[0]}`;
  }
  try {
    let visible: boolean;
    let enabled: boolean;
    // Occlusion: a visible, enabled element can still be covered (a modal overlay, a sticky bar).
    // Clicking it would wait out Playwright's actionability timeout and then throw — so refuse it
    // up front, naming what covers it, exactly as a user could not click it either.
    // The SAME predicate the snapshot filter uses (./occlusion.ts), so the two never disagree.
    let cover: string | null;
    try {
      visible = await handle.isVisible();
      enabled = visible && (await handle.isEnabled());
      cover = visible ? await handle.evaluate(occluderOf) : null;
    } catch (e) {
      // The handle resolved a moment ago but the element is gone by now (detached mid-check) —
      // a normal UI transition, recorded as a failed act, never a throw (#77).
      return `target no longer present: ${(e as Error).message.split("\n")[0]}`;
    }
    if (!visible) return "target not visible";
    if (!enabled) return "target not enabled";
    if (cover !== null) return `target obscured by ${cover}`;
    if (await isHiddenSamePageAnchor(handle, control, page.url())) {
      return "target not actionable: visually-hidden skip link";
    }
    return null;
  } finally {
    await handle.dispose().catch(() => undefined);
  }
}

/**
 * What a `click` on `control` actually clicks (#90). A visually-hidden (sr-only) input is activated
 * the way a user does it — through its visible `<label>` (the gate has already probed occlusion at
 * that label: ./occlusion.ts); one with no visible label cannot be clicked by a user at all and is
 * refused up front, never left to wait out an actionability timeout. Anything else is clicked as is.
 */
async function clickTargetFor(actor: Actor, control: Control): Promise<{ target: Target } | { reason: string }> {
  const page = actor.ability(BrowseTheWebToken).session.page;
  const own = targetFor(control.descriptor);
  if (control.tag !== "input") return { target: own };
  const locator = descriptorToLocator(page, control.descriptor);
  const via = await locator.evaluate(srOnlyLabelOf, undefined, { timeout: GATE_TIMEOUT_MS }).catch(() => null);
  if (via === null) return { target: own };
  if ("none" in via) return { reason: "target not actionable: visually-hidden input with no visible label to click" };
  const name = `label of ${describe(control.descriptor)}`;
  if ("wrap" in via) {
    return {
      target: Target.named(name).locatedBy((p) => descriptorToLocator(p, control.descriptor).locator("xpath=ancestor::label[1]")),
    };
  }
  const id = via.for;
  const nth = via.nth;
  return { target: Target.named(name).locatedBy((p) => p.locator(`label[for=${JSON.stringify(id)}]`).nth(nth)) };
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
    return { ok: false, mutated: false, reason: `action failed: ${failureLine(message)}` };
  }
}

/**
 * The first line of an automation error — plus, when Playwright's log says another element took the
 * click ("<div class=overlay> intercepts pointer events"), that line too: it names what covered the
 * target, so the history says why and the strategy does not retry the same target blind (#90).
 */
export function failureLine(message: string): string {
  const lines = message.split("\n");
  const first = lines[0] ?? message;
  const intercept = lines.map((l) => l.trim().replace(/^-\s*/, "")).find((l) => /intercepts pointer events/.test(l));
  if (intercept === undefined || first.includes(intercept)) return first;
  return `${first} (${intercept.replace(/\s+from\s+<.*?>\s+subtree/, "").slice(0, 200)})`;
}

/**
 * Parses the element that intercepted a click out of Playwright's own failure text
 * ("<button aria-label=\"Close inspector\">…</button> intercepts pointer events") into a CSS
 * selector that finds the SAME element again — by its identifying attributes only (id, data-testid,
 * aria-label, name, role, class), never a bare tag name (that would match every `<div>` on the page).
 * Used to deprioritise every control the same interceptor covers until the page state changes (#90),
 * so a run does not keep re-choosing sibling targets under a backdrop that already refused one click.
 * Returns null when the message names no interception, or the element carries nothing to key on.
 */
export function parseInterceptor(message: string): string | null {
  const m = /<([a-zA-Z][\w-]*)\b([^>]*)>[\s\S]{0,300}?intercepts pointer events/.exec(message);
  if (m === null) return null;
  const tag = m[1]!.toLowerCase();
  const attrText = m[2] ?? "";
  const attrs: Array<[string, string]> = [];
  const attrRe = /([a-zA-Z_:][-\w:.]*)\s*=\s*"([^"]*)"/g;
  for (let a = attrRe.exec(attrText); a !== null; a = attrRe.exec(attrText)) attrs.push([a[1]!, a[2]!]);
  const priority = ["data-testid", "id", "aria-label", "name", "role", "class"];
  const chosen = priority
    .map((key) => attrs.find(([k]) => k === key))
    .filter((x): x is [string, string] => x !== undefined)
    .slice(0, 2);
  if (chosen.length === 0) return null;
  return `${tag}${chosen.map(([k, v]) => `[${k}=${JSON.stringify(v)}]`).join("")}`;
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
      const via = await clickTargetFor(actor, args.control);
      if ("reason" in via) return { ok: false, mutated: false, reason: via.reason };
      return dispatch(() => Click.on(via.target, { timeout: CLICK_TIMEOUT_MS }).performAs(actor));
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
          await Click.on(targetFor(submit.descriptor), { timeout: CLICK_TIMEOUT_MS }).performAs(actor);
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
    case "edit_text": {
      if (args.control === null) return { ok: false, mutated: false, reason: "edit_text needs a target" };
      if (args.edit === null || args.edit === undefined) {
        return { ok: false, mutated: false, reason: "edit_text has no edit (fail-closed)" };
      }
      const bad = await gate(actor, args.control);
      if (bad !== null) return { ok: false, mutated: false, reason: bad };
      const edit = args.edit;
      const descriptor = args.control.descriptor;
      // A quote no longer in the element fails here (thrown → a failed act), never a whole retype.
      return dispatch(() => applyTextEdit(page, descriptorToLocator(page, descriptor), edit));
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
      const viewport = page.viewportSize();
      const pt = { x: (viewport?.width ?? 0) / 2, y: (viewport?.height ?? 0) / 2 };
      // The wheel scrolls whatever is under the pointer — put it over the viewport centre first
      // (an inner overflow:auto pane there is what the wheel actually moves) rather than wherever
      // the mouse last was.
      const before: number | null = await page.evaluate(scrollPositionAt, pt).catch(() => null);
      await page.mouse.move(pt.x, pt.y).catch(() => undefined);
      await page.mouse.wheel(0, dy);
      // `mouse.wheel` does not wait for the scroll it dispatches (#109) — poll the same point's
      // scroll position until it settles to a new value, or give up after SCROLL_SETTLE_MS.
      let moved = false;
      if (before !== null) {
        const deadline = Date.now() + SCROLL_SETTLE_MS;
        do {
          const after: number = await page.evaluate(scrollPositionAt, pt).catch(() => before);
          if (after !== before) {
            moved = true;
            break;
          }
          await page.waitForTimeout(SCROLL_POLL_MS);
        } while (Date.now() < deadline);
      }
      return { ok: true, mutated: false, moved };
    }
    case "wait": {
      await page.waitForTimeout(WAIT_MS);
      return { ok: true, mutated: false };
    }
    case "reload":
      return reloadPage(page);
    case "done":
    case "report":
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
