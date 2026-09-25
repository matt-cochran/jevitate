import type { Recording } from "@jevitate/recording";
import { RecordingInterpreter } from "@jevitate/interpreter";
import { perceive, type PerceiveOptions } from "./perceive.js";
import { monitorFor } from "./page-monitor.js";
import { observeAfterStep } from "./record.js";
import { hangFingerprint, type HangKind, type HangSignal } from "./hang.js";
import { messageClass } from "./adversarial/defect-fingerprint.js";
import type { VerifySession } from "./verify-fix.js";
import type { TranscriptEntry } from "./transcript.js";
import type { MissionOutcome } from "@jevitate/domain";
import { hostProbe, type HostProbe } from "./host-pressure.js";
import { SafetyPolicy, controlRisk, type SafetyConfig } from "./safety.js";

/**
 * Reproducing a hang (owner ruling 7): when a hang is detected, the steps that led to it are
 * replayed in a FRESH browser context N times (default 2), through the existing Recording
 * interpreter, and the page is examined with the same hang rule. `reproduced k/N`, where only an
 * attempt that actually RAN counts as evidence either way:
 *
 *  - k ≥ 1 ⇒ `reproduced` — a confirmed hang finding;
 *  - k = 0 and at least one attempt ran fully ⇒ `intermittent` — seen once, not again;
 *  - no attempt ran (the fresh session could not open, the replay itself failed before reaching the
 *    step) ⇒ `inconclusive` — a replay that never ran is NOT a non-reproduction.
 *
 * Every attempt's evidence is kept; the finding is never dropped and never reported clean.
 *
 * `ui-no-progress` has two sub-kinds, told apart by `busyIndicatorOf` — `HangSignal.element`, or
 * for a signal persisted before `element` existed, the indicator its detail names (#108/#164):
 *
 *  - a BUSY-INDICATOR hang (an indicator is named — a spinner/progressbar that never cleared): "the same
 *    hang" means THAT indicator (by its normalized identity) is visible again after the replay. A
 *    settled page with a stable signature is not evidence either way — it is what a genuinely
 *    fixed page looks like, so it can never alone read as reproduced;
 *  - a STALLED-STATE hang (`element` undefined — an action whose result undid itself, #79/#80): "the
 *    same hang" means the replay lands on the SAME page signature and stays there for the stall
 *    window.
 */

export const DEFAULT_HANG_REPLAYS = 2;

/**
 * A recorded step a hang replay WITHHOLDS (#153): replaying it would re-send a paid or destructive
 * write (a paid simulation, a charge, an email) on every fresh-context attempt. Decided by
 * independent code — the #116 safety categories (paid / destructive) and the operator's `--deny`
 * patterns over the recorded control — never by a model. A click on such a control is treated as
 * the write it names: a replay cannot prove it would not fire one.
 */
export interface WithheldWrite {
  /** 1-based position of the step in the Recording (flat, across pages). */
  readonly step: number;
  /** The recorded control's name. */
  readonly control: string;
  readonly risk: "paid" | "destructive" | "denied";
}

/** The inconclusive reason for a replay that was withheld. */
export function withheldReason(w: WithheldWrite): string {
  return `inconclusive: replay would repeat a paid/destructive write (step ${w.step}: "${w.control}", ${w.risk}); pass --hang-replay-writes to allow it`;
}

/**
 * The first step, up to and INCLUDING `upTo` (flat index), whose replay would re-send a paid or
 * destructive write — or null. Always null when the operator opted in (`safety.hangReplayWrites`).
 * `allowDestructive` / a goal that asked for the action lift the ORIGINAL run's refusal, never the
 * replay's: the run already sent that write once.
 */
export function replayWouldRepeatWrite(recording: Recording, upTo: number, safety: SafetyConfig | undefined): WithheldWrite | null {
  if (safety?.hangReplayWrites === true) return null;
  const deny = new SafetyPolicy({ ...(safety?.deny === undefined ? {} : { deny: safety.deny }), allowDestructive: true });
  let i = 0;
  for (const page of recording.pages) {
    for (const recorded of page.steps) {
      if (i > upTo) return null;
      const step = recorded.step;
      if (step.kind === "click") {
        const t = step.target;
        const name = (t.name ?? t.text ?? t.label ?? step.label ?? "").replace(/\s+/g, " ").trim();
        if (name !== "") {
          const r = controlRisk(name);
          if (r !== null && (r.risk === "paid" || r.risk === "destructive")) return { step: i + 1, control: name, risk: r.risk };
          if (deny.refuses({ name, role: t.role ?? "", descriptor: t }) !== null) return { step: i + 1, control: name, risk: "denied" };
        }
      }
      i += 1;
    }
  }
  return null;
}
/** How long a replayed page must stay stuck to count as the same no-progress hang (ms). */
export const DEFAULT_STALL_MS = 8_000;

