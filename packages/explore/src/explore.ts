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
import { snapshot, type Snapshot } from "./snapshot.js";
import { decide, OPS_NEEDING_TARGET, type Op } from "./decide.js";
import { FillHelper } from "./fill.js";
import { act } from "./act.js";
import { RunRecorder } from "./record.js";
import { resolveMissionFixture } from "./fixture.js";
import { redactText, redactUrl } from "./redact.js";

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
}

export interface TranscriptEntry {
  readonly step: number;
  readonly op: Op;
  readonly target: string | null;
  readonly confidence: number;
  readonly actOk: boolean;
  readonly reason?: string;
  readonly url: string;
  readonly signature: string;
}

export interface ExploreRun {
  readonly stop: StopReason;
  readonly recording: Recording;
  readonly transcript: TranscriptEntry[];
  readonly finalUrl: string;
  readonly decisions: number;
  readonly actions: number;
}

export async function explore(cfg: ExploreConfig): Promise<ExploreRun> {
  // #1 — authorize the start target before ANY snapshot/decision/action.
  const startOrigin = assertAuthorizedExploreTarget(cfg.startUrl, cfg.allowlist);
  // Mission fixture: validated before any navigation/decision (fail fast).
  const fixture = cfg.fixture === undefined ? null : await resolveMissionFixture(cfg.fixture);

  const bounds = resolveBounds(cfg.bounds);
  const tracker = new BoundsTracker(bounds);
  const noProgress = new NoProgressDetector(3);
  const fillHelper = new FillHelper(cfg.gen);
  const recorder = new RunRecorder(cfg.site ?? startOrigin, undefined, cfg.secrets ?? []);
  const page = cfg.actor.ability(BrowseTheWebToken).session.page;
  const now = (): number => Date.now();

  const transcript: TranscriptEntry[] = [];
  const history: string[] = [];

  // Initial navigation (authorized above).
  await Navigate.to(cfg.startUrl).performAs(cfg.actor);
  recorder.navigate(cfg.startUrl, now());

  let stop: StopReason = "exhausted";
  let lastActedOp: string | null = null;
  let step = 0;

  for (;;) {
    if (!tracker.mayDecide()) {
      stop = "exhausted";
      break;
    }

    const snap = await snapshot(page, { maxCandidates: bounds.maxCandidates });
    // Re-observe the PREVIOUS action's effect: patch its postcondition + open
    // the next page segment if the URL changed (record-before-reobserve).
    recorder.observed(snap.url, now());

    // #1 — mid-run origin guard (fail-closed): never act off an authorized origin.
    if (!isAuthorizedExploreTarget(snap.url, cfg.allowlist)) {
      stop = "blocked";
      break;
    }

    // Additive observation hook (usability analysis). Advisory: awaited but its
    // result never gates the loop, bounds, or stop decision.
    await cfg.onSnapshot?.(snap);

    // #2 — no-progress: the last executed op left the page unchanged N times.
    if (lastActedOp !== null && noProgress.note(lastActedOp, snap.signature)) {
      stop = "no-progress";
      break;
    }

    const decision = await decide(cfg.judge, {
      goal: cfg.goal,
      snapshot: snap,
      history,
      missionContext: cfg.missionContext,
      secrets: cfg.secrets,
      uploadAvailable: fixture !== null,
    });
    tracker.countDecision();
    step += 1;

    const pushTranscript = (actOk: boolean, reason?: string): void => {
      transcript.push({
        step,
        op: decision.op,
        target: decision.control ? redactText(decision.control.summary, cfg.secrets ?? []) : null,
        confidence: decision.confidence,
        actOk,
        reason,
        url: redactText(redactUrl(snap.url), cfg.secrets ?? []),
        signature: snap.signature,
      });
    };

    // Advisory terminals (guardrail #4: the loop does not adjudicate success).
    if (decision.op === "done") {
      pushTranscript(true, "model proposed done (advisory)");
      stop = "done";
      break;
    }
    if (decision.op === "blocked") {
      pushTranscript(true, "model blocked");
      stop = "blocked";
      break;
    }

    // Target-requiring op with no valid target → fail-closed.
    if (OPS_NEEDING_TARGET.has(decision.op) && (decision.control === null || decision.targetMissing)) {
      pushTranscript(false, "no valid target (fail-closed)");
      stop = "blocked";
      break;
    }

    const control = decision.control;
    const at = now();

    if (decision.op === "type") {
      if (!tracker.mayAct()) {
        pushTranscript(false, "action budget exhausted");
        stop = "exhausted";
        break;
      }
      const { text } = await fillHelper.valueFor({
        fieldLabel: control!.name || control!.summary,
        goal: cfg.goal,
        visibleContext: snap.controls.map((c) => c.summary).join("; "),
        history,
        secrets: cfg.secrets,
      });
      if (text === null) {
        // The generator will not honestly supply a required value → never guess.
        pushTranscript(false, "no value available (fail-closed)");
        stop = "blocked";
        break;
      }
      const r = await act(cfg.actor, { op: "type", control, value: text });
      if (r.ok) {
        recorder.fill(control!.descriptor, text, at);
        tracker.countAction();
        fillHelper.commit();
        history.push(`typed into ${control!.name}`);
      } else {
        history.push(`type failed: ${r.reason ?? "?"}`);
      }
      pushTranscript(r.ok, r.reason);
    } else if (decision.op === "click") {
      if (!tracker.mayAct()) {
        pushTranscript(false, "action budget exhausted");
        stop = "exhausted";
        break;
      }
      const r = await act(cfg.actor, { op: "click", control });
      if (r.ok) {
        recorder.click(control!.descriptor, at);
        tracker.countAction();
        history.push(`clicked ${control!.name}`);
      } else {
        history.push(`click failed: ${r.reason ?? "?"}`);
      }
      pushTranscript(r.ok, r.reason);
    } else if (decision.op === "select") {
      if (!tracker.mayAct()) {
        pushTranscript(false, "action budget exhausted");
        stop = "exhausted";
        break;
      }
      // For P1 the generator supplies the option text (same discipline as type).
      const { text } = await fillHelper.valueFor({
        fieldLabel: control!.name || control!.summary,
        goal: cfg.goal,
        visibleContext: snap.controls.map((c) => c.summary).join("; "),
        history,
        secrets: cfg.secrets,
      });
      if (text === null) {
        pushTranscript(false, "no value available (fail-closed)");
        stop = "blocked";
        break;
      }
      const r = await act(cfg.actor, { op: "select", control, value: text });
      if (r.ok) {
        recorder.select(control!.descriptor, text, at);
        tracker.countAction();
        fillHelper.commit();
        history.push(`selected in ${control!.name}`);
      } else {
        history.push(`select failed: ${r.reason ?? "?"}`);
      }
      pushTranscript(r.ok, r.reason);
    } else if (decision.op === "upload") {
      if (!tracker.mayAct()) {
        pushTranscript(false, "action budget exhausted");
        stop = "exhausted";
        break;
      }
      // act fails closed without a fixture, so `ok` implies `fixture !== null`.
      const r = await act(cfg.actor, { op: "upload", control, fixture });
      if (r.ok && fixture !== null) {
        // The recorded path goes through the shared redaction seam: a path that
        // contains a registered secret is recorded redacted (replay then fails
        // closed) rather than persisting the secret into the artifact.
        const recordedFile: ValueOrVar =
          redactText(fixture, cfg.secrets ?? []) === fixture
            ? { redacted: false, value: fixture }
            : { redacted: true, length: fixture.length };
        recorder.upload(control!.descriptor, recordedFile, at);
        tracker.countAction();
        history.push(`uploaded the fixture into ${control!.name}`);
      } else {
        history.push(`upload failed: ${r.reason ?? "?"}`);
      }
      pushTranscript(r.ok, r.reason);
    } else {
      // scroll_up / scroll_down / wait — no recorded mutation.
      const r = await act(cfg.actor, { op: decision.op, control: null });
      pushTranscript(r.ok, r.reason);
    }

    lastActedOp = decision.op;
  }

  return {
    stop,
    recording: recorder.finish({ intent: cfg.goal }),
    transcript,
    finalUrl: redactText(redactUrl(page.url()), cfg.secrets ?? []),
    decisions: tracker.decisions,
    actions: tracker.actions,
  };
}
