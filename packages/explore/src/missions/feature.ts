import type { Page } from "playwright";
import type { Actor } from "@jevitate/screenplay";
import { Navigate } from "@jevitate/screenplay";
import {
  RecordingSchema,
  type Assertion,
  type PageSegment,
  type Recording,
  type Step,
  type StepTiming,
  type TargetDescriptor,
} from "@jevitate/recording";
import { assertAuthorizedExploreTarget } from "../authorized-targets.js";
import { resolveBounds, type Bounds } from "../bounds.js";
import type { Control, Snapshot } from "../snapshot.js";
import { perceive } from "../perceive.js";
import { targetCandidates, type TargetOp } from "../actions.js";
import { act } from "../act.js";
import { toPath } from "../record.js";
import { stateFingerprint, actionKey, type FrontierOp } from "../feature/fingerprint.js";
import { Frontier } from "../feature/frontier.js";
import { chromeClassifier } from "../coverage/chrome.js";
import { StallWatchdog, StalledError } from "../stall-watchdog.js";
import { seedPath } from "./induction.js";
import { reachFrontierState } from "../feature/reach.js";
import { isInScope, type CapabilityScope } from "../feature/capability-scope.js";
import { boundaryValueCandidates, isSecretLike } from "../feature/boundary-values.js";
import { featureWords, relevanceScore, ChromeTracker } from "../feature/relevance.js";
import type { MissionFailure } from "@jevitate/domain";
import type { SettleConfig } from "../settle-config.js";
import type { HangSignal } from "../hang.js";
import { recordCoverageHang, type HangFinding } from "../hang-repro.js";
import { MissionSessions } from "../mission-session.js";
import type { VerifySession } from "../verify-fix.js";
import { CrashWatch, describeFailure, describeUnreachable, isUnreachableTarget } from "../mission-failure.js";
import { monitorFor } from "../page-monitor.js";
import { TranscriptLog, type TranscriptEntry, type TranscriptListener } from "../transcript.js";
import { seedRedirectReason } from "../seed-redirect.js";
import { MissionSafety } from "../mission-safety.js";
import type { SafetyConfig } from "../safety.js";
import type { SideEffect } from "../side-effects.js";
import type { InvariantSpec } from "@jevitate/recording";
import {
  InvariantDefectLog,
  InvariantMonitor,
  recordingStepCount,
  type InvariantDefect,
  type InvariantReport,
} from "../declared-invariants.js";

/**
 * runFeatureMission — a capability-scoped variant of proof-by-induction
 * (ticket #3's coverage algorithm), restricted to a `CapabilityScope`:
 *
 *  - it discovers UI paths dynamically (frontier expansion from a seed url +
 *    scope, never a pre-authored step list),
 *  - it exercises multiple valid routes through the named capability, using
 *    reset-and-replay to revisit branch points deterministically,
 *  - it stimulates in-scope form fields with VALID boundary values
 *    (`boundary-values.ts`), never adversarial ones and never a secret field,
 *  - a state whose url falls outside scope is recorded as a *boundary edge*
 *    and never expanded (guardrail #4), and
 *  - it emits one replayable `Recording` per distinct discovered path plus a
 *    scoped coverage summary.
 *
 * This mission is MODEL-FREE by design: it issues zero Jev/generation calls in
 * its loop (it is handed a seed url + scope, not a natural-language goal to
 * interpret), which trivially satisfies guardrail #5 ("the model never
 * self-certifies") — called out explicitly since every other mission does call
 * a model.
 *
 * DEVIATIONS from the plan (documented rulings — the plan was written against
 * an assumed ticket #1 surface that differs from the shipped one):
 *  - consumes the real `snapshot`/`act`/`resolveBounds`/`Control`/`Snapshot`
 *    (not the assumed `snapshotPage`/`executeAction`/`defaultBounds`);
 *  - builds Recordings with a local pure `extendRecording` (the shipped
 *    recorder is the stateful `RunRecorder` builder; there is no functional
 *    `recordStep(recording, ...)`), each leaf self-contained and replayable;
 *  - the real `Control` has no `value` field, so a typed form field does not
 *    change the state fingerprint — see the "known limitation" note below.
 */

