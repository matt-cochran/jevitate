import type { Page } from "playwright";
import type { Actor } from "@jevitate/screenplay";
import type { InvariantSpec, Recording } from "@jevitate/recording";
import { RecordingInterpreter, type ReplayTargetFailure } from "@jevitate/interpreter";
import { perceive, type PerceiveOptions } from "./perceive.js";
import { observeAfterStep } from "./record.js";
import type { HangSignal } from "./hang.js";
import { replayAndDetectHang, replayTargetWaitMs, type HangRule } from "./hang-repro.js";
import type { SafetyConfig } from "./safety.js";
import { monitorFor } from "./page-monitor.js";
import { PageSignalCollector } from "./adversarial/defect-oracle.js";
import { signalFingerprint } from "./adversarial/defect-fingerprint.js";
import { InvariantMonitor, type ObserverSessions } from "./declared-invariants.js";

/**
 * verifyFix — "is this defect fixed?", answered by REPLAY, not by opinion.
 *
 * Replays a defect's reproduction (its Recording up to `recordingStepIndex`, via the existing
 * `RecordingInterpreter.runToCheckpoint` — no second replay engine) in a FRESH session with the
 * same hard-signal oracle attached before the first step, lets the page settle, and looks for the
 * defect's fingerprint among the signals the replay produced.
 *
 * A SINGLE clean replay is not evidence a fix landed (#74): a timing-dependent signal (the
 * `net::ERR_ABORTED`-after-response case in #73 is one example, but any signal can be
 * intermittent) can simply not fire once and still be there. The replay runs `replays` times
 * (default `DEFAULT_VERIFY_REPLAYS`), each in its own FRESH session, mirroring the reproduction
 * machinery `hang-repro.ts` uses to confirm a hang. Only attempts that actually RAN (reached the
 * defect's step) count as evidence:
 *
 *  - `still-reproduces` — the fingerprint fired on EVERY attempt that ran;
 *  - `fixed`            — the fingerprint fired on NONE of the attempts that ran, and at least one
 *                         ran;
 *  - `intermittent`     — the fingerprint fired on SOME but not all attempts that ran: the signal
 *                         is flaky on the CURRENT code, so absence on any one replay proves
 *                         nothing — never reported as fixed;
 *  - `inconclusive`     — no attempt ran (the app changed so the recorded path no longer matches,
 *                         a step failed, every session failed to open): that proves nothing either
 *                         way.
 *
 * A DECLARED `invariant` defect (#86) is re-checked with the same invariant spec: each attempt
 * replays up to the step BEFORE the defect's, snapshots the invariant's observables, replays the
 * defect's step, lets it settle and evaluates that one invariant. An attempt whose observables
 * could not be read did not run (no evidence). A code-level invariant (no spec) stays inconclusive.
 *
 * Never throws (aside from a caller bug like an invalid `replays` count): every failure is an
 * `inconclusive` verdict with its reason.
 */

export interface VerifySession {
  readonly page: Page;
  readonly actor: Actor;
  close(): Promise<void>;
}

export interface VerifyFixParams {
  readonly recording: Recording;
  /** Flat index of the last Recording step to replay (the defect's `repro.recordingStepIndex`). */
  readonly recordingStepIndex: number;
  /** The defect's fingerprint. */
  readonly fingerprint: string;
  /**
   * The defect's kind. An `invariant` defect is re-checked with `invariant` (its declared spec); a
   * code-level invariant that is not part of the Recording cannot be re-checked: `inconclusive`.
   */
  readonly defectKind: string;
  /** For a declared `invariant` defect (#86): the spec and id to re-check, and where probes may go. */
  readonly invariant?: VerifyInvariant;
  /** Opens a FRESH browser session (never the one the defect was found in). */
  readonly openSession: () => Promise<VerifySession>;
  /** Render/settle ceiling after the replay (ms). Default: perceive's default. */
  readonly settleCeilingMs?: number;
  /**
   * For a `hang` finding: the hang signal. Its fix is verified by replaying and re-applying the hang
   * rule — it passes only if the replay now settles within the bound.
   */
  readonly hang?: HangSignal;
  /** Perception bounds for the hang re-check (the ones the mission used). */
  readonly perceive?: PerceiveOptions;
  /** Stall window for a stalled-state `ui-no-progress` hang (ms). */
  readonly stallMs?: number;
  /**
   * The target's safety policy (#153): a hang replay never re-sends a paid/destructive write unless
   * `hangReplayWrites` opts in — the verdict is then `inconclusive`, never `fixed`.
   */
  readonly safety?: SafetyConfig;
  /** Controls the mission's recorded side effects show firing a write (#181): a hang replay through one is withheld. */
  readonly writtenBy?: readonly string[];
  /**
   * How long a recorded target may take to appear on replay (ms). Default (#164): the render wait —
   * `perceive.renderWaitMs`, else `settleCeilingMs`, else `RENDER_WAIT_MS` (`replayTargetWaitMs`).
   */
  readonly targetTimeoutMs?: number;
  /** Fresh-context replays for a non-hang defect signal (#74). Default `DEFAULT_VERIFY_REPLAYS`. */
  readonly replays?: number;
  /**
   * The defect's recorded reproducibility at mission time, when it's available (e.g. an
   * `AdversarialDefect.occurrences` — how many times the SAME run hit it). Consulted only for the
   * verdict's evidence trail (`reason`); the replay verdict itself is always decided by what this
   * replay actually observed, never by opinion about how reproducible the original finding "should"
   * have been.
   */
  readonly occurrences?: number;
}

