import type { Page } from "playwright";
import { computeDescriptor, isSecretField } from "@jevitate/recorder";
import type { TargetDescriptor } from "@jevitate/recording";
import { contentHash } from "@jevitate/domain";
import { DEFAULT_BOUNDS } from "./bounds.js";
import { occluderOf } from "./occlusion.js";
import { redactUrl } from "./redact.js";

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
  /** Model-facing one-liner (role/name/state). Never a raw secret value. */
  readonly summary: string;
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
}

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
  "[contenteditable=true]",
].join(",");

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

  const style = window.getComputedStyle(el as HTMLElement);
  const rect = (el as HTMLElement).getBoundingClientRect();
  // Rendered only; whether it is COVERED is decided separately by the shared `occluderOf`
  // predicate (./occlusion.ts) — the same one the pre-click act() gate uses.
  const visible =
    style.visibility !== "hidden" &&
    style.display !== "none" &&
    rect.width > 0 &&
    rect.height > 0;

  const roleAttr = norm(el.getAttribute("role")).split(" ")[0] ?? "";
  const roleByTag: Record<string, string> = {
    a: "link",
    button: "button",
    select: "combobox",
    textarea: "textbox",
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
  const buttonType = tag === "button" ? (el.getAttribute("type") ?? "submit").toLowerCase() : null;
  const submits =
    owner !== null && (buttonType === "submit" || inputType === "submit" || inputType === "image");
  const href = tag === "a" ? (el as HTMLAnchorElement).href || null : null;
  const ariaHasPopup = norm(el.getAttribute("aria-haspopup")).toLowerCase() || null;
  const ariaCurrent = norm(el.getAttribute("aria-current")).toLowerCase() || null;
  const min = tag === "input" ? el.getAttribute("min") : null;
  const max = tag === "input" ? el.getAttribute("max") : null;
  const step = tag === "input" ? el.getAttribute("step") : null;
  // Chrome landmark: a <nav>/role=navigation anywhere up the tree, or a PAGE-level <header>/<footer>
  // (one inside an article/section/main/aside is that region's own header, not page chrome).
  let landmark: "navigation" | "banner" | "contentinfo" | null = null;
  for (let a: Element | null = el.parentElement; a !== null; a = a.parentElement) {
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
    submits,
    href,
    ariaHasPopup,
    ariaCurrent,
    min,
    max,
    step,
    landmark,
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
  if (facts.value !== null && facts.value !== "") bits.push(`value="${facts.value}"`);
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
    })),
  });
}

export async function snapshot(page: Page, opts?: SnapshotOptions): Promise<Snapshot> {
  const maxCandidates = opts?.maxCandidates ?? DEFAULT_BOUNDS.maxCandidates;
  const url = page.url();
  const viewport = page.viewportSize();
  const handles = await page.locator(INTERACTIVE_SELECTOR).elementHandles();

  const controls: Control[] = [];
  const keptFacts: DescribedFacts[] = [];
  let truncated = false;

  for (const handle of handles) {
    try {
      if (controls.length >= maxCandidates) {
        truncated = true;
        continue;
      }
      const raw = await handle.evaluate(readControlFacts);
      // Hidden file inputs are the sole exception (see the module doc).
      if (!raw.visible && raw.inputType !== "file") continue;
      // Occlusion — the ONE shared predicate (./occlusion.ts), also used by act()'s gate: a control
      // a user cannot click (covered by an overlay, or by an ancestor at its own centre) is not
      // offered. Off-screen controls stay eligible (scroll ops reach them).
      if (raw.inputType !== "file" && (await handle.evaluate(occluderOf)) !== null) continue;
      // The value leaves the page only for a control the shared predicate says
      // is NOT a secret (type=password, or a password/one-time-code
      // autocomplete — which catches a revealed "show password" field).
      const value =
        raw.valueBearing && !isSecretField(raw.inputType, raw.autocomplete)
          ? await handle.evaluate(readControlValue)
          : null;
      const facts: DescribedFacts = { ...raw, value };
      // computeDescriptor validates against the live page and throws if nothing
      // resolves uniquely — an un-describable control is dropped, never guessed.
      const computed = await computeDescriptor(page, handle);
      controls.push({
        index: controls.length,
        descriptor: computed.descriptor,
        stability: computed.stability,
        role: facts.role,
        name: facts.name,
        tag: facts.tag,
        inputType: facts.inputType,
        enabled: facts.enabled,
        ...(facts.options === null ? {} : { options: facts.options }),
        summary: summarize(facts),
        form: facts.form,
        container: facts.container,
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
      });
      keptFacts.push(facts);
    } catch {
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
