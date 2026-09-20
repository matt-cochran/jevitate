import type { Control, Op, Snapshot } from "../index.js";

/**
 * Bounded MISUSE strategies (spec §3.1). Each picks the next action by
 * deliberately violating normal flow — instead of Jev's usual free-form op +
 * target choice — to stress the app's own logic (ordering, timing, boundary
 * values, contradictions). It NEVER attempts to bypass rate limiting, spoof
 * identity, or evade monitoring (guardrail #6): the ops are restricted to
 * click/type/select/scroll (see the mission loop), never an off-origin
 * navigation or an irreversible primitive the loop cannot see.
 *
 * A `MisuseDecision` is a lean, index-based intent the mission loop resolves
 * against the current snapshot's controls (`controls.find(c => c.index === i)`)
 * before handing it to the GATED `act()` — the same actionability gate the
 * normal loop uses still applies, so a stale target never mutates the wrong
 * element.
 */

export type MisuseStrategy =
  | "ordering-violation"
  | "repeat-rapid"
  | "nav-during-pending"
  | "boundary-input"
  | "contradictory-actions";

export interface MisuseDecision {
  readonly op: Op;
  /** The chosen control's snapshot index — for click/type/select. */
  readonly targetIndex?: number;
  /** The value to type — set only for `type` (boundary-input). */
  readonly fillText?: string;
}

const TERMINAL_NAME = /submit|confirm|pay|complete|checkout|send/i;

function terminalControl(controls: readonly Control[]): Control | undefined {
  return controls.find((c) => c.role === "button" && TERMINAL_NAME.test(c.name) && c.enabled);
}

export function pickMisuseAction(params: {
  snapshot: Snapshot;
  strategy: MisuseStrategy;
  lastDecision?: MisuseDecision;
  rng: () => number;
}): MisuseDecision | null {
  switch (params.strategy) {
    case "ordering-violation": {
      const terminal = terminalControl(params.snapshot.controls);
      return terminal ? { op: "click", targetIndex: terminal.index } : null;
    }
    case "repeat-rapid":
      return params.lastDecision ?? null;
    default:
      return null; // Task 4 fills in nav-during-pending / boundary-input / contradictory-actions
  }
}
