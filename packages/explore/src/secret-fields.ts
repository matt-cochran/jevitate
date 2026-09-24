import type { Page } from "playwright";
import { descriptorToLocator } from "@jevitate/recorder";
import type { Control, Snapshot } from "./snapshot.js";
import { decodeBase32, totp } from "./totp.js";

/**
 * secret-fields: bind a secret to a field, typed by code — never by the model (#72).
 *
 * `--secret` only REDACTS a value; nothing could ever type it. A binding (`--secret-field
 * 'label=Password=env:APP_PW'`, `--totp 'label=Code=env:APP_TOTP_SEED'`) closes that gap:
 *
 *  - the model only ever sees a placeholder (`«secret:APP_PW»`): the bound control's summary is
 *    replaced by it, and the mission context says code types it;
 *  - when the loop chooses `type` on a matching control, code types the real value itself (a TOTP
 *    code is computed in-process at that moment from the seed);
 *  - code also types an EMPTY bound field on its own (#111) — before a submit of the form it belongs
 *    to, or once a validation message names it — since the model cannot see the value and was seen
 *    never choosing `type` on a field it was told "code types";
 *  - the Recording records the fill `{ redacted: true }`, the transcript the placeholder;
 *  - the value (and a TOTP seed) is registered as a run secret, so every existing redaction seam
 *    — model payloads, transcript, Recording, issue drafts — scrubs it and proves the scrub.
 *
 * The binding's value is resolved from the environment by the caller (the CLI); this module never
 * reads `process.env` and never puts a value in an error message.
 */

/** What a binding matches: a control's label, test id, input type, element id or name attribute. */
export type FieldMatcherKey = "label" | "testId" | "type" | "id" | "name";

export interface FieldMatcher {
  readonly key: FieldMatcherKey;
  readonly value: string;
}

export interface SecretField {
  /** The descriptor as given (`label=Password`) — non-secret, safe to show. */
  readonly descriptor: string;
  readonly matcher: FieldMatcher;
  /** The environment variable the value came from: the placeholder's name. */
  readonly name: string;
  /** `value` types `secret` as is; `totp` types the current code for the base32 seed `secret`. */
  readonly kind: "value" | "totp";
  readonly secret: string;
}

export class SecretFieldSpecError extends Error {
  readonly code = "E_EXPLORE_ARGS";
  constructor(message: string) {
    super(message);
    this.name = "SecretFieldSpecError";
  }
}

const MATCHER_KEYS: ReadonlySet<string> = new Set<FieldMatcherKey>(["label", "testId", "type", "id", "name"]);

/**
 * Parses `<key>=<value>=env:<NAME>` and resolves NAME from `env`. Throws `SecretFieldSpecError`
 * (naming the flag and the variable, never a value) on a malformed spec, an unset/empty variable,
 * or a TOTP seed that is not base32.
 */
export function parseSecretField(
  spec: string,
  kind: "value" | "totp",
  env: Readonly<Record<string, string | undefined>>,
): SecretField {
  const flag = kind === "totp" ? "--totp" : "--secret-field";
  const at = spec.lastIndexOf("=env:");
  const descriptor = at === -1 ? "" : spec.slice(0, at);
  const name = at === -1 ? "" : spec.slice(at + "=env:".length);
  const eq = descriptor.indexOf("=");
  const key = eq === -1 ? "" : descriptor.slice(0, eq).trim();
  const value = eq === -1 ? "" : descriptor.slice(eq + 1).trim();
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) || !MATCHER_KEYS.has(key) || value === "") {
    // The spec is not echoed: a value pasted in place of `env:<VAR>` must not reach a log.
    throw new SecretFieldSpecError(
      `${flag} expects '<label|testId|type|id|name>=<value>=env:<VAR>' (e.g. 'label=Password=env:APP_PASSWORD'); the value itself is read from the environment variable, never passed on the command line`,
    );
  }
  const secret = env[name];
  if (secret === undefined || secret === "") throw new SecretFieldSpecError(`${flag} ${descriptor}: environment variable ${name} is not set`);
  if (kind === "totp") {
    try {
      decodeBase32(secret);
    } catch {
      throw new SecretFieldSpecError(`${flag} ${descriptor}: ${name} is not a base32 TOTP seed`);
    }
  }
  return { descriptor: `${key}=${value}`, matcher: { key: key as FieldMatcherKey, value }, name, kind, secret };
}

/** The only form of a bound secret a model (or a transcript) ever sees. */
export function secretPlaceholder(f: SecretField): string {
  return f.kind === "totp" ? `«totp:${f.name}»` : `«secret:${f.name}»`;
}

/** The run secrets a binding registers (its value, or its TOTP seed) — redacted everywhere. */
export function secretFieldSecrets(fields: readonly SecretField[] | undefined): string[] {
  return (fields ?? []).map((f) => f.secret);
}

const normLabel = (s: string): string => s.replace(/[*:]+\s*$/g, "").replace(/\s+/g, " ").trim().toLowerCase();

