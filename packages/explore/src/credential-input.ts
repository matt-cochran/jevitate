/**
 * Credential fields, whatever the typed value's source (0.30.0, the d-sign-in-verb finding).
 *
 * A goal may state a credential ("Sign in with alice@example.com and password hunter2"), and since
 * #810 such a goal types it. Redaction used to match only REGISTERED secrets (`--secret`,
 * `--secret-field`), so a password the goal stated was stored in the clear: the Recording's fill
 * `{ redacted: false, value }`, its `intent`, and every later model payload that carries the goal.
 *
 * The rule is now the field's, not the value's: a value typed into a credential field (a password
 * input, a password / one-time-code / card autocomplete, or a credential-named control — the same
 * `isSecretField` predicate that already keeps such a field's value off the page read, plus the
 * one-time-code names of `isCredentialField`) is ALWAYS recorded `{ redacted: true }` and becomes a
 * run secret the moment it is typed, so every redaction seam (transcript, Recording intent, model
 * payloads, evidence) masks it from then on.
 */

import { isSecretField } from "@jevitate/recorder";
import type { TargetDescriptor } from "@jevitate/recording";
import { isCredentialField } from "./auth-completion.js";
import type { Control } from "./snapshot.js";

/**
 * The descriptors of controls the snapshot perceived as secret fields (by `type`, `autocomplete` or
 * name), keyed by the control's own descriptor object — `autocomplete` is not kept on `Control`.
 */
const SECRET_FIELD_DESCRIPTORS = new WeakSet<TargetDescriptor>();

/** Notes (snapshot) that the control with this descriptor is a secret field. */
export function markSecretFieldDescriptor(descriptor: TargetDescriptor): void {
  SECRET_FIELD_DESCRIPTORS.add(descriptor);
}

/** True when the snapshot perceived the control with this descriptor as a secret field. */
export function isSecretFieldDescriptor(descriptor: TargetDescriptor): boolean {
  return SECRET_FIELD_DESCRIPTORS.has(descriptor);
}

/** True for a control a value typed into is a credential: never recorded, persisted or shown in the clear. */
export function isCredentialInput(c: Control): boolean {
  return isSecretFieldDescriptor(c.descriptor) || isCredentialField(c) || isSecretField(c.inputType, null, [c.name]);
}
