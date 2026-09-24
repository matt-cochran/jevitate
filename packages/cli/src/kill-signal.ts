import { AsyncLocalStorage } from "node:async_hooks";
import { readFileSync, writeSync } from "node:fs";
import type { UsageCounts } from "@jevitate/ai-core";
import type { TranscriptEntry } from "@jevitate/explore";
import { closeSharedBrowserPool } from "@jevitate/playwright";
import { currentEngineInfo, type EngineInfo } from "./engine.js";
import { ok } from "./envelope.js";
import { resultPathFor, writeMissionResult } from "./mission-journal.js";
import { transcriptPathFor } from "./transcript-file.js";

/**
 * Crash-safe termination (#94). `jevitate explore`/`explore --strategy usability` runs are commonly
 * wrapped in an external timeout (`timeout -s TERM 900 jevitate explore ...`, the dogfooding
 * harness's own convention) or killed by an operator. Before this module, SIGTERM/SIGINT killed the
 * process outright — sometimes leaving NOTHING on disk to audit (no `.result.json`, even though the
 * `MissionJournal` had already flushed every step's transcript/Recording as the run progressed).
 *
 * A single process-level handler is installed lazily, once, the first time any mission arms it
 * (`armMissionKillSwitch`). On SIGTERM/SIGINT it writes a partial typed result — `outcome:
 * "inconclusive"`, `reason: "interrupted by SIG… after N steps"` — built from whatever the journal
 * already flushed, starts closing the shared browser pool, then exits with the conventional code
 * (130 SIGINT / 143 SIGTERM) — all SYNCHRONOUSLY, in the same turn the signal arrives, without
 * awaiting the browser close. Playwright installs its OWN SIGTERM/SIGINT handler on the browsers it
 * launched; the instant that fires, any in-flight page operation starts rejecting, and the killed
 * mission's own error handling can turn that into a normal (non-killed) result and call
 * `process.exit` on its own terms — an `await` here, even a fast one, is enough of a window for
 * that race to be won by the mission instead of by this handler. Writing synchronously
 * (`writeFileSync`, already the case) and exiting before yielding the event loop makes this
 * deterministic. Idempotent: a second signal (the wrapper/operator escalating) force-exits
 * immediately.
 *
 * Several missions can be armed at once — one process may run many browser contexts on the shared
 * pool (a daemon, a long-lived MCP server, a watch-mode queue drain). A signal flushes a partial
 * result for EVERY armed mission, each with its own steps/usage, and tells each one's own scoped
 * listener (`runWithMissionKillListener`) — never another mission's. Only then does the process exit,
 * once. A mission's own outcome never exits the process: that is `process.exitCode`, set by the CLI
 * command after the mission returns.
 */

export interface KillableMission {
  /**
   * The mission's identity path — the same path handed to `MissionJournal` (a Recording path, or a
   * report path for the usability strategy; the journal treats both identically).
   * `transcriptPathFor`/`resultPathFor` are derived from it.
   */
  readonly recordingPath: string;
  /**
   * Where the journal flushes the transcript, when it is NOT `transcriptPathFor(recordingPath)` — a
   * usability run keys its transcript off its report (`usability-<stamp>.transcript.json`), not off
   * its Recording (`usability-<stamp>.recording.json`) (#120).
   */
  readonly transcriptPath?: string;
  /**
   * The live step list (the journal's last flushed entries) — read in preference to the file, so a
   * killed run reports every step it took even when the file lags or lives elsewhere (#120).
   */
  readonly transcript?: () => readonly TranscriptEntry[] | undefined;
  /** The run's usage tracker: the tokens already spent are part of the killed run's result (#120). */
  readonly usage?: { snapshot(): UsageCounts };
  /**
   * Whatever partial report the mission has so far (e.g. a usability run's observed screens and
   * screenshots). Read synchronously on the signal; absent/throwing means no partial report.
   */
  readonly partialReport?: () => Record<string, unknown> | undefined;
}

/**
 * What a killed run prints to stdout before exiting (#120): the `--json` envelope, the bare result
 * (a non-`--json` explore prints its result as JSON), or nothing (a caller that owns stdout, e.g.
 * the MCP server, or a library use). Set by the CLI command that armed the mission.
 */
export type KillSwitchOutput = "envelope" | "raw" | "none";

const SIGNAL_EXIT_CODE = { SIGINT: 130, SIGTERM: 143 } as const;
type KillSignal = keyof typeof SIGNAL_EXIT_CODE;

/** The seams a test fakes: nothing here touches the real process/filesystem/browser pool. */
export interface KillSwitchDeps {
  readonly exit: (code: number) => void;
  readonly closeBrowsers: () => Promise<void>;
  readonly writeResult: (recordingPath: string, missionOutcome: string, exitCode: number, result: unknown) => string;
  readonly readTranscript: (transcriptPath: string) => { steps: number; transcript: readonly TranscriptEntry[] };
  readonly onSignal: (signal: KillSignal, handler: () => void) => void;
  /** This build's identity, stamped on the killed run's result like every other result (#112). */
  readonly engine?: () => EngineInfo;
  /** SYNCHRONOUS stdout write — the process exits in the same turn, so nothing may be buffered. */
  readonly writeStdout?: (text: string) => void;
}