function matches(m: FieldMatcher, c: Control): boolean {
  switch (m.key) {
    case "label": {
      const want = normLabel(m.value);
      return normLabel(c.name) === want || (c.descriptor.label !== undefined && normLabel(c.descriptor.label) === want);
    }
    case "testId":
      return c.descriptor.testId === m.value;
    case "type":
      return c.tag === "input" && (c.inputType ?? "text").toLowerCase() === m.value.toLowerCase();
    case "id":
      return c.descriptor.anchor?.id === m.value;
    case "name":
      return c.descriptor.anchor?.name === m.value;
  }
}

/** The binding for a control (the first that matches), or null. Only text-entry controls bind. */
export function boundSecretField(c: Control, fields: readonly SecretField[] | undefined): SecretField | null {
  if (fields === undefined || fields.length === 0) return null;
  if (c.tag !== "input" && c.tag !== "textarea" && c.role !== "textbox") return null;
  return fields.find((f) => matches(f.matcher, c)) ?? null;
}

/** The value code types for a binding now (a TOTP code for `atMs`). Never logged, never returned to a model. */
export function secretFieldValue(f: SecretField, atMs: number): string {
  return f.kind === "totp" ? totp(f.secret, atMs) : f.secret;
}

/**
 * The snapshot the model sees: every bound control's summary is its placeholder (whatever the
 * field holds — a typed TOTP code in a plain text input included — never reaches a model or the
 * transcript). Descriptors, indexes and the signature are untouched.
 */
export function maskSecretFields(snap: Snapshot, fields: readonly SecretField[] | undefined): Snapshot {
  if (fields === undefined || fields.length === 0) return snap;
  let changed = false;
  const controls = snap.controls.map((c) => {
    const f = boundSecretField(c, fields);
    if (f === null) return c;
    changed = true;
    const head = c.name !== "" ? `${c.role || c.tag} "${c.name}"` : c.role || c.tag;
    return { ...c, summary: `${head} (bound: ${secretPlaceholder(f)} — choose \`type\` on it; code types the value)` };
  });
  return changed ? { ...snap, controls } : snap;
}

/** The mission-context line telling the model which fields code fills (placeholders only). */
export function secretFieldContext(fields: readonly SecretField[] | undefined): string | null {
  if (fields === undefined || fields.length === 0) return null;
  const list = fields.map((f) => `${f.descriptor} → ${secretPlaceholder(f)}`).join("; ");
  return `secret fields hold a value only code knows: a bound field still needs a \`type\` step — choose \`type\` on it while it is empty and code types the value (${list})`;
}

/** What a validation status names: an invalid field (by name) or an alert's text. */
export interface SecretFieldStatus {
  readonly invalid: readonly { readonly name: string; readonly message: string }[];
  readonly alerts: readonly string[];
}

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** True when `text` names the field `label` as a whole word ("Password is invalid"). */
function namedIn(label: string, text: string): boolean {
  const l = normLabel(label);
  return l.length >= 3 && new RegExp(`(?<![\\p{L}\\p{N}])${escapeRe(l)}(?![\\p{L}\\p{N}])`, "iu").test(text);
}

/**
 * The bound controls code should type on its own now (#111), before the chosen action runs: every
 * bound control in the same form as a submit being clicked (`submitting`), and every bound control
 * a validation message names (an invalid field of that name, or an alert naming it). The caller
 * types only the ones still empty and visible (`secretFieldNeedsValue`). `exclude` (the control a
 * `type` was chosen on) is left to the normal bound path.
 */
export function secretFieldsToFill(
  controls: readonly Control[],
  fields: readonly SecretField[] | undefined,
  opts: { readonly submitting: Control | null; readonly status: SecretFieldStatus; readonly exclude?: Control | null },
): Array<{ readonly control: Control; readonly field: SecretField; readonly why: "submit" | "invalid" }> {
  if (fields === undefined || fields.length === 0) return [];
  const out: Array<{ control: Control; field: SecretField; why: "submit" | "invalid" }> = [];
  for (const c of controls) {
    if (opts.exclude !== undefined && opts.exclude !== null && c.index === opts.exclude.index) continue;
    const f = boundSecretField(c, fields);
    if (f === null || !c.enabled) continue;
    const sub = opts.submitting;
    if (sub !== null && (sub.form ?? null) === (c.form ?? null)) {
      out.push({ control: c, field: f, why: "submit" });
      continue;
    }
    const names = [c.name, c.descriptor.label ?? ""].filter((n) => n.trim() !== "");
    const named =
      opts.status.invalid.some((i) => names.some((n) => normLabel(i.name) === normLabel(n))) ||
      opts.status.alerts.some((a) => names.some((n) => namedIn(n, a)));
    if (named) out.push({ control: c, field: f, why: "invalid" });
  }
  return out;
}

/**
 * True when a bound control on the page is visible, editable and EMPTY (#111) — the only state in
 * which code types it on its own. The value read is only compared with "" — never returned or logged.
 */
export async function secretFieldNeedsValue(page: Page, c: Control): Promise<boolean> {
  const locator = descriptorToLocator(page, c.descriptor);
  try {
    if ((await locator.count()) !== 1) return false;
    if (!(await locator.isVisible()) || !(await locator.isEditable({ timeout: 1_000 }))) return false;
    return (await locator.inputValue({ timeout: 1_000 })) === "";
  } catch {
    return false;
  }
}