export interface VerifyInvariant {
  readonly spec: InvariantSpec;
  readonly id: string;
  /** The mission's authorized origins (probes never leave them). */
  readonly allowlist: readonly string[];
  /** What relative probe paths resolve against (the mission's start URL). */
  readonly baseUrl: string;
  readonly secrets?: readonly string[];
  /** Resolved `authFrom.secret` refs (#135) a declared probe may use: `env:VAR` → its value. */
  readonly authTokens?: ReadonlyMap<string, string>;
  /**
   * #147: opens the observer actors' sessions for a cross-actor invariant — called once per replay
   * attempt, so every attempt checks from FRESH observer contexts too.
   */
  readonly openObservers?: () => ObserverSessions;
  /** #147: the primary actor's name. */
  readonly primaryActor?: string;
}

export type VerifyFixVerdict = "fixed" | "still-reproduces" | "intermittent" | "inconclusive";

export interface VerifyFixResult {
  readonly verdict: VerifyFixVerdict;
  readonly fingerprint: string;
  /** Distinct signal fingerprints the replay produced (evidence for the verdict). */
  readonly observedFingerprints: string[];
  /** How far the (last-run) replay got: `completed`, or the step it failed at and why. */
  readonly replay:
    | { readonly outcome: "completed" }
    | {
        readonly outcome: "failed";
        readonly at: number;
        readonly error: string;
        /** A replay-TARGET failure: the recorded element is missing or ambiguous (never guessed). */
        readonly reason?: ReplayTargetFailure;
      };
  readonly reason: string;
  /** Every fresh-context attempt (#74; a hang's single replay too, #164): absent for `invariant`. */
  readonly attempts?: ReplayAttemptEvidence[];
}

/** One fresh-context replay's evidence: did it RUN (reach the step), and did the signal FIRE. */
export interface ReplayAttemptEvidence {
  readonly ran: boolean;
  readonly fired: boolean;
  readonly detail: string;
  /** A hang replay: which rule decided (#164). */
  readonly rule?: HangRule;
  /** A busy-indicator hang replay: busy indicators visible on the replayed page (#164). */
  readonly busyIndicators?: number;
}

/**
 * The pure verdict rule (#74): only attempts that RAN count as evidence. Absence on every one that
 * ran is `fixed`; firing on every one is `still-reproduces`; a mix is `intermittent` — a signal
 * that is flaky on the CURRENT code is never reported as fixed just because one replay was clean.
 */
export function verifyReplayVerdict(runs: readonly Pick<ReplayAttemptEvidence, "ran" | "fired">[]): VerifyFixVerdict {
  const ran = runs.filter((r) => r.ran);
  if (ran.length === 0) return "inconclusive";
  const fired = ran.filter((r) => r.fired).length;
  if (fired === 0) return "fixed";
  if (fired === ran.length) return "still-reproduces";
  return "intermittent";
}

export const DEFAULT_VERIFY_REPLAYS = 3;

/** A replayed step's bounded target wait (#164): explicit, else the render wait this verify uses. */
function targetWaitOf(params: VerifyFixParams): number {
  return replayTargetWaitMs({ targetTimeoutMs: params.targetTimeoutMs, renderWaitMs: params.perceive?.renderWaitMs ?? params.settleCeilingMs });
}

function firstLine(e: unknown): string {
  return e instanceof Error ? e.message.split("\n")[0] ?? e.message : String(e);
}

