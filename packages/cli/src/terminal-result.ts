import { mkdirSync, writeSync } from "node:fs";
import { dirname } from "node:path";
import { Command } from "commander";
import { redactCredentialShapes } from "@jevitate/ai-core";
import { clock, MISSION_RESULT_SCHEMA_VERSION, type MissionOutcome, type TimerHandle } from "@jevitate/domain";
import { terminateOwnBrowsersSync } from "@jevitate/playwright";
import { emitCommandResult } from "./cli-shared.js";
import { currentEngineInfo, type EngineInfo } from "./engine.js";
import { fail, type JsonEnvelope } from "./envelope.js";
import { exitCodeForOutcome } from "./exit-codes.js";
import { redactSecretValues } from "./journey-api.js";
import { installMissionKillSwitch, setKillTerminalReporter, type KillSignal } from "./kill-signal.js";
import { resultPathFor, writeMissionResult } from "./mission-journal.js";
import { currentRunMetadata, type RunMetadata } from "./run-metadata.js";

/**
 * The shared terminal result of a long-running command: however the command ends, it ends with a
 * machine-readable result. A command registers once (`registerTerminalResult`), reports progress as
 * it goes, and calls `complete()` when it has emitted its own result. If it ends any other way, this
 * layer writes a redacted diagnostic artifact, prints one envelope and exits:
 *
 *  | trigger        | code                 | exit                                                  |
 *  |----------------|----------------------|-------------------------------------------------------|
 *  | signal         | E_TERMINAL_SIGNAL    | 129/130/143, by the kill switch (kill-signal.ts)      |
 *  | watchdog       | E_TERMINAL_WATCHDOG  | 2 (inconclusive: it proves nothing)                   |
 *  | `fail(err)`    | E_TERMINAL_INTERNAL  | 2 (crashed)                                           |
 *  | uncaught error | E_TERMINAL_INTERNAL  | 2 (crashed; an unhandled rejection arrives this way)  |
 *  | process exit   | E_TERMINAL_UNSETTLED | 2 (a `process.exit` or a drained event loop, no result) |
 *
 * Exactly once: the first trigger wins and every later one is a no-op.
 *
 * SYNCHRONOUS BY CONTRACT. Everything from a trigger to the exit runs in one turn and never yields
 * the event loop, for the reason `onKillSignal` documents: Playwright's own signal handler closes
 * the browsers, in-flight page operations start rejecting, and the command's own error handling can
 * otherwise win the race to `process.exit` with another result. So artifact and output writes are
 * `writeFileSync`/`writeSync` only. `process.stdout.write` is not safe here: on a pipe it can queue,
 * and an exit in the same turn loses what is queued. The envelope therefore goes through
 * `emitCommandResult` on a program whose writers are synchronous. `progress` and `addSecrets` are
 * synchronous for the same reason: the trigger only reads what was already reported.
 *
 * Limit: the watchdog and the signal handler both run on the event loop, so a synchronous spin
 * delays them until it returns.
 */

/** Where the command was when it ended: what a diagnostic names. All text is redacted before use. */
export interface TerminalProgress {
  readonly phase?: string;
  readonly replay?: number | string;
  readonly mutation?: string;
  readonly step?: number | string;
  readonly detail?: Readonly<Record<string, unknown>>;
}

export interface TerminalResultRegistration {
  /** The command, named in the diagnostic and in a usage hint (e.g. `journey verify`, `verify-fix`). */
  readonly command: string;
  /** `--json` was passed: the envelope on stdout; otherwise the `error <CODE>: …` line on stderr. */
  readonly json: boolean;
  /** Values masked from all text, in each of their URL forms. Add later ones with `addSecrets`. */
  readonly secrets: readonly string[];
  /**
   * The command's identity path. The result goes to `resultPathFor(artifactPath)` (`<stem>.result.json`),
   * through `writeMissionResult`, and never to `artifactPath` itself, so a kill cannot replace an
   * earlier proof stored there. Absent: the envelope is the only result.
   */
  readonly artifactPath?: string;
  /** The command's whole-run limit, in milliseconds: a positive integer a timer can represent. */
  readonly watchdogMs: number;
  /** The progress known at registration. */
  readonly progress?: TerminalProgress;
}

