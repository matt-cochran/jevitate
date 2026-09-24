import { readFileSync } from "node:fs";
import type { TranscriptEntry } from "@jevitate/explore";
import { closeSharedBrowserPool } from "@jevitate/playwright";
import { writeMissionResult } from "./mission-journal.js";
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
 */

export interface KillableMission {
  /**
   * The mission's identity path — the same path handed to `MissionJournal` (a Recording path, or a
   * report path for the usability strategy; the journal treats both identically).
   * `transcriptPathFor`/`resultPathFor` are derived from it.
   */
  readonly recordingPath: string;
}

const SIGNAL_EXIT_CODE = { SIGINT: 130, SIGTERM: 143 } as const;
type KillSignal = keyof typeof SIGNAL_EXIT_CODE;

/** The seams a test fakes: nothing here touches the real process/filesystem/browser pool. */
export interface KillSwitchDeps {
  readonly exit: (code: number) => void;
  readonly closeBrowsers: () => Promise<void>;
  readonly writeResult: (recordingPath: string, missionOutcome: string, exitCode: number, result: unknown) => string;
  readonly readTranscript: (transcriptPath: string) => { steps: number; transcript: readonly TranscriptEntry[] };
  readonly onSignal: (signal: KillSignal, handler: () => void) => void;
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
};

let installed = false;
let active: KillableMission | undefined;
let terminating = false;

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
  const mission = active;
  if (mission !== undefined) {
    const transcriptPath = transcriptPathFor(mission.recordingPath);
    const { steps, transcript } = deps.readTranscript(transcriptPath);
    const partial = {
      outcome: "inconclusive",
      reason: `interrupted by ${signal} after ${steps} step${steps === 1 ? "" : "s"}`,
      stop: "terminated",
      signal,
      recordingPath: mission.recordingPath,
      transcriptPath,
      transcript,
    };
    try {
      deps.writeResult(mission.recordingPath, "inconclusive", code, partial);
    } catch {
      // Best-effort: a failed flush must never keep the process from honoring the signal.
    }
  }
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
  active = mission;
  return () => {
    if (active === mission) active = undefined;
  };
}

/** Test seam: resets all module state (a real run never needs this — one process, one exit). */
export function __resetKillSwitchForTests(): void {
  installed = false;
  active = undefined;
  terminating = false;
}
