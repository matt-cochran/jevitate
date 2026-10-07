import type { Page } from "playwright";
import { computeDescriptor, isSecretField } from "@jevitate/recorder";
import type { TargetDescriptor } from "@jevitate/recording";
import { contentHash, clock } from "@jevitate/domain";
import { DEFAULT_BOUNDS } from "./bounds.js";
import { occluderOf } from "./occlusion.js";
import { MESSAGE_FIELD, MESSAGE_INPUT_TYPES, PAIRED_SUBMIT_DISTANCE, SUBMIT_NAME, composerEvidence } from "./composer-evidence.js";
import { redactControl, redactUrl } from "./redact.js";
import { TEMPORAL_FORMATS, isTemporalInputType } from "./temporal-value.js";

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

/** Raw per-control facts gathered in-page (safe values only). */
interface ControlFacts {
  readonly tag: string;
  readonly inputType: string | null;
  readonly role: string;
  readonly name: string;
  readonly enabled: boolean;
  readonly checked: boolean | null;
  /** The raw `autocomplete` attribute (a secret marker), or null. */
  readonly autocomplete: string | null;
  /**
   * True for a control whose value can be described (textarea, or a non-hidden,
   * non-file, non-button input). The value itself is NOT read here — it is read
   * in a second step, and only when `isSecretField` says the control is not a
   * secret (see `snapshot`).
   */
  readonly valueBearing: boolean;
  readonly visible: boolean;
  /** A file input's `accept` filter (e.g. `image/*`); null for every other control. */
  readonly accept: string | null;
  /** A `<select>`'s enabled, non-placeholder option labels; null for every other control. */
  readonly options: string[] | null;
  /** A `<select>`'s selected option label; null for every other control. */
  readonly selected: string | null;
  /** The owning form's key (`form#<id>` / `form@<n>`), or null. */
  readonly form: string | null;
  /** The nearest form-like container's key, computed only when `form` is null. See `Control.container`. */
  readonly container: string | null;
  /** The nearest named dialog/region, as the model reads it. See `Control.scope`. */
  readonly scope: string | null;
  /** The nearest visible heading before the control. See `Control.heading`. */
  readonly heading: string | null;
  /** Whether activating the control submits its form. */
  readonly submits: boolean;
  /** A link's resolved `href`, or null. */
  readonly href: string | null;
  /** The raw `aria-haspopup` attribute, or null — a disclosure signal (e.g. `dialog`). */
  readonly ariaHasPopup: string | null;
  /** The raw `aria-current` attribute, or null — marks the current nav item (#127). */
  readonly ariaCurrent: string | null;
  /** The raw `min` attribute, or null. */
  readonly min: string | null;
  /** The raw `max` attribute, or null. */
  readonly max: string | null;
  /** The raw `step` attribute, or null. */
  readonly step: string | null;
  /** The enclosing chrome landmark (`navigation` / `banner` / `contentinfo`), or null. */
  readonly landmark: "navigation" | "banner" | "contentinfo" | null;
  /** A rich-text (`contenteditable`, not input/textarea) element. See `Control.richText`. */
  readonly richText: boolean;
  /** See `Control.clippedOffscreen` (#75, #161). */
  readonly clippedOffscreen: boolean;
  /**
   * #272: a modal is open (`dialog:modal`, a visible `[aria-modal=true]`, or an open `<dialog>`
   * drawn as a fixed overlay over much of the viewport) and this control is outside it — a user
   * cannot reach it until the modal is dismissed, wherever it sits (even below the fold, where the
   * centre-point occlusion probe cannot see the overlay).
   */
  readonly outsideModal: boolean;
  /**
   * #294: the control's box lies wholly outside what the page can ever bring into view — a fixed
   * element (or one in a fixed panel, like a closed drawer translated off-screen) outside the
   * viewport, or an in-flow element outside the document's scrollable area. Never judged inside a
   * scroll container (scrolling it may reach the control) or for a visually-hidden (sr-only) one.
   */
  readonly unreachable: boolean;
  /** #287: a disclosure summary's state (its `<details>` open); null for every other control. */
  readonly expanded: boolean | null;
}

