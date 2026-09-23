import type { Page } from "playwright";
import type { Actor } from "@jevitate/screenplay";
import { Navigate } from "@jevitate/screenplay";
import type { Recording } from "@jevitate/recording";
import { redactUrl, type JudgmentPort, type GenerationPort } from "@jevitate/ai-core";
import { assertAuthorizedExploreTarget } from "../authorized-targets.js";
import { resolveBounds, type Bounds } from "../bounds.js";
import type { Control, Snapshot } from "../snapshot.js";
import { perceive } from "../perceive.js";
import { act } from "../act.js";
import { buildJudgmentState } from "../redact.js";
import { PROMPT_INJECTION_GUARD } from "../decide.js";
import { TranscriptLog, type TranscriptEntry, type TranscriptJudgment } from "../transcript.js";
import { RunRecorder } from "../record.js";
import { PageSignalCollector, type DefectSignal } from "../adversarial/defect-oracle.js";
import { pickMisuseAction, type MisuseDecision, type MisuseStrategy } from "../adversarial/misuse.js";

/**
 * runAdversarialMission — a bounded "try to break it" run.
 *
 * The mission applies bounded misuse strategies (ordering violations,
 * repeated/rapid actions, navigation during pending async, boundary/invalid
 * inputs chosen by field semantics, contradictory actions) and, after EVERY
 * step, asks a TRUSTED HARD-SIGNAL oracle (`PageSignalCollector`) whether the
 * app broke — a console error, an HTTP 5xx, a failed request, an unhandled page
 * exception — plus an optional user-declared invariant.
 *
 * GUARDRAIL #4 (the mission's defining property): the stop-on-defect decision
 * comes EXCLUSIVELY from that independent oracle or the user invariant. Jev's
 * `Noul` "does this look broken?" is a SOFT augment only — it is consulted for
 * the transcript/triage context and then discarded; it can never, alone,
 * conclude a defect or gate the stop. A "looks broken" Noul with no hard signal
 * MUST NOT surface as a defect (proved in adversarial.test.ts Task 7).
 *
 * On a defect the mission stops, keeps the run `Recording` as the exact repro,
 * and hands a REDACTED failure summary + URL (never raw form state — guardrail
 * #3) to the generation gateway for a triage narrative.
 *
 * Perception is the shared `perceive()` step (render wait + occlusion), so a
 * misuse strategy never picks from a blank, still-rendering frame or a control
 * hidden behind an overlay; every outcome carries the shared decision
 * transcript (the strategy's action, whether it landed, and Jev's advisory
 * `looksBroken` judgment — recorded, never gating).
 */

export interface AdversarialDefect {
  readonly signals: DefectSignal[];
  readonly url: string;
  readonly recording: Recording;
  readonly triage: { summary: string; likelyCause: string };
}

export type AdversarialOutcome =
  | { outcome: "clean"; recording: Recording; transcript: TranscriptEntry[] }
  | { outcome: "cap"; recording: Recording; transcript: TranscriptEntry[] }
  | { outcome: "defect"; defect: AdversarialDefect; transcript: TranscriptEntry[] };

export interface AdversarialMissionParams {
  readonly page: Page;
  readonly actor: Actor;
  readonly judgment: JudgmentPort;
  readonly generation: GenerationPort;
  readonly seedUrl: string;
  readonly allowlist: readonly string[];
  readonly strategies: readonly MisuseStrategy[];
  readonly bounds?: Partial<Bounds>;
  /** An independent, user-declared invariant. `ok:false` is a HARD defect. */
  readonly userInvariant?: (page: Page) => Promise<{ ok: boolean; reason?: string }>;
  /** Recording.site label. Defaults to the seed origin. */
  readonly site?: string;
  /** Bound (ms) on waiting for a rendered page before each strategy step. Default `RENDER_WAIT_MS`. */
  readonly renderWaitMs?: number;
}

