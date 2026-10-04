/**
 * A settled in-scope state (#149, guardrails #3–#5): its overflow / clipping check, Jev's advisory
 * "is this a defect?" (recorded, never gating), and — unless flagged — its controls enqueued. Moved out of
 * `runInductionFrontier` unchanged (#232). "continue" is the loop's former `continue`.
 */

import type { Answer } from "@jevitate/ai-core";
import { contentHash } from "@jevitate/domain";
import type { FrontierItem } from "../../coverage/frontier.js";
import { PROMPT_INJECTION_GUARD, buildJudgmentState, redactText, redactUrl } from "../../index.js";
import { StalledError } from "../../stall-watchdog.js";
import type { FrontierState } from "./context.js";
import { enqueueFrom, withSeed } from "./helpers.js";
import type { Acted, Settled } from "./transition.js";

/** #320: how many of the judged state's controls a flag quotes. */
const JUDGED_CONTROLS_SHOWN = 8;

export async function judgeState(ctx: FrontierState, item: FrontierItem, acted: Acted, settled: Settled): Promise<"continue" | "next"> {
  const { params } = ctx;
  const { liveControl, decidedOn, decidedOnTiming } = acted;
  const { newFingerprint, branch } = settled;
  // Horizontal-overflow hard signal (#149) — pure DOM geometry, never a Jev judgment.
  await ctx.guard(ctx.checkOverflow(newFingerprint, ctx.snap.url, withSeed(branch, params.seedUrl)));

  // Advisory-only Jev defect judgment (guardrail #4). State is redacted first
  // (guardrail #3, via buildJudgmentState) and carries the prompt-injection
  // guard (guardrail #5). The verdict NEVER gates termination or expansion — so an
  // unavailable judgment is a missing advisory, recorded, and the run goes on.
  let isDefect: Answer | undefined;
  let judgmentNote: string | undefined;
  try {
    const answers = await ctx.guard(params.judgment.systemOne({
      state: buildJudgmentState({
        goal: "state coverage",
        url: ctx.snap.url,
        controls: [PROMPT_INJECTION_GUARD, ...ctx.snap.controls.map((c) => c.summary)],
        history: [],
      }),
      questions: { isDefect: { kind: "noul" } },
    }));
    isDefect = answers.isDefect;
  } catch (e) {
    if (e instanceof StalledError) throw e;
    judgmentNote = `advisory judgment unavailable: ${e instanceof Error ? e.message.split("\n")[0] : String(e)}`;
  }
  const flagged = isDefect?.kind === "noul" && isDefect.value;
  ctx.transcript.record({
    op: item.op,
    control: liveControl,
    confidence: null,
    chosenBy: "strategy",
    strategy: ctx.strategyLabel,
    actOk: true,
    snapshot: decidedOn,
    ...(decidedOnTiming === undefined ? {} : { timing: decidedOnTiming }),
    ...(judgmentNote === undefined ? {} : { reason: judgmentNote }),
    ...(isDefect?.kind === "noul"
      ? { judgments: { isDefect: { value: isDefect.value, probability: isDefect.probability } } }
      : {}),
  });
  if (flagged) {
    // #320: the flag carries what the judgment saw — never the bare "judgment flagged defect".
    const secrets = params.secrets ?? [];
    const after = `${item.op} ${JSON.stringify(redactText(liveControl.name || liveControl.summary, secrets).slice(0, 80))}`;
    const shown = ctx.snap.controls.slice(0, JUDGED_CONTROLS_SHOWN).map((c) => redactText(c.summary, secrets).slice(0, 120));
    const probability = isDefect?.kind === "noul" ? Math.round(isDefect.probability * 100) / 100 : 1;
    ctx.defects.push({
      fingerprint: contentHash(`judgment-flagged-state|${newFingerprint}`).slice(0, 16),
      kind: "judgment-flagged-state",
      stateFingerprint: newFingerprint,
      url: ctx.snap.url,
      // The reason is the defect's title: short. What the judgment was shown is in `judgment.shown`.
      reason: `advisory: the judgment flagged a possible defect (p=${probability}) after ${after} on ${redactUrl(ctx.snap.url)}`,
      recording: branch,
      advisory: true,
      judgment: { probability, after, shown },
    });
    ctx.currentFingerprint = newFingerprint;
    return "continue"; // recorded, but a flagged state is never expanded
  }

  if (!ctx.visited.has(newFingerprint)) {
    ctx.visited.add(newFingerprint);
    ctx.statePaths.set(newFingerprint, branch);
    enqueueFrom(ctx.frontier, newFingerprint, branch, ctx.snap.controls, (c) => ctx.withheld(c, ctx.snap));
  }
  ctx.currentFingerprint = newFingerprint;
  return "next";
}