/**
 * BROWSER CODE — serialized by `handle.evaluate`: no imports, no closure over
 * module scope. Reads only *safe* facts: NO control's value is read here. The
 * secret decision (`isSecretField`, the predicate `@jevitate/recorder`'s
 * in-page capture listener also uses) is made Node-side from `inputType` +
 * `autocomplete`, and only a non-secret control's value is then fetched by
 * `readControlValue` — so a secret's plaintext cannot reach Node from here.
 */
function readControlFacts(node: Node): ControlFacts {
  const el = node as Element;
  const norm = (s: string | null): string => (s === null ? "" : s.replace(/\s+/g, " ").trim());
  const tag = el.tagName.toLowerCase();
  const inputType = tag === "input" ? String((el as HTMLInputElement).type || "").toLowerCase() : null;
  // #357: a control inside an OPEN shadow root has ancestors across the boundary (its host, and the
  // host's own ancestors) — fixed panels, modals and landmarks are judged through it.
  const parentOf = (a: Element): Element | null =>
    a.parentElement ?? (a.parentNode instanceof ShadowRoot ? a.parentNode.host : null);
  const holds = (a: Element, b: Element): boolean => {
    for (let n: Element | null = b; n !== null; n = parentOf(n)) if (n === a) return true;
    return false;
  };

  const style = window.getComputedStyle(el as HTMLElement);
  const rect = (el as HTMLElement).getBoundingClientRect();
  // Rendered only; whether it is COVERED is decided separately by the shared `occluderOf`
  // predicate (./occlusion.ts) — the same one the pre-click act() gate uses.
  const visible =
    style.visibility !== "hidden" &&
    style.display !== "none" &&
    rect.width > 0 &&
    rect.height > 0;
  // The sr-only "skip link" clipping idiom (#75, #161) — mirrors `act.ts`'s
  // `isClippedOrPulledOffscreen` exactly (kept in sync by hand: BROWSER CODE here cannot import
  // it). A `visible` control per the check above (non-zero box, not display:none) can still be
  // clipped to near-nothing or pulled off-screen by a large negative offset.
  const clippedOffscreen = (rect.width <= 1 && rect.height <= 1) || rect.left <= -1_000 || rect.top <= -1_000;
  // #272: the open modal(s) — a control outside every one is behind it, however far down it sits.
  const modals = Array.from(document.querySelectorAll('dialog[open], [aria-modal="true"]')).filter((m) => {
    const ms = window.getComputedStyle(m as HTMLElement);
    const mr = (m as HTMLElement).getBoundingClientRect();
    if (ms.display === "none" || ms.visibility === "hidden" || mr.width <= 0 || mr.height <= 0) return false;
    if (m.tagName.toLowerCase() !== "dialog") return true;
    let modal = false;
    try {
      modal = m.matches(":modal");
    } catch {
      modal = false;
    }
    // A non-modal `<dialog open>` blocks the page only when it is drawn as an overlay (fixed, large).
    return modal || (ms.position === "fixed" && mr.width * mr.height >= 0.25 * window.innerWidth * window.innerHeight);
  });
  const outsideModal = modals.length > 0 && !modals.some((m) => holds(m, el));
  // #294: wholly outside what scrolling can ever bring into view.
  let unreachable = false;
  if (!clippedOffscreen && rect.width > 0 && rect.height > 0) {
    let fixedBox: DOMRect | null = null;
    let scroller = false;
    for (let a: Element | null = el; a !== null && a !== document.documentElement; a = parentOf(a)) {
      const s = window.getComputedStyle(a as HTMLElement);
      if (s.position === "fixed") {
        fixedBox = (a as HTMLElement).getBoundingClientRect();
        break;
      }
      if (a !== el && a !== document.body && /(auto|scroll)/.test(`${s.overflowX} ${s.overflowY}`)) scroller = true;
    }
    const outside = (r: DOMRect, w: number, h: number, dx: number, dy: number): boolean =>
      r.right + dx <= 0 || r.bottom + dy <= 0 || r.left + dx >= w || r.top + dy >= h;
    if (fixedBox !== null) {
      // A fixed panel never scrolls: off the viewport (itself or the control in it) is unreachable.
      unreachable =
        outside(fixedBox, window.innerWidth, window.innerHeight, 0, 0) ||
        (!scroller && outside(rect, window.innerWidth, window.innerHeight, 0, 0));
    } else if (!scroller) {
      const root = document.scrollingElement ?? document.documentElement;
      unreachable = outside(rect, root.scrollWidth, root.scrollHeight, window.scrollX, window.scrollY);
    }
  }

  const roleAttr = norm(el.getAttribute("role")).split(" ")[0] ?? "";
  const roleByTag: Record<string, string> = {
    a: "link",
    button: "button",
    select: "combobox",
    textarea: "textbox",
    summary: "button",
  };
  const roleByInput: Record<string, string> = {
    button: "button",
    submit: "button",
    reset: "button",
    checkbox: "checkbox",
    radio: "radio",
    text: "textbox",
    email: "textbox",
    search: "searchbox",
    tel: "textbox",
    url: "textbox",
    password: "textbox",
    number: "spinbutton",
  };
  let role = roleAttr;
  // A file input is always `file-input` (the `upload` op's target), whatever
  // role attribute it carries — so the model recognises it unambiguously.
  if (inputType === "file") role = "file-input";
  else if (role === "") {
    if (tag === "input") role = roleByInput[inputType ?? "text"] ?? "textbox";
    else role = roleByTag[tag] ?? "";
  }

  // Accessible-name approximation: aria-label -> label -> text -> placeholder -> value(button-ish).
  const ariaLabel = norm(el.getAttribute("aria-label"));
  let labelText = "";
  const labels = (el as unknown as { labels?: NodeListOf<HTMLLabelElement> }).labels;
  // A label that WRAPS a select also "contains" every option's text: strip the control's own text.
  const ownText = tag === "select" ? norm(el.textContent) : "";
  const labelOf = (l: Element): string => {
    const t = norm(l.textContent);
    return ownText !== "" && l.contains(el) ? norm(t.replace(ownText, " ")) : t;
  };
  if (labels && labels.length > 0) labelText = labelOf(labels[0]!);
  else {
    const owner = el.closest("label");
    if (owner) labelText = labelOf(owner);
  }
  const placeholder = norm(el.getAttribute("placeholder"));
  const buttonish = inputType === "button" || inputType === "submit" || inputType === "reset";
  const nameCandidates = [
    ariaLabel,
    labelText,
    // A select's own text is every option label run together — never its name.
    tag === "select" ? "" : norm(el.textContent),
    placeholder,
    buttonish ? norm((el as HTMLInputElement).value) : "",
  ];
  const name = nameCandidates.find((c) => c !== "") ?? "";

  const enabled = !(el as HTMLInputElement).disabled;
  const checked =
    inputType === "checkbox" || inputType === "radio" ? (el as HTMLInputElement).checked : null;

  const OPAQUE = new Set(["hidden", "file"]);
  const valueBearing =
    tag === "textarea" || (tag === "input" && inputType !== null && !OPAQUE.has(inputType) && !buttonish);
  const autocomplete = el.getAttribute("autocomplete");

  const accept = inputType === "file" ? norm(el.getAttribute("accept")) : null;

  let options: string[] | null = null;
  let selected: string | null = null;
  if (tag === "select") {
    const sel = el as HTMLSelectElement;
    options = Array.from(sel.options)
      .filter((o) => !o.disabled && o.value !== "")
      .map((o) => norm(o.label || o.text).slice(0, 200))
      .filter((o) => o !== "")
      .slice(0, 100);
    const cur = sel.selectedIndex >= 0 ? sel.options[sel.selectedIndex] : undefined;
    selected = cur === undefined ? null : norm(cur.label || cur.text);
  }

  // Form membership: the element's own form owner (honours the `form=` attribute), else the
  // nearest enclosing <form>. Keyed by id when it has one, else by its position in the document.
  const owner = (el as HTMLInputElement).form ?? el.closest("form");
  let form: string | null = null;
  if (owner !== null) {
    form = owner.id !== "" ? `form#${owner.id}` : `form@${Array.from(document.forms).indexOf(owner)}`;
  }
  // Form-LIKE container (#121): only computed when the control has no <form> owner. Lets a page
  // built without <form> elements still pair a field with its OWN submit (a settings section, a
  // dialog) instead of every form-less control on the page collapsing into one "page" bucket — the
  // bug behind pairing a global header search with an unrelated "Send feedback" button.
  let container: string | null = null;
  if (owner === null) {
    const CONTAINER_SELECTOR = '[role="form"], dialog, [role="dialog"], fieldset, section';
    const containerEl = el.closest(CONTAINER_SELECTOR);
    if (containerEl !== null) {
      const containerRole = norm(containerEl.getAttribute("role")).toLowerCase();
      const containerTag = containerEl.tagName.toLowerCase();
      const kind = containerRole === "form" ? "role-form" : containerRole === "dialog" ? "dialog" : containerTag;
      if (containerEl.id !== "") container = `${kind}#${containerEl.id}`;
      else {
        const all = Array.from(document.querySelectorAll(CONTAINER_SELECTOR));
        container = `${kind}@${all.indexOf(containerEl)}`;
      }
    }
  }
  // #182: the nearest dialog / region, named — what tells a trigger from its same-named confirm.
  let scope: string | null = null;
  const scopeEl = el.closest('dialog, [role="dialog"], [role="alertdialog"], [role="region"], section[aria-label], section[aria-labelledby], form[aria-label]');
  if (scopeEl !== null) {
    const kind = norm(scopeEl.getAttribute("role")).toLowerCase() || (scopeEl.tagName.toLowerCase() === "section" ? "region" : scopeEl.tagName.toLowerCase());
    const labelledBy = norm(scopeEl.getAttribute("aria-labelledby"))
      .split(" ")
      .filter((id) => id !== "")
      .map((id) => norm(document.getElementById(id)?.textContent ?? ""))
      .join(" ");
    const heading = norm(scopeEl.querySelector("h1, h2, h3, h4")?.textContent ?? "");
    const label = (norm(scopeEl.getAttribute("aria-label")) || labelledBy || heading).slice(0, 60);
    scope = label === "" ? kind : `${kind} "${label}"`;
  }
  // #356: the heading the control sits under — the last visible heading before it in document
  // order (a heading that CONTAINS the control is not before it). A hidden screen's heading is skipped.
  let sectionHeading: string | null = null;
  for (const h of Array.from(document.querySelectorAll('h1, h2, h3, h4, h5, h6, [role="heading"]'))) {
    if (h.contains(el)) continue;
    if ((h.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING) === 0) break;
    const t = norm(h.textContent);
    if (t !== "" && h.getClientRects().length > 0) sectionHeading = t.slice(0, 120);
  }
  const buttonType = tag === "button" ? (el.getAttribute("type") ?? "submit").toLowerCase() : null;
  const submits =
    owner !== null && (buttonType === "submit" || inputType === "submit" || inputType === "image");
  const href = tag === "a" ? (el as HTMLAnchorElement).href || null : null;
  const ariaHasPopup = norm(el.getAttribute("aria-haspopup")).toLowerCase() || null;
  const ariaCurrent = norm(el.getAttribute("aria-current")).toLowerCase() || null;
  const min = tag === "input" ? el.getAttribute("min") : null;
  const max = tag === "input" ? el.getAttribute("max") : null;
  const step = tag === "input" ? el.getAttribute("step") : null;
  const richText = (el as HTMLElement).isContentEditable === true && tag !== "input" && tag !== "textarea";
  // Chrome landmark: a <nav>/role=navigation anywhere up the tree, or a PAGE-level <header>/<footer>
  // (one inside an article/section/main/aside is that region's own header, not page chrome).
  let landmark: "navigation" | "banner" | "contentinfo" | null = null;
  for (let a: Element | null = parentOf(el); a !== null; a = parentOf(a)) {
    const r = (a.getAttribute("role") ?? "").toLowerCase();
    const t = a.tagName.toLowerCase();
    if (r === "navigation" || t === "nav") {
      landmark = "navigation";
      break;
    }
    if (r === "banner" || r === "contentinfo") {
      landmark = r;
      break;
    }
    if ((t === "header" || t === "footer") && (a.parentElement?.closest("article,aside,main,section") ?? null) === null) {
      landmark = t === "header" ? "banner" : "contentinfo";
      break;
    }
  }

  return {
    tag,
    inputType,
    role,
    name,
    enabled,
    checked,
    autocomplete,
    valueBearing,
    visible,
    accept,
    options,
    selected,
    form,
    container,
    scope,
    heading: sectionHeading,
    submits,
    href,
    ariaHasPopup,
    ariaCurrent,
    min,
    max,
    step,
    landmark,
    richText,
    clippedOffscreen,
    outsideModal,
    unreachable,
    expanded: tag === "summary" ? (el.parentElement as HTMLDetailsElement | null)?.open === true : null,
  };
}