export async function runAdversarialMission(params: AdversarialMissionParams): Promise<AdversarialOutcome> {
  // Guardrail #1 — authorize the target origin BEFORE anything else runs.
  const origin = assertAuthorizedExploreTarget(params.seedUrl, params.allowlist);
  const bounds = resolveBounds(params.bounds);

  // Attach the hard-signal listeners BEFORE navigating, so no signal is missed.
  const collector = new PageSignalCollector(params.page);
  const recorder = new RunRecorder(params.site ?? origin);
  const transcript = new TranscriptLog();
  const now = (): number => Date.now();
  const perceiveNow = async (): Promise<Snapshot> =>
    (
      await perceive(params.page, {
        maxCandidates: bounds.maxCandidates,
        ...(params.renderWaitMs === undefined ? {} : { renderWaitMs: params.renderWaitMs }),
      })
    ).snapshot;

  await Navigate.to(params.seedUrl).performAs(params.actor);
  recorder.navigate(params.seedUrl, now());

  let snap = await perceiveNow();
  let lastDecision: MisuseDecision | undefined;
  let actions = 0;

  for (const strategy of params.strategies) {
    if (actions >= bounds.maxActions) {
      return { outcome: "cap", recording: recorder.finish({ intent: "adversarial" }), transcript: transcript.entries() };
    }

    const decidedOn = snap;
    const decision = pickMisuseAction({ snapshot: snap, strategy, lastDecision, rng: Math.random });
    let acted = false;
    let control: Control | null = null;
    let actOk = false;
    let actReason: string | undefined = "strategy found no applicable action";
    if (decision) {
      control =
        decision.targetIndex !== undefined
          ? snap.controls.find((c) => c.index === decision.targetIndex) ?? null
          : null;
      const at = now();
      const result = await act(params.actor, { op: decision.op, control, value: decision.fillText ?? null });
      actions += 1;
      acted = true;
      actOk = result.ok;
      actReason = result.reason;
      if (result.ok && control !== null) {
        if (decision.op === "click") recorder.click(control.descriptor, at);
        else if (decision.op === "type") recorder.fill(control.descriptor, decision.fillText ?? "", at);
        else if (decision.op === "select") recorder.select(control.descriptor, decision.fillText ?? "", at);
      }
      lastDecision = decision;
    }
    const recordStep = (extra: { reason?: string; judgments?: Record<string, TranscriptJudgment> }): void => {
      const reason = extra.reason ?? actReason;
      transcript.record({
        op: decision ? decision.op : null,
        control,
        confidence: null,
        chosenBy: "strategy",
        strategy,
        actOk,
        ...(reason === undefined ? {} : { reason }),
        snapshot: decidedOn,
        ...(extra.judgments === undefined ? {} : { judgments: extra.judgments }),
      });
    };

    // Independent oracle — runs EVERY iteration, even when a strategy chose no
    // action: the user invariant is an independent probe of live page state,
    // and hard signals may have accrued. A user invariant may synthesize or
    // observe a hard signal; give a same-tick console/response event one loop
    // tick to land before draining.
    const invariantResult = params.userInvariant ? await params.userInvariant(params.page) : { ok: true };
    await params.page.waitForTimeout(10);
    const hardSignals = collector.drain();

    if (hardSignals.length > 0 || !invariantResult.ok) {
      const reasons = [...hardSignals.map((s) => s.detail), invariantResult.reason]
        .filter((r): r is string => Boolean(r))
        .join("; ");
      recordStep({ reason: `defect: ${reasons}` });
      // Guardrail #3: the generation call receives only a redacted failure
      // summary (hard-signal details — never raw form state) + the URL. The
      // triage.narrative schema is `.strict()`, so a stray key would be rejected.
      const triage = await params.generation.generate("triage.narrative", {
        failureSummary: reasons,
        url: redactUrl(params.page.url()),
      });
      return {
        outcome: "defect",
        defect: {
          signals: hardSignals,
          url: redactUrl(params.page.url()),
          recording: recorder.finish({ intent: "adversarial" }),
          triage: triage.output,
        },
        transcript: transcript.entries(),
      };
    }

    // SOFT augment only (guardrail #4). Jev's "looks broken?" is consulted and
    // recorded in the transcript — it is never read into the stop decision above.
    // Wiring this answer into the defect condition would be the single most
    // dangerous regression this mission can suffer (see Task 7). The state is
    // redacted and carries the prompt-injection guard like every other prompt.
    const answers = await params.judgment.systemOne({
      state: buildJudgmentState({
        goal: "try to break it",
        url: params.page.url(),
        controls: [PROMPT_INJECTION_GUARD, ...snap.controls.map((c) => c.summary)],
        history: [],
      }),
      questions: { looksBroken: { kind: "noul" } },
    });
    const looksBroken = answers.looksBroken;
    recordStep(
      looksBroken?.kind === "noul"
        ? { judgments: { looksBroken: { value: looksBroken.value, probability: looksBroken.probability } } }
        : {},
    );

    if (acted) {
      snap = await perceiveNow();
      recorder.observed(snap.url, now());
    }
  }

  return { outcome: "clean", recording: recorder.finish({ intent: "adversarial" }), transcript: transcript.entries() };
}
