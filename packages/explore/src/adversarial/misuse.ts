import type { Control, Op, Snapshot } from "../index.js";
import { affordedOp } from "../actions.js";
import { valueFor } from "./input-strategy.js";

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
  | "contradictory-actions"
  /**
   * Keep hunting on OTHER routes: follow a same-page link not followed before (by accessible
   * name), so a run that already found a defect goes on to exercise the rest of the app.
   */
  | "visit-route";

export interface MisuseDecision {
  readonly op: Op;
  /** The chosen control's snapshot index — for click/type/select. */
  readonly targetIndex?: number;
  /** The value to type — set only for `type` (boundary-input). */
  readonly fillText?: string;
}

const TERMINAL_NAME = /submit|confirm|pay|complete|checkout|send/i;
const OPPOSING_NAME = /cancel|back|reject|decline/i;

function terminalControl(controls: readonly Control[]): Control | undefined {
  return controls.find((c) => c.role === "button" && TERMINAL_NAME.test(c.name) && c.enabled);
}

/**
 * The first enabled text-entry control — by the SHARED affordance mapping (`affordedOp`), so a
 * boundary input targets exactly the controls the goal loop would type into (textarea, search,
 * number, `role=textbox` widgets…) and never a control that cannot take text.
 */
function firstTextbox(controls: readonly Control[]): Control | undefined {
  return controls.find((c) => affordedOp(c) === "type" && c.enabled);
}

export function pickMisuseAction(params: {
  snapshot: Snapshot;
  strategy: MisuseStrategy;
  lastDecision?: MisuseDecision;
  rng: () => number;
  /** Link names already followed by `visit-route` (so each link is followed at most once). */
  visitedLinks?: ReadonlySet<string>;
}): MisuseDecision | null {
  switch (params.strategy) {
    case "ordering-violation": {
      const terminal = terminalControl(params.snapshot.controls);
      return terminal ? { op: "click", targetIndex: terminal.index } : null;
    }
    case "repeat-rapid":
      return params.lastDecision ?? null;
    case "boundary-input": {
      const textbox = firstTextbox(params.snapshot.controls);
      if (!textbox) return null;
      // Field-semantics invalid value (spec §3.1: never blind fuzz). The
      // strategy order is walked by the mission loop across steps; a single
      // pick uses the "invalid" value chosen by the field's role/name.
      return { op: "type", targetIndex: textbox.index, fillText: valueFor("invalid", textbox) };
    }
    case "contradictory-actions": {
      if (!params.lastDecision || params.lastDecision.targetIndex === undefined) return null;
      const last = params.snapshot.controls.find((c) => c.index === params.lastDecision!.targetIndex);
      if (!last) return null;
      const opposing = TERMINAL_NAME.test(last.name)
        ? params.snapshot.controls.find((c) => OPPOSING_NAME.test(c.name) && c.enabled)
        : undefined;
      return opposing ? { op: "click", targetIndex: opposing.index } : null;
    }
    case "visit-route": {
      const visited = params.visitedLinks ?? new Set<string>();
      const link = params.snapshot.controls.find(
        (c) => c.role === "link" && c.enabled && c.name !== "" && !visited.has(c.name),
      );
      return link ? { op: "click", targetIndex: link.index } : null;
    }
    case "nav-during-pending":
      // The mission loop (Task 6) is what actually races this against a
      // pending request; this pure function only chooses "do something else
      // immediately" rather than performing the race itself.
      return { op: "scroll_down" };
  }
}