export interface FeatureCoverage {
  pathsDiscovered: number;
  statesExercised: number;
  transitionsExercised: number;
  /** urls that were reached but fell outside scope (the feature's perimeter). Deduplicated. */
  boundaryEdges: string[];
  /**
   * Count of executed actions that (a) succeeded, (b) landed in scope, and
   * (c) were not flagged as global chrome (`feature/relevance.ts`'s
   * `ChromeTracker`) — i.e. actions that genuinely exercised the named
   * capability. Zero means the run proved nothing about `scope.name`,
   * whatever the loop's own stop reason was — `runFeatureCliMission` turns
   * that into `missionOutcome: "inconclusive"`, never a fabricated `"clean"`.
   */
  inScopeActionsExercised: number;
}

export interface FeatureRunResult {
  /**
   * `crashed`: the engine failed; the paths discovered up to the failure are still returned.
   * `hang`: stopped at a hang it could not reset from (an unresponsive page, no fresh session).
   * `scope-unreachable`: the seed redirected elsewhere (e.g. a lost `--storage-state` session
   * bounced to a login page) — the run never got to test the capability it was asked to (#82) — or,
   * mid-run, the frontier could not return to the seed after a departure (#114).
   * `stalled`: no step completed within the stall watchdog's bound (#114).
   */
  outcome: "exhausted" | "cap" | "path-cap" | "crashed" | "hang" | "scope-unreachable" | "stalled";
  /** Hangs met while exploring (deduped by fingerprint), each with its fresh-context reproduction. */
  hangs: HangFinding[];
  /** Why the run crashed, could not reach its target, or stalled. */
  failure?: MissionFailure;
  coverage: FeatureCoverage;
  recordings: Recording[];
  /** The shared decision transcript: each ranked frontier action, whether it landed, in/out of scope, and chrome. */
  transcript: TranscriptEntry[];
  /** Declared-invariant violations (#86), each with the path Recording that reproduces it. */
  invariantDefects?: InvariantDefect[];
  /** Per declared invariant: how often it applied, held, was violated, or could not be read. */
  invariants?: InvariantReport[];
  /** The writes the frontier's actions fired (#116), marked when the control was paid / destructive. */
  sideEffects?: SideEffect[];
  sideEffectsTruncated?: number;
}

/** Declared invariants (#86) for a frontier mission: the monitor and the defects it found. */
interface Declared {
  readonly monitor: InvariantMonitor;
  readonly log: InvariantDefectLog;
}

const TIMING: StepTiming = { atMs: 0, durationMs: 0, gapBeforeMs: 0 };

/** The ops the feature frontier issues — never `upload` (the mission carries no fixture). */
const FRONTIER_OPS: ReadonlySet<TargetOp> = new Set<TargetOp>(["click", "type", "select"]);

/**
 * The frontier candidates a state offers, by the SHARED affordance mapping (`affordedOp`,
 * ./actions.ts) — the same op the goal loop would use on each control.
 */
function frontierCandidates(controls: readonly Control[]): Array<{ control: Control; op: FrontierOp }> {
  const out: Array<{ control: Control; op: FrontierOp }> = [];
  for (const c of targetCandidates(controls, { ops: FRONTIER_OPS })) {
    if (c.op === "click" || c.op === "type" || c.op === "select") out.push({ control: c.control, op: c.op });
  }
  return out;
}

/**
 * The same candidates, RANKED by relevance to the feature words (ticket #78):
 * highest-scoring first, so a capability-relevant control (e.g. "Buy pack" for
 * `--feature "buy a pack"`) is tried well before de-prioritised global chrome
 * (header/nav landmarks, theme toggles, account menus, command palettes — see
 * `ChromeTracker`). A stable sort keeps original DOM order among equal scores.
 */
