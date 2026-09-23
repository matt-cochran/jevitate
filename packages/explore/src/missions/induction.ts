import type { Page } from "playwright";
import type { Actor } from "@jevitate/screenplay";
import { Navigate } from "@jevitate/screenplay";
import type { PageSegment, RecordedStep, Recording, Step, TargetDescriptor } from "@jevitate/recording";
import type { Answer, GenerationPort, JudgmentPort } from "@jevitate/ai-core";
import {
  assertAuthorizedExploreTarget,
  perceive,
  targetCandidates,
  TranscriptLog,
  act,
  toPath,
  resolveBounds,
  buildJudgmentState,
  PROMPT_INJECTION_GUARD,
  type Bounds,
  type Control,
  type Snapshot,
  type TargetOp,
  type TranscriptEntry,
  type TranscriptListener,
} from "../index.js";
import type { MissionFailure } from "@jevitate/domain";
import { CrashWatch, describeFailure } from "../mission-failure.js";
import { monitorFor } from "../page-monitor.js";
import { summarizeTimings, type PageTiming, type TimingSummary } from "../timing.js";
import { actionKey, stateFingerprint, type FrontierOp } from "../coverage/fingerprint.js";
import { Frontier } from "../coverage/frontier.js";
import { reachFrontierState } from "../coverage/reach.js";

/**
 * Proof-by-induction (state-coverage) mission — spec §3.3.
 *
 * A bounded, terminating expansion of a state-fingerprint FRONTIER that
 * maximizes new-state / transition coverage (objective: coverage, not
 * shortest-path-to-goal). It reuses `@jevitate/explore`'s primitives
 * (`snapshot`/`act`/`assertAuthorizedExploreTarget`) but composes a DIFFERENT
 * loop than the goal-based driver: it maintains an explicit queue of
 * not-yet-tried `(state, action)` pairs keyed by a state fingerprint, pops the
 * next unexplored pair, and — when that pair belongs to a state other than the
 * one the browser is on — resets to the seed and replays the recorded prefix
 * (`reachFrontierState`) to get back there deterministically.
 *
 * "Same state?" is decided by fingerprint EQUALITY (a hard oracle), never a Jev
 * judgment. Jev's only role here is an advisory `Noul` "is this a defect?" per
 * state — it is recorded but NEVER gates termination, state identity, or
 * frontier expansion (guardrail #4).
 */

export interface DefectRecord {
  readonly stateFingerprint: string;
  readonly url: string;
  readonly reason: string;
  /** A replayable repro path from the seed to the flagged state. */
  readonly recording: Recording;
}

export interface CoverageReport {
  readonly statesVisited: number;
  readonly transitionsExercised: number;
  readonly frontierExhausted: boolean;
  readonly defects: DefectRecord[];
}

export interface InductionRunResult {
  /** `crashed`: the engine failed; everything discovered up to the failure is still returned. */
  readonly outcome: "exhausted" | "cap" | "crashed";
  /** Why the run crashed — present only for `crashed`. */
  readonly failure?: MissionFailure;
  readonly coverage: CoverageReport;
  /** One replayable repro Recording per distinct state visited (discovery order). */
  readonly recordings: Recording[];
  /** The shared decision transcript: each frontier action, whether it landed, and Jev's advisory `isDefect`. */
  readonly transcript: TranscriptEntry[];
  /** Per-run timing summary: slowest pages/transitions and endpoints (p50/max), keyed by route. */
  readonly timing: TimingSummary;
}

export interface InductionMissionParams {
  readonly page: Page;
  readonly actor: Actor;
  readonly judgment: JudgmentPort;
  /** Accepted for symmetry with the goal-based mission / CLI wiring; the
   *  coverage loop drives ops directly and authors no synthetic fill text. */
  readonly generation?: GenerationPort;
  readonly seedUrl: string;
  readonly allowlist: readonly string[];
  readonly bounds?: Partial<Bounds>;
  readonly maxDepth?: number;
  /** Bound (ms) on waiting for a rendered page on each perception. Default `RENDER_WAIT_MS` — the shared settle rule
   *  recognises a control-free leaf state in about the quiet window, so no shorter coverage bound is needed. */
  readonly renderWaitMs?: number;
  /** Incremental-flush seam: every transcript entry, as it is recorded. */
  readonly onTranscriptEntry?: TranscriptListener;
}

/**
 * Which ops the frontier enqueues for a control. RULING (deviation from the
 * plan's literal `type`/`select` inclusion): the coverage fingerprint is a
 * function of url-template + control role/name/enabled — a control's VALUE is
 * deliberately excluded. `type`/`select` only mutate a value, so they can never
 * expand the state frontier; enqueuing them would only burn the action budget
 * against guardrail #2 (bounded). Clicks (navigations / control toggles) are
 * the only fingerprint-affecting transitions, so the frontier enqueues the
 * controls whose SHARED afforded op (`affordedOp`, ./actions.ts) is `click`.
 */