export interface HangAttempt {
  readonly reproduced: boolean;
  /** The hang kind the replay showed (null: none). */
  readonly kind: HangKind | null;
  /** How the replay itself went. */
  readonly replay: "completed" | "failed" | "hung";
  /**
   * Did the attempt actually RUN — replay the recorded steps up to the hang and examine the page?
   * False when the session could not open or the replay failed before the step: no evidence.
   */
  readonly ran: boolean;
  readonly detail: string;
  /** Set when the attempt was not run: its replay would repeat a paid/destructive write (#153). */
  readonly withheld?: WithheldWrite;
  /** Which rule decided an attempt that ran (#164). */
  readonly rule?: HangRule;
  /** Busy-indicator rule only: how many busy indicators were visible on the replayed page (#164). */
  readonly busyIndicators?: number;
}

export type HangRule = "busy-indicator" | "stalled-state" | "same-kind";

/**
 * The busy indicator a `ui-no-progress` hang was attributed to, or null for a stalled-state hang
 * (#164): `HangSignal.element`, else — for a hang persisted before `element` existed — the
 * indicator named in its detail ("a busy indicator (X) never went away …"). Pure.
 */
export function busyIndicatorOf(hang: Pick<HangSignal, "kind" | "detail" | "element">): string | null {
  if (hang.kind !== "ui-no-progress") return null;
  if (hang.element !== undefined && hang.element !== "") return hang.element;
  const m = /^a busy indicator \((.+)\) never went away within \d+ms$/.exec(hang.detail.trim());
  return m?.[1] ?? null;
}

/** The pre-#87 description form `<css selector> <tag>` (e.g. `[role="progressbar"]:not([aria-valuenow]) <div>`). */
function legacySelectorForm(indicator: string): { selector: string; tag: string } | null {
  const m = /^(\[.+\]\S*) <([a-z][a-z0-9-]*)>$/.exec(indicator);
  return m === null || m[1] === undefined || m[2] === undefined ? null : { selector: m[1], tag: m[2] };
}

/** Visible elements matching a recorded (legacy) indicator selector and tag; -1 when it cannot be evaluated. */
async function countVisible(page: VerifySession["page"], selector: string, tag: string): Promise<number> {
  return page
    .evaluate(
      ([sel, t]) => {
        try {
          return Array.from(document.querySelectorAll(sel)).filter((el) => {
            if (el.tagName.toLowerCase() !== t) return false;
            const r = (el as HTMLElement).getBoundingClientRect();
            const s = window.getComputedStyle(el as HTMLElement);
            return r.width > 0 && r.height > 0 && s.visibility !== "hidden" && s.display !== "none" && s.opacity !== "0";
          }).length;
        } catch {
          return -1;
        }
      },
      [selector, tag] as const,
    )
    .catch(() => -1);
}

/** How many busy indicators (the `visibleBusyIndicator` selectors) are visible now; -1 when unreadable. */
async function countVisibleBusy(page: VerifySession["page"]): Promise<number> {
  return page
    .evaluate(() => {
      const seen = new Set<Element>();
      for (const sel of ['[aria-busy="true"]', '[role="progressbar"]:not([aria-valuenow])', '[class*="spinner" i]', '[class*="animate-spin" i]']) {
        for (const el of Array.from(document.querySelectorAll(sel))) {
          const r = (el as HTMLElement).getBoundingClientRect();
          const s = window.getComputedStyle(el as HTMLElement);
          if (r.width > 0 && r.height > 0 && s.visibility !== "hidden" && s.display !== "none" && s.opacity !== "0") seen.add(el);
        }
      }
      return seen.size;
    })
    .catch(() => -1);
}

export type ReproductionStatus = "reproduced" | "intermittent" | "inconclusive";

export interface HangReproduction {
  readonly attempts: number;
  /** Attempts that actually ran (the rest could not execute and prove nothing). */
  readonly ran: number;
  readonly reproduced: number;
  readonly status: ReproductionStatus;
  readonly runs: HangAttempt[];
  /** Set when no replay ran because it would have repeated a paid/destructive write (#153). */
  readonly withheld?: WithheldWrite;
}