export interface TerminalResultHandle {
  /** Merges what the command knows now into the progress a diagnostic reports. Synchronous; never throws. */
  progress(update: TerminalProgress): void;
  /** Adds secrets learned during the run (a resolved auth token). Synchronous; never throws. */
  addSecrets(values: readonly string[]): void;
  /** An internal error: reports it, then exits. A no-op once the command has settled. */
  fail(err: unknown): void;
  /**
   * The command has emitted its own result: nothing more is reported. Call it in the same synchronous
   * turn as that emit, with no `await` between them. A command that never calls it reports
   * E_TERMINAL_UNSETTLED at exit.
   */
  complete(): void;
}

/** The seams a test fakes. Every one of them must be synchronous (see this module's doc). */
export interface TerminalResultDeps {
  readonly exit: (code: number) => void;
  /** Ends only the browsers this process launched (`terminateOwnBrowsersSync`), and nothing else. */
  readonly terminateBrowsers: () => void;
  readonly writeStdout: (text: string) => void;
  readonly writeStderr: (text: string) => void;
  readonly writeResult: (artifactPath: string, missionOutcome: MissionOutcome, exitCode: number, result: unknown, meta: RunMetadata | undefined) => string;
  readonly engine: () => EngineInfo;
  /** Listens for an uncaught error (and so an unhandled rejection). Returns the remover. */
  readonly onFatalError: (listener: (err: unknown) => void) => () => void;
  /** Listens for the process ending on any path. Returns the remover. */
  readonly onProcessExit: (listener: () => void) => () => void;
  readonly installKillSwitch: () => void;
}

/** Steps of `RETRY_SLEEP_MS`: a reader that drains nothing for this long no longer holds up the exit. */
const WRITE_RETRIES = 200;
const RETRY_SLEEP_MS = 5;
const MAX_TIMER_MS = 2_147_483_647;
const MAX_CAUSE_DEPTH = 5;

/** Writes all of `text` to `fd`, blocking. `writeSync` can write part of it, or throw EAGAIN on a full non-blocking pipe. */
function writeAllSync(fd: number, text: string): void {
  const bytes = Buffer.from(text, "utf8");
  let offset = 0;
  let retries = 0;
  while (offset < bytes.length) {
    try {
      offset += writeSync(fd, bytes, offset);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EAGAIN" || retries >= WRITE_RETRIES) throw err;
      retries += 1;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, RETRY_SLEEP_MS);
    }
  }
}

const realDeps: TerminalResultDeps = {
  exit: (code) => process.exit(code),
  terminateBrowsers: () => {
    terminateOwnBrowsersSync();
  },
  writeStdout: (text) => writeAllSync(1, text),
  writeStderr: (text) => writeAllSync(2, text),
  writeResult: (artifactPath, missionOutcome, exitCode, result, meta) => {
    // A run can end before anything else created the folder.
    mkdirSync(dirname(artifactPath), { recursive: true });
    return writeMissionResult(artifactPath, missionOutcome, exitCode, result, undefined, meta);
  },
  engine: currentEngineInfo,
  onFatalError: (listener) => {
    process.on("uncaughtException", listener);
    return () => process.off("uncaughtException", listener);
  },
  onProcessExit: (listener) => {
    process.on("exit", listener);
    return () => process.off("exit", listener);
  },
  installKillSwitch: installMissionKillSwitch,
};

type Trigger =
  | { readonly kind: "signal"; readonly signal: KillSignal; readonly exitCode: number }
  | { readonly kind: "watchdog" }
  | { readonly kind: "internal-error"; readonly error: unknown }
  | { readonly kind: "unsettled-exit" };

