import type { Page } from "playwright";
import type { Actor } from "@jevitate/screenplay";
import { Navigate } from "@jevitate/screenplay";
import type { Recording } from "@jevitate/recording";
import { redactUrl, type JudgmentPort, type GenerationPort } from "@jevitate/ai-core";
import type { MissionFailure, MissionOutcome } from "@jevitate/domain";
import { assertAuthorizedExploreTarget } from "../authorized-targets.js";
import { resolveBounds, type Bounds } from "../bounds.js";
import type { Control, Snapshot } from "../snapshot.js";
import { perceive } from "../perceive.js";
import { act } from "../act.js";
import { buildJudgmentState } from "../redact.js";
import { PROMPT_INJECTION_GUARD } from "../decide.js";
import {
  TranscriptLog,
  type TranscriptEntry,
  type TranscriptJudgment,
  type TranscriptListener,
} from "../transcript.js";
import { CrashWatch, describeFailure, tryTriage, type Triage } from "../mission-failure.js";
import { RunRecorder, emptyRecording } from "../record.js";
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
 * #3) to the generation gateway for a triage narrative. The narrative is a
 * HELPER: when it cannot be generated the defect is still recorded with its raw
 * evidence and the triage is marked `unavailable` with the reason.
 *
 * The outcome is always a typed result, never a throw: an engine failure
 * (browser/page crash, unexpected exception) returns `crashed` with the partial
 * transcript and Recording; a seed page that never renders returns
 * `inconclusive`. Neither can ever read as `clean`.
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
  readonly triage: Triage;
}

/** The typed result of an adversarial run — returned for every ending, including engine failure. */
export interface AdversarialOutcome {
  readonly outcome: Extract<MissionOutcome, "clean" | "defects-found" | "inconclusive" | "crashed">;
  readonly defects: AdversarialDefect[];
  /** The run's Recording (partial when the run crashed) — the exact repro path. */
  readonly recording: Recording;
  readonly transcript: TranscriptEntry[];
  /** Why the run ended `crashed`/`inconclusive`. */
  readonly failure?: MissionFailure;
}

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
  /** Incremental-flush seam: every transcript entry, as it is recorded. */
  readonly onTranscriptEntry?: TranscriptListener;
  /** Incremental-flush seam: the partial Recording after every recorded step. */
  readonly onRecording?: (recording: Recording) => void;
}

export async function runAdversarialMission(params: AdversarialMissionParams): Promise<AdversarialOutcome> {
  // Guardrail #1 — authorize the target origin BEFORE anything else runs.
  const origin = assertAuthorizedExploreTarget(params.seedUrl, params.allowlist);
  const bounds = resolveBounds(params.bounds);
  const site = params.site ?? origin;

  // Attach the hard-signal listeners BEFORE navigating, so no signal is missed.
  const collector = new PageSignalCollector(params.page);
  const crashWatch = new CrashWatch(params.page);
  const recorder = new RunRecorder(site, undefined, [], params.onRecording);
  const transcript = new TranscriptLog([], params.onTranscriptEntry);
  const defects: AdversarialDefect[] = [];
  const now = (): number => Date.now();

  const finish = (
    outcome: AdversarialOutcome["outcome"],
    failure?: MissionFailure,
  ): AdversarialOutcome => {
    const finished = recorder.tryFinish({ intent: "adversarial" });
    const recordingFailure: MissionFailure | undefined = finished.ok
      ? undefined
      : { kind: "exception", message: `recording rejected: ${finished.reason}` };
    const finalFailure = failure ?? recordingFailure;
    return {
      outcome: finished.ok ? outcome : "crashed",
      defects,
      recording: finished.ok ? finished.recording : emptyRecording(site, finished.reason),
      transcript: transcript.entries(),
      ...(finalFailure === undefined ? {} : { failure: finalFailure }),
    };
  };

  try {
    const perceiveNow = async (): Promise<{ snapshot: Snapshot; rendered: boolean; reason?: string }> => {
      const p = await perceive(params.page, {
        maxCandidates: bounds.maxCandidates,
        ...(params.renderWaitMs === undefined ? {} : { renderWaitMs: params.renderWaitMs }),
      });
      return p.rendered ? { snapshot: p.snapshot, rendered: true } : { snapshot: p.snapshot, rendered: false, reason: p.reason };
    };

    await Navigate.to(params.seedUrl).performAs(params.actor);
    recorder.navigate(params.seedUrl, now());

    const seed = await perceiveNow();
    if (!seed.rendered) {
      // Nothing to misuse: the run proves nothing (fail closed on meaning — never `clean`).
      transcript.record({
        op: null,
        control: null,
        confidence: null,
        chosenBy: "strategy",
        actOk: false,
        reason: `${seed.reason ?? "page did not render"} (inconclusive)`,
        snapshot: seed.snapshot,
      });
      return finish("inconclusive", { kind: "exception", message: seed.reason ?? "seed page did not render" });
    }
    let snap = seed.snapshot;
    let lastDecision: MisuseDecision | undefined;
    let actions = 0;

    for (const strategy of params.strategies) {
      if (actions >= bounds.maxActions) break;

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
        // summary (hard-signal details — never raw form state) + the URL. A
        // triage failure is data (`unavailable`), never a lost defect.
        const url = redactUrl(params.page.url());
        const triage = await tryTriage(params.generation, { failureSummary: reasons, url });
        defects.push({ signals: hardSignals, url, triage });
        return finish("defects-found");
      }

      // SOFT augment only (guardrail #4). Jev's "looks broken?" is consulted and
      // recorded in the transcript — it is never read into the stop decision above.
      // Wiring this answer into the defect condition would be the single most
      // dangerous regression this mission can suffer (see Task 7). The state is
      // redacted and carries the prompt-injection guard like every other prompt.
      // It is advisory, so an unavailable judgment is recorded and the run goes on.
      let judgments: Record<string, TranscriptJudgment> | undefined;
      let judgmentNote: string | undefined;
      try {
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
        if (looksBroken?.kind === "noul") {
          judgments = { looksBroken: { value: looksBroken.value, probability: looksBroken.probability } };
        }
      } catch (e) {
        judgmentNote = `advisory judgment unavailable: ${e instanceof Error ? e.message.split("\n")[0] : String(e)}`;
      }
      recordStep({
        ...(judgments === undefined ? {} : { judgments }),
        ...(judgmentNote === undefined ? {} : { reason: actReason === undefined ? judgmentNote : `${actReason}; ${judgmentNote}` }),
      });

      if (acted) {
        const next = await perceiveNow();
        snap = next.snapshot;
        recorder.observed(snap.url, now());
      }
    }

    return finish("clean");
  } catch (e) {
    return finish("crashed", describeFailure(e, crashWatch.signals()));
  }
}
