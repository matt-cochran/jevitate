import { urlTemplate } from "@jevitate/recording";
import type { Control, Snapshot } from "../index.js";

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
 * The deterministic "same state?" oracle for the proof-by-induction mission
 * (spec §3.3 / §7): a normalized control TABLE plus the URL TEMPLATE. Control
 * ORDER never affects the fingerprint — only which controls exist and their
 * role/name/enabled state — and id-like path segments are normalized by
 * `urlTemplate`, so `/thread/1` and `/thread/2` fingerprint identically.
 *
 * This is fingerprint EQUALITY — a hard, deterministic check — never a Jev
 * judgment (guardrail #4: model verdicts are advisory only).
 */
export function stateFingerprint(snapshot: Snapshot): string {
  const controls = snapshot.controls.map(controlSignature).sort().join("\u0002");
  return `${urlTemplate(snapshot.url)}\u0003${controls}`;
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