/** BROWSER CODE — reads a (non-secret, value-bearing) control's current value. */
function readControlValue(node: Node): string {
  return String((node as HTMLInputElement).value ?? "");
}

/** Facts plus the value, which is present only for a non-secret value-bearing control. */
interface DescribedFacts extends ControlFacts {
  readonly value: string | null;
}

function summarize(facts: DescribedFacts): string {
  const head = facts.name !== "" ? `${facts.role || facts.tag} "${facts.name}"` : facts.role || facts.tag;
  const bits: string[] = [];
  if (!facts.enabled) bits.push("disabled");
  if (facts.checked === true) bits.push("checked");
  if (facts.checked === false) bits.push("unchecked");
  if (facts.expanded === true) bits.push("expanded");
  if (facts.expanded === false) bits.push("collapsed");
  if (facts.value !== null && facts.value !== "") bits.push(`value="${facts.value}"`);
  if (facts.richText) bits.push("rich text");
  // #332: a date/time input takes only its wire format — say which, so the model types `08:00`, not `8:00 AM`.
  if (facts.tag === "input" && isTemporalInputType(facts.inputType)) bits.push(`format ${TEMPORAL_FORMATS[facts.inputType!.toLowerCase()]!.split(" ")[0]}`);
  if (facts.accept !== null && facts.accept !== "") bits.push(`accept=${facts.accept}`);
  if (facts.selected !== null && facts.selected !== "") bits.push(`selected="${facts.selected}"`);
  if (facts.options !== null && facts.options.length > 0) {
    const shown = facts.options.slice(0, 12).map((o) => `"${o}"`).join(" | ");
    bits.push(`options: ${shown}${facts.options.length > 12 ? ` | …${facts.options.length - 12} more` : ""}`);
  }
  return bits.length > 0 ? `${head} (${bits.join(", ")})` : head;
}