export async function verifyFix(params: VerifyFixParams): Promise<VerifyFixResult> {
  const base = { fingerprint: params.fingerprint };
  if (params.defectKind === "hang") {
    if (params.hang === undefined) {
      return {
        ...base,
        verdict: "inconclusive",
        observedFingerprints: [],
        replay: { outcome: "failed", at: -1, error: "not replayed" },
        reason: "a hang finding needs its hang signal to be re-checked",
      };
    }
    const attempt = await replayAndDetectHang({
      recording: params.recording,
      recordingStepIndex: params.recordingStepIndex,
      hang: params.hang,
      openSession: params.openSession,
      ...(params.perceive === undefined ? {} : { perceive: params.perceive }),
      ...(params.stallMs === undefined ? {} : { stallMs: params.stallMs }),
      ...(params.safety === undefined ? {} : { safety: params.safety }),
      ...(params.writtenBy === undefined ? {} : { writtenBy: params.writtenBy }),
      targetTimeoutMs: targetWaitOf(params),
    });
    const replay: VerifyFixResult["replay"] =
      attempt.replay === "failed" ? { outcome: "failed", at: -1, error: attempt.detail } : { outcome: "completed" };
    // #164: the hang's one replay is recorded as evidence too — which rule decided, and what it saw.
    const attempts: ReplayAttemptEvidence[] = [
      {
        ran: attempt.ran,
        fired: attempt.reproduced,
        detail: attempt.detail,
        ...(attempt.rule === undefined ? {} : { rule: attempt.rule }),
        ...(attempt.busyIndicators === undefined ? {} : { busyIndicators: attempt.busyIndicators }),
      },
    ];
    if (attempt.reproduced) {
      return { ...base, verdict: "still-reproduces", observedFingerprints: [params.fingerprint], replay, reason: `the hang reproduced: ${attempt.detail}`, attempts };
    }
    if (attempt.withheld !== undefined) {
      // #153: not replayed — the path re-sends a paid/destructive write. Never "fixed".
      return { ...base, verdict: "inconclusive", observedFingerprints: [], replay: { outcome: "failed", at: -1, error: "not replayed" }, reason: attempt.detail };
    }
    if (!attempt.ran) {
      // The attempt never ran (no session, or the replay failed before the step): no evidence.
      return { ...base, verdict: "inconclusive", observedFingerprints: [], replay, reason: `${attempt.detail}; absence of the hang proves nothing`, attempts };
    }
    return { ...base, verdict: "fixed", observedFingerprints: [], replay, reason: `the replay settled within the bound (${attempt.detail})`, attempts };
  }
  const declared = params.defectKind === "invariant" ? params.invariant : undefined;
  if (params.defectKind === "invariant" && (declared === undefined || !declared.spec.invariants.some((i) => i.id === declared.id))) {
    return {
      ...base,
      verdict: "inconclusive",
      observedFingerprints: [],
      replay: { outcome: "failed", at: -1, error: "not replayed" },
      reason: "an invariant defect needs its user invariant to be re-checked; a replay alone proves nothing",
    };
  }
  const replays = params.replays ?? DEFAULT_VERIFY_REPLAYS;
  if (!Number.isInteger(replays) || replays < 1) throw new Error(`verifyFix: replays must be >= 1, got ${replays}`);

  const runs: SingleReplayAttempt[] = [];
  for (let i = 0; i < replays; i++) {
    const attempt = declared === undefined ? await runOneReplay(params) : await runOneInvariantReplay(params, declared);
    runs.push(attempt);
    // The recorded path itself does not match the current app: retrying cannot change that, so more
    // attempts would not add evidence (matches the pre-#74 single-attempt inconclusive verdict).
    if (attempt.targetMismatch) break;
  }
  const last = runs[runs.length - 1] as SingleReplayAttempt;
  const observedFingerprints = [...new Set(runs.flatMap((r) => r.observed))];
  const attempts: ReplayAttemptEvidence[] = runs.map((r) => ({ ran: r.ran, fired: r.fired, detail: r.detail }));
  const verdict = verifyReplayVerdict(runs);
  const ran = runs.filter((r) => r.ran).length;
  const fired = runs.filter((r) => r.ran && r.fired).length;
  const occNote = params.occurrences === undefined ? "" : ` (the original run observed it ${params.occurrences} time(s))`;
  const reason: string =
    verdict === "inconclusive"
      ? `${last.detail}${occNote}`
      : verdict === "still-reproduces"
        ? `the defect's fingerprint fired on all ${fired}/${ran} replay(s) that ran${occNote}`
        : verdict === "fixed"
          ? `the defect's fingerprint was absent on all ${ran}/${runs.length} replay(s) that ran${occNote}`
          : `the defect's fingerprint fired on ${fired}/${ran} replay(s) that ran — intermittent on the current code, never reported as fixed${occNote}`;
  return { ...base, verdict, observedFingerprints, replay: last.replay, reason, attempts };
}