function rankedFrontierCandidates(
  controls: readonly Control[],
  words: readonly string[],
  chrome: ChromeTracker,
): Array<{ control: Control; op: FrontierOp }> {
  return frontierCandidates(controls)
    .map((c, i) => ({ ...c, i, score: relevanceScore(c.control, words, chrome) }))
    .sort((a, b) => b.score - a.score || a.i - b.i);
}

function pathnameOf(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return url;
  }
}

function seedRecording(seedUrl: string, site: string): Recording {
  // WITH the seed's query (#114): `/workspace?inquiry=…` without it is a different page, so every
  // reset would land elsewhere and every queued item would go stale.
  const path = seedPath(seedUrl);
  return {
    version: "1.0.0",
    site,
    pages: [
      { url: path, steps: [{ step: { kind: "navigate", url: path, expect: { kind: "urlIncludes", text: path } }, timing: TIMING }] },
    ],
  };
}

/**
 * Pure, immutable append: prefix + one executed step → a new schema-valid,
 * replayable Recording. Mirrors `RunRecorder`'s record-before-reobserve
 * discipline (a navigating step gets a `urlIncludes` postcondition and opens
 * the next page segment); a non-navigating step gets a `visible` postcondition.
 */
function extendRecording(
  prefix: Recording,
  op: FrontierOp,
  descriptor: TargetDescriptor,
  value: string | undefined,
  navigatedToPath: string | null,
): Recording {
  const pages: PageSegment[] = structuredClone(prefix.pages);
  // A feature path always starts with its seed navigate segment (`seedRecording`); a prefix with no
  // page segment is not a path this mission produced, so it is rejected rather than guessed at.
  const last = pages.at(-1);
  if (last === undefined) throw new Error("extendRecording: path prefix has no page segment");
  const expect: Assertion =
    navigatedToPath !== null ? { kind: "urlIncludes", text: navigatedToPath } : { kind: "visible", target: { ...descriptor } };

  let step: Step;
  if (op === "click") step = { kind: "click", target: { ...descriptor }, expect };
  else if (op === "type") step = { kind: "fill", target: { ...descriptor }, value: { redacted: false, value: value ?? "" }, expect };
  else step = { kind: "select", target: { ...descriptor }, value: { redacted: false, value: value ?? "" }, expect };

  last.steps.push({ step, timing: TIMING });
  if (navigatedToPath !== null) pages.push({ url: navigatedToPath, steps: [] });
  return RecordingSchema.parse({ version: prefix.version, site: prefix.site, pages });
}

export type FeatureMissionParams = {
  page: Page;
  actor: Actor;
  seedUrl: string;
  allowlist: readonly string[];
  scope: CapabilityScope;
  bounds?: Partial<Bounds>;
  maxDepth?: number;
  maxPaths?: number;
  /** Bound (ms) on waiting for a rendered page on each perception. Default `RENDER_WAIT_MS` — the shared settle rule
   *  recognises a control-free leaf state in about the quiet window, so no shorter coverage bound is needed. */
  renderWaitMs?: number;
  /** The target's settle configuration (background requests, long-poll threshold). */
  settle?: SettleConfig;
  /** Opens a FRESH browser session: reproduces a hang and resets to it after one. */
  openFreshSession?: () => Promise<VerifySession>;
  /** Fresh-context replays that confirm a hang. Default 2. */
  hangReplays?: number;
  /** Incremental-flush seam: every transcript entry, as it is recorded. */
  onTranscriptEntry?: TranscriptListener;
  /** App-declared invariants (#86): evaluated around every frontier action; a violation is a hard defect. */
  invariants?: InvariantSpec;
  /** Registered secrets: redacted out of invariant values and evidence. */
  secrets?: readonly string[];
  /** Resolved `authFrom.secret` refs (#135) a declared probe may use: `env:VAR` → its value. */
  invariantAuthTokens?: ReadonlyMap<string, string>;
  /** No-progress watchdog (#114): the run ends `stalled` when no step completes within this bound. Default 120s. */
  stallTimeoutMs?: number;
  /** Bound (ms) on one reset-and-replay back to a queued state. Default `DEFAULT_REACH_TIMEOUT_MS`. */
  reachTimeoutMs?: number;
  /** The shared safety policy (#116): session-ending / destructive / paid / --deny'd controls are never clicked. */
  safety?: SafetyConfig;
};