/** The status rule (pure): any reproduction confirms; a run that ran clean is intermittent; else inconclusive. */
export function reproductionStatus(runs: readonly Pick<HangAttempt, "reproduced" | "ran">[]): ReproductionStatus {
  if (runs.some((r) => r.reproduced)) return "reproduced";
  if (runs.some((r) => r.ran)) return "intermittent";
  return "inconclusive";
}

/** A reproduction's status as a mission outcome. */
export function hangOutcome(status: ReproductionStatus): MissionOutcome {
  return status === "reproduced" ? "hang" : status;
}

/** No replay could be attempted at all (no way to open a fresh session): nothing ran. */
export const NOT_REPLAYED: HangReproduction = { attempts: 0, ran: 0, reproduced: 0, status: "inconclusive", runs: [] };

export interface ReproduceHangParams {
  readonly recording: Recording;
  /** Flat index of the last Recording step to replay (the step that led to the hang). */
  readonly recordingStepIndex: number;
  readonly hang: HangSignal;
  /** Opens a FRESH browser session for each attempt. */
  readonly openSession: () => Promise<VerifySession>;
  readonly attempts?: number;
  /** The perception bounds used to re-detect the hang (the same rule the mission used). */
  readonly perceive?: PerceiveOptions;
  /** For a stalled-state `ui-no-progress`: how long the state must stay stuck. */
  readonly stallMs?: number;
  /** Bound on the replay itself (a hung page can block a step). Default 60s. */
  readonly replayBoundMs?: number;
  /** Sleep seam for the stall window (default: a real timer). */
  readonly sleep?: (ms: number) => Promise<void>;
  /**
   * The target's safety policy (#116/#153): replays never re-send a paid/destructive write unless
   * `hangReplayWrites` opts in.
   */
  readonly safety?: SafetyConfig;
}

function firstLine(e: unknown): string {
  return e instanceof Error ? e.message.split("\n")[0] ?? e.message : String(e);
}

const realSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** One attempt: fresh session → replay → re-detect. Never throws. */
export async function replayAndDetectHang(p: ReproduceHangParams): Promise<HangAttempt> {
  const withheld = replayWouldRepeatWrite(p.recording, p.recordingStepIndex, p.safety);
  if (withheld !== null) {
    // Never replayed, so no evidence either way: not reproduced, not "fixed" — inconclusive.
    return { reproduced: false, kind: null, replay: "failed", ran: false, detail: withheldReason(withheld), withheld };
  }
  let session: VerifySession;
  try {
    session = await p.openSession();
  } catch (e) {
    return { reproduced: false, kind: null, replay: "failed", ran: false, detail: `could not open a fresh session: ${firstLine(e)}` };
  }
  try {
    await monitorFor(session.page).instrument();
    const bound = p.replayBoundMs ?? 60_000;
    let timer: ReturnType<typeof setTimeout> | undefined;
    // Replay up to the step that led to the hang, then OBSERVE (that step's own postcondition is not
    // the verdict — the hang rule applied afterwards is).
    const replayP = new RecordingInterpreter().runToCheckpoint(
      session.actor,
      observeAfterStep(p.recording, p.recordingStepIndex),
      p.recordingStepIndex,
    );
    replayP.catch(() => undefined);
    const outcome = await Promise.race([
      replayP.then((r) => ({ kind: "done" as const, r })),
      new Promise<{ kind: "hung" }>((resolve) => {
        timer = setTimeout(() => resolve({ kind: "hung" }), bound);
      }),
    ]).finally(() => {
      if (timer !== undefined) clearTimeout(timer);
    });
    if (outcome.kind === "done" && outcome.r.outcome !== "completed") {
      const why =
        outcome.r.outcome === "failed"
          ? `failed at step ${outcome.r.at}${outcome.r.reason === undefined ? "" : ` (${outcome.r.reason})`}: ${outcome.r.error.split("\n")[0]}`
          : "paused for a hand-back";
      return { reproduced: false, kind: null, replay: "failed", ran: false, detail: `replay ${why}` };
    }
    const replay: HangAttempt["replay"] = outcome.kind === "hung" ? "hung" : "completed";

    const seen = await perceive(session.page, p.perceive ?? {});
    const kind = seen.hang?.kind ?? null;
    const indicator = busyIndicatorOf(p.hang);
    if (indicator !== null) {
      // A busy-indicator hang (#108/#164): reproduction requires THAT indicator to be visible and
      // stuck again. A stable, settled page signature alone proves nothing — it is exactly what a
      // fixed page looks like, so the stalled-state rule below must never decide this sub-kind
      // (including a hang recorded before `element` existed, identified from its detail).
      const legacy = legacySelectorForm(indicator);
      const matching = legacy === null ? null : await countVisible(session.page, legacy.selector, legacy.tag);
      const backAgain =
        kind === "ui-no-progress" &&
        seen.hang?.element !== undefined &&
        (messageClass(seen.hang.element) === messageClass(indicator) || (matching !== null && matching > 0));
      const busyIndicators = await countVisibleBusy(session.page);
      return {
        reproduced: backAgain,
        kind: backAgain ? "ui-no-progress" : kind,
        replay,
        ran: true,
        rule: "busy-indicator",
        busyIndicators,
        detail: backAgain
          ? `busy-indicator rule: the indicator (${seen.hang?.element ?? indicator}) is back — ${seen.hang?.detail ?? p.hang.detail}`
          : kind === null
            ? `busy-indicator rule: the indicator (${indicator}) is gone and the page settled (${busyIndicators} busy indicator(s) visible) — fixed`
            : kind === "ui-no-progress"
              ? `busy-indicator rule: a different busy indicator (${seen.hang?.element ?? "unknown"}), not the one that hung`
              : `busy-indicator rule: no busy indicator, a different hang (${kind}) instead`,
      };
    }
    if (p.hang.kind === "ui-no-progress" && kind !== "ui-no-progress") {
      // A stalled state (no busy indicator, #79/#80): the replay must land on the SAME state and
      // stay there.
      const stalled = p.hang.lastState.signature;
      if (seen.snapshot.signature !== stalled) {
        return { reproduced: false, kind, replay, ran: true, rule: "stalled-state", detail: "stalled-state rule: replay reached a different page state (progress was made)" };
      }
      await (p.sleep ?? realSleep)(p.stallMs ?? DEFAULT_STALL_MS);
      const again = await perceive(session.page, p.perceive ?? {});
      const stuck = again.snapshot.signature === stalled;
      return {
        reproduced: stuck,
        kind: stuck ? "ui-no-progress" : null,
        replay,
        ran: true,
        rule: "stalled-state",
        detail: stuck
          ? "stalled-state rule: the replay landed on the same stalled state and stayed there"
          : "stalled-state rule: the page moved on after the stall window",
      };
    }
    const reproduced = kind === p.hang.kind;
    return {
      reproduced,
      kind,
      replay,
      ran: true,
      rule: "same-kind",
      detail: reproduced ? (seen.hang?.detail ?? p.hang.detail) : kind === null ? "same-kind rule: the page settled — no hang" : `same-kind rule: a different hang (${kind})`,
    };
  } catch (e) {
    return { reproduced: false, kind: null, replay: "failed", ran: false, detail: `replay failed: ${firstLine(e)}` };
  } finally {
    await session.close().catch(() => undefined);
  }
}

export async function reproduceHang(p: ReproduceHangParams): Promise<HangReproduction> {
  const attempts = p.attempts ?? DEFAULT_HANG_REPLAYS;
  if (!Number.isInteger(attempts) || attempts < 0) throw new Error(`reproduceHang: attempts must be a non-negative integer, got ${attempts}`);
  // #154: 0 replays is the operator's "don't replay" (a replay could repeat a paid write): the hang
  // stays UNCONFIRMED — inconclusive, never a crash and never a non-reproduction.
  if (attempts === 0) return NOT_REPLAYED;
  // #153: a replay that would re-send a paid/destructive write is not run at all (by default).
  const withheld = replayWouldRepeatWrite(p.recording, p.recordingStepIndex, p.safety);
  if (withheld !== null) return { attempts, ran: 0, reproduced: 0, status: "inconclusive", runs: [], withheld };
  const runs: HangAttempt[] = [];
  for (let i = 0; i < attempts; i++) runs.push(await replayAndDetectHang(p));
  return {
    attempts,
    ran: runs.filter((r) => r.ran).length,
    reproduced: runs.filter((r) => r.reproduced).length,
    status: reproductionStatus(runs),
    runs,
  };
}