/** Steps `0..index` of a Recording (flat order), so a resume stops at the defect's step. */
function truncateAt(recording: Recording, index: number): Recording {
  const copy: Recording = structuredClone(recording);
  let i = 0;
  const pages: Recording["pages"] = [];
  for (const page of copy.pages) {
    if (i > index) break;
    const steps = page.steps.filter(() => i++ <= index);
    pages.push({ ...page, steps });
  }
  return { ...copy, pages };
}

/** The recorded step at a flat index: its op and the acted control's name (for the invariant's action). */
function stepAction(recording: Recording, index: number): { op: string; control: string | null } {
  const step = recording.pages.flatMap((p) => p.steps)[index]?.step;
  if (step === undefined) return { op: "unknown", control: null };
  const target = "target" in step ? step.target : undefined;
  return { op: step.kind, control: target?.name ?? target?.label ?? target?.text ?? null };
}

/**
 * One fresh-context re-check of a DECLARED invariant (#86): replay to the step before the defect's,
 * snapshot, replay the defect's step, settle, evaluate that invariant. Never throws.
 */
async function runOneInvariantReplay(params: VerifyFixParams, inv: VerifyInvariant): Promise<SingleReplayAttempt> {
  let session: VerifySession;
  try {
    session = await params.openSession();
  } catch (e) {
    return {
      ran: false,
      fired: false,
      observed: [],
      replay: { outcome: "failed", at: -1, error: firstLine(e) },
      detail: `could not open a fresh session: ${firstLine(e)}`,
      targetMismatch: false,
    };
  }
  const observers = inv.openObservers?.();
  try {
    const monitor = new InvariantMonitor(inv.spec, {
      allowlist: inv.allowlist,
      baseUrl: inv.baseUrl,
      ...(inv.secrets === undefined ? {} : { secrets: inv.secrets }),
      ...(inv.authTokens === undefined ? {} : { authTokens: inv.authTokens }),
      ...(observers === undefined ? {} : { observers }),
      ...(inv.primaryActor === undefined ? {} : { primaryActor: inv.primaryActor }),
    });
    monitor.attach(session.page);
    await monitorFor(session.page).instrument();
    const index = params.recordingStepIndex;
    const upTo = truncateAt(observeAfterStep(params.recording, index), index);
    const interpreter = new RecordingInterpreter({ targetTimeoutMs: targetWaitOf(params) });
    const settle = (): Promise<unknown> =>
      perceive(session.page, { ...(params.settleCeilingMs === undefined ? {} : { renderWaitMs: params.settleCeilingMs }) }).catch(() => undefined);
    const failedAt = (r: Awaited<ReturnType<RecordingInterpreter["run"]>>): SingleReplayAttempt | null => {
      if (r.outcome === "completed") return null;
      const replay: VerifyFixResult["replay"] =
        r.outcome === "failed"
          ? { outcome: "failed", at: r.at, error: r.error.split("\n")[0] ?? r.error, ...(r.reason === undefined ? {} : { reason: r.reason }) }
          : { outcome: "failed", at: r.at, error: "replay paused for a human hand-back" };
      const mismatch = r.outcome === "failed" && r.reason !== undefined;
      return {
        ran: false,
        fired: false,
        observed: [],
        replay,
        detail: mismatch
          ? `replay stopped at step ${r.at}: ${r.reason} — the recorded path was not reproduced, so this proves nothing`
          : `replay could not reach the defect's step (failed at step ${r.at}); the invariant was not re-checked`,
        targetMismatch: mismatch,
      };
    };
    if (index > 0) {
      const pre = failedAt(await interpreter.runToCheckpoint(session.actor, upTo, index - 1));
      if (pre !== null) return pre;
      await settle();
    }
    const actedOn = session.page.url();
    await monitor.before(session.actor);
    const stepResult = index > 0 ? await interpreter.resumeFrom(session.actor, upTo, index) : await interpreter.runToCheckpoint(session.actor, upTo, 0);
    const failed = failedAt(stepResult);
    if (failed !== null) return failed;
    await settle();
    await session.page.waitForTimeout(10);
    // The original run already found the invariant applicable to this step: re-check exactly it.
    const checked = await monitor.after(session.actor, { ...stepAction(params.recording, index), url: actedOn }, { only: inv.id, force: true });
    const observed = checked.violations.map((v) => v.fingerprint);
    const replay: VerifyFixResult["replay"] = { outcome: "completed" };
    if (checked.violations.length > 0) {
      return {
        ran: true,
        fired: true,
        observed,
        replay,
        detail: `the invariant was violated again: ${checked.violations[0]?.reason ?? inv.id}`,
        targetMismatch: false,
      };
    }
    if (checked.held.length === 0) {
      return { ran: false, fired: false, observed, replay, detail: `invariant ${inv.id} could not be evaluated (an observable was unreadable); this proves nothing`, targetMismatch: false };
    }
    return { ran: true, fired: false, observed, replay, detail: `replay reached the defect's step and invariant ${inv.id} held`, targetMismatch: false };
  } catch (e) {
    return {
      ran: false,
      fired: false,
      observed: [],
      replay: { outcome: "failed", at: -1, error: firstLine(e) },
      detail: `replay failed: ${firstLine(e)}`,
      targetMismatch: false,
    };
  } finally {
    await observers?.close().catch(() => undefined);
    await session.close().catch(() => undefined);
  }
}