export async function runFeatureMission(params: FeatureMissionParams): Promise<FeatureRunResult> {
  // Guardrail #1 — authorize BEFORE touching the page (fail-closed).
  assertAuthorizedExploreTarget(params.seedUrl, params.allowlist);
  const declared: Declared | null =
    params.invariants === undefined
      ? null
      : {
          monitor: new InvariantMonitor(params.invariants, {
            allowlist: params.allowlist,
            baseUrl: params.seedUrl,
            ...(params.secrets === undefined ? {} : { secrets: params.secrets }),
            ...(params.invariantAuthTokens === undefined ? {} : { authTokens: params.invariantAuthTokens }),
          }),
          log: new InvariantDefectLog(),
        };
  // The named capability is the mission's goal: a risky control whose verb it names ("buy a pack"
  // → "Buy pack 1") is what the operator asked to test; any other stays refused (#116).
  const safety = new MissionSafety(params.safety, { goal: params.scope.name });
  const result = { ...(await runFeatureFrontier(params, declared, safety)), ...safety.result() };
  return declared === null ? result : { ...result, invariantDefects: declared.log.defects(), invariants: declared.monitor.report() };
}

async function runFeatureFrontier(params: FeatureMissionParams, declared: Declared | null, safety: MissionSafety): Promise<FeatureRunResult> {
  const bounds = resolveBounds(params.bounds);
  const maxDepth = params.maxDepth ?? 10;
  const maxPaths = params.maxPaths ?? 20;
  const site = new URL(params.seedUrl).origin;

  const sessions = new MissionSessions({ page: params.page, actor: params.actor }, params.openFreshSession);
  const hangs = new Map<string, HangFinding>();
  /** The hang the latest perception saw (a holder: it is set inside the perception closure). */
  const seenHang: { last: HangSignal | null } = { last: null };

  // Shared perception (render wait + occlusion): a state is never fingerprinted from a blank,
  // still-rendering frame — including right after a reset-and-replay.
  const snapshotNow = async (): Promise<Snapshot> => {
    const p = await perceive(sessions.page, {
      maxCandidates: bounds.maxCandidates,
      ...(params.renderWaitMs === undefined ? {} : { renderWaitMs: params.renderWaitMs }),
      ...(params.settle === undefined ? {} : { settleConfig: params.settle }),
    });
    seenHang.last = p.hang;
    return p.snapshot;
  };

  let crashWatch = new CrashWatch(sessions.page);
  declared?.monitor.attach(sessions.page);
  sessions.onReset((page) => {
    crashWatch = new CrashWatch(page);
    declared?.monitor.attach(page);
  });
  const visited = new Set<string>();
  const boundaryEdgeSet = new Set<string>();
  const leaves = new Map<string, Recording>();
  const extended = new Set<string>();
  let transitionsExercised = 0;
  let pathsDiscovered = 1; // the seed state counts as the first path
  let inScopeActionsExercised = 0;

  // Ranking inputs (ticket #78): feature words drive lexical relevance; the
  // chrome tracker accumulates cross-page control repetition as it's observed.
  const words = featureWords(params.scope.name);
  const chrome = new ChromeTracker();
  // No-progress watchdog (#114): every recorded step kicks it; every await on the page is guarded.
  const watchdog = new StallWatchdog(params.stallTimeoutMs);
  const guard = <T>(work: Promise<T>): Promise<T> => watchdog.guard(work);
  const transcript = new TranscriptLog([], (entry, all) => {
    watchdog.kick("choosing the next frontier action");
    params.onTranscriptEntry?.(entry, all);
  });

  const endRun = (outcome: FeatureRunResult["outcome"], failure?: MissionFailure): FeatureRunResult => ({
    outcome,
    ...(failure === undefined ? {} : { failure }),
    coverage: {
      pathsDiscovered,
      statesExercised: visited.size,
      transitionsExercised,
      boundaryEdges: [...boundaryEdgeSet],
      inScopeActionsExercised,
    },
    recordings: [...leaves.entries()].filter(([fp]) => !extended.has(fp)).map(([, r]) => r),
    hangs: [...hangs.values()],
    transcript: transcript.entries(),
  });

  try {
    watchdog.during("loading the seed");
    await guard(monitorFor(sessions.page).instrument());
    safety.attach(monitorFor(sessions.page));
    // #128: real network evidence for the FIRST navigation — a refused connection can still
    // surface as a bare navigation timeout.
    let firstNavNetError: string | null = null;
    const onFirstNavRequestFailed = (req: { failure(): { errorText: string } | null }): void => {
      const text = req.failure()?.errorText;
      if (text !== undefined) firstNavNetError = text;
    };
    sessions.page.on("requestfailed", onFirstNavRequestFailed);
    try {
      await guard(sessions.actor.attemptsTo(Navigate.to(params.seedUrl)));
    } catch (e) {
      const message = e instanceof Error ? (e.message.split("\n")[0] ?? e.message) : String(e);
      if (!isUnreachableTarget(message) && !isUnreachableTarget(firstNavNetError ?? "")) throw e;
      // The seed itself could not be loaded: never a defect in the app, never a bug in jevitate —
      // a configuration problem. `inconclusive`, never `crashed`; no crash report/issue drafted.
      return endRun("scope-unreachable", {
        kind: "target-unreachable",
        message: `target unreachable (${describeUnreachable(message, firstNavNetError)})`,
      });
    } finally {
      sessions.page.off("requestfailed", onFirstNavRequestFailed);
    }
    let snap = await guard(snapshotNow());

    // The seed redirected elsewhere — most often a lost/expired `--storage-state` session bounced
    // to a login page (#82): the run cannot exercise the capability it was asked to.
    const redirect = seedRedirectReason(params.seedUrl, snap.url);
    if (redirect !== null) return endRun("scope-unreachable", { kind: "target-unreachable", message: redirect.reason });
    chrome.observe(pathnameOf(snap.url), snap.controls);
    let currentFingerprint = stateFingerprint(snap);
    visited.add(currentFingerprint);
    // Chrome last (#115): nav/header/footer landmarks, controls repeated across pathnames and links out
    // of scope are tried only once the capability's own controls are exhausted, each destination once.
    const frontier = new Frontier({ classify: chromeClassifier({ chrome, inScope: (url) => isInScope(url, params.scope) }) });
    /** The last transition left the scope — the next reset is a return after a departure. */
    let departed = false;

    const seedRec = seedRecording(params.seedUrl, site);
    leaves.set(currentFingerprint, seedRec);
    for (const { control, op } of rankedFrontierCandidates(snap.controls, words, chrome)) {
      frontier.push({ key: actionKey(currentFingerprint, control, op), fromFingerprint: currentFingerprint, pathPrefix: seedRec, control, op });
    }

    let actions = 0;

    while (!frontier.isExhausted()) {
      if (actions >= bounds.maxActions) return endRun("cap");
      if (pathsDiscovered >= maxPaths) return endRun("path-cap");

      const item = frontier.popPreferring(currentFingerprint);
      if (item === undefined) break;
      const depth = item.pathPrefix.pages.reduce((n, p) => n + p.steps.length, 0);
      if (depth >= maxDepth) continue;
      // A link to a boundary already recorded proves nothing new: shared nav repeated on every
      // in-scope state would otherwise be re-clicked once per state (the states multiply as
      // in-scope controls toggle), so the run never exhausts.
      if (item.control.href != null && !isInScope(item.control.href, params.scope) && boundaryEdgeSet.has(item.control.href)) continue;

      if (item.fromFingerprint !== currentFingerprint) {
        watchdog.during(departed ? "returning to the seed after a departure" : "resetting to a queued state");
        const reached = await guard(
          reachFrontierState({
            actor: sessions.actor,
            item,
            snapshotNow,
            homeUrl: params.seedUrl,
            currentUrl: () => sessions.page.url(),
            ...(params.reachTimeoutMs === undefined ? {} : { timeoutMs: params.reachTimeoutMs }),
          }),
        );
        if (!reached.ok) {
          if (reached.reason === "stale") {
            // Stale — dropped, and so is every other item replaying the same path (#114).
            frontier.dropState(item.fromFingerprint);
            currentFingerprint = "";
            continue;
          }
          // The seed is gone (a lost session) or stopped answering: a typed stop, never an idle grind (#114).
          return endRun("scope-unreachable", {
            kind: "target-unreachable",
            message: `could not return to the seed${departed ? " after a departure" : ""} (${reached.detail ?? reached.reason})`,
          });
        }
        departed = false;
        snap = reached.snapshot;
        chrome.observe(pathnameOf(snap.url), snap.controls);
        currentFingerprint = item.fromFingerprint;
      }

      // Boundary-value stimulation on type; a secret-like field yields NO
      // candidate and is skipped entirely (guardrail #3 — never synthesized).
      const fillText = item.op === "type" && !isSecretLike(item.control) ? boundaryValueCandidates(item.control)[0] : undefined;
      if (item.op === "type" && fillText === undefined) continue;

      const beforeUrl = snap.url;
      const decidedOn = snap;
      const itemScore = relevanceScore(item.control, words, chrome);
      const itemWasChrome = chrome.isChrome(item.control);
      const rankReason = `relevance=${itemScore} chrome=${itemWasChrome}`;
      // The shared safety policy (#116): a session-ending / destructive / paid control is never
      // clicked; the refusal is recorded once per control.
      const unsafe = safety.gate(item.op, item.control);
      if (unsafe !== null) {
        if (unsafe.first) {
          transcript.record({
            op: null,
            control: item.control,
            confidence: null,
            chosenBy: "strategy",
            strategy: "safety-policy",
            origin: "engine",
            actOk: false,
            reason: unsafe.reason,
            snapshot: decidedOn,
          });
        }
        continue;
      }
      watchdog.during(`acting on "${item.control.name || item.op}"`);
      if (declared !== null) await guard(declared.monitor.before(sessions.actor));
      safety.mark(transcript.nextStep, item.op, item.control);
      const result = await guard(act(sessions.actor, { op: item.op, control: item.control, value: fillText ?? null }));
      actions += 1;
      frontier.recordAttempt();
      if (!result.ok) {
        transcript.record({
          op: item.op,
          control: item.control,
          confidence: null,
          chosenBy: "strategy",
          strategy: "feature-frontier",
          actOk: false,
          reason: result.reason === undefined ? rankReason : `${rankReason}; ${result.reason}`,
          snapshot: decidedOn,
        });
        continue;
      }

      snap = await guard(snapshotNow());
      chrome.observe(pathnameOf(snap.url), snap.controls);
      const navigatedToPath = toPath(beforeUrl) !== toPath(snap.url) ? toPath(snap.url) : null;
      const newFingerprint = stateFingerprint(snap);
      const branch = extendRecording(item.pathPrefix, item.op, item.control.descriptor, fillText, navigatedToPath);
      transitionsExercised += 1;
      extended.add(item.fromFingerprint);
      if (declared !== null && seenHang.last === null) {
        // Declared invariants (#86): judged on the settled state the action produced; the finding
        // replays this very path (the seed navigate is its first step).
        const path = { ...branch, pages: branch.pages.filter((p) => p.steps.length > 0) };
        const checked = await guard(declared.monitor.after(sessions.actor, { op: item.op, control: item.control.name, url: beforeUrl }));
        for (const v of checked.violations) {
          declared.log.add(v, { recordingStepIndex: recordingStepCount(path) - 1, recording: path });
        }
      }

      // A hang: record it (reproduced from the path that led here), reset to a known state and keep
      // exploring the rest of the frontier. The hung state is never expanded.
      const hang = seenHang.last;
      if (hang !== null) {
        transcript.record({
          op: item.op,
          control: item.control,
          confidence: null,
          chosenBy: "strategy",
          strategy: "feature-frontier",
          actOk: true,
          reason: `${rankReason}; hang (${hang.kind}): ${hang.detail}`,
          snapshot: decidedOn,
        });
        watchdog.suspend(); // the reproduction is bounded on its own (fresh contexts, bounded replays)
        await recordCoverageHang({
          hang,
          recording: { ...branch, pages: branch.pages.filter((p) => p.steps.length > 0) },
          steps: [],
          found: hangs,
          ...(params.openFreshSession === undefined ? {} : { openSession: params.openFreshSession }),
          ...(params.hangReplays === undefined ? {} : { attempts: params.hangReplays }),
          // Re-detected with the SAME perception bounds the mission used.
          perceive: {
            ...(params.renderWaitMs === undefined ? {} : { renderWaitMs: params.renderWaitMs }),
            ...(params.settle === undefined ? {} : { settleConfig: params.settle }),
          },
        });
        watchdog.kick("resetting after a hang");
        if (!(await guard(sessions.reset(hang)))) return endRun("hang");
        await guard(monitorFor(sessions.page).instrument());
        safety.attach(monitorFor(sessions.page));
        currentFingerprint = ""; // the next item is reached afresh from the seed
        continue;
      }

      const landedInScope = isInScope(snap.url, params.scope);
      transcript.record({
        op: item.op,
        control: item.control,
        confidence: null,
        chosenBy: "strategy",
        strategy: "feature-frontier",
        actOk: true,
        reason: `${rankReason}; inScope=${landedInScope}`,
        snapshot: decidedOn,
      });

      if (!landedInScope) {
        // Out of scope — recorded as a boundary edge (deduplicated), never
        // expanded (guardrail #4). Never counted as a discovered feature path.
        boundaryEdgeSet.add(snap.url);
        leaves.set(newFingerprint, branch);
        currentFingerprint = newFingerprint;
        departed = true;
        continue;
      }

      if (!itemWasChrome) inScopeActionsExercised += 1;

      if (!visited.has(newFingerprint)) {
        visited.add(newFingerprint);
        leaves.set(newFingerprint, branch);
        pathsDiscovered += 1;
        for (const { control, op } of rankedFrontierCandidates(snap.controls, words, chrome)) {
          frontier.push({ key: actionKey(newFingerprint, control, op), fromFingerprint: newFingerprint, pathPrefix: branch, control, op });
        }
      }
      currentFingerprint = newFingerprint;
    }

    return endRun("exhausted");
  } catch (e) {
    // The watchdog fired (#114): a typed `stalled` stop with every path found so far, never an idle run.
    if (e instanceof StalledError) return endRun("stalled", { kind: "stalled", message: e.reason });
    // Engine failure: a typed `crashed` result carrying every path discovered so far.
    return endRun("crashed", describeFailure(e, crashWatch.signals()));
  } finally {
    watchdog.stop();
    await sessions.closeOwned();
  }
}