/** A hang the mission found, with how to reproduce it and how often it did. */
export interface HangFinding {
  readonly fingerprint: string;
  /** Always `hang` (so a finding list can hold defects and hangs); the hang's own kind is `hangKind`. */
  readonly kind: "hang";
  readonly hangKind: HangKind;
  readonly title: string;
  /** The route it was FIRST seen on. */
  readonly route: string;
  readonly url: string;
  readonly signal: HangSignal;
  readonly firstSeenStep: number;
  /** How many times this same hang (by fingerprint) was hit in the run, and at which steps. */
  readonly occurrences: number;
  readonly occurrenceSteps: number[];
  /**
   * Every DISTINCT route this same hang (by fingerprint) was seen on, first-seen order (#87): a
   * global element (e.g. a shared layout widget) hanging on many routes is ONE finding that lists
   * every route it was met on, never one finding per route.
   */
  readonly routes: string[];
  /**
   * `recording` is set when the hang was found after the mission RESET (a fresh page): the steps to
   * replay are then this segment's own Recording, not the run's first one.
   */
  readonly repro: { readonly steps: TranscriptEntry[]; readonly recordingStepIndex: number; readonly recording?: Recording };
  readonly reproduction: HangReproduction;
}

/** Assembles a hang finding (its identity, title and repro) from what the mission saw. */
export function hangFinding(
  signal: HangSignal,
  steps: readonly TranscriptEntry[],
  recordingStepIndex: number,
  reproduction: HangReproduction,
): HangFinding {
  return {
    fingerprint: hangFingerprint(signal),
    kind: "hang",
    hangKind: signal.kind,
    title: `Hang (${signal.kind}) on ${signal.route}: ${signal.detail}`,
    route: signal.route,
    url: signal.url,
    signal,
    firstSeenStep: steps.length,
    occurrences: 1,
    occurrenceSteps: [steps.length],
    routes: [signal.route],
    // The repro is the ordered steps; their timing stays in the run transcript.
    repro: {
      steps: steps.map((e): TranscriptEntry => {
        const { timing: _timing, ...step } = e;
        return step;
      }),
      recordingStepIndex,
    },
    reproduction,
  };
}

/**
 * Records a hang met by a COVERAGE mission (induction / feature) into its deduped set: a new
 * fingerprint is reproduced by replaying `recording` (the path that led to it) in fresh contexts; a
 * known one is one more occurrence. The caller then resets and keeps exploring the frontier.
 */
export async function recordCoverageHang(p: {
  readonly hang: HangSignal;
  readonly recording: Recording;
  readonly steps: readonly TranscriptEntry[];
  readonly found: Map<string, HangFinding>;
  readonly openSession?: () => Promise<VerifySession>;
  readonly attempts?: number;
  readonly perceive?: PerceiveOptions;
  /** The target's safety policy: replays never re-send a paid/destructive write by default (#153). */
  readonly safety?: SafetyConfig;
  /** Samples the host's resource pressure for the evidence. Default: this platform's signals. */
  readonly hostProbe?: HostProbe;
}): Promise<void> {
  const fingerprint = hangFingerprint(p.hang);
  const known = p.found.get(fingerprint);
  const step = p.steps.length;
  if (known !== undefined) {
    // Already confirmed (or being confirmed): no replay budget spent again — just one more
    // occurrence, and the route added when it is a new one ("also seen on <route>", #87).
    p.found.set(fingerprint, {
      ...known,
      occurrences: known.occurrences + 1,
      occurrenceSteps: [...known.occurrenceSteps, step],
      routes: known.routes.includes(p.hang.route) ? known.routes : [...known.routes, p.hang.route],
    });
    return;
  }
  const index = Math.max(0, p.recording.pages.reduce((n, page) => n + page.steps.length, 0) - 1);
  const hang: HangSignal = { ...p.hang, host: await (p.hostProbe ?? hostProbe())() };
  const reproduction: HangReproduction =
    p.openSession === undefined
      ? NOT_REPLAYED
      : await reproduceHang({
          recording: p.recording,
          recordingStepIndex: index,
          hang,
          openSession: p.openSession,
          ...(p.attempts === undefined ? {} : { attempts: p.attempts }),
          ...(p.perceive === undefined ? {} : { perceive: p.perceive }),
          ...(p.safety === undefined ? {} : { safety: p.safety }),
        });
  const finding = hangFinding(hang, p.steps, index, reproduction);
  p.found.set(fingerprint, { ...finding, repro: { ...finding.repro, recording: p.recording } });
}
