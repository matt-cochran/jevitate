import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Recording } from "@jevitate/recording";
import type { TranscriptEntry } from "@jevitate/explore";
import { usageSidecar, type UsageLedger } from "@jevitate/ai-core";
import { transcriptPathFor } from "./transcript-file.js";

/**
 * Crash-safe persistence for a running mission: the transcript and the (partial) Recording are
 * written to disk AS THE RUN PROGRESSES — after every transcript step and every recorded step —
 * not only at the end. A run that dies mid-way (browser crash, OOM, a killed process) therefore
 * still leaves every step up to the failure next to where its final artifacts would have been.
 *
 * Writes are synchronous on purpose: the flush must have landed before the next browser action
 * can crash the process. Entries and Recordings arrive already redacted (TranscriptLog /
 * RunRecorder apply the redaction seam before emitting), so nothing here adds page data.
 */
export class MissionJournal {
  readonly transcriptPath: string;
  /** The entries last flushed — the live step list a killed run reports (#120). */
  #entries: readonly TranscriptEntry[] = [];

  /**
   * `recordingPath` is the run's Recording file; the transcript goes to `<recording>.transcript.json`
   * unless `transcriptPath` names another file (a usability run keys both off its report).
   */
  constructor(
    readonly recordingPath: string,
    transcriptPath: string = transcriptPathFor(recordingPath),
  ) {
    this.transcriptPath = transcriptPath;
    mkdirSync(dirname(recordingPath), { recursive: true });
  }

  /** TranscriptLog listener: rewrites the whole (small) transcript file after each step. */
  readonly onTranscriptEntry = (_entry: TranscriptEntry, all: readonly TranscriptEntry[]): void => {
    this.#entries = [...all];
    writeFileSync(this.transcriptPath, `${JSON.stringify(all, null, 2)}\n`, "utf8");
  };

  /** Every transcript entry flushed so far (a copy). */
  get transcript(): readonly TranscriptEntry[] {
    return this.#entries;
  }

  /** RunRecorder listener: rewrites the partial Recording after each recorded step. */
  readonly onRecording = (recording: Recording): void => {
    this.writeRecording(recording);
  };

  /** Final write of the Recording (also used when the run ended before any step was recorded). */
  writeRecording(recording: Recording): void {
    writeFileSync(this.recordingPath, `${JSON.stringify(recording, null, 2)}\n`, "utf8");
  }

  /** Final write of the transcript (idempotent with the incremental writes). */
  writeTranscript(entries: readonly TranscriptEntry[]): void {
    this.#entries = [...entries];
    writeFileSync(this.transcriptPath, `${JSON.stringify(entries, null, 2)}\n`, "utf8");
  }
}

/** `<dir>/<stem>.json` → `<dir>/<stem>.result.json`: the typed mission result next to its Recording. */
export function resultPathFor(recordingPath: string): string {
  return recordingPath.endsWith(".json")
    ? `${recordingPath.slice(0, -".json".length)}.result.json`
    : `${recordingPath}.result.json`;
}

/**
 * Persists a mission's typed result (`{ missionOutcome, exitCode, result }`) so it can be read back
 * later — by `verify-fix` and by the MCP `get_mission_result` tool — without re-running anything.
 */
export function writeMissionResult(
  recordingPath: string,
  missionOutcome: string,
  exitCode: number,
  result: unknown,
  usage?: UsageLedger,
): string {
  const path = resultPathFor(recordingPath);
  writeFileSync(path, `${JSON.stringify({ missionOutcome, exitCode, result }, null, 2)}\n`, "utf8");
  if (usage !== undefined) writeUsageSidecar(path, usage);
  return path;
}

/**
 * `<dir>/<stem>.result.json` (or any `<stem>.json`) → `<dir>/<stem>.usage.json`: the run's per-call
 * usage breakdown (#163), next to its result.
 */
export function usagePathFor(resultPath: string): string {
  const stem = resultPath.endsWith(".result.json")
    ? resultPath.slice(0, -".result.json".length)
    : resultPath.endsWith(".json")
      ? resultPath.slice(0, -".json".length)
      : resultPath;
  return `${stem}.usage.json`;
}

/**
 * Writes the per-call usage sidecar (#163): kind, task, model, tokens, cost and its source for every
 * model call the run made — never prompt contents, answers or credentials (a `UsageCall` has no
 * field that could hold one). Best-effort: accounting never replaces a run's result with an error.
 */
export function writeUsageSidecar(resultPath: string, usage: UsageLedger): string | undefined {
  const path = usagePathFor(resultPath);
  try {
    writeFileSync(path, `${JSON.stringify(usageSidecar(usage), null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    return path;
  } catch {
    return undefined;
  }
}

/** `<prefix>-<iso with : and . replaced>` — the artifact stamp every mission file uses. */
export function artifactStamp(iso: string): string {
  return iso.replace(/[:.]/g, "-");
}

/**
 * Closes a browser session without letting a close failure (a crashed browser often fails to
 * close cleanly) replace the mission's typed result with an exception.
 */
export async function closeQuietly(session: { close(): Promise<void> }): Promise<void> {
  try {
    await session.close();
  } catch {
    // The run's outcome already carries the crash evidence; a failed teardown adds nothing.
  }
}
