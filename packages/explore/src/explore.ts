import type { Actor } from "@jevitate/screenplay";
import { BrowseTheWebToken, Navigate } from "@jevitate/screenplay";
import type { JudgmentPort, GenerationPort } from "@jevitate/ai-core";
import type { Recording, ValueOrVar } from "@jevitate/recording";
import {
  BoundsTracker,
  NoProgressDetector,
  resolveBounds,
  type Bounds,
  type StopReason,
} from "./bounds.js";
import {
  assertAuthorizedExploreTarget,
  isAuthorizedExploreTarget,
} from "./authorized-targets.js";
import type { Snapshot } from "./snapshot.js";
import { perceive } from "./perceive.js";
import { monitorFor } from "./page-monitor.js";
import { summarizeTimings, type TimingSummary } from "./timing.js";
import { hangRoute, probeResponsive, type HangSignal } from "./hang.js";
import { HANG_PROBE_MS } from "./perceive.js";
import { DEFAULT_STALL_MS } from "./hang-repro.js";
import { decide } from "./decide.js";
import { FillHelper } from "./fill.js";
import { act } from "./act.js";
import { RunRecorder, emptyRecording } from "./record.js";
import { resolveMissionFixture } from "./fixture.js";
import { redactText, redactUrl } from "./redact.js";
import { TranscriptLog, type TranscriptEntry, type TranscriptListener } from "./transcript.js";
import type { MissionFailure } from "@jevitate/domain";
import { CrashWatch, describeFailure } from "./mission-failure.js";
import { HeapLog, buildCrashReport, sampleHeap, type CrashReport } from "./crash-report.js";
import type { HeapSample } from "@jevitate/domain";

export type { TranscriptEntry } from "./transcript.js";

/**
 * explore: the bounded perceive → decide → act → record loop.
 *
 * Guardrails wired here, end to end:
 *  - #1 authorized-target-only: the start URL is asserted before anything runs;
 *    any mid-run off-origin URL stops the run (blocked), never acts.
 *  - #2 bounded + fail-closed: BoundsTracker caps decisions & actions; a
 *    NoProgressDetector stops a stuck run; `done`/`blocked`/exhausted/no-progress
 *    are the only terminations — the loop never guesses an irreversible action.
 *  - #3 no secrets to models: decide()/fill() redact before every model call.
 *  - #5 prompt-injection guard: present in every decide() prompt.
 *
 * The durable product is the emitted `Recording` (index-free, replayable). The
 * caller (a mission) adjudicates success with an INDEPENDENT oracle — the loop
 * never certifies its own success (#4).
 */

export interface ExploreConfig {
  readonly actor: Actor;
  readonly judge: JudgmentPort;
  readonly gen: GenerationPort;
  readonly goal: string;
  /** Authorized origins; the start URL and every observed URL must be on it. */
  readonly allowlist: readonly string[];
  readonly startUrl: string;
  readonly bounds?: Partial<Bounds>;
  readonly secrets?: readonly string[];
  readonly missionContext?: string;
  /** Recording.site label. Defaults to the start origin. */
  readonly site?: string;
  /**
   * Additive, optional observation hook: fired with each authorized observed
   * `Snapshot` after the origin guard passes. Used by the usability mission to
   * run UX analysis per screen. Advisory only — it MUST NOT change the loop's
   * control flow, bounds, or stop decision (its return is awaited but ignored).
   */
  readonly onSnapshot?: (snap: Snapshot) => void | Promise<void>;
  /**
   * Optional mission fixture file for the `upload` op (never model-chosen).
   * Validated to exist at loop start (fail fast: `fixture not found: <path>`);
   * only when present is `upload` offered to the model.
   */
  readonly fixture?: string;
  /**
   * Bound (ms) on waiting for a rendered page (≥1 interactive control) before each decision.
   * Default `RENDER_WAIT_MS` (see `perceive`).
   */
  readonly renderWaitMs?: number;
  /** Bound on the main-thread probe (ms). Default `HANG_PROBE_MS`. */
  readonly hangProbeMs?: number;
  /** A request pending longer than this (ms) is a hang. Default: the render ceiling. */
  readonly requestBoundMs?: number;
  /**
   * How long a page must stay stuck in an earlier state after an action before it counts as a
   * `ui-no-progress` hang (ms). Default `DEFAULT_STALL_MS`.
   */
  readonly stallMs?: number;
  /** Incremental-flush seam: every transcript entry, as it is recorded. */
  readonly onTranscriptEntry?: TranscriptListener;
  /** Incremental-flush seam: the partial Recording after every recorded step. */
  readonly onRecording?: (recording: Recording) => void;
}

