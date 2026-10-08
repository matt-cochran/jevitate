/**
 * One decided step of the goal loop (#232): the page state the decision was made on, the decision,
 * and the per-step helpers every action handler shares — `record` (the step's transcript entry),
 * the sign-in signal, and the goal grounding (`groundGoal`, `pendingNote`, `acceptedBy`). They are
 * the closures the loop used to define inline, moved verbatim; each reads the same step's values.
 */
import type { Snapshot } from "../snapshot.js";
import { judgeGoalCompletion, type Decision } from "../decide.js";
import { isCredentialField } from "../auth-completion.js";
import { SaveProgress } from "../save-completion.js";
import type { Control } from "../snapshot.js";
import {
  type AnswerVerdict,
} from "../answer.js";
import {
  GOAL_MET_THRESHOLD,
  groundDone,
  readPageText,
  withoutAuthored,
  type ReplyResult,
  type RunOutcome,
} from "../conversation.js";
import {
  describeStatus,
  isEmptyStatus,
} from "../status.js";

import {
  fieldValuesOf,
  keyOf,
  quote,
} from "./helpers.js";

/** #371: the ops that act on a target — their failures are blockers. */
const TARGET_OPS: ReadonlySet<string> = new Set(["click", "type", "send", "select", "upload", "edit_text"]);
/** #367: the ops the loop-cycle detector counts as steps (a wait is patience, never a step of a loop). */
const CYCLE_OPS: ReadonlySet<string> = new Set([...TARGET_OPS, "scroll_up", "scroll_down", "reload"]);

import type { Perception } from "../perceive.js";
import type { RunContext } from "./context.js";

/** What a step module tells the loop: go on to the next step, end the run, or fall through. */
export type Flow = "continue" | "stop" | "next";

/** What one perception produced (the page state the next decision is made on). */
export interface Perceived {
  readonly perceiveStartedAt: number;
  readonly perception: Perception;
  readonly snap: Snapshot;
}

/** What one perception produced and the decision made on it. */
export interface StepInput {
  readonly perceiveStartedAt: number;
  readonly perception: Perception;
  readonly snap: Snapshot;
  readonly modelControls: Control[];
  readonly keys: Map<string, Control>;
  readonly offered: Set<number>;
  readonly unsubmitted: Set<number>;
  readonly visibleText: string;
  readonly decision: Decision;
}

/** A decided step: its input plus the per-step helpers (see the module doc). */
export type Step = ReturnType<typeof newStep>;

/** A step whose decision is a target op that passed the action gate: its control and when it acts. */
export type ActStep = Step & { readonly control: Control; readonly at: number };

