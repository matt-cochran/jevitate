import type { Control, Snapshot } from "../snapshot.js";

/**
 * Local (feature-mission) copy of ticket #3's state fingerprint + action key.
 * Deliberately duplicated under `feature/` (see the plan's "Known duplication"
 * note) so this ticket lands independently of #3's `coverage/` module.
 *
 * DEVIATION from the plan's Task 1 (documented ruling): the fingerprint uses
 * the RAW url, NOT `urlTemplate(url)`. Ticket #3 templates id-like segments so
 * `/thread/1` and `/thread/2` collapse to one "semantic page"; but ticket #2's
 * acceptance ("exercises multiple valid ROUTES through the capability") treats
 * those as two distinct reachable states, and Task 6 asserts exactly 3 states
 * for inbox + thread-1 + thread-2. Templating would collapse that to 2, so a
 * feature-coverage fingerprint keys on the concrete url instead.
 *
 * The real shipped `Control` (../snapshot.ts) carries no `visible`/`value`
 * field — a snapshot only ever keeps visible, describable controls — and its
 * `role`/`name` are always strings, so the control signature is built from
 * `role`/`name`/`enabled` only.
 */

function controlSignature(c: Control): string {
  return `${c.role}\u0001${c.name}\u0001${c.enabled ? "e" : "-"}`;
}

export function stateFingerprint(snapshot: Snapshot): string {
  const controls = snapshot.controls.map(controlSignature).sort().join("\u0002");
  return `${snapshot.url}\u0003${controls}`;
}

export type FrontierOp = "click" | "type" | "select";

export function actionKey(fingerprint: string, control: Control, op: FrontierOp): string {
  return `${fingerprint}\u0004${op}\u0004${controlSignature(control)}`;
}