interface ActiveCommand {
  readonly registration: TerminalResultRegistration;
  readonly deps: TerminalResultDeps;
  /** The writers `emitCommandResult` reads, built up front so a trigger allocates nothing it can fail on. */
  readonly output: Command;
  readonly meta: RunMetadata | undefined;
  readonly startedMs: number;
  readonly secrets: string[];
  progress: TerminalProgress;
  timer?: TimerHandle;
  removeListeners?: () => void;
}

/** Newest last. A signal reports for the newest; a nested command never prints a second envelope. */
const active: ActiveCommand[] = [];
/** The process is ending and its one result was written. */
let terminated = false;
let removeReporter: (() => void) | undefined;

/** What the kill switch calls on a signal; it does the teardown and the exit itself. */
function reportSignal({ signal, exitCode }: { signal: KillSignal; exitCode: number }): void {
  const newest = active.at(-1);
  if (newest !== undefined) terminate(newest, { kind: "signal", signal, exitCode });
}

function release(command: ActiveCommand): void {
  if (command.timer !== undefined) clock.clearTimeout(command.timer);
  command.removeListeners?.();
}

/** A secret inside a longer one must not be masked first: that leaves the rest of the longer one readable. */
function longestFirst(secrets: readonly string[]): string[] {
  return [...new Set(secrets)].filter((s) => typeof s === "string").sort((a, b) => b.length - a.length);
}

/** Every string in `value`, object keys included, with each secret masked. */
function scrub(value: unknown, secrets: readonly string[]): unknown {
  if (typeof value === "string") return redactSecretValues(value, secrets);
  if (Array.isArray(value)) return value.map((v) => scrub(v, secrets));
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [redactSecretValues(k, secrets), scrub(v, secrets)]));
  }
  return value;
}

function printable(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return "<unprintable>";
  }
}

/**
 * A thrown value as text. Only its text is carried: an error's own properties can hold anything. A
 * thrown error may also hold a credential nobody registered, so its text loses credential shapes too.
 */
function describeError(err: unknown, depth = 0): Record<string, unknown> {
  const text = (s: string): string => redactCredentialShapes(s);
  if (!(err instanceof Error)) return { message: text(printable(err)) };
  const code = (err as NodeJS.ErrnoException).code;
  return {
    name: text(err.name),
    message: text(err.message),
    ...(err.stack === undefined ? {} : { stack: text(err.stack) }),
    ...(typeof code === "string" ? { code: text(code) } : {}),
    ...(err.cause === undefined || depth >= MAX_CAUSE_DEPTH ? {} : { cause: describeError(err.cause, depth + 1) }),
  };
}

/** `replay 2, mutation drop-save, step 3`, or undefined when nothing was reported. */
function progressPhrase(p: TerminalProgress): string | undefined {
  const parts = [
    p.phase,
    p.replay === undefined ? undefined : `replay ${p.replay}`,
    p.mutation === undefined ? undefined : `mutation ${p.mutation}`,
    p.step === undefined ? undefined : `step ${p.step}`,
  ].filter((part) => part !== undefined);
  return parts.length === 0 ? undefined : parts.join(", ");
}

function headline(trigger: Trigger, registration: TerminalResultRegistration): string {
  switch (trigger.kind) {
    case "signal":
      return `interrupted by ${trigger.signal}`;
    case "watchdog":
      return `no result within the ${registration.watchdogMs}ms watchdog limit`;
    case "internal-error":
      return "internal error";
    case "unsettled-exit":
      return "the process ended before the command produced a result";
  }
}

const ERROR_CODES = {
  signal: "E_TERMINAL_SIGNAL",
  watchdog: "E_TERMINAL_WATCHDOG",
  "internal-error": "E_TERMINAL_INTERNAL",
  "unsettled-exit": "E_TERMINAL_UNSETTLED",
} as const;

