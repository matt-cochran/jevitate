import type { ElementHandle, Locator, Page } from "playwright";
import { descriptorLocator } from "@jevitate/interpreter";
import { computeDescriptor, isSecretField, targetDisplay } from "@jevitate/recorder";
import type { TargetDescriptor, TargetDisplay } from "@jevitate/recording";
import { isCredentialField } from "./auth-completion.js";
import { markSecretFieldDescriptor } from "./credential-input.js";
import { clock } from "@jevitate/domain";
import { DEFAULT_BOUNDS } from "./bounds.js";
import { occluderOf } from "./occlusion.js";
import { MESSAGE_FIELD, MESSAGE_INPUT_TYPES, PAIRED_SUBMIT_DISTANCE, RECIPIENT_NAME, SUBMIT_NAME, composerEvidence } from "./composer-evidence.js";
import { redactControl, redactUrl } from "./redact.js";
import { markInRegion, readCheapNames, readControlFacts, readListItems } from "./snapshot-browser.js";
import { boundFacts, computeSignature, summarize } from "./snapshot-signature.js";
import type { DescribedFacts } from "./snapshot-signature.js";

/**
 * perceive: turn a live `Page` into an indexed table of interactive controls,
 * each with a durable `TargetDescriptor` (computed by `@jevitate/recorder`, so
 * it validates against the live page and replays), a per-step index Jev picks
 * by, and a role/name/state summary — plus a semantic freshness signature.
 *
 * The index is meaningful only WITHIN one snapshot (jev-ultrafast's freshness
 * discipline): Jev picks `controls[i]`, the loop acts on `controls[i].descriptor`,
 * and the NEXT step re-snapshots and re-indexes. The recording is written by
 * descriptor, never by index, so the emitted artifact is index-free.
 *
 * Only visible controls are surfaced — with ONE exception: an
 * `<input type=file>` is kept even when visually hidden, because the common
 * upload pattern hides the real input behind a styled label/dropzone. It is
 * surfaced with role `file-input` (plus its `accept` filter) so the model can
 * target it with the `upload` op. No other hidden element is exposed.
 *
 * Controls inside an OPEN shadow root (a web component) are perceived like light-DOM ones (#357):
 * the Playwright locator pierces open roots, and the visibility, modal, reachability and occlusion
 * checks see through them. A CLOSED shadow root is opaque — its controls are never offered.
 *
 * A control whose value cannot be described (`computeDescriptor` throws) is
 * dropped, never guessed. Candidates past `maxCandidates` are truncated and
 * therefore un-selectable — a target Jev never sees, it can never pick.
 */

export type Stability = "high" | "medium" | "low";

