/**
 * One frontier transition as it moves through the loop's phases (#232): the popped item, what acting
 * on it produced, and the state it settled in — the loop's former per-iteration locals, names
 * unchanged.
 */
import type { ActionDeltas } from "../../action-delta.js";
import type { ActResult } from "../../act.js";
import type { Recording } from "@jevitate/recording";
import type { Control, Snapshot } from "../../snapshot.js";
import type { PageTiming } from "../../timing.js";

/** What acting on an item produced (an action that went through). */
export interface Acted {
  readonly liveControl: Control;
  readonly actedOn: string;
  readonly armed: ActionDeltas | null;
  readonly result: ActResult;
  readonly decidedOn: Snapshot;
  readonly decidedOnTiming: PageTiming | undefined;
}

/** The state the action settled in, and the replayable path that reaches it. */
export interface Settled {
  readonly newFingerprint: string;
  readonly branch: Recording;
}