const FRONTIER_OPS: ReadonlySet<TargetOp> = new Set<TargetOp>(["click"]);

function enqueueFrom(
  frontier: Frontier,
  fingerprint: string,
  pathPrefix: Recording,
  controls: readonly Control[],
): void {
  // A disabled control can never be acted on — never enqueue it.
  for (const { control } of targetCandidates(controls, { ops: FRONTIER_OPS, enabledOnly: true })) {
    frontier.push({ key: actionKey(fingerprint, control, "click"), fromFingerprint: fingerprint, pathPrefix, control, op: "click" });
  }
}

/**
 * Re-resolves a frontier item's control in the CURRENT snapshot by its stable
 * identity (role + name + enabled) — the `index` is snapshot-local and useless
 * across re-snapshots. A control that has vanished returns null and the item is
 * dropped, never guessed at (fail-closed).
 */
function resolveControl(snap: Snapshot, want: Control): Control | null {
  return (
    snap.controls.find((c) => c.role === want.role && c.name === want.name && c.enabled === want.enabled) ?? null
  );
}

/**
 * Immutable "append one executed step to a replayable path", mirroring
 * `RunRecorder`'s discipline: a step whose action changed the URL gets a
 * `urlIncludes` postcondition (and opens the next page segment); one that did
 * not keeps a `visible` postcondition on its target. Returns a NEW Recording.
 */
function extendPath(
  prefix: Recording,
  op: FrontierOp,
  descriptor: TargetDescriptor,
  value: string | null,
  afterUrl: string,
): Recording {
  const pages: PageSegment[] = prefix.pages.map((p) => ({ ...p, steps: [...p.steps] }));
  let current = pages[pages.length - 1];
  if (current === undefined) {
    current = { url: "/", steps: [] };
    pages.push(current);
  }
  const target: TargetDescriptor = { ...descriptor };
  let step: Step;
  if (op === "click") {
    step = { kind: "click", target, expect: { kind: "visible", target } };
  } else if (op === "type") {
    step = { kind: "fill", target, value: { redacted: false, value: value ?? "" }, expect: { kind: "visible", target } };
  } else {
    step = { kind: "select", target, value: { redacted: false, value: value ?? "" }, expect: { kind: "visible", target } };
  }
  const recorded: RecordedStep = { step };
  current.steps.push(recorded);

  const path = toPath(afterUrl);
  if (path !== current.url) {
    step.expect = { kind: "urlIncludes", text: path };
    pages.push({ url: path, steps: [] });
  }
  return { version: prefix.version, site: prefix.site, pages };
}

