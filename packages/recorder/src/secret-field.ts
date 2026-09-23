/**
 * The ONE definition of "this form control holds a secret, so its value is
 * never read": `type=password`, OR an `autocomplete` token of
 * `current-password` / `new-password` / `one-time-code` (plus the non-standard
 * `otp`, which the recorder has always honoured).
 *
 * The `autocomplete` half is what makes a "show password" toggle safe: the
 * toggle flips `type` from `password` to `text`, but the field keeps its
 * `autocomplete="current-password"`, so it is still recognised as a secret.
 *
 * BROWSER-SAFE BY CONSTRUCTION: it is self-contained (no imports, no reference
 * to module scope, no nested named functions), because it is also shipped into
 * the page — `Recorder.install` serializes it into the in-page capture
 * listener's init script (`installRecorderListener`'s argument). Node-side
 * callers (`@jevitate/explore`'s snapshot) call it directly. Keep it that way:
 * a closure over a module-level constant typechecks here and throws in the page.
 */
export function isSecretField(inputType: string | null, autocomplete: string | null): boolean {
  if (String(inputType || "").toLowerCase() === "password") return true;
  const tokens = String(autocomplete || "").toLowerCase().split(/\s+/);
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t === "current-password" || t === "new-password" || t === "one-time-code" || t === "otp") {
      return true;
    }
  }
  return false;
}

/** Signature of `isSecretField`, as handed into browser code. */
export type SecretFieldPredicate = (inputType: string | null, autocomplete: string | null) => boolean;