export interface ExploreRun {
  readonly stop: StopReason;
  readonly recording: Recording;
  readonly transcript: TranscriptEntry[];
  readonly finalUrl: string;
  readonly decisions: number;
  readonly actions: number;
  /** Why the run ended `crashed`/`inconclusive` — absent on every other stop. */
  readonly failure?: MissionFailure;
  /** The page's JS heap per step (resource evidence for crash attribution). */
  readonly heap: HeapSample[];
  /** For a `crashed` run: the evidence and its attribution (jevitate / system under test / uncertain). */
  readonly crash?: CrashReport;
  /** Per-run timing summary: slowest pages/transitions and endpoints (p50/max), keyed by route. */
  readonly timing: TimingSummary;
  /** For a `hang` stop: what hung, and the Recording step to replay up to (to reproduce it). */
  readonly hang?: { readonly signal: HangSignal; readonly recordingStepIndex: number };
}

function firstLine(e: unknown): string {
  return e instanceof Error ? e.message.split("\n")[0] ?? e.message : String(e);
}

export async function explore(cfg: ExploreConfig): Promise<ExploreRun> {
  // #1 — authorize the start target before ANY snapshot/decision/action.
  const startOrigin = assertAuthorizedExploreTarget(cfg.startUrl, cfg.allowlist);
  // Mission fixture: validated before any navigation/decision (fail fast).
  const fixture = cfg.fixture === undefined ? null : await resolveMissionFixture(cfg.fixture);

  const secrets = cfg.secrets ?? [];
  const bounds = resolveBounds(cfg.bounds);
  const tracker = new BoundsTracker(bounds);
  const noProgress = new NoProgressDetector(3);
  const fillHelper = new FillHelper(cfg.gen);
  const recorder = new RunRecorder(cfg.site ?? startOrigin, undefined, secrets, cfg.onRecording);
  const page = cfg.actor.ability(BrowseTheWebToken).session.page;
  const crashWatch = new CrashWatch(page);
  const heap = new HeapLog();
  const now = (): number => Date.now();

  const transcript = new TranscriptLog(secrets, cfg.onTranscriptEntry);
  const history: string[] = [];

  let stop: StopReason = "exhausted";
  let failure: MissionFailure | undefined;
  let lastActedOp: string | null = null;
  let fixtureAttached = false;
  let hang: ExploreRun["hang"];
  /** Every page state seen so far (for "the action sent the page back to an earlier state"). */
  const seen = new Set<string>();
  /** The last executed page-changing action: when, from which state, and its Recording index. */
  const track: {
    lastMutation: { at: number; before: string; seenBefore: Set<string>; label: string; recordIndex: number } | null;
    /** The raw descriptor of the last RECORDED action's target, to check it is still on the page. */
    lastRecordedTarget: string | null;
  } = { lastMutation: null, lastRecordedTarget: null };
  const perceiveOpts = {
    maxCandidates: bounds.maxCandidates,
    ...(cfg.renderWaitMs === undefined ? {} : { renderWaitMs: cfg.renderWaitMs }),
    ...(cfg.hangProbeMs === undefined ? {} : { hangProbeMs: cfg.hangProbeMs }),
    ...(cfg.requestBoundMs === undefined ? {} : { requestBoundMs: cfg.requestBoundMs }),
  };
  const stallMs = cfg.stallMs ?? DEFAULT_STALL_MS;
  const noteMutation = (label: string, descriptor: unknown, before: string, at: number): void => {
    track.lastMutation = { at, before, seenBefore: new Set(seen), label, recordIndex: recorder.stepCount - 1 };
    track.lastRecordedTarget = JSON.stringify(descriptor);
  };

  try {
    // The page monitor observes network + DOM from BEFORE the first navigation (the settle rule).
    await monitorFor(page).instrument();
    // Initial navigation (authorized above).
    await Navigate.to(cfg.startUrl).performAs(cfg.actor);
    recorder.navigate(cfg.startUrl, now());

    for (;;) {
      if (!tracker.mayDecide()) {
        stop = "exhausted";
        break;
      }

      // Shared perception: never decide on an unrendered page (bounded render wait) and never
      // offer an occluded control (see `perceive`).
      const perception = await perceive(page, perceiveOpts);
      const snap = perception.snapshot;
      await heap.sample(page, transcript.nextStep);
      // Re-observe the PREVIOUS action's effect: patch its postcondition + open
      // the next page segment if the URL changed (record-before-reobserve).
      const target = track.lastRecordedTarget;
      recorder.observed(
        snap.url,
        now(),
        perception.timing,
        target === null ? undefined : { lastTargetStillPresent: snap.controls.some((c) => JSON.stringify(c.descriptor) === target) },
      );
      track.lastRecordedTarget = null;

      // A hang is its own first-class stop (owner ruling 7) — detected by perception's rule.
      if (perception.hang !== null) {
        transcript.record({
          op: null,
          control: null,
          confidence: null,
          chosenBy: "strategy",
          strategy: "hang-check",
          actOk: false,
          reason: `hang (${perception.hang.kind}): ${perception.hang.detail}`,
          snapshot: snap,
          timing: perception.timing,
        });
        const heapNow = await sampleHeap(page, 1_000);
        hang = {
          signal: heapNow === null ? perception.hang : { ...perception.hang, heapBytes: heapNow.usedBytes },
          recordingStepIndex: Math.max(0, recorder.stepCount - 1),
        };
        stop = "hang";
        break;
      }

      // #1 — mid-run origin guard (fail-closed): never act off an authorized origin.
      if (!isAuthorizedExploreTarget(snap.url, cfg.allowlist)) {
        stop = "blocked";
        break;
      }

      // Additive observation hook (usability analysis). Advisory: awaited but its
      // result never gates the loop, bounds, or stop decision.
      await cfg.onSnapshot?.(snap);

      if (!perception.rendered) {
        transcript.record({
          op: "wait",
          control: null,
          confidence: null,
          chosenBy: "strategy",
          actOk: false,
          reason: `${perception.reason} (fail-closed)`,
          snapshot: snap,
          timing: perception.timing,
        });
        stop = "blocked";
        break;
      }

      // #2 — no-progress: the last executed op left the page unchanged N times.
      if (lastActedOp !== null && noProgress.note(lastActedOp, snap.signature)) {
        // Is the APP stuck (not the explorer)? The page is alive, the last page-changing action
        // sent it BACK to a state it had already been in (it changed, then reverted — an action
        // that silently undid itself, like an import that never starts), and it stays there for
        // the stall window: a `ui-no-progress` hang, not generic no-progress. An action that simply
        // did nothing (same state before and after) stays plain no-progress.
        const m = track.lastMutation;
        if (m !== null && snap.signature !== m.before && m.seenBefore.has(snap.signature)) {
          const waited = now() - m.at;
          if (waited < stallMs) await page.waitForTimeout(stallMs - waited);
          const again = await perceive(page, perceiveOpts);
          const stuck =
            again.hang ??
            (again.snapshot.signature === snap.signature && (await probeResponsive(page, cfg.hangProbeMs ?? HANG_PROBE_MS))
              ? ({
                  kind: "ui-no-progress",
                  detail: `after "${m.label}" the page returned to an earlier state and made no progress for ${Math.round((now() - m.at) / 1000)}s`,
                  route: hangRoute(snap.url),
                  url: redactUrl(snap.url),
                  pending: [],
                  lastState: { signature: snap.signature, controls: snap.controls.map((c) => c.summary) },
                } satisfies HangSignal)
              : null);
          if (stuck !== null) {
            transcript.record({
              op: null,
              control: null,
              confidence: null,
              chosenBy: "strategy",
              strategy: "hang-check",
              actOk: false,
              reason: `hang (${stuck.kind}): ${stuck.detail}`,
              snapshot: again.snapshot,
              timing: again.timing,
            });
            const heapNow = await sampleHeap(page, 1_000);
            hang = {
              signal: heapNow === null ? stuck : { ...stuck, heapBytes: heapNow.usedBytes },
              recordingStepIndex: stuck.kind === "ui-no-progress" ? m.recordIndex : Math.max(0, recorder.stepCount - 1),
            };
            stop = "hang";
            break;
          }
        }
        stop = "no-progress";
        break;
      }
      seen.add(snap.signature);

      let decision: Awaited<ReturnType<typeof decide>>;
      try {
        decision = await decide(cfg.judge, {
          goal: cfg.goal,
          snapshot: snap,
          history,
          missionContext: cfg.missionContext,
          secrets,
          // One fixture ⇒ one upload: once attached, upload actions leave the candidate set (the
          // model had kept re-choosing it after a successful attach instead of proceeding).
          uploadAvailable: fixture !== null && !fixtureAttached,
        });
      } catch (e) {
        // The decision IS the goal loop's engine: without it the run can prove nothing more, so it
        // ends `inconclusive` (typed) with everything recorded so far — never a throw, never clean.
        failure = { kind: "exception", message: `model decision unavailable: ${firstLine(e)}` };
        transcript.record({
          op: null,
          control: null,
          confidence: null,
          chosenBy: "model",
          actOk: false,
          reason: failure.message,
          snapshot: snap,
          timing: perception.timing,
        });
        stop = "inconclusive";
        break;
      }
      tracker.countDecision();

      const record = (actOk: boolean, reason?: string): void => {
        transcript.record({
          op: decision.op,
          control: decision.control,
          confidence: decision.confidence,
          chosenBy: "model",
          actOk,
          ...(reason === undefined ? {} : { reason }),
          snapshot: snap,
          timing: perception.timing,
        });
      };

      // Advisory terminals (guardrail #4: the loop does not adjudicate success).
      if (decision.op === "done") {
        record(true, "model proposed done (advisory)");
        stop = "done";
        break;
      }
      if (decision.op === "blocked") {
        record(true, "model blocked");
        stop = "blocked";
        break;
      }

      const control = decision.control;
      if (decision.op === "scroll_up" || decision.op === "scroll_down" || decision.op === "wait") {
        // No recorded mutation.
        const r = await act(cfg.actor, { op: decision.op, control: null });
        record(r.ok, r.reason);
        lastActedOp = decision.op;
        continue;
      }

      // Target-requiring op with no valid target → fail-closed.
      if (control === null || decision.targetMissing) {
        record(false, "no valid target (fail-closed)");
        stop = "blocked";
        break;
      }
      if (!tracker.mayAct()) {
        record(false, "action budget exhausted");
        stop = "exhausted";
        break;
      }
      const at = now();

      if (decision.op === "type" || decision.op === "select") {
        // The generator supplies the text/option (never the model's choice head). It is a HELPER:
        // when it is unavailable the step fails (recorded, visible to the model) and the run goes on.
        let text: string | null;
        try {
          ({ text } = await fillHelper.valueFor({
            fieldLabel: control.name || control.summary,
            goal: cfg.goal,
            visibleContext: snap.controls.map((c) => c.summary).join("; "),
            history,
            secrets: cfg.secrets,
          }));
        } catch (e) {
          const reason = `value generation unavailable: ${firstLine(e)}`;
          history.push(`${decision.op} skipped: ${reason}`);
          record(false, reason);
          lastActedOp = decision.op;
          continue;
        }
        if (text === null) {
          // The generator will not honestly supply a required value → never guess.
          record(false, "no value available (fail-closed)");
          stop = "blocked";
          break;
        }
        const r = await act(cfg.actor, { op: decision.op, control, value: text });
        if (r.ok) {
          if (decision.op === "type") recorder.fill(control.descriptor, text, at);
          else recorder.select(control.descriptor, text, at);
          noteMutation(`${decision.op} ${control.name}`, control.descriptor, snap.signature, at);
          tracker.countAction();
          fillHelper.commit();
          history.push(`${decision.op === "type" ? "typed into" : "selected in"} ${control.name}`);
        } else {
          history.push(`${decision.op} failed: ${r.reason ?? "?"}`);
        }
        record(r.ok, r.reason);
      } else if (decision.op === "click") {
        const r = await act(cfg.actor, { op: "click", control });
        if (r.ok) {
          recorder.click(control.descriptor, at);
          noteMutation(`click ${control.name}`, control.descriptor, snap.signature, at);
          tracker.countAction();
          history.push(`clicked ${control.name}`);
        } else {
          history.push(`click failed: ${r.reason ?? "?"}`);
        }
        record(r.ok, r.reason);
      } else {
        // upload — act fails closed without a fixture.
        const r = await act(cfg.actor, { op: "upload", control, fixture });
        if (r.ok && fixture !== null) {
          // The recorded path goes through the shared redaction seam: a path that
          // contains a registered secret is recorded redacted (replay then fails
          // closed) rather than persisting the secret into the artifact.
          const recordedFile: ValueOrVar =
            redactText(fixture, secrets) === fixture
              ? { redacted: false, value: fixture }
              : { redacted: true, length: fixture.length };
          recorder.upload(control.descriptor, recordedFile, at);
        noteMutation(`upload into ${control.name}`, control.descriptor, snap.signature, at);
          tracker.countAction();
          history.push(`uploaded the fixture into ${control.name}`);
          fixtureAttached = true;
        } else {
          history.push(`upload failed: ${r.reason ?? "?"}`);
        }
        record(r.ok, r.reason);
      }

      lastActedOp = decision.op;
    }
  } catch (e) {
    // Engine failure (browser/page crash, automation error outside `act`'s own guard): a typed
    // `crashed` stop carrying the partial transcript and Recording — the run never throws here.
    failure = describeFailure(e, crashWatch.signals());
    stop = "crashed";
  }

  const finished = recorder.tryFinish({ intent: cfg.goal });
  if (!finished.ok) {
    // The Recording itself failed its fail-closed checks (schema / a surviving secret). It is not
    // written; the run is reported crashed so this can never read as a pass.
    failure = failure ?? { kind: "exception", message: `recording rejected: ${finished.reason}` };
    stop = "crashed";
  }
  return {
    stop,
    recording: finished.ok ? finished.recording : emptyRecording(cfg.site ?? startOrigin, finished.reason),
    transcript: transcript.entries(),
    finalUrl: redactText(redactUrl(safeUrl(page)), secrets),
    decisions: tracker.decisions,
    actions: tracker.actions,
    ...(failure === undefined ? {} : { failure }),
    heap: heap.samples(),
    timing: summarizeTimings(transcript.entries().map((e) => e.timing)),
    ...(hang === undefined ? {} : { hang }),
    ...(stop === "crashed" && failure !== undefined
      ? { crash: buildCrashReport(failure, crashWatch.signals(), heap.samples()) }
      : {}),
  };
}

/** `page.url()` survives a closed page, but guard it: winding down must never throw. */
function safeUrl(page: { url(): string }): string {
  try {
    return page.url();
  } catch {
    return "about:blank";
  }
}