export interface Control {
  /** Stable index within THIS snapshot only. */
  readonly index: number;
  /** Durable, replay-valid descriptor (recorder-computed). */
  readonly descriptor: TargetDescriptor;
  readonly stability: Stability;
  /** `data-tflow-id` (#468): tracking metadata, copied off the descriptor; never used to find the control. */
  readonly tflowId?: string;
  /** The attribute the descriptor's testId came from (`data-testid`/`data-test`), when it has one. */
  readonly testIdAttr?: string;
  readonly role: string;
  readonly name: string;
  readonly tag: string;
  readonly inputType: string | null;
  readonly enabled: boolean;
  /** A native `<select>`'s selectable option labels (what a `select` may choose from). */
  readonly options?: readonly string[];
  /** A native `<select>`'s currently selected option label (#273: a select of it is a no-op). */
  readonly selected?: string | null;
  /** Model-facing one-liner (role/name/state). Never a raw secret value. */
  readonly summary: string;
  /**
   * The control's current value (#207) — exactly the one `summary` shows as `value="…"`: present
   * only for a non-secret value-bearing control (never a password / one-time-code field, and
   * cleared by `maskSecretFields` for a bound field). A form field's value is page content a
   * find-out answer may rest on. Absent/null when there is none.
   */
  readonly value?: string | null;
  /**
   * The form the control belongs to (`form#<id>` or `form@<n>`, the form's position in the
   * document), or null when it sits in no `<form>`. Absent on controls built outside `snapshot`.
   */
  readonly form?: string | null;
  /**
   * The nearest form-LIKE container (`[role=form]`, `dialog`, `fieldset`, `section`) — computed
   * only for a control with no `<form>` owner (#121). Lets a field-and-submit pairing survive on a
   * page built without `<form>` elements (a settings toolbar in a `<section>`) without merging
   * every unrelated form-less control on the page into one bucket (a global header search must
   * never be paired with an unrelated "Send feedback" in a different section).
   */
  readonly container?: string | null;
  /**
   * The nearest named dialog / alertdialog / region the control sits in, as the model reads it —
   * `alertdialog "Confirm analysis"` (#182). Tells same-named controls apart ("Analyze" the trigger
   * vs "Analyze" the confirm); never part of the signature or the descriptor.
   */
  readonly scope?: string | null;
  /**
   * #519: whether the control sits inside the run's declared scope region (`--scope-region`, or the
   * Journey anchor's `region`). Present on every control only when a region is declared; never part
   * of the signature or the descriptor.
   */
  readonly inRegion?: boolean;
  /**
   * #356: the text of the nearest VISIBLE heading before the control in document order (the
   * heading of the screen / section it sits under), or null. Part of the repeat guard's action
   * identity: two same-labelled controls under different headings on one route (an SPA's two
   * screens) are different actions. Never part of the signature or the descriptor.
   */
  readonly heading?: string | null;
  /** True for a control that submits its form (a submit button / `<input type=submit|image>`). */
  readonly submits?: boolean;
  /** A link's resolved destination (`a[href]`), so a mission can tell where it leads without clicking. */
  readonly href?: string | null;
  /** A checkbox/radio's checked state; `null`/absent for a control with no such state. */
  readonly checked?: boolean | null;
  /** The raw `aria-haspopup` value (e.g. `dialog`), or null — marks a control that discloses more UI. */
  readonly ariaHasPopup?: string | null;
  /** The raw `aria-current` value (e.g. `page`, `true`), or null — marks the current nav item (#127). */
  readonly ariaCurrent?: string | null;
  /** The raw `min` attribute (number/date/range…), or null — for type-appropriate boundary values (#121). */
  readonly min?: string | null;
  /** The raw `max` attribute, or null. */
  readonly max?: string | null;
  /** The raw `step` attribute, or null. */
  readonly step?: string | null;
  /**
   * The page-chrome landmark the control sits in — `navigation` (`<nav>`), `banner` (a page-level
   * `<header>`) or `contentinfo` (a page-level `<footer>`) — or null. Frontier missions try such
   * controls only after the page's own content (#115).
   */
  readonly landmark?: "navigation" | "banner" | "contentinfo" | null;
  /**
   * True for a rich-text (`contenteditable`) element — not an input/textarea (#148). Such a control
   * is also offered `edit_text`: an edit INSIDE its text (at a quoted anchor), not a full retype.
   */
  readonly richText?: boolean;
  /**
   * #370: for a message-named (`MESSAGE_FIELD`) text field only — whether the page shows
   * conversational evidence around it (a transcript, or a Send control paired with it; see
   * `composerEvidence`). Only such a field is a chat composer (`sendable`); absent on every other
   * control, and on controls built outside `snapshot`.
   */
  readonly conversational?: boolean;
  /**
   * True when the element's own box is clipped to near-nothing or pulled far off-screen by a
   * large NEGATIVE offset — the classic sr-only "skip to content" clipping idiom (#75, #161).
   * Mirrors `act.ts`'s `isClippedOrPulledOffscreen` (the gate's own click-time check), computed
   * once here so a PLANNING-time candidate list (the adversarial strategies, which never go
   * through the coverage frontier's blacklist) can exclude it from the start, instead of only
   * finding out after `act()`'s gate refuses it. Deliberately narrow: ordinary below-the-fold
   * content (a positive offset, reachable by scrolling) never matches.
   */
  readonly clippedOffscreen?: boolean;
}

export interface Snapshot {
  readonly url: string;
  readonly controls: Control[];
  /** True when more interactive controls existed than `maxCandidates` allowed. */
  readonly truncated: boolean;
  /**
   * #447: why visible controls were left out of `controls` besides the candidate limit (`truncated`):
   * behind an open modal (#272), out of reach off-screen (#294), covered by another element. Absent
   * when none was — then `controls` (with `truncated` false) is the page's whole control inventory.
   */
  readonly dropped?: readonly string[];
  /** #519: how many elements matched the declared scope region(s). Present only when one is declared. */
  readonly region?: { readonly matched: number };
  /** Semantic freshness signature (document url + viewport + safe control state). */
  readonly signature: string;
}