/** The redacted diagnostic. Throws only when caller-supplied values cannot be read or serialized. */
function buildDiagnostic(command: ActiveCommand, trigger: Trigger, exitCode: number, secrets: readonly string[]): { message: string; diagnostic: Record<string, unknown> } {
  const { progress, registration, startedMs } = command;
  const error = trigger.kind === "internal-error" ? describeError(trigger.error) : undefined;
  const where = progressPhrase(progress);
  const reason = `${registration.command}: ${headline(trigger, registration)}${where === undefined ? " before any progress was reported" : ` at ${where}`}`;
  const detail = error === undefined ? reason : `${reason}: ${printable(error["message"])}`;
  return {
    message: redactSecretValues(detail, secrets),
    // A JSON round trip first: a cycle or a BigInt throws here, inside the caller's guard, and a
    // `toJSON` runs here rather than while the artifact is being written.
    diagnostic: scrub(
      JSON.parse(
        JSON.stringify({
          command: registration.command,
          trigger: trigger.kind,
          ...(trigger.kind === "signal" ? { signal: trigger.signal } : {}),
          ...(trigger.kind === "watchdog" ? { watchdogMs: registration.watchdogMs } : {}),
          elapsedMs: clock.monotonicMs() - startedMs,
          exitCode,
          progress,
          ...(error === undefined ? {} : { error }),
        }),
      ),
      secrets,
    ) as Record<string, unknown>,
  };
}

/** Everything the layer can say with no caller-supplied text: what is left when that text is unusable. */
function bareDiagnostic(command: ActiveCommand, trigger: Trigger, exitCode: number): { message: string; diagnostic: Record<string, unknown> } {
  return {
    message: `${headline(trigger, command.registration)} (the diagnostic could not be built, so its details are withheld)`,
    diagnostic: { trigger: trigger.kind, ...(trigger.kind === "signal" ? { signal: trigger.signal } : {}), exitCode, diagnosticWithheld: true },
  };
}

function missionOutcomeOf(trigger: Trigger): MissionOutcome {
  return trigger.kind === "internal-error" ? "crashed" : "inconclusive";
}

/** The first trigger's report, exit excluded. Never throws: nothing here may keep the process from exiting. */
function report(command: ActiveCommand, trigger: Trigger): number {
  const { deps, registration } = command;
  const missionOutcome = missionOutcomeOf(trigger);
  const exitCode = trigger.kind === "signal" ? trigger.exitCode : exitCodeForOutcome(missionOutcome);
  const secrets = longestFirst(command.secrets);
  let built: { message: string; diagnostic: Record<string, unknown> };
  try {
    built = buildDiagnostic(command, trigger, exitCode, secrets);
  } catch {
    built = bareDiagnostic(command, trigger, exitCode);
  }

  let resultPath: string | undefined;
  let artifactError: string | undefined;
  if (registration.artifactPath !== undefined) {
    try {
      let engine: EngineInfo | undefined;
      try {
        engine = deps.engine();
      } catch {
        engine = undefined; // A missing stamp must not cost the result.
      }
      resultPath = deps.writeResult(
        registration.artifactPath,
        missionOutcome,
        exitCode,
        {
          schemaVersion: MISSION_RESULT_SCHEMA_VERSION,
          outcome: missionOutcome,
          missionOutcome,
          reason: built.message,
          stop: trigger.kind === "signal" ? "terminated" : trigger.kind,
          exitCode,
          defects: [],
          defectOutcome: { status: "none", byKind: {} },
          hangs: [],
          recordingPaths: [],
          resultPath: redactSecretValues(resultPathFor(registration.artifactPath), secrets),
          ...(engine === undefined ? {} : { engine }),
          diagnostic: built.diagnostic,
        },
        command.meta,
      );
    } catch (err) {
      artifactError = redactSecretValues(redactCredentialShapes(printable(err instanceof Error ? err.message : err)), secrets);
    }
  }

  const shownPath = resultPath === undefined ? undefined : redactSecretValues(resultPath, secrets);
  const envelope: JsonEnvelope<Record<string, unknown>> = {
    ...fail(ERROR_CODES[trigger.kind], shownPath === undefined ? built.message : `${built.message} (result: ${shownPath})`),
    data: {
      ...built.diagnostic,
      ...(shownPath === undefined ? {} : { resultPath: shownPath }),
      ...(artifactError === undefined ? {} : { artifactError }),
    },
  };
  try {
    emitCommandResult(command.output, envelope, { json: registration.json, exitCode, command: registration.command });
  } catch {
    // Best-effort: stdout may already be gone (a closed pipe). The artifact above still stands.
    process.exitCode = exitCode;
  }
  return exitCode;
}

