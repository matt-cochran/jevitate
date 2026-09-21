import type { Snapshot } from "../snapshot.js";
import { stateFingerprint as coverageStateFingerprint } from "../coverage/fingerprint.js";

/**
 * Feature-mission fingerprint — a THIN adapter over the shared coverage module
 * (ticket #28 de-dup). The control signature, `actionKey`, and `FrontierOp`
 * were byte-identical across the two missions and now live ONLY in
 * `coverage/fingerprint.ts`; they are re-exported here so the feature mission
 * keeps its import path.
 */
export { actionKey, type FrontierOp } from "../coverage/fingerprint.js";

/**
 * The ONE genuine divergence between the two missions (ticket #2's documented
 * ruling): the feature mission keys on the CONCRETE url — `/thread/1` and
 * `/thread/2` are two distinct reachable ROUTES through a capability, and Task
 * 6 asserts exactly 3 states for inbox + thread-1 + thread-2. Templating (the
 * coverage default) would collapse that to 2, so the feature fingerprint passes
 * the identity normalizer. Everything else is shared.
 */
export function stateFingerprint(snapshot: Snapshot): string {
  return coverageStateFingerprint(snapshot, (url) => url);
}
