/** `createRunContext`: the conversation's turns, stuck detection (#122), typed values (#123) and offered controls (#500: moved verbatim out of `context.ts`). */
import { FieldValueLog } from "../../fill.js";
import type { Control } from "../../snapshot.js";
import { STUCK_TURNS, UnsubmittedTypeTracker, goalCallToAction, repetitiveTurns } from "../../conversation.js";
import { quote } from "../helpers.js";
import type { ExploreConfig } from "../../explore.js";
import type { MutableRunContext } from "./types.js";

export function initConversation(ctx: MutableRunContext, cfg: ExploreConfig): void {
  ctx.unsent = new UnsubmittedTypeTracker();
  ctx.conversation = { latestReply: null, sent: [] };
  /** Consecutive message generations made while the conversation was stuck (#122). */
  ctx.stuckTurns = 0;
  /** The current stuck episode was already told to the decision (#122). */
  ctx.stuckNoted = false;
  /**
   * After a user turn went out (#122): when the conversation is now stuck on content-free / repeated
   * turns, the NEXT decision is told so once per episode — answer concretely, or take the page's
   * call to action toward the goal.
   */
  ctx.noteStuckConversation = (controls: readonly Control[]): void => {
    if (!repetitiveTurns(ctx.conversation.sent)) {
      ctx.stuckNoted = false;
      return;
    }
    if (ctx.stuckNoted) return;
    ctx.stuckNoted = true;
    const cta = goalCallToAction(controls, cfg.goal);
    ctx.history.push(
      `the conversation is stuck: your last ${STUCK_TURNS} messages acknowledged or repeated without answering — ` +
        `answer the assistant's question with a concrete fact or choice${cta === null ? "" : `, or take the page's call to action ${quote(cta.name, 80)}`}`,
    );
  };
  /** The values this run typed into each form field, and which were submitted (#123). */
  ctx.valueLog = new FieldValueLog();
  /** Controls present just before a message was sent — the next snapshot's new ones were offered with the reply. */
  ctx.offerBaseline = null;
  ctx.offeredKeys = new Set<string>();
}
