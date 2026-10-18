/**
 * The ONE definition of "this form control holds a secret, so its value is
 * never read":
 *  - `type=password`; OR
 *  - an `autocomplete` token of `current-password` / `new-password` /
 *    `one-time-code` / `cc-number` / `cc-csc` (plus the non-standard `otp`,
 *    which the recorder has always honoured); OR
 *  - (#564) any of the field's naming `hints` — its `name`, `id`, label /
 *    `aria-label`, `placeholder` — naming a credential: password / passcode /
 *    passphrase, token, api key, secret, credential, cvv / cvc / csc, card
 *    number, ssn, otp / one-time / 2fa / mfa, pin.
 *
 * Hints are normalized before matching — camelCase and `_`/`-`/`.` separators
 * become spaces, as does a letter→digit boundary (`password1`) — and every term is matched as a whole word, so `apiKey`,
 * `user_password` and `card-number` match while `pinned`, `spinner`,
 * `passport` and `tokenizer` do not.
 *
 * The `autocomplete` half is what makes a "show password" toggle safe: the
 * toggle flips `type` from `password` to `text`, but the field keeps its
 * `autocomplete="current-password"`, so it is still recognised as a secret.
 * (A toggle on a field with neither is caught by the recorder's stickiness:
 * an element once seen secret stays secret — see `inject.ts`/`assemble.ts`.)
 *
 * `@jevitate/explore`'s binding proposal calls this with only `hints` (its
 * descriptor words) — the same pattern, so the two can never drift.
 *
 * BROWSER-SAFE BY CONSTRUCTION: it is self-contained (no imports, no reference
 * to module scope, no nested named functions), because it is also shipped into
 * the page — `Recorder.install` serializes it into the in-page capture
 * listener's init script (`installRecorderListener`'s argument). Node-side
 * callers (`@jevitate/explore`'s snapshot) call it directly. Keep it that way:
 * a closure over a module-level constant typechecks here and throws in the page.
 */
export function isSecretField(
  inputType: string | null,
  autocomplete: string | null,
  hints?: string | readonly (string | null | undefined)[] | null,
): boolean {
  if (String(inputType || "").toLowerCase() === "password") return true;
  const tokens = String(autocomplete || "").toLowerCase().split(/\s+/);
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (
      t === "current-password" ||
      t === "new-password" ||
      t === "one-time-code" ||
      t === "otp" ||
      t === "cc-number" ||
      t === "cc-csc"
    ) {
      return true;
    }
  }
  const list = hints === undefined || hints === null ? [] : typeof hints === "string" ? [hints] : hints;
  const credential =
    /\b(?:pass(?:word|wd|code|phrase)?s?|pwd|secrets?|tokens?|credentials?|api ?keys?|access ?keys?|private ?keys?|otp|totp|one ?time|2fa|mfa|pins?|cvv|cvc|csc|cc ?(?:number|num|csc)|card ?(?:number|num|no)|ssn|social security|security code)\b/;
  for (let i = 0; i < list.length; i++) {
    const raw = list[i];
    if (typeof raw !== "string" || raw === "") continue;
    const normalized = raw
      .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
      .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
      .replace(/([A-Za-z])([0-9])/g, "$1 $2")
      .replace(/[_\-.:[\]/]+/g, " ")
      .toLowerCase();
    if (credential.test(normalized)) return true;
  }
  return false;
}

/** Signature of `isSecretField`, as handed into browser code. */
export type SecretFieldPredicate = (
  inputType: string | null,
  autocomplete: string | null,
  hints?: string | readonly (string | null | undefined)[] | null,
) => boolean;