/**
 * The semantic freshness signature: a hash of the full URL, the viewport, and
 * each control's safe state (role/name/tag/enabled/checked/value). Same page
 * state ⇒ same signature; a navigation, a newly-revealed control, or a value
 * change ⇒ a different one. This is state-derived, NOT DOM-mutation counting.
 */
function computeSignature(
  url: string,
  viewport: { width: number; height: number } | null,
  facts: readonly DescribedFacts[],
): string {
  return contentHash({
    url,
    viewport,
    controls: facts.map((f) => ({
      tag: f.tag,
      role: f.role,
      name: f.name,
      enabled: f.enabled,
      checked: f.checked,
      value: f.value,
      selected: f.selected,
      ...(f.expanded === null ? {} : { expanded: f.expanded }),
    })),
  });
}

/**
 * BROWSER CODE — serialized by `evaluateAll`: for each candidate that is an item of an ARIA list
 * (explicit role in `roles`), its list (the index of its nearest list container), its visible name
 * and whether it renders; `null` for every other candidate.
 */
function readListItems(els: Element[], roles: string[]): Array<{ list: number; name: string; visible: boolean } | null> {
  const LIST = '[role=listbox],[role=menu],[role=menubar],[role=tablist],[role=radiogroup],[role=tree],[role=grid],ul,ol';
  const lists: Element[] = [];
  return els.map((el) => {
    const role = (el.getAttribute("role") ?? "").toLowerCase();
    if (!roles.includes(role)) return null;
    const container = el.parentElement?.closest(LIST) ?? el.parentElement ?? el;
    let list = lists.indexOf(container);
    if (list === -1) {
      lists.push(container);
      list = lists.length - 1;
    }
    const name = (el.getAttribute("aria-label") ?? el.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 200);
    const style = getComputedStyle(el);
    const visible = el.getClientRects().length > 0 && style.visibility !== "hidden" && style.display !== "none";
    return { list, name, visible };
  });
}

