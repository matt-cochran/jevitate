/**
 * Feature-mission frontier — the deduped work queue of "from this state, do
 * this op on this control" items was byte-identical across the two missions, so
 * it now lives ONLY in `coverage/frontier.ts` (ticket #28 de-dup). Re-exported
 * here so the feature mission (and its unit test) keep their import path.
 */
export { Frontier, type FrontierItem } from "../coverage/frontier.js";