export interface SnapshotOptions {
  readonly maxCandidates?: number;
  /**
   * #192: options kept per long list (a picker's ≈250 countries). Past it, an option is kept only
   * when `mentioned` names it, so the list cannot crowd out the page's other controls (the dialog's
   * Save) from the `maxCandidates` budget. Default `LIST_OPTION_CAP`.
   */
  readonly listOptionCap?: number;
  /** Does the run's goal (or recent history) name this control? Such an option is always kept. */
  readonly mentioned?: (name: string) => boolean;
  /**
   * #219: the run's registered secret values. Every control's page content (name, summary, value,
   * scope, href) is scrubbed of them as it is read (`redactControl`), so no consumer of the
   * snapshot ever holds a secret the page merely displays. Default none.
   */
  readonly secrets?: readonly string[];
  /**
   * #519: the run's scope region(s). Every control is tagged `inRegion`, and in-region controls are
   * read first so the `maxCandidates` bound never crowds them out. Default none.
   */
  readonly regions?: readonly TargetDescriptor[];
  /**
   * #278: wall-clock bound (ms) on reading the controls. A page with hundreds of clickable elements
   * (a heatmap of words) costs a few live queries per control; past the bound the rest are left
   * unread and the snapshot says so (`truncated`), so one perception never outlasts a mission's
   * stall watchdog. Default `SNAPSHOT_BUDGET_MS`.
   */
  readonly budgetMs?: number;
  /**
   * #372: re-reads after a navigation replaced the page mid-read (an "execution context destroyed"
   * error). Default `NAVIGATION_RETRIES`; past it the read fails with `PageNavigatingError`.
   */
  readonly navigationRetries?: number;
  /** #372: bound (ms) on all the navigation waits of one snapshot. Default `NAVIGATION_WAIT_MS`. */
  readonly navigationWaitMs?: number;
  /**
   * #372: how to wait for the navigation that interrupted a read to settle, given the time left
   * (ms). Default: the new document's `load`. `perceive` passes its shared settle rule.
   */
  readonly awaitNavigation?: (remainingMs: number) => Promise<void>;
}

/** Re-reads a snapshot gets after a navigation interrupted it (#372). */
export const NAVIGATION_RETRIES = 3;

/** Default bound (ms) on the navigation waits of one snapshot (#372) — the default render ceiling. */
export const NAVIGATION_WAIT_MS = 15_000;

/**
 * #372: the page kept navigating — every read of its controls (`NAVIGATION_RETRIES` re-reads after
 * waiting for the navigation to settle) was cut off by another navigation. A typed signal the
 * caller turns into a fail-closed outcome; never an engine crash.
 */
export class PageNavigatingError extends Error {
  override readonly name = "PageNavigatingError";
  constructor(
    readonly url: string,
    readonly attempts: number,
    cause: unknown,
  ) {
    super(`the page kept navigating: its controls could not be read in ${attempts} attempts (last at ${redactUrl(url)})`, { cause });
  }
}

/**
 * #372: true when `e` is a page read cut off because a NAVIGATION replaced the document (its
 * execution context was destroyed) — a signal to wait and re-read. A closed page, context or
 * browser ("Target page, context or browser has been closed") is NOT this: it propagates.
 */
export function isNavigationInterruption(e: unknown): boolean {
  const message = e instanceof Error ? e.message : String(e);
  if (/Target page, context or browser has been closed|Target closed/i.test(message)) return false;
  return /Execution context was destroyed|Cannot find context with specified id/.test(message);
}

/** Default bound (ms) on reading a snapshot's controls (#278). */
export const SNAPSHOT_BUDGET_MS = 30_000;

/** Options kept per long list before only the goal-named ones are (#192). */
export const LIST_OPTION_CAP = 25;

const LIST_OPTION_ROLES = new Set(["option", "menuitem", "menuitemradio", "menuitemcheckbox", "treeitem"]);

/** The interactive controls the loop considers. Lean, per P1 (spec §9). */
const INTERACTIVE_SELECTOR = [
  "a[href]",
  "button",
  "input:not([type=hidden])",
  "select",
  "textarea",
  "[role=button]",
  "[role=link]",
  "[role=textbox]",
  "[role=checkbox]",
  "[role=combobox]",
  // Custom pickers, menus and tab bars (component-library ARIA widgets): their items are what a user
  // clicks, so a mission must see them (#192). Long lists are capped per list (`listOptionCap`).
  "[role=option]",
  "[role=menuitem]",
  "[role=menuitemradio]",
  "[role=menuitemcheckbox]",
  "[role=tab]",
  "[role=radio]",
  "[role=switch]",
  "[role=treeitem]",
  "[contenteditable=true]",
  // #287: a disclosure's summary ("Analysis & diagnostics") is what a user clicks to expand it.
  "details > summary",
].join(",");