/** BROWSER CODE — each candidate's approximate accessible name (aria-label, label, text, placeholder). */
function readCheapNames(els: Element[]): string[] {
  const norm = (s: string | null | undefined): string => (s ?? "").replace(/\s+/g, " ").trim();
  return els.map((el) => {
    const labels = (el as unknown as { labels?: NodeListOf<HTMLLabelElement> }).labels;
    return (
      norm(el.getAttribute("aria-label")) ||
      norm(labels?.[0]?.textContent) ||
      (el.tagName.toLowerCase() === "select" ? "" : norm(el.textContent)) ||
      norm(el.getAttribute("placeholder"))
    ).slice(0, 200);
  });
}

/**
 * Reads the page's controls. #372: the ONE place a read cut off by a navigation (a server redirect
 * then a client `location.replace` on load) is retried — every caller (`perceive`, so every
 * mission; invariants; screenshots) gets it. Bounded: `navigationRetries` re-reads, all waits within
 * `navigationWaitMs`; then `PageNavigatingError`. Any other error propagates unchanged.
 */
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

  for (const [i, handle] of handles.entries()) {
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
      const raw = await handle.evaluate(readControlFacts);
      // Hidden file inputs are the sole exception (see the module doc).
      if (!raw.visible && raw.inputType !== "file") continue;
      // #272: behind an open modal — never offered (a click there is intercepted by the modal).
      if (raw.outsideModal) continue;
      // #294: a control no scroll can bring into view (a closed panel translated off-screen) is not
      // actionable — never offered (a hidden file input stays: `upload` needs no visible element).
      if (raw.unreachable && raw.inputType !== "file") continue;
      // Occlusion — the ONE shared predicate (./occlusion.ts), also used by act()'s gate: a control
      // a user cannot click (covered by an overlay, or by an ancestor at its own centre) is not
      // offered. Off-screen controls stay eligible (scroll ops reach them) unless a fixed layer (a
      // dialog's backdrop) would still cover them once scrolled into view (#397).
      if (raw.inputType !== "file" && (await handle.evaluate(occluderOf)) !== null) continue;
      // The value leaves the page only for a control the shared predicate says
      // is NOT a secret (type=password, or a password/one-time-code
      // autocomplete — which catches a revealed "show password" field).
      const value =
        raw.valueBearing && !isSecretField(raw.inputType, raw.autocomplete)
          ? await handle.evaluate(readControlValue)
          : null;
      const facts: DescribedFacts = { ...raw, value };
      // #370: a message-named text field is a composer only with conversational evidence on the page.
      const textEntry =
        raw.tag === "textarea" || (raw.tag === "input" && MESSAGE_INPUT_TYPES.has(raw.inputType ?? "")) || raw.role === "textbox";
      const conversational =
        textEntry && MESSAGE_FIELD.test(raw.name)
          ? await handle
              .evaluate(composerEvidence, { submit: SUBMIT_NAME.source, distance: PAIRED_SUBMIT_DISTANCE })
              .catch(() => false)
          : null;
      // computeDescriptor validates against the live page and throws if nothing
      // resolves uniquely — an un-describable control is dropped, never guessed.
      const computed = await computeDescriptor(page, handle, { primaryOnly: true });
      const control: Control = {
        index: controls.length,
        descriptor: computed.descriptor,
        stability: computed.stability,
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
      };
      controls.push(redactControl(control, opts?.secrets ?? []));
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
    signature: computeSignature(url, viewport, keptFacts),
  };
}
