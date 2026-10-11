import { redactCredentialShapes, redactText } from "@jevitate/ai-core";
import type { TargetDisplay } from "@jevitate/recording";
import type { ElementFacts } from "./descriptor.js";
import { isSecretField } from "./secret-field.js";

/**
 * #497 — a step target's `display` (its role + visible label), the ONE place every recording path
 * (the human recorder, Jev/explore recordings, the label backfill) turns a label it read into what a
 * Recording may store. Display metadata only: it never locates an element.
 *
 * Redaction is by refusal, not by masking: a label read from a credential field (a password /
 * one-time-code field), or one that holds a registered secret or a credential-shaped string, is
 * NEVER stored — the step then reads as unlabelled. A long label is cut to `DISPLAY_NAME_MAX`.
 */
export const DISPLAY_NAME_MAX = 120;

export interface DisplayInput {
  readonly role?: string | null;
  readonly name?: string | null;
}

export interface DisplayGuard {
  /** The element is a credential field (password / one-time code): its label is never stored. */
  readonly secretField?: boolean;
  /** Registered secret values: a label containing one is never stored. */
  readonly secrets?: readonly string[];
}

/** Why a label was not stored (or `null` when it was). Used by the backfill's report. */
export type DisplayRefusal = "no-label" | "credential-field" | "secret";

/** The storable display for `input`, or why there is none. */
export function displayOrRefusal(input: DisplayInput, guard: DisplayGuard = {}): { display: TargetDisplay } | { refused: DisplayRefusal } {
  if (guard.secretField === true) return { refused: "credential-field" };
  const name = (input.name ?? "").replace(/\s+/g, " ").trim();
  if (name === "") return { refused: "no-label" };
  if (redactText(name, guard.secrets ?? []) !== name || redactCredentialShapes(name) !== name) return { refused: "secret" };
  const cut = name.length > DISPLAY_NAME_MAX ? `${name.slice(0, DISPLAY_NAME_MAX - 1).trimEnd()}…` : name;
  const role = (input.role ?? "").trim();
  return { display: role === "" || role === "generic" || role === "none" ? { name: cut } : { role, name: cut } };
}

/** The storable display for `input`, or `undefined` (see `displayOrRefusal`). */
export function targetDisplay(input: DisplayInput, guard: DisplayGuard = {}): TargetDisplay | undefined {
  const r = displayOrRefusal(input, guard);
  return "display" in r ? r.display : undefined;
}

/** 0.12.0 review: roles whose element holds typed or chosen text — that text is never a label. */
const FIELD_ROLES: ReadonlySet<string> = new Set(["textbox", "searchbox", "combobox"]);

/**
 * The visible label of a recorded element, from the facts the human recorder captured, in
 * accessible-name order: `aria-label` → its `<label>` → its text (never a text field's own content:
 * a `<textarea>`'s or a rich-text editor's text is typed content, a `<select>`'s text is every
 * option) → a button-input's value → `alt` → `title` → `placeholder`.
 */
export function displayNameOf(facts: ElementFacts): string | undefined {
  const field = facts.tag === "input" || facts.tag === "textarea" || facts.tag === "select" || facts.editable === true || FIELD_ROLES.has(facts.roleAttr ?? "");
  const candidates: (string | null | undefined)[] = [facts.ariaLabel, facts.labelText, field ? null : facts.text, facts.value, facts.alt, facts.title, facts.placeholder];
  for (const c of candidates) {
    const name = (c ?? "").replace(/\s+/g, " ").trim();
    if (name !== "") return name;
  }
  return undefined;
}

/** The human recorder's display for an acted element (see `targetDisplay`). */
export function displayFromFacts(facts: ElementFacts, role: string | undefined): TargetDisplay | undefined {
  return targetDisplay(
    { role: role ?? null, name: displayNameOf(facts) ?? null },
    { secretField: isSecretField(facts.inputType, facts.autocomplete ?? null) },
  );
}