/** Reads whatever the journal has already flushed; a run killed before its first step is 0 steps. */
function readTranscriptFile(transcriptPath: string): { steps: number; transcript: readonly TranscriptEntry[] } {
  try {
    const parsed: unknown = JSON.parse(readFileSync(transcriptPath, "utf8"));
    if (Array.isArray(parsed)) return { steps: parsed.length, transcript: parsed as TranscriptEntry[] };
  } catch {
    // Not on disk yet (killed before the first step flushed) — an honest 0-step report, not a crash.
  }
  return { steps: 0, transcript: [] };
}

const realDeps: KillSwitchDeps = {
  exit: (code) => process.exit(code),
  closeBrowsers: closeSharedBrowserPool,
  writeResult: writeMissionResult,
  readTranscript: readTranscriptFile,
  onSignal: (signal, handler) => {
    process.on(signal, handler);
  },
  engine: currentEngineInfo,
  writeStdout: (text) => {
    writeSync(1, text);
  },
};

type KilledListener = (killed: { resultPath: string; exitCode: number }) => void;

let installed = false;
/** Every armed mission, in arming order, with the kill listener scoped to the context that ran it. */
const armed = new Map<KillableMission, KilledListener | undefined>();
let terminating = false;
let output: KillSwitchOutput = "none";
/** Process-wide listeners: told about every killed mission. */
const killedListeners = new Set<KilledListener>();
/** The listener for missions armed inside `runWithMissionKillListener` (e.g. one queue-drain item). */
const scopedListener = new AsyncLocalStorage<KilledListener>();

/** A getter that throws (or a missing one) yields `undefined` — a flush must never block the exit. */
function safely<T>(read: (() => T) | undefined): T | undefined {
  if (read === undefined) return undefined;
  try {
    return read();
  } catch {
    return undefined;
  }
}

/** The killed run's partial typed result: every field a finished run's result would carry that exists yet. */
function partialResult(mission: KillableMission, signal: KillSignal, code: number, deps: KillSwitchDeps): Record<string, unknown> {
  const transcriptPath = mission.transcriptPath ?? transcriptPathFor(mission.recordingPath);
  // The live step list wins over the file (it is never behind it); the file is the fallback for a
  // mission armed without a live reference.
  const live = safely(mission.transcript);
  const flushed = live === undefined ? deps.readTranscript(transcriptPath) : undefined;
  const transcript = live ?? flushed?.transcript ?? [];
  const steps = live === undefined ? (flushed?.steps ?? 0) : live.length;
  const engine = safely(deps.engine);
  const usage = safely(() => mission.usage?.snapshot());
  const report = safely(mission.partialReport);
  return {
    outcome: "inconclusive",
    missionOutcome: "inconclusive",
    reason: `interrupted by ${signal} after ${steps} step${steps === 1 ? "" : "s"}`,
    stop: "terminated",
    signal,
    steps,
    exitCode: code,
    recordingPath: mission.recordingPath,
    transcriptPath,
    resultPath: resultPathFor(mission.recordingPath),
    transcript,
    ...(engine === undefined ? {} : { engine }),
    ...(usage === undefined ? {} : { usage }),
    ...(report === undefined ? {} : { partialReport: report }),
  };
}

/**
 * Synchronous by design (never `await`s before `deps.exit`): a killed mission's OWN in-flight
 * `runExploration`/`runUsabilityMission`/etc. call is still running concurrently, and Playwright
 * closes ITS launched browser on the same signal independently — the instant that happens, any
 * pending page operation starts rejecting, and the mission's own error handling can turn that into
 * a normal (non-killed) `crashed` result and call `process.exit` on its OWN terms. Racing that with
 * an `await` here (even a fast one) is enough for the mission's own completion to win — so this
 * writes the partial result (already synchronous: `writeFileSync`) and calls `deps.exit` in the
 * SAME synchronous turn, before anything else gets a chance to run. Browser teardown is started but
 * deliberately not awaited; a close that doesn't finish in time is left to the OS / Playwright's own
 * process-group cleanup on the same signal.
 */