export async function runInductionMission(params: InductionMissionParams): Promise<InductionRunResult> {
  // Guardrail #1 — authoring/test plane only: refuse an undeclared origin before
  // any page interaction (throws UnauthorizedExploreTargetError).
  assertAuthorizedExploreTarget(params.seedUrl, params.allowlist);
  const bounds = resolveBounds(params.bounds);
  const maxDepth = params.maxDepth ?? 10;
  const site = new URL(params.seedUrl).origin;
  // Shared perception (render wait + occlusion): a state is never fingerprinted from a blank,
  // still-rendering frame — including right after a reset-and-replay.
  let lastTiming: PageTiming | undefined;
  /** Every perception's full timing (with request samples), once each — the run summary's input. */
  const timings: PageTiming[] = [];
  const takeSnapshot = async (): Promise<Snapshot> => {
    const p = await perceive(params.page, {
      maxCandidates: bounds.maxCandidates,
      ...(params.renderWaitMs === undefined ? {} : { renderWaitMs: params.renderWaitMs }),
    });
    lastTiming = p.timing;
    timings.push(p.timing);
    return p.snapshot;
  };
  const transcript = new TranscriptLog([], params.onTranscriptEntry);
  const crashWatch = new CrashWatch(params.page);
  const visited = new Set<string>();
  const statePaths = new Map<string, Recording>();
  const defects: DefectRecord[] = [];
  let transitionsExercised = 0;

  const report = (frontierExhausted: boolean): CoverageReport => ({
    statesVisited: visited.size,
    transitionsExercised,
    frontierExhausted,
    defects,
  });

  try {
    await monitorFor(params.page).instrument();
    await params.actor.attemptsTo(Navigate.to(params.seedUrl));
    let snap = await takeSnapshot();
    let currentFingerprint = stateFingerprint(snap);
    visited.add(currentFingerprint);
    const frontier = new Frontier();

    const seedRecording: Recording = { version: "1", site, pages: [] };
    statePaths.set(currentFingerprint, seedRecording);
    enqueueFrom(frontier, currentFingerprint, seedRecording, snap.controls);

    let actions = 0;

    while (!frontier.isExhausted()) {
      // Hard cap (guardrail #2): checked BEFORE spending — never guess one more step.
      if (actions >= bounds.maxActions) {
        return {
          outcome: "cap",
          coverage: report(false),
          recordings: [...statePaths.values()],
          transcript: transcript.entries(),
          timing: summarizeTimings(timings),
        };
      }

      const item = frontier.popPreferring(currentFingerprint);
      if (item === undefined) break;

      const depth = item.pathPrefix.pages.reduce((n, p) => n + p.steps.length, 0);
      if (depth >= maxDepth) continue; // bounded exploration depth

      if (item.fromFingerprint !== currentFingerprint) {
        const reached = await reachFrontierState({
          actor: params.actor,
          seedUrl: params.seedUrl,
          item,
          snapshotNow: takeSnapshot,
        });
        if (!reached.ok) continue; // stale frontier item — dropped, never guessed at
        snap = reached.snapshot;
        currentFingerprint = item.fromFingerprint;
      }

      const liveControl = resolveControl(snap, item.control);
      if (liveControl === null) continue; // control vanished between snapshots — dropped

      const result = await act(params.actor, {
        op: item.op,
        control: liveControl,
        value: item.op === "click" ? null : "",
      });
      actions += 1;
      const decidedOn = snap;
    // Each perception's timing is reported once (a failed act re-uses the same snapshot).
    const decidedOnTiming = lastTiming;
    lastTiming = undefined;
      if (!result.ok) {
        transcript.record({
          op: item.op,
          control: liveControl,
          confidence: null,
          chosenBy: "strategy",
          strategy: "coverage-frontier",
          actOk: false,
          ...(result.reason === undefined ? {} : { reason: result.reason }),
          snapshot: decidedOn,
        ...(decidedOnTiming === undefined ? {} : { timing: decidedOnTiming }),
        });
        continue;
      }

      snap = await takeSnapshot();
      const newFingerprint = stateFingerprint(snap);
      const branch = extendPath(item.pathPrefix, item.op, liveControl.descriptor, null, snap.url);
      transitionsExercised += 1;

      // Advisory-only Jev defect judgment (guardrail #4). State is redacted first
      // (guardrail #3, via buildJudgmentState) and carries the prompt-injection
      // guard (guardrail #5). The verdict NEVER gates termination or expansion — so an
      // unavailable judgment is a missing advisory, recorded, and the run goes on.
      let isDefect: Answer | undefined;
      let judgmentNote: string | undefined;
      try {
        const answers = await params.judgment.systemOne({
          state: buildJudgmentState({
            goal: "state coverage",
            url: snap.url,
            controls: [PROMPT_INJECTION_GUARD, ...snap.controls.map((c) => c.summary)],
            history: [],
          }),
          questions: { isDefect: { kind: "noul" } },
        });
        isDefect = answers.isDefect;
      } catch (e) {
        judgmentNote = `advisory judgment unavailable: ${e instanceof Error ? e.message.split("\n")[0] : String(e)}`;
      }
      const flagged = isDefect?.kind === "noul" && isDefect.value;
      transcript.record({
        op: item.op,
        control: liveControl,
        confidence: null,
        chosenBy: "strategy",
        strategy: "coverage-frontier",
        actOk: true,
        snapshot: decidedOn,
        ...(decidedOnTiming === undefined ? {} : { timing: decidedOnTiming }),
        ...(judgmentNote === undefined ? {} : { reason: judgmentNote }),
        ...(isDefect?.kind === "noul"
          ? { judgments: { isDefect: { value: isDefect.value, probability: isDefect.probability } } }
          : {}),
      });
      if (flagged) {
        defects.push({
          stateFingerprint: newFingerprint,
          url: snap.url,
          reason: "judgment flagged defect",
          recording: branch,
        });
        currentFingerprint = newFingerprint;
        continue; // recorded, but a flagged state is never expanded
      }

      if (!visited.has(newFingerprint)) {
        visited.add(newFingerprint);
        statePaths.set(newFingerprint, branch);
        enqueueFrom(frontier, newFingerprint, branch, snap.controls);
      }
      currentFingerprint = newFingerprint;
    }

    return {
      outcome: "exhausted",
      coverage: report(true),
      recordings: [...statePaths.values()],
      transcript: transcript.entries(),
      timing: summarizeTimings(timings),
    };
  } catch (e) {
    // Engine failure: a typed `crashed` result with every state path and transcript step so far.
    return {
      outcome: "crashed",
      failure: describeFailure(e, crashWatch.signals()),
      coverage: report(false),
      recordings: [...statePaths.values()],
      transcript: transcript.entries(),
      timing: summarizeTimings(timings),
    };
  }
}