/** One fresh-context replay's raw outcome, before it is folded into the verdict. */
interface SingleReplayAttempt extends ReplayAttemptEvidence {
  readonly observed: string[];
  readonly replay: VerifyFixResult["replay"];
  /** A replay-TARGET failure (the recorded element is missing or ambiguous): more attempts cannot help. */
  readonly targetMismatch: boolean;
}

/** Session open → replay to the defect's step → observe. Never throws. */
async function runOneReplay(params: VerifyFixParams): Promise<SingleReplayAttempt> {
  let session: VerifySession;
  try {
    session = await params.openSession();
  } catch (e) {
    return {
      ran: false,
      fired: false,
      observed: [],
      replay: { outcome: "failed", at: -1, error: firstLine(e) },
      detail: `could not open a fresh session: ${firstLine(e)}`,
      targetMismatch: false,
    };
  }
  try {
    // The oracle listens BEFORE the first replayed step, exactly as in the original run.
    const collector = new PageSignalCollector(session.page);
    await monitorFor(session.page).instrument();
    // The defect's step is replayed to OBSERVE what the app does next — its own postcondition is not
    // the verdict (a fixed app may legitimately behave differently after it); the signal check is.
    const result = await new RecordingInterpreter({ targetTimeoutMs: targetWaitOf(params) }).runToCheckpoint(
      session.actor,
      observeAfterStep(params.recording, params.recordingStepIndex),
      params.recordingStepIndex,
    );
    // Let async work the replayed step started (the late 500, the deferred console error) land.
    await perceive(session.page, {
      ...(params.settleCeilingMs === undefined ? {} : { renderWaitMs: params.settleCeilingMs }),
    }).catch(() => undefined);
    await session.page.waitForTimeout(10);
    const observed = [...new Set(collector.drain().map(signalFingerprint))];
    const replay: VerifyFixResult["replay"] =
      result.outcome === "completed"
        ? { outcome: "completed" }
        : result.outcome === "failed"
          ? {
              outcome: "failed",
              at: result.at,
              error: result.error.split("\n")[0] ?? result.error,
              ...(result.reason === undefined ? {} : { reason: result.reason }),
            }
          : { outcome: "failed", at: result.at, error: "replay paused for a human hand-back" };

    // The replay could not find (or tell apart) a recorded element: it did not reproduce the
    // recorded path, so nothing it saw — or did not see — is evidence. Always inconclusive.
    if (replay.outcome === "failed" && replay.reason !== undefined) {
      return {
        ran: false,
        fired: false,
        observed,
        replay,
        detail: `replay stopped at step ${replay.at}: ${replay.reason} — the recorded path was not reproduced, so this proves nothing`,
        targetMismatch: true,
      };
    }
    const fired = observed.includes(params.fingerprint);
    if (fired) {
      return { ran: true, fired: true, observed, replay, detail: "the defect's fingerprint fired again on replay", targetMismatch: false };
    }
    if (replay.outcome === "failed") {
      return {
        ran: false,
        fired: false,
        observed,
        replay,
        detail: `replay could not reach the defect's step (failed at step ${replay.at}); absence of the signal proves nothing`,
        targetMismatch: false,
      };
    }
    return {
      ran: true,
      fired: false,
      observed,
      replay,
      detail: "replay reached the defect's step and the fingerprint did not fire",
      targetMismatch: false,
    };
  } catch (e) {
    return {
      ran: false,
      fired: false,
      observed: [],
      replay: { outcome: "failed", at: -1, error: firstLine(e) },
      detail: `replay failed: ${firstLine(e)}`,
      targetMismatch: false,
    };
  } finally {
    await session.close().catch(() => undefined);
  }
}