/** #287: controls the goal names that are still kept past `maxCandidates` (never crowded out). */
const MENTIONED_PAST_CAP = 10;

function readControlValue(node: Node): string {
  return String((node as HTMLInputElement).value ?? "");
}

/**
 * Reads the page's controls. #372: the ONE place a read cut off by a navigation (a server redirect
 * then a client `location.replace` on load) is retried — every caller (`perceive`, so every
 * mission; invariants; screenshots) gets it. Bounded: `navigationRetries` re-reads, all waits within
 * `navigationWaitMs`; then `PageNavigatingError`. Any other error propagates unchanged.
 */
/**
 * #497: each perceived control's display (its role + visible label), keyed by the control's own
 * descriptor object. Kept OFF the descriptor on purpose: a control's descriptor is its identity
 * (`JSON.stringify(c.descriptor)` keys the repeat guard and "is the last target still here"), and a
 * label that changes on click ("Save" → "Saving…") must not make it a different control. The
 * recorder (`record.ts`) reads it when a step on that control is recorded.
 */
const CONTROL_DISPLAY = new WeakMap<TargetDescriptor, TargetDisplay>();

/** The display perceived for the control whose descriptor this is, if any (#497). */
export function controlDisplay(descriptor: TargetDescriptor): TargetDisplay | undefined {
  return CONTROL_DISPLAY.get(descriptor);
}

/**
 * #789: the role and accessible name of one resolved element, read exactly as a mission reads a
 * control's (`readControlFacts`), so a replay's refusals judge what a mission's judge.
 */
export async function readControlIdentity(element: Locator | ElementHandle): Promise<{ readonly name: string; readonly role: string }> {
  const { name, role } = await (element as Locator).evaluate(readControlFacts);
  return { name, role };
}

export async function snapshot(page: Page, opts?: SnapshotOptions): Promise<Snapshot> {
  const retries = opts?.navigationRetries ?? NAVIGATION_RETRIES;
  const deadline = clock.now() + (opts?.navigationWaitMs ?? NAVIGATION_WAIT_MS);
  const awaitNavigation =
    opts?.awaitNavigation ??
    (async (remainingMs: number): Promise<void> => {
      await page.waitForLoadState("load", { timeout: Math.max(1, remainingMs) }).catch(() => undefined);
    });
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await readSnapshot(page, opts);
    } catch (e) {
      if (!isNavigationInterruption(e)) throw e;
      const remaining = deadline - clock.now();
      if (attempt > retries || remaining <= 0 || page.isClosed()) throw new PageNavigatingError(page.url(), attempt, e);
      await awaitNavigation(remaining);
    }
  }
}