/** Runs `trigger` once per process. Returns the exit code, or undefined when a result already went out. */
function terminate(command: ActiveCommand, trigger: Trigger): number | undefined {
  if (terminated) return undefined;
  terminated = true;
  for (const c of active) release(c);
  active.length = 0;
  return report(command, trigger);
}

/** A trigger this layer ends itself; the kill switch does the same on the signal path. */
function terminateAndExit(command: ActiveCommand, trigger: Trigger): void {
  const exitCode = terminate(command, trigger);
  if (exitCode === undefined) return;
  try {
    command.deps.terminateBrowsers();
  } catch {
    // Best-effort, like the kill switch's teardown: it must never keep the process from exiting.
  }
  command.deps.exit(exitCode);
}

/**
 * Registers how a long-running command produces its terminal result. Call it before the command's
 * first browser launch, and keep the returned handle for the run. See this module's doc for what ends
 * a command, and for the synchronous contract everything reachable from a trigger keeps.
 *
 * Throws a `RangeError` on an unusable `watchdogMs`: a command never runs without its bound.
 */
export function registerTerminalResult(registration: TerminalResultRegistration, deps: TerminalResultDeps = realDeps): TerminalResultHandle {
  if (!Number.isInteger(registration.watchdogMs) || registration.watchdogMs <= 0 || registration.watchdogMs > MAX_TIMER_MS) {
    throw new RangeError(`watchdogMs must be a positive integer of at most ${MAX_TIMER_MS}, got ${registration.watchdogMs}`);
  }
  // Only a fake `exit` can get here with a finished process behind it (a later test in one worker).
  if (active.length === 0) terminated = false;
  deps.installKillSwitch();

  const command: ActiveCommand = {
    registration,
    deps,
    output: new Command().configureOutput({ writeOut: deps.writeStdout, writeErr: deps.writeStderr }),
    meta: currentRunMetadata(),
    startedMs: clock.monotonicMs(),
    secrets: [...registration.secrets],
    progress: registration.progress ?? {},
  };
  active.push(command);
  removeReporter = setKillTerminalReporter(reportSignal);

  const removeFatal = deps.onFatalError((err) => terminateAndExit(command, { kind: "internal-error", error: err }));
  const removeExit = deps.onProcessExit(() => {
    // The process is already ending: only the report and the teardown are left to do.
    const exitCode = terminate(command, { kind: "unsettled-exit" });
    if (exitCode === undefined) return;
    try {
      deps.terminateBrowsers();
    } catch {
      // Best-effort, as in terminateAndExit.
    }
  });
  command.removeListeners = () => {
    removeFatal();
    removeExit();
  };
  // Unref'd: this timer alone must not hold a finished process open. If the event loop drains, the
  // exit listener above reports it at once.
  command.timer = clock.setTimeout(() => terminateAndExit(command, { kind: "watchdog" }), registration.watchdogMs);
  command.timer.unref();

  const settled = (): boolean => !active.includes(command);
  return {
    progress: (update) => {
      command.progress = { ...command.progress, ...update };
    },
    addSecrets: (values) => {
      command.secrets.push(...values);
    },
    fail: (err) => {
      if (!settled()) terminateAndExit(command, { kind: "internal-error", error: err });
    },
    complete: () => {
      if (settled()) return;
      active.splice(active.indexOf(command), 1);
      release(command);
      if (active.length === 0) {
        removeReporter?.();
        removeReporter = undefined;
      }
    },
  };
}

/** Test seam: resets all module state (a real run never needs this: one process, one exit). */
export function __resetTerminalResultForTests(): void {
  for (const c of active) release(c);
  active.length = 0;
  terminated = false;
  removeReporter?.();
  removeReporter = undefined;
}
