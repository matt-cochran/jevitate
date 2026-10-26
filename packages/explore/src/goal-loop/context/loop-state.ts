/** `createRunContext`: the loop's stop/failure state, scroll streaks (#172, #323) and loop-cycle tracking (#367) (#500: moved verbatim out of `context.ts`). */
import { clock } from "@jevitate/domain";
import { LoopCycleDetector } from "../../loop-cycle.js";
import type { MutableRunContext } from "./types.js";

export function initLoopState(ctx: MutableRunContext): void {
  ctx.stop = "exhausted";
  ctx.failure = undefined;
  ctx.lastActedOp = null;
  /** #172: did the last scroll move the page, and how many moved scrolls in a row on one state. */
  ctx.lastScrollMoved = false;
  ctx.movingScrolls = 0;
  ctx.movingScrollsSignature = null;
  ctx.scrollStreakSignatures = new Set<string>();
  ctx.cycles = new LoopCycleDetector();
  ctx.cycleAction = null;
  ctx.cycleMark = clock.now();
  ctx.pageText = null;
  ctx.formBefore = null;
  ctx.formMessage = null;
  ctx.replyTold = false;
  /** #172: the no-progress last-chance turn was given (it is given once per run). */
  ctx.lastChanceGiven = false;
  /** #172: this decision is the last-chance turn. */
  ctx.lastChanceTurn = false;
  ctx.fixtureAttached = false;
  ctx.hang = undefined;
  ctx.outcome = null;
  /** #688 — the machine-readable terminal actionable-control outcome, set only at a blocked stop. */
  ctx.actionableControl = null;
  /** Why the run ended incomplete, when a specific detector ended it. */
  ctx.incomplete = null;
  /** #209: stopped because every `done` the model proposed was rejected. */
  ctx.endedOnRejectedDone = false;
}