async function readSnapshot(page: Page, opts?: SnapshotOptions): Promise<Snapshot> {
  const maxCandidates = opts?.maxCandidates ?? DEFAULT_BOUNDS.maxCandidates;
  const url = page.url();
  const viewport = page.viewportSize();
  const handles = await page.locator(INTERACTIVE_SELECTOR).elementHandles();

  const controls: Control[] = [];
  const keptFacts: DescribedFacts[] = [];
  let truncated = false;
  const dropped = new Set<string>();
  const listOptionCap = opts?.listOptionCap ?? LIST_OPTION_CAP;
  // #192: one in-page pass over every candidate finds the items of ARIA lists (options, menu items,
  // tabs, radios…) that are invisible, or past their list's cap and not named by the goal — skipped
  // without a per-element round trip, so a 300-item picker costs one evaluation, not 300.
  const listItems = await page
    .locator(INTERACTIVE_SELECTOR)
    .evaluateAll(readListItems, [...LIST_OPTION_ROLES])
    .catch(() => null);
  const skip: boolean[] = [];
  const skipReason: Array<"hidden" | "capped" | undefined> = [];
  if (listItems !== null && listItems.length === handles.length) {
    const perList = new Map<number, number>();
    listItems.forEach((it, i) => {
      if (it === null) return;
      if (!it.visible) {
        skip[i] = true;
        skipReason[i] = "hidden";
        return;
      }
      const n = (perList.get(it.list) ?? 0) + 1;
      perList.set(it.list, n);
      if (n > listOptionCap && opts?.mentioned?.(it.name) !== true) {
        skip[i] = true;
        skipReason[i] = "capped";
      }
    });
  }
  // Bounded: a page with thousands of candidates never turns perception into a crawl.
  let evaluated = 0;
  const maxEvaluated = maxCandidates * 4;
  // #287: past the cap, a control the goal names is still kept (bounded) — a disclosure below the
  // first `maxCandidates` controls must never be unreachable. Its name is read cheaply, in one pass.
  const mentioned = opts?.mentioned;
  const cheapNames =
    mentioned !== undefined && handles.length > maxCandidates
      ? await page.locator(INTERACTIVE_SELECTOR).evaluateAll(readCheapNames).catch(() => null)
      : null;
  let pastCap = 0;
  // #278: wall-clock bound on reading controls. Past it (as past the count cap) only the bounded
  // #287 goal-named rescue is still read, so perception stays well inside the stall watchdog.
  const deadline = clock.now() + (opts?.budgetMs ?? SNAPSHOT_BUDGET_MS);

  // #519: resolve the scope region(s) once per read (no polling: a region absent now is absent) and
  // tag every candidate in/out of it in one in-page pass — never guessed.
  const regionDescs = opts?.regions ?? [];
  let regionMatched = 0;
  let inRegion: boolean[] | null = null;
  if (regionDescs.length > 0) {
    const regionHandles: ElementHandle<Node>[] = [];
    try {
      for (const d of regionDescs) {
        // A descriptor with no usable rung throws synchronously; like a miss, it matches nothing.
        const found = await Promise.resolve()
          .then(() => descriptorLocator(page, d).elementHandles())
          .catch(() => []);
        regionHandles.push(...found);
      }
      regionMatched = regionHandles.length;
      const read =
        regionHandles.length === 0
          ? handles.map(() => false)
          : await page
              .locator(INTERACTIVE_SELECTOR)
              // Playwright serializes the handles in the array arg back into the page's elements.
              .evaluateAll(markInRegion, regionHandles)
              .catch(() => null);
      if (read === null || read.length !== handles.length) {
        // The page changed between the two reads (or the pass failed): nothing is claimed in-region.
        dropped.add("scope region changed mid-read");
        inRegion = handles.map(() => false);
      } else {
        inRegion = read;
      }
    } finally {
      await Promise.all(regionHandles.map((h) => h.dispose().catch(() => undefined)));
    }
  }
  // In-region candidates first, so the `maxCandidates` bound never crowds them out.
  const order = handles.map((_, i) => i);
  if (inRegion !== null) {
    const tags = inRegion;
    order.sort((a, b) => Number(tags[b]) - Number(tags[a]) || a - b);
  }

  for (const i of order) {
    const handle = handles[i] as (typeof handles)[number];
    try {
      if (controls.length >= maxCandidates || evaluated >= maxEvaluated || clock.now() > deadline) {
        truncated = true;
        const name = cheapNames !== null && cheapNames.length === handles.length ? cheapNames[i] : undefined;
        if (pastCap >= MENTIONED_PAST_CAP || name === undefined || name === "" || mentioned?.(name) !== true) continue;
        pastCap += 1;
      }
      if (skip[i] === true) {
        truncated = truncated || skipReason[i] === "capped";
        continue;
      }
      evaluated += 1;
      const raw = boundFacts(await handle.evaluate(readControlFacts), opts?.secrets ?? []);
      // Hidden file inputs are the sole exception (see the module doc).
      if (!raw.visible && raw.inputType !== "file") continue;
      // #272: behind an open modal — never offered (a click there is intercepted by the modal).
      if (raw.outsideModal) {
        dropped.add("controls behind an open modal");
        continue;
      }
      // #294: a control no scroll can bring into view (a closed panel translated off-screen) is not
      // actionable — never offered (a hidden file input stays: `upload` needs no visible element).
      if (raw.unreachable && raw.inputType !== "file") {
        dropped.add("controls out of reach off-screen");
        continue;
      }
      // Occlusion — the ONE shared predicate (./occlusion.ts), also used by act()'s gate: a control
      // a user cannot click (covered by an overlay, or by an ancestor at its own centre) is not
      // offered. Off-screen controls stay eligible (scroll ops reach them) unless a fixed layer (a
      // dialog's backdrop) would still cover them once scrolled into view (#397).
      if (raw.inputType !== "file" && (await handle.evaluate(occluderOf)) !== null) {
        dropped.add("controls covered by another element");
        continue;
      }
      // The value leaves the page only for a control the shared predicate says
      // is NOT a secret (type=password, a password/one-time-code autocomplete —
      // which catches a revealed "show password" field — or a credential-named
      // control such as "API key" or "Card number", #564).
      const value =
        raw.valueBearing && !isSecretField(raw.inputType, raw.autocomplete, [raw.name])
          ? await handle.evaluate(readControlValue)
          : null;
      const facts: DescribedFacts = { ...raw, value };
      // #370: a message-named text field is a composer only with conversational evidence on the page.
      const textEntry =
        raw.tag === "textarea" || (raw.tag === "input" && MESSAGE_INPUT_TYPES.has(raw.inputType ?? "")) || raw.role === "textbox";
      const conversational =
        textEntry && MESSAGE_FIELD.test(raw.name)
          ? await handle
              .evaluate(composerEvidence, { submit: SUBMIT_NAME.source, distance: PAIRED_SUBMIT_DISTANCE, recipient: RECIPIENT_NAME.source })
              .catch(() => false)
          : null;
      // computeDescriptor validates against the live page and throws if nothing
      // resolves uniquely — an un-describable control is dropped, never guessed.
      const computed = await computeDescriptor(page, handle, { primaryOnly: true });
      const control: Control = {
        index: controls.length,
        descriptor: computed.descriptor,
        stability: computed.stability,
        ...(computed.descriptor.tflowId === undefined ? {} : { tflowId: computed.descriptor.tflowId }),
        ...(computed.descriptor.testIdAttr === undefined ? {} : { testIdAttr: computed.descriptor.testIdAttr }),
        role: facts.role,
        name: facts.name,
        tag: facts.tag,
        inputType: facts.inputType,
        enabled: facts.enabled,
        ...(facts.options === null ? {} : { options: facts.options }),
        ...(facts.selected === null ? {} : { selected: facts.selected }),
        summary: summarize(facts),
        ...(facts.value === null || facts.value === "" ? {} : { value: facts.value }),
        form: facts.form,
        container: facts.container,
        scope: facts.scope,
        heading: facts.heading,
        submits: facts.submits,
        // Only the path matters (scope checks); sensitive query values are masked like every URL.
        href: facts.href === null ? null : redactUrl(facts.href),
        checked: facts.checked,
        ariaHasPopup: facts.ariaHasPopup,
        ariaCurrent: facts.ariaCurrent,
        min: facts.min,
        max: facts.max,
        step: facts.step,
        landmark: facts.landmark,
        ...(facts.richText ? { richText: true } : {}),
        ...(conversational === null ? {} : { conversational }),
        ...(facts.clippedOffscreen ? { clippedOffscreen: true } : {}),
        ...(inRegion === null ? {} : { inRegion: inRegion[i] === true }),
      };
      const kept = redactControl(control, opts?.secrets ?? []);
      // #497: the label a person sees on it (role + accessible name), for the Recording only — never a
      // credential field's, never one holding a secret (`targetDisplay` refuses both).
      const display = targetDisplay(
        { role: facts.role === "file-input" ? null : facts.role, name: facts.name },
        { secretField: isSecretField(raw.inputType, raw.autocomplete, [raw.name]) || isCredentialField(control), secrets: opts?.secrets ?? [] },
      );
      if (display !== undefined) CONTROL_DISPLAY.set(kept.descriptor, display);
      // A value typed into a secret field is recorded redacted, whatever its source (`credential-input.ts`).
      if (isSecretField(raw.inputType, raw.autocomplete, [raw.name])) markSecretFieldDescriptor(kept.descriptor);
      controls.push(kept);
      keptFacts.push(facts);
    } catch (e) {
      // #372: the document itself was replaced — the whole read is stale; `snapshot` re-reads.
      if (isNavigationInterruption(e)) throw e;
      // not describable / detached mid-read — skip it.
    } finally {
      await handle.dispose().catch(() => undefined);
    }
  }

  return {
    url,
    controls,
    truncated,
    ...(dropped.size === 0 ? {} : { dropped: [...dropped] }),
    ...(regionDescs.length === 0 ? {} : { region: { matched: regionMatched } }),
    signature: computeSignature(url, viewport, keptFacts),
  };
}