function onKillSignal(signal: KillSignal, deps: KillSwitchDeps): void {
  const code = SIGNAL_EXIT_CODE[signal];
  if (terminating) {
    // Escalation (a second signal, or the mission's own completion racing ahead): stop being
    // graceful and exit right now.
    deps.exit(code);
    return;
  }
  terminating = true;
  for (const [mission, scoped] of [...armed]) {
    let partial: Record<string, unknown> | undefined;
    let resultPath: string | undefined;
    try {
      partial = partialResult(mission, signal, code, deps);
      resultPath = deps.writeResult(mission.recordingPath, "inconclusive", code, partial);
    } catch {
      // Best-effort: a failed flush must never keep the process from honoring the signal — nor keep
      // the OTHER armed missions from being flushed.
    }
    // Whoever ran THIS mission (e.g. its queue-drain item, #117) records where its result went —
    // synchronously; process-wide listeners hear about every mission.
    if (resultPath !== undefined) {
      for (const listener of [...(scoped === undefined ? [] : [scoped]), ...killedListeners]) {
        try {
          listener({ resultPath, exitCode: code });
        } catch {
          // Best-effort, like the flush.
        }
      }
    }
    // A `--json` caller gets its envelope even from a killed run (#120) — one line per mission,
    // written synchronously, before the exit below.
    if (partial !== undefined && output !== "none" && deps.writeStdout !== undefined) {
      try {
        deps.writeStdout(`${JSON.stringify(output === "envelope" ? ok(partial) : partial)}\n`);
      } catch {
        // Best-effort, like the flush: stdout may already be gone (a closed pipe).
      }
    }
  }
  armed.clear();
  deps.closeBrowsers().catch(() => {
    // Best-effort: a failed teardown must never keep the process from having honored the signal.
  });
  deps.exit(code);
}

function install(deps: KillSwitchDeps): void {
  if (installed) return;
  installed = true;
  deps.onSignal("SIGTERM", () => onKillSignal("SIGTERM", deps));
  deps.onSignal("SIGINT", () => onKillSignal("SIGINT", deps));
}

/**
 * Installs the process-level SIGTERM/SIGINT handler with no mission armed yet. The CLI entry point
 * (`bin.ts`) calls this ONCE, before `buildProgram`/`parseAsync` — i.e. before ANY browser can have
 * launched. This matters: Playwright installs its OWN SIGTERM/SIGINT handler on the browser it
 * launches (to avoid orphaning the Chromium subprocess), and Node invokes same-signal listeners in
 * REGISTRATION ORDER — so registering ours first guarantees this module's write-then-exit always
 * runs (and completes: writing is synchronous, and `deps.exit` is called with nothing awaited
 * in between) before Playwright's handler can tear down the browser and let an in-flight mission's
 * own error handling race it to `process.exit` with a different result/code. A command that never
 * arms a mission (`jevitate journey list`, etc.) still benefits: Ctrl-C exits with the conventional
 * code instead of Node's default. Idempotent — a redundant call (or `armMissionKillSwitch` calling
 * it again as a safety net) is a no-op.
 */
export function installMissionKillSwitch(deps: KillSwitchDeps = realDeps): void {
  install(deps);
}

/**
 * Arms the kill switch around a running mission: installs the process-level handler (as a safety
 * net — the CLI entry point should already have via `installMissionKillSwitch`) and registers
 * `mission` as the one to report on a kill signal. The caller's `finally` MUST call the returned
 * disarm function, synchronously, before any `await` — the mission itself has (or is about to have)
 * written its own typed result by then, so the process-level handler must stop treating a later,
 * unrelated signal as belonging to this mission.
 */
export function armMissionKillSwitch(mission: KillableMission, deps: KillSwitchDeps = realDeps): () => void {
  install(deps);
  armed.set(mission, scopedListener.getStore());
  return () => {
    armed.delete(mission);
  };
}

/**
 * Runs `fn` so that any mission armed inside it (at any await depth) reports a kill to `listener` —
 * and ONLY that mission does. This is how a runner that owns one mission among several running
 * concurrently in the process (e.g. a queue-drain item) learns where ITS result went, never another's.
 */
export function runWithMissionKillListener<T>(listener: KilledListener, fn: () => Promise<T>): Promise<T> {
  return scopedListener.run(listener, fn);
}

/** How many missions are armed right now (diagnostics and tests). */
export function armedMissionCount(): number {
  return armed.size;
}

/**
 * What a killed run prints to stdout (#120). The CLI command that runs a mission sets it from its
 * own flags (`--json` → the envelope) before arming; the default prints nothing.
 */
export function setKillSwitchOutput(mode: KillSwitchOutput): void {
  output = mode;
}

/**
 * Registers a process-wide SYNCHRONOUS listener told where EVERY killed mission's partial result was
 * written, just before the process exits. A runner that owns one specific mission should use
 * `runWithMissionKillListener` instead, so it never records another mission's result. Returns the
 * unregister function.
 */
export function onMissionKilled(listener: KilledListener): () => void {
  killedListeners.add(listener);
  return () => {
    killedListeners.delete(listener);
  };
}

/** Test seam: resets all module state (a real run never needs this — one process, one exit). */
export function __resetKillSwitchForTests(): void {
  installed = false;
  armed.clear();
  terminating = false;
  output = "none";
  killedListeners.clear();
}
