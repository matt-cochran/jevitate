import { urlTemplate } from "@jevitate/recording";
import type { Control, Snapshot } from "../snapshot.js";

/**
 * A control's contribution to a state fingerprint: role + accessible name +
 * enabled flag. Deliberately NOT the control's value (a value change is not a
 * new *state* under the coverage abstraction) and never the raw index (which
 * is snapshot-local). `@jevitate/explore`'s `Control` only ever exposes safe,
 * model-facing facts here — a secret field's plaintext never reaches this
 * function (the snapshot layer never reads it).
 */
function controlSignature(c: Pick<Control, "role" | "name" | "enabled">): string {
  return `${c.role}\u0001${c.name}\u0001${c.enabled ? "e" : "-"}`;
}

/**
 * How a snapshot url is reduced before it enters the fingerprint. This is the
 * ONE axis on which the two callers of this module genuinely differ (ticket
 * #28): the proof-by-induction / state-coverage mission templates id-like
 * segments so `/thread/1` and `/thread/2` collapse to one semantic page, while
 * the feature-testing mission keys on the CONCRETE url so those two routes stay
 * distinct reachable states (ticket #2's acceptance). Everything else — the
 * control table, the action key, the op set — is shared verbatim.
 */
export type UrlNormalizer = (url: string) => string;

/**
 * The deterministic "same state?" oracle (spec §3.3 / §7): a normalized control
 * TABLE plus the (normalized) URL. Control ORDER never affects the fingerprint
 * — only which controls exist and their role/name/enabled state. The default
 * `normalizeUrl` is `urlTemplate`, so `/thread/1` and `/thread/2` fingerprint
 * identically for the coverage mission; the feature mission passes the identity
 * normalizer to keep concrete routes distinct.
 *
 * This is fingerprint EQUALITY — a hard, deterministic check — never a Jev
 * judgment (guardrail #4: model verdicts are advisory only).
 */
export function stateFingerprint(snapshot: Snapshot, normalizeUrl: UrlNormalizer = urlTemplate): string {
  const controls = snapshot.controls.map(controlSignature).sort().join("\u0002");
  return `${normalizeUrl(snapshot.url)}\u0003${controls}`;
}

/**
 * A control's identity ACROSS states — role + accessible name, ignoring which state it was seen
 * from or whether it is currently enabled. A global nav link (or any other control repeated on
 * every page) resolves to the SAME identity everywhere it appears, even though each occurrence
 * belongs to a different state fingerprint (and so gets a different `actionKey`). The frontier
 * (#75) uses this to recognise "the same control again" — to blacklist one that failed with a
 * timeout for the rest of the run, and to prefer a control never yet exercised over one already
 * exercised under a different state.
 */
export function controlIdentity(c: Pick<Control, "role" | "name">): string {
  return `${c.role}\u0001${c.name}`;
}

/** The ops the coverage frontier may enqueue against an in-page control. */
export type FrontierOp = "click" | "type" | "select";

/**
 * A stable, unique key for one `(state, op, control)` candidate. The `Frontier`
 * dedupes on this, so the same pair is never enqueued or attempted twice
 * regardless of which path reached the state.
 */
export function actionKey(fingerprint: string, control: Control, op: FrontierOp): string {
  return `${fingerprint}\u0004${op}\u0004${controlSignature(control)}`;
}
