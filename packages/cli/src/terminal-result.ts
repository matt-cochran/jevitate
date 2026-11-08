import { mkdirSync, writeSync } from "node:fs";
import { dirname } from "node:path";
import { Command } from "commander";
import { isWeakSecret, redactCredentialShapes, redactText, redactUrl, REDACTION_MASK, SENSITIVE_URL_PARAMS } from "@jevitate/ai-core";
import { clock, MISSION_RESULT_SCHEMA_VERSION, type MissionOutcome, type TimerHandle } from "@jevitate/domain";
import { terminateOwnBrowsersSync } from "@jevitate/playwright";
import { inMcpInvocation } from "./approval-provenance.js";
import { emitCommandResult } from "./cli-shared.js";
import { currentEngineInfo, type EngineInfo } from "./engine.js";
import { fail, type JsonEnvelope } from "./envelope.js";
import { EXIT_CODES, exitCodeForOutcome } from "./exit-codes.js";
import { installMissionKillSwitch, PARENT_GONE_HINT, setKillTerminalReporter, type KillCause, type KillSignal } from "./kill-signal.js";
import { resultPathFor, writeMissionResult } from "./mission-journal.js";
import { currentRunMetadata, type RunMetadata } from "./run-metadata.js";

/**
 * The shared terminal result of a long-running command: however the command ends, it ends with a
 * machine-readable result. A command registers once (`registerTerminalResult`), reports progress as
 * it goes, and calls `complete()` when it has emitted its own result. If it ends any other way, this
 * layer writes a redacted diagnostic artifact, prints one envelope and exits:
 *
 *  | trigger        | code                   | exit                                                  |
 *  |----------------|------------------------|-------------------------------------------------------|
 *  | signal         | E_TERMINAL_SIGNAL      | 129/130/143, by the kill switch (kill-signal.ts)      |
 *  | parent gone    | E_TERMINAL_PARENT_GONE | 129, by the kill switch; no signal was sent           |
 *  | inactivity     | E_TERMINAL_WATCHDOG    | 2 (inconclusive: it proves nothing)                   |
 *  | `fail(err)`    | E_TERMINAL_INTERNAL    | 2 (crashed)                                           |
 *  | uncaught error | E_TERMINAL_INTERNAL    | 2 (crashed; an unhandled rejection arrives this way)  |
 *  | process exit   | E_TERMINAL_UNSETTLED   | 2 (a `process.exit` or a drained event loop, no result) |
 *
 * Exactly once: the first trigger wins and every later one is a no-op. An uncaught error after
 * `complete()` is no trigger, since the result is already out: one redacted stderr report, then an
 * exit that keeps the code the command set.
 *
 * What cannot be handled in process (SIGKILL, a caller's limit that kills the whole group) leaves
 * only what was already printed, so each `progress()` also prints one short redacted line to stderr.
 * stdout stays exactly one envelope. A stderr that stops accepting them only ends the printing.
 *
 * A broken output pipe never decides a result: see `installBrokenPipePolicy`.
 *
 * Inside an MCP tool call (`mcp-cli-runner.ts`) the process is the shared server and fd 1 is the MCP
 * protocol channel, so this layer stays out: nothing is printed, nothing is armed, and nothing
 * exits. The tool's result is still the command's own captured envelope. `fail` rethrows there, and
 * the runner turns that into its own `E_CLI_INTERNAL` result.
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

/**
 * Where the command is now: what a progress line and a diagnostic name. All text is redacted before
 * use. An update merges into what was reported, so pass `undefined` to clear a field that no longer
 * applies (the mutation, once the replay under it has finished).
 */
export interface TerminalProgress {
  readonly phase?: string | undefined;
  readonly replay?: number | string | undefined;
  readonly mutation?: string | undefined;
  readonly step?: number | string | undefined;
  /** Carried in the diagnostic only, never in a progress line. */
  readonly detail?: Readonly<Record<string, unknown>> | undefined;
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
  /**
   * The longest the command may go without calling `progress()`, in milliseconds: a positive integer
   * a timer can represent. Each `progress()` starts this limit again, so it does not bound the whole
   * run: legal runs range from seconds to over 100 minutes (#778).
   *
   * Derive it from what one uninterrupted stretch can legally take, not from a typical run. If
   * `progress()` is called per replay, it must cover the 300 s machine-slot admission bound
   * (`DEFAULT_ADMISSION_TIMEOUT_MS`) plus the longest legal single replay of this command's plan,
   * since both can fall between two calls.
   */
  readonly inactivityMs: number;
  /** The progress known at registration. */
  readonly progress?: TerminalProgress;
}