export function newStep(ctx: RunContext, input: StepInput) {
  const { cfg } = ctx;
  const { snap, perception, decision } = input;
  const record = (
    actOk: boolean,
    reason?: string,
    extra: {
      message?: string;
      value?: string;
      reply?: ReplyResult;
      judgments?: Record<string, { value: boolean; probability: number }>;
      op?: typeof decision.op;
      control?: Control | null;
      strategy?: string;
      answer?: AnswerVerdict["answer"];
      /** See `TranscriptEntry.origin` — set for a refusal decided by jevitate's own guard/fail-closed logic, never after a real `act()` attempt. */
      origin?: "engine";
    } = {},
  ): void => {
    const op = extra.op ?? decision.op;
    const target = extra.control === undefined ? decision.control : extra.control;
    if (!actOk && extra.origin === "engine") ctx.refusedSinceMutation += 1;
    // #371: a failed / refused target action is the latest blocker (named in a no-progress reason).
    if (!actOk && target !== null && TARGET_OPS.has(op)) ctx.noteFailure(op, target, reason, extra.origin === "engine");
    // #367: what this step did, for the loop-cycle detector (read at the next progress check).
    if (CYCLE_OPS.has(op)) {
      ctx.cycleAction = {
        action: `${op} ${target === null ? "" : keyOf(target)} ${actOk ? "ok" : "failed"}`,
        label: target === null ? op.replace("_", " ") : `${op} ${quote(target.name || target.summary, 60)}`,
      };
    }
    // #424: the run's depth — what was tried on this page, and the form submissions that went through.
    if (target !== null && TARGET_OPS.has(op)) ctx.depth.noteTried(snap.url, target.name || target.summary);
    if (actOk && target !== null && (op === "send" || (op === "click" && target.submits === true))) ctx.depth.noteSubmitted();
    if (op === "type" || op === "send") ctx.auth.noteTyped(target, snap.url, actOk, target !== null && ctx.isBound(target));
    // #225: typed credentials make the pending submit a sign-in, never a save.
    if ((op === "type" || op === "send") && actOk && target !== null && (ctx.isBound(target) || isCredentialField(target))) ctx.save.noteCredential();
    // #338: a click into a section the goal names puts the run in the goal's area.
    if (actOk && target !== null && op === "click") ctx.goalFocus.noteClicked(target, ctx.chrome);
    if (actOk && target !== null && (op === "click" || op === "type" || op === "select")) {
      const steps = ctx.nextFrom.get(snap.signature) ?? [];
      // The first visit's steps only: a return must not overwrite what the state led to.
      if (!ctx.nextFrom.has(snap.signature) || steps.length < 4) {
        if (!steps.includes(`${op} ${quote(target.name || target.summary, 60)}`)) steps.push(`${op} ${quote(target.name || target.summary, 60)}`);
        ctx.nextFrom.set(snap.signature, steps);
      }
    }
    ctx.transcript.record({
      op: extra.op ?? decision.op,
      control: extra.control === undefined ? decision.control : extra.control,
      ...(extra.strategy === undefined ? {} : { strategy: extra.strategy }),
      ...(extra.answer === undefined || extra.answer === null ? {} : { answer: { ...extra.answer, accepted: actOk } }),
      confidence: decision.confidence,
      chosenBy: "model",
      actOk,
      ...(reason === undefined ? {} : { reason }),
      ...(extra.origin === undefined ? {} : { origin: extra.origin }),
      snapshot: snap,
      timing: perception.timing,
      ...(extra.message === undefined ? {} : { message: extra.message }),
      ...(extra.value === undefined ? {} : { value: extra.value }),
      ...(extra.reply === undefined ? {} : { reply: extra.reply }),
      ...(extra.judgments === undefined ? {} : { judgments: extra.judgments }),
    });
  };

  // Grounds "the goal is met on this page" (guardrail #4): typed-but-unsent text, the mission's
  // independent success condition, or — without one — an advisory goal judgment on the visible
  // page (the run's own messages removed) and its status text, which must clear the threshold.
  // A run that typed sign-in credentials also carries what code observed about the sign-in
  // (#188): shown to the judgment as a trusted fact, and weighed by `groundDone`.
  const signIn = ctx.auth.signal(snap, ctx.isBound);
  /**
   * #209: what an accepted verdict may claim. The in-run success condition is only a proposal's
   * grounding — when part of it is still pending (a `reloadThen` check judged after the run, a
   * check holding since before any action), the transcript says so instead of "goal verified".
   */
  const pendingNote = (o: RunOutcome): string | null =>
    o.status === "completed" && o.verifiedBy === "success-condition" ? (cfg.successCheckPending?.() ?? null) : null;
  const acceptedBy = (o: RunOutcome): string => {
    const pending = pendingNote(o);
    if (pending !== null) return `the in-run success checks held, but the final verdict is still pending — ${pending}`;
    return `goal verified by ${o.status === "completed" ? o.verifiedBy : "?"}`;
  };
  const groundGoal = async (advisoryOnly = false): Promise<{
    verdict: ReturnType<typeof groundDone>;
    judgments: Record<string, { value: boolean; probability: number }> | undefined;
  }> => {
    const unsubmittedLabels = [...ctx.unsent.pending().values()].map((p) => p.label);
    let successCheck: boolean | undefined;
    let goalMet: number | null | undefined;
    let goalIsSignIn: number | null = null;
    let goalIsSave: number | null = null;
    let saved: ReturnType<SaveProgress["signal"]> = null;
    if (unsubmittedLabels.length === 0) {
      if (cfg.successCheck !== undefined && !advisoryOnly) {
        successCheck = await cfg.successCheck().then(
          (v) => v,
          () => false,
        );
      } else {
        const fullText = await readPageText(ctx.page, ctx.secrets);
        const pageText = withoutAuthored(fullText, ctx.conversation.sent);
        // #225: the run's own save, as code observed it — its writes, the page's notice, and whether
        // the page still displays what it saved (a field's value is never in the page text).
        saved = ctx.save.signal(snap, ctx.status, ctx.sideEffects.lastClick(), fullText);
        const judged = await judgeGoalCompletion(cfg.judge, {
          goal: cfg.goal,
          url: snap.url,
          pageText,
          history: ctx.history,
          secrets: ctx.secrets,
          ...(isEmptyStatus(ctx.status) ? {} : { pageStatus: describeStatus(ctx.status) }),
          ...(signIn === null ? {} : { signInFacts: signIn.facts }),
          ...(saved === null ? {} : { saveFacts: saved.facts }),
          fieldValues: fieldValuesOf(snap.controls, ctx.isBound),
        }).catch(() => ({ goalMet: null, goalIsSignIn: null, goalIsSave: null }));
        goalMet = judged.goalMet;
        goalIsSignIn = judged.goalIsSignIn;
        goalIsSave = judged.goalIsSave;
      }
    }
    const verdict = groundDone({
      unsubmitted: unsubmittedLabels,
      ...(successCheck === undefined ? {} : { successCheck }),
      ...(goalMet === undefined ? {} : { goalMetProbability: goalMet }),
      ...(signIn === null || goalMet === undefined ? {} : { signIn: { completed: signIn.completed, goalIsSignIn } }),
      ...(saved === null || goalMet === undefined ? {} : { save: { completed: saved.completed, goalIsSave } }),
    });
    // `value` is code's reading of the probability (the acceptance threshold), not the port's
    // p >= 0.5 — a transcript must never show "goalMet: true" beside "done rejected" (#91).
    const judgments: Record<string, { value: boolean; probability: number }> = {};
    if (goalMet !== undefined && goalMet !== null) judgments.goalMet = { value: goalMet >= GOAL_MET_THRESHOLD, probability: goalMet };
    if (goalIsSignIn !== null) judgments.goalIsSignIn = { value: goalIsSignIn >= GOAL_MET_THRESHOLD, probability: goalIsSignIn };
    if (goalIsSave !== null) judgments.goalIsSave = { value: goalIsSave >= GOAL_MET_THRESHOLD, probability: goalIsSave };
    return { verdict, judgments: Object.keys(judgments).length === 0 ? undefined : judgments };
  };
  return { ...input, record, signIn, pendingNote, acceptedBy, groundGoal };
}
