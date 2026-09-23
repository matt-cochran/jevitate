import type { Page } from "playwright";
import { computeDescriptor, isSecretField } from "@jevitate/recorder";
import type { TargetDescriptor } from "@jevitate/recording";
import { contentHash } from "@jevitate/domain";
import { DEFAULT_BOUNDS } from "./bounds.js";

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
  /** Model-facing one-liner (role/name/state). Never a raw secret value. */
  readonly summary: string;
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
  const rendered =
    style.visibility !== "hidden" &&
    style.display !== "none" &&
    rect.width > 0 &&
    rect.height > 0;
  // Occlusion (the technique browser agents such as browser-use use): an on-screen control that is
  // NOT the topmost element at its own centre is covered — e.g. page chrome behind a modal overlay
  // that lacks role=dialog/aria-modal. A user cannot click it, so it is not offered. Off-screen
  // controls cannot be probed with elementFromPoint and stay eligible (scroll ops reach them).
  const cx = rect.left + rect.width / 2;
  const cy = rect.top + rect.height / 2;
  const onScreen = cx >= 0 && cy >= 0 && cx < window.innerWidth && cy < window.innerHeight;
  let occluded = false;
  if (rendered && onScreen) {
    const top = document.elementFromPoint(cx, cy);
    occluded = top !== null && top !== el && !el.contains(top) && !top.contains(el);
  }
  const visible = rendered && !occluded;

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
  if (labels && labels.length > 0) labelText = norm(labels[0]!.textContent);
  else {
    const owner = el.closest("label");
    if (owner) labelText = norm(owner.textContent);
  }
  const placeholder = norm(el.getAttribute("placeholder"));
  const buttonish = inputType === "button" || inputType === "submit" || inputType === "reset";
  const nameCandidates = [
    ariaLabel,
    labelText,
    norm(el.textContent),
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

  return { tag, inputType, role, name, enabled, checked, autocomplete, valueBearing, visible, accept };
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
        summary: summarize(facts),
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