export interface TerminalResultHandle {
  /**
   * Merges what the command knows now into the progress a diagnostic reports, prints one redacted line
   * to stderr, and starts `inactivityMs` again. A no-op once the command has settled. Synchronous;
   * never throws.
   */
  progress(update: TerminalProgress): void;
  /** Adds secrets learned during the run (a resolved auth token), so a later trigger masks them too. Synchronous; never throws. */
  addSecrets(values: readonly string[]): void;
  /**
   * An internal error: reports it, then exits. A no-op once the command has settled. Inside an MCP
   * tool call it throws the redacted error instead, so call it where a throw reaches the command's
   * caller (a `catch` that ends the action).
   */
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
  /** True when this process is shared with other work and is not this command's to print on or end. */
  readonly sharedProcess: () => boolean;
}

/** Steps of `RETRY_SLEEP_MS`: a reader that drains nothing for this long no longer holds up the exit. */
const WRITE_RETRIES = 200;
const RETRY_SLEEP_MS = 5;
const MAX_TIMER_MS = 2_147_483_647;
const MAX_CAUSE_DEPTH = 5;
/** A progress line is one short line: a caller may keep only the tail of its stderr. */
const MAX_PROGRESS_LINE = 200;

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
  sharedProcess: inMcpInvocation,
};

type Trigger =
  | { readonly kind: "signal"; readonly signal: KillSignal; readonly exitCode: number }
  | { readonly kind: "parent-gone"; readonly exitCode: number }
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
  /** stderr refused a progress line (a closed pipe, a reader that stopped draining): no more are tried. */
  progressSilenced: boolean;
  timer?: TimerHandle;
  removeListeners?: () => void;
}

/** Newest last. A signal reports for the newest; a nested command never prints a second envelope. */
const active: ActiveCommand[] = [];
/** The process is ending and its one result was written. */
let terminated = false;
/** Secrets of commands that already completed: an error after their result is still theirs to redact. */
const completedSecrets: string[] = [];
let completedAny = false;
let removeReporter: (() => void) | undefined;
/** The listener for an uncaught error after the last command completed. */
let removeLateReporter: (() => void) | undefined;

/** What the kill switch calls on a signal; it does the teardown and the exit itself. */
function reportKill({ cause, exitCode }: { cause: KillCause; exitCode: number }): void {
  const newest = active.at(-1);
  if (newest === undefined) return;
  terminate(newest, cause === "parent-gone" ? { kind: "parent-gone", exitCode } : { kind: "signal", signal: cause, exitCode });
}

function release(command: ActiveCommand): void {
  if (command.timer !== undefined) clock.clearTimeout(command.timer);
  command.removeListeners?.();
}

/** A secret inside a longer one must not be masked first: that leaves the rest of the longer one readable. */
function longestFirst(secrets: readonly string[]): string[] {
  return [...new Set(secrets)].filter((s) => typeof s === "string").sort((a, b) => b.length - a.length);
}

/** The name of a value that is itself a credential. `code` and `key` are too common as plain field names to be here. */
const CREDENTIAL_KEY = /^(?:sid|session|otp|jwt)$|(?:pass(?:word|wd|phrase|code)|pwd|secret|token|apikey|authorization|cookies?|sessionid|csrf|xsrf)$/;

/** Whether a field, header or parameter of this name holds a credential, however it is cased or separated. */
function isCredentialKey(name: string): boolean {
  return CREDENTIAL_KEY.test(name.toLowerCase().replace(/[-_.]/g, ""));
}

/** `key: "value"`, quoted or not, including JSON inside a string (`\\"password\\":\\"x\\"`): the value runs to its own closing quote. */
const QUOTED_FIELD = /(?<![\w-])((?:(?<!\\)\\*["'])?)([A-Za-z][\w-]*)\1\s*:\s*(\\*)(["'])((?:(?!\3\4)(?:\\.|[^\n\\]))*)\3\4/g;
/** `"set-cookie":[` : the opening of an array, whose values have no one shape. */
const ARRAY_FIELD = /(?<![\w-])((?:(?<!\\)\\*["'])?)([A-Za-z][\w-]*)\1\s*:\s*\[/g;
const NUMERIC_FIELD = /(?<![\w-])((?<!\\)\\*["'])([A-Za-z][\w-]*)\1\s*:\s*\d+/g;
/** `name=value` outside a URL's own query, where `redactUrl` stops: its separators, plus a quoted value. */
/** `Authorization=Bearer abc`: the scheme and its token are one value, and a space does not end it. */
const AUTHORIZATION_ASSIGNMENT = /(?<![\w.%-])((?:proxy-)?authorization)[ \t]*=[ \t]*(?!«)[^\r\n]*/gi;
const ASSIGNMENT = /(?<![\w.%-])([A-Za-z][\w.-]*)=("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|[^&;#\s"'<>]*)/g;
/** A header holds its credential to the end of the line (`Cookie: a=1; b=2`). A quoted value is QUOTED_FIELD's. */
const CREDENTIAL_HEADER = /(?<![\w-])((?:set-)?cookie|(?:proxy-)?authorization|x-api-key|x-auth-token|x-csrf-token)\s*:\s*(?!\\*["'])[^\r\n]*/gi;
const PASSWORD_FIELD = /(?<![\w-])(pass(?:word|wd|phrase|code)|pwd|secret|api[-_ ]?key)\s*:\s*(?!\\*["'«])\S+/gi;
/** `token: abc`: any credential name, unquoted, or with a quote the text was cut before closing. */
const UNQUOTED_FIELD = /(?<![\w.-])([A-Za-z][\w.-]*)[ \t]*:[ \t]*(?!\\*["']?«)\S+/g;
/** Too common in a sentence to mask after a word: `could not open a session: refused` names no credential. */
const PROSE_WORDS = /^(?:session|auth)$/i;
const BEARER = /\b(bearer)\s+[A-Za-z0-9._~+/=-]{8,}/gi;
/**
 * To the last `@`, as a password can hold `/` or `@`, or with no password at all. `host:3000/@fs/x` is a
 * port and a path, not a password, so a value of port shape before the first `/`, `?` or `#` stays readable.
 */
const URL_USERINFO = /(\/\/)(?:[^\s/@:"'<>]+:(?!\d{1,5}[/?#])[^\s"'<>]{0,1024}|[^\s/?#"'<>]*)@/g;
/** A URL carried inside another URL's parameter (`?next=https%3A%2F%2Fapp%3Ftoken%3Dabc`). */
const ENCODED_PARAM = /(%3F|%26|%23|%3B)([\w.-]+)%3D((?:(?!%26|%23|%3B)[^&;#\s"'<>])*)/gi;
/** A status or exit code, or a named constant: `code=` that is not a one-time code. */
const PLAIN_CODE_VALUE = /^(?:\d{1,3}|[A-Z][A-Z0-9_]*)$/;
/** A signed URL's parts, which `SENSITIVE_URL_PARAMS` does not name. `X-Amz-Date` and the like stay readable. */
const SIGNED_URL_PARAMS: ReadonlySet<string> = new Set(["x-amz-signature", "x-amz-credential", "x-goog-signature", "x-goog-credential"]);
/**
 * The longest text the masking rules run on. Their time grows with the length, and a page can choose
 * the text, on the one thread that also answers a signal. Longer text is withheld whole, since cutting
 * it could leave half a value for a rule to miss.
 */
const MAX_MASKED_TEXT = 16 * 1024;

function isCredentialParam(name: string, value: string): boolean {
  const lower = name.toLowerCase();
  if (lower === "code" && PLAIN_CODE_VALUE.test(value)) return false;
  return SENSITIVE_URL_PARAMS.has(lower) || SIGNED_URL_PARAMS.has(lower) || isCredentialKey(name);
}

/** A credential-named array, to the end of its line: its values can hold anything that would end a shorter match. */
function maskCredentialArrays(text: string): string {
  let out = "";
  let from = 0;
  for (const m of text.matchAll(ARRAY_FIELD)) {
    if (m.index < from || !isCredentialKey(m[2] ?? "")) continue;
    const end = /[\r\n]/.exec(text.slice(m.index))?.index;
    out += `${text.slice(from, m.index)}${m[1]}${m[2]}${m[1]}: [${REDACTION_MASK}]`;
    from = end === undefined ? text.length : m.index + end;
  }
  return out + text.slice(from);
}

/** What `redactUrl` does not reach: named credentials outside a URL query, and in headers, bodies and URL userinfo. */
function redactCredentialContext(text: string): string {
  return maskCredentialArrays(text)
    .replace(QUOTED_FIELD, (whole: string, q: string, name: string, vq: string, quote: string) =>
      isCredentialKey(name) ? `${q}${name}${q}: ${vq}${quote}${REDACTION_MASK}${vq}${quote}` : whole,
    )
    .replace(NUMERIC_FIELD, (whole: string, q: string, name: string) => (isCredentialKey(name) ? `${q}${name}${q}: ${REDACTION_MASK}` : whole))
    .replace(AUTHORIZATION_ASSIGNMENT, (_whole: string, name: string) => `${name}=${REDACTION_MASK}`)
    .replace(ASSIGNMENT, (whole: string, name: string, value: string) => (value !== "" && value !== REDACTION_MASK && isCredentialParam(name, value) ? `${name}=${REDACTION_MASK}` : whole))
    .replace(CREDENTIAL_HEADER, (_whole: string, name: string) => `${name}: ${REDACTION_MASK}`)
    .replace(PASSWORD_FIELD, (_whole: string, name: string) => `${name}: ${REDACTION_MASK}`)
    .replace(UNQUOTED_FIELD, (whole: string, name: string, at: number, all: string) => {
      const inProse = PROSE_WORDS.test(name) && /[A-Za-z] $/.test(all.slice(Math.max(0, at - 2), at));
      return !inProse && (isCredentialKey(name) || PROSE_WORDS.test(name)) ? `${name}: ${REDACTION_MASK}` : whole;
    })
    .replace(BEARER, (_whole: string, word: string) => `${word} ${REDACTION_MASK}`)
    .replace(URL_USERINFO, (_whole: string, slashes: string) => `${slashes}${REDACTION_MASK}@`)
    .replace(ENCODED_PARAM, (whole: string, sep: string, name: string, value: string) => (value !== "" && isCredentialParam(name, value) ? `${sep}${name}%3D${REDACTION_MASK}` : whole));
}

/**
 * The one rule for text leaving a command: registered secrets first and whole, so no part of one is
 * left for a later rule to half-mask, then URL parameters, named credentials and credential shapes.
 * Text past `MAX_MASKED_TEXT` once the secrets' masks are in is withheld whole.
 */
export function redactSensitiveText(text: string, secrets: readonly string[]): string {
  const withoutSecrets = redactText(text, longestFirst(secrets));
  if (withoutSecrets.length > MAX_MASKED_TEXT) return `${REDACTION_MASK} (${text.length} characters, too long to check)`;
  return redactCredentialShapes(redactCredentialContext(redactUrl(withoutSecrets)));
}

/**
 * A path this process wrote must still open: only a real secret is masked, never a shape (a video's
 * file name is 32 hex digits) and never a short value (`--param dir=logs` is not `.jevitate/logs`).
 */
export function redactSensitivePath(path: string, secrets: readonly string[]): string {
  return redactText(path, longestFirst(secrets).filter((s) => !isWeakSecret(s)));
}

/** How a field keeps its value: `verbatim` (no secret can be there), or `path` (see `redactSensitivePath`). */
export type RedactionFieldRule = (key: string) => "verbatim" | "path" | undefined;

/**
 * Every string VALUE in `value` through `redactSensitiveText`. A field named for a credential loses
 * its whole value, whatever it looks like. `rule` exempts a caller's known fields. Keys are never
 * touched: they are what a reader finds `exitCode` and `verdict` by, so a value that happens to equal
 * one must not rename it. A map keyed by data has to reach here as text (see `buildDiagnostic`).
 */
export function redactSensitiveValue(value: unknown, secrets: readonly string[], rule: RedactionFieldRule = () => undefined): unknown {
  const walk = (v: unknown, field: "verbatim" | "path" | "credential" | undefined): unknown => {
    if (typeof v === "string") {
      if (field === "verbatim") return v;
      if (field === "path") return redactSensitivePath(v, secrets);
      return field === "credential" && v !== "" ? REDACTION_MASK : redactSensitiveText(v, secrets);
    }
    if (Array.isArray(v)) return v.map((item) => walk(item, field));
    if (v !== null && typeof v === "object") {
      return Object.fromEntries(
        Object.entries(v).map(([k, item]) => [k, walk(item, rule(k) ?? (field === "credential" || isCredentialKey(k) ? "credential" : undefined))]),
      );
    }
    return v;
  };
  return walk(value, undefined);
}

/** `err` with its text redacted: the same object and class, so a caller's `instanceof` still decides. */
export function redactThrown(err: unknown, secrets: readonly string[], depth = 0): unknown {
  if (typeof err === "string") return redactSensitiveText(err, secrets);
  if (!(err instanceof Error)) return err;
  err.message = redactSensitiveText(err.message, secrets);
  if (err.stack !== undefined) err.stack = redactSensitiveText(err.stack, secrets);
  if (depth < MAX_CAUSE_DEPTH && err.cause !== undefined) err.cause = redactThrown(err.cause, secrets, depth + 1);
  return err;
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
 * thrown error may also hold a credential nobody registered, so its text gets the whole rule.
 */
function describeError(err: unknown, secrets: readonly string[], depth = 0): Record<string, unknown> {
  const text = (s: string): string => redactSensitiveText(s, secrets);
  if (!(err instanceof Error)) return { message: text(printable(err)) };
  const code = (err as NodeJS.ErrnoException).code;
  return {
    name: text(err.name),
    message: text(err.message),
    ...(err.stack === undefined ? {} : { stack: text(err.stack) }),
    ...(typeof code === "string" ? { code: text(code) } : {}),
    ...(err.cause === undefined || depth >= MAX_CAUSE_DEPTH ? {} : { cause: describeError(err.cause, secrets, depth + 1) }),
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
    case "parent-gone":
      return `the parent process went away, no signal was sent (${PARENT_GONE_HINT})`;
    case "watchdog":
      return `no progress for the ${registration.inactivityMs}ms inactivity limit`;
    case "internal-error":
      return "internal error";
    case "unsettled-exit":
      return "the process ended before the command produced a result";
  }
}

const ERROR_CODES = {
  signal: "E_TERMINAL_SIGNAL",
  "parent-gone": "E_TERMINAL_PARENT_GONE",
  watchdog: "E_TERMINAL_WATCHDOG",
  "internal-error": "E_TERMINAL_INTERNAL",
  "unsettled-exit": "E_TERMINAL_UNSETTLED",
} as const;

/** What names the ending rather than describes it: a value equal to one of these must not rewrite it. */
const DIAGNOSTIC_VERBATIM_FIELDS: ReadonlySet<string> = new Set(["command", "trigger", "signal"]);

/** `detail` is keyed by whatever the caller had to hand, so it is redacted as text: keys and values alike. */
function progressForDiagnostic({ detail, ...progress }: TerminalProgress): Record<string, unknown> {
  return detail === undefined ? progress : { ...progress, detail: JSON.stringify(detail) };
}

/** The redacted diagnostic. Throws only when caller-supplied values cannot be read or serialized. */
function buildDiagnostic(command: ActiveCommand, trigger: Trigger, exitCode: number, secrets: readonly string[]): { message: string; diagnostic: Record<string, unknown> } {
  const { progress, registration, startedMs } = command;
  const error = trigger.kind === "internal-error" ? describeError(trigger.error, secrets) : undefined;
  const where = progressPhrase(progress);
  const reason = `${registration.command}: ${headline(trigger, registration)}${where === undefined ? " before any progress was reported" : ` at ${where}`}`;
  const detail = error === undefined ? reason : `${reason}: ${printable(error["message"])}`;
  return {
    message: redactSensitiveText(detail, secrets),
    // A JSON round trip first: a cycle or a BigInt throws here, inside the caller's guard, and a
    // `toJSON` runs here rather than while the artifact is being written.
    diagnostic: redactSensitiveValue(
      JSON.parse(
        JSON.stringify({
          command: registration.command,
          trigger: trigger.kind,
          ...(trigger.kind === "signal" ? { signal: trigger.signal } : {}),
          ...(trigger.kind === "watchdog" ? { inactivityMs: registration.inactivityMs } : {}),
          elapsedMs: Math.round(clock.monotonicMs() - startedMs),
          exitCode,
          progress: progressForDiagnostic(progress),
          ...(error === undefined ? {} : { error }),
        }),
      ),
      secrets,
      (key) => (DIAGNOSTIC_VERBATIM_FIELDS.has(key) ? "verbatim" : undefined),
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
  const exitCode = trigger.kind === "signal" || trigger.kind === "parent-gone" ? trigger.exitCode : exitCodeForOutcome(missionOutcome);
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
          stop: trigger.kind === "signal" || trigger.kind === "parent-gone" ? "terminated" : trigger.kind,
          exitCode,
          defects: [],
          defectOutcome: { status: "none", byKind: {} },
          hangs: [],
          recordingPaths: [],
          resultPath: redactSensitivePath(resultPathFor(registration.artifactPath), secrets),
          ...(engine === undefined ? {} : { engine }),
          diagnostic: built.diagnostic,
        },
        command.meta,
      );
    } catch (err) {
      artifactError = redactSensitiveText(printable(err instanceof Error ? err.message : err), secrets);
    }
  }

  const shownPath = resultPath === undefined ? undefined : redactSensitivePath(resultPath, secrets);
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

/** (Re)starts the command's inactivity limit. */
function armInactivity(command: ActiveCommand): void {
  if (command.timer !== undefined) clock.clearTimeout(command.timer);
  // Unref'd: this timer alone must not hold a finished process open. If the event loop drains, the
  // exit listener reports it at once.
  command.timer = clock.setTimeout(() => terminateAndExit(command, { kind: "watchdog" }), command.registration.inactivityMs);
  command.timer.unref();
}

/** All redaction first: cutting or rewriting the text before it could leave part of a secret readable. */
function progressLine(command: ActiveCommand): string {
  const { progress, registration, secrets, startedMs } = command;
  const elapsedS = Math.round((clock.monotonicMs() - startedMs) / 1_000);
  const raw = `progress ${registration.command}: ${progressPhrase(progress) ?? "running"} (${elapsedS}s)`;
  const redacted = redactSensitiveText(raw, secrets);
  return `${redacted.replace(/[\u0000-\u001f\u007f]+/g, " ").slice(0, MAX_PROGRESS_LINE)}\n`;
}

/** Nothing here may reach the run: a stderr that refuses a line ends the printing, and only that. */
function printProgress(command: ActiveCommand): void {
  if (command.progressSilenced) return;
  try {
    command.deps.writeStderr(progressLine(command));
  } catch {
    command.progressSilenced = true;
  }
}

/** The handle inside a shared process: see this module's doc. */
function sharedProcessHandle(registration: TerminalResultRegistration): TerminalResultHandle {
  const secrets = [...registration.secrets];
  return {
    progress: () => {},
    addSecrets: (values) => {
      secrets.push(...values);
    },
    fail: (err) => {
      throw new Error(printable(describeError(err, secrets)["message"]));
    },
    complete: () => {},
  };
}

/**
 * An uncaught error once every command has completed (a late teardown failure, say). Node's own
 * printer would show the raw stack and replace the code with 1, so this reports it redacted and ends
 * the process as the command said it should. Listening means Node no longer ends it, so this must.
 */
function reportLateError(err: unknown, deps: TerminalResultDeps): void {
  try {
    const raw = err instanceof Error ? (err.stack ?? String(err)) : printable(err);
    deps.writeStderr(`${redactSensitiveText(raw, completedSecrets)}\n`);
  } catch {
    // Best-effort: stderr may already be gone. The exit below still stands.
  }
  try {
    deps.terminateBrowsers();
  } catch {
    // Best-effort, as in terminateAndExit.
  }
  deps.exit(Number(process.exitCode ?? EXIT_CODES.inconclusive));
}

/**
 * Registers how a long-running command produces its terminal result. Call it before the command's
 * first browser launch, and keep the returned handle for the run. See this module's doc for what ends
 * a command, and for the synchronous contract everything reachable from a trigger keeps.
 *
 * Throws a `RangeError` on an unusable `inactivityMs`: a command never runs without its bound.
 */
export function registerTerminalResult(registration: TerminalResultRegistration, deps: TerminalResultDeps = realDeps): TerminalResultHandle {
  if (!Number.isInteger(registration.inactivityMs) || registration.inactivityMs <= 0 || registration.inactivityMs > MAX_TIMER_MS) {
    throw new RangeError(`inactivityMs must be a positive integer of at most ${MAX_TIMER_MS}, got ${registration.inactivityMs}`);
  }
  if (deps.sharedProcess()) return sharedProcessHandle(registration);
  removeLateReporter?.();
  removeLateReporter = undefined;
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
    progressSilenced: false,
  };
  active.push(command);
  removeReporter = setKillTerminalReporter(reportKill);

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
  armInactivity(command);

  const settled = (): boolean => !active.includes(command);
  return {
    progress: (update) => {
      if (settled()) return;
      command.progress = { ...command.progress, ...update };
      // Any command's progress shows the process is working, and an outer command waits on the inner.
      for (const c of active) armInactivity(c);
      printProgress(command);
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
      completedAny = true;
      completedSecrets.push(...command.secrets);
      if (active.length === 0) {
        removeReporter?.();
        removeReporter = undefined;
        removeLateReporter = deps.onFatalError((err) => reportLateError(err, deps));
      }
    },
  };
}

/**
 * What an EPIPE on an output stream means. A closed reader is not a verdict, and exit 0 here once
 * reported `still-reproduces` as a pass, so:
 *
 *  - stderr: nothing. It carries progress and diagnostics, and `2>&1 | head` must not end a proof.
 *  - stdout, a registered command still running: nothing. It goes on to its real result and exit code.
 *  - stdout otherwise: the process exits quietly (#213) with whatever `process.exitCode` the command
 *    set, 0 when it set none. `emitEnvelope` writes before it sets the code, but a stream reports
 *    the error on a later tick than the write, so the code is set by the time this runs. And a
 *    registered command calls `complete()` in that same turn, so if the error ever came first, the
 *    "still running" rule above would keep its code.
 *
 * `process.exit()` takes no code on purpose: it keeps the one the command set.
 */
export function installBrokenPipePolicy(
  streams: { readonly stdout: NodeJS.EventEmitter; readonly stderr: NodeJS.EventEmitter } = process,
  exit: () => void = () => process.exit(),
): void {
  const rethrowUnlessEpipe = (err: NodeJS.ErrnoException): void => {
    if (err.code !== "EPIPE") throw err;
  };
  streams.stderr.on("error", rethrowUnlessEpipe);
  streams.stdout.on("error", (err: NodeJS.ErrnoException) => {
    rethrowUnlessEpipe(err);
    if (active.length === 0) exit();
  });
}

/**
 * A command's promise rejected up to the entry point. With a command registered in this process the
 * layer handles it, so its secrets are redacted: a running one gets the usual E_TERMINAL_INTERNAL
 * ending, and a completed one (its result already out, so no second envelope) a redacted stderr line
 * and exit 2. Returns false when nothing was registered: the caller reports it itself.
 */
export function reportCommandRejection(err: unknown, writeStderr: (text: string) => void = realDeps.writeStderr): boolean {
  const newest = active.at(-1);
  if (newest !== undefined) {
    terminateAndExit(newest, { kind: "internal-error", error: err });
    return true;
  }
  if (!completedAny) return false;
  process.exitCode = EXIT_CODES.inconclusive;
  try {
    writeStderr(`${redactSensitiveText(String(err), completedSecrets)}\n`);
  } catch {
    // Best-effort: stderr may already be gone. The exit code above still stands.
  }
  return true;
}

/** Test seam: resets all module state (a real run never needs this: one process, one exit). */
export function __resetTerminalResultForTests(): void {
  for (const c of active) release(c);
  active.length = 0;
  terminated = false;
  completedAny = false;
  completedSecrets.length = 0;
  removeReporter?.();
  removeReporter = undefined;
  removeLateReporter?.();
  removeLateReporter = undefined;
}
