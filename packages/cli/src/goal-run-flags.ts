/**
 * #369: the goal run's run-shaping flags, shared by `jevitate explore` (goal/usability) and
 * `jevitate explore-author-journey` (whose discovery and corroborating takes ARE goal runs) — one
 * definition of each flag (text, parser, default) and one resolver, so the two commands accept and
 * validate the same setup and an author run can reproduce what a goal run needed.
 */
import { Option } from "commander";
import {
  parseSecretField,
  validateDenyPatterns,
  type DialogPolicy,
  type SecretField,
  type SuccessWhen,
  type TypeFixture,
} from "@jevitate/explore";
import type { EmulationSpec } from "@jevitate/playwright";
import { intArg, nonNegativeIntArg, positiveIntArg } from "./cli-args.js";
import type { ConversationOptions } from "./conversation-options.js";
import { LITERAL_SECRET_WARNING, resolveSecretArgs } from "./secret-args.js";
import { secretCommandRunner } from "./secret-command.js";
import { loadTypeFixtures } from "./type-fixture-file.js";
import { SessionFileInProjectError, assertSessionFileOutsideProject } from "./project-dir.js";
import { parseScreenshotsArg, type ScreenshotsSpec } from "./run-screenshots.js";
import { TargetConfigError, loadTargetsFile, resolveTargetConfig, type TargetConfig, type TargetFlags } from "./target-config.js";
import { emulationFromFlags, type EmulationFlags, type ScreenshotsFlags } from "./cli-shared.js";
import type { SecretCommandRunner } from "@jevitate/explore";

const collect = (v: string, prev: string[]): string[] => [...prev, v];

/** Each shared flag, built fresh per command (commander owns an `Option` once added). */
export const GOAL_RUN_OPTIONS = {
  successWhen: () =>
    new Option(
      "--success-when <when>",
      "when the --success page checks must hold: final (default; on the final page) | held (on the final page, or all together at any settled step — a one-time secret, a toast) | " +
        "each (each went from not holding to holding at some settled step, in any order — checks on different pages; the run stops once all have). reloadThen is always final",
    ),
  allowVacuousChecks: () =>
    new Option(
      "--allow-vacuous-checks",
      "downgrade a vacuous --success check to a warning. By default a check satisfied before the run's first action — a page check that held on the seed page and never changed " +
        "(an empty result container), a requestMade/responseStatus matched only by a page-load or polling request — FAILS: it cannot verify the goal",
    ),
  actionDeltas: () =>
    new Option(
      "--action-deltas",
      "opt-in (#303; every --strategy, not --feature): record what each action changed on the page — an accessibility snapshot before and after, announcements, " +
        "the action's requests — redacted, with a code verdict per step (no-change | relevant-change | inconclusive) used by the goal loop's no-progress check and a persistence re-check after writes (goal), and as defect evidence (adversarial, coverage); " +
        "adds `delta` to every transcript step (and Recording step, goal) and `actionDeltas` to the result. Costs about 50-100 ms per action on a small page, 0.3-0.5 s on a large one",
    ),
  secret: () =>
    new Option(
      "--secret <value|env:VAR>",
      "REDACTION ONLY: a secret/PII value kept out of every model call and artifact (repeatable); env:VAR reads it from the environment (preferred: a literal is visible in the process list and shell history). It is never typed into a field — to log in, bind it with --secret-field (or start from --storage-state)",
    )
      .default([] as string[])
      .argParser(collect),
  secretField: () =>
    new Option(
      "--secret-field <binding>",
      "goal/usability strategy: '<label|testId|type|id|name>=<value>=env:<VAR>' (repeatable), e.g. 'label=Password=env:APP_PASSWORD'. When the run types into a matching field, code types $VAR itself; the model sees only «secret:VAR» and the Recording {redacted:true}. " +
        "A value delivered during the run (an emailed code): '<descriptor>=cmd:<command>' runs the command when the field is typed and types its stdout (needs --allow-secret-cmd)",
    )
      .default([] as string[])
      .argParser(collect),
  totp: () =>
    new Option(
      "--totp <binding>",
      "goal/usability strategy: '<descriptor>=env:<VAR>' with $VAR a base32 TOTP seed (repeatable), e.g. 'label=Authentication code=env:APP_TOTP_SEED'. The 6-digit code is computed locally (RFC 6238) when the field is typed; the seed never reaches a model or disk",
    )
      .default([] as string[])
      .argParser(collect),
  typeFixture: () =>
    new Option(
      "--type-fixture <binding>",
      "goal strategy: '<label|testId|type|id|name>=<value>=<file>' (repeatable), e.g. 'label=Paste your text=./fixtures/import.txt'. When the run types into a matching field, code types the file's exact text verbatim (line breaks kept, never paraphrased or capped); the model sees only «fixture:<file name>». Recorded as typed unless it holds a --secret",
    )
      .default([] as string[])
      .argParser(collect),
  fixture: () => new Option("--fixture <path>", "local file the upload op attaches to a file input (goal and usability strategies); must exist"),
  saveStorageState: () =>
    new Option(
      "--save-storage-state <file>",
      "write the context's storageState (cookies + origin storage) here when the run ends; mode 0600, contents never logged. " +
        "Useful with a rotating refresh token: --storage-state's file goes stale after one authenticated run refreshes it, " +
        "so point --save-storage-state at the SAME file (or a new one) to keep it usable for the next run. " +
        "Written on every exit path -- a crash or a SIGTERM/SIGINT kill included (#159), not only a clean end -- but " +
        "never over a good file with a session that already looks lost/logged-out; the last known-good state is used " +
        "instead, or nothing is written if none was ever captured.",
    ),
  replyWaitMs: () =>
    new Option(
      "--reply-wait-ms <ms>",
      "conversational pages: how long to keep waiting for a reply while the page shows no sign of working on one " +
        "(goal and usability; default 60000). While a request the message started is in flight, a busy indicator shows, " +
        "or the reply is still growing, the wait continues up to --reply-ceiling-ms",
    ).argParser(positiveIntArg),
  replyQuietMs: () =>
    new Option(
      "--reply-quiet-ms <ms>",
      "conversational pages: how long a reply must hold still (no new text, no busy sign) before it is read as complete " +
        "(goal and usability; default 1000). Raise it for an assistant that answers in several parts (a sentence, then a card a moment later)",
    ).argParser(positiveIntArg),
  replyCeilingMs: () =>
    new Option(
      "--reply-ceiling-ms <ms>",
      "conversational pages: hard ceiling on the TOTAL wait for one sent message's reply — the send's own wait plus every later 'wait' — " +
        "however busy the page stays; once spent the run ends naming the missing reply (default 180000; never below --reply-wait-ms) (default 180000; never below --reply-wait-ms)",
    ).argParser(positiveIntArg),
  replyMaxChars: () =>
    new Option("--reply-max-chars <n>", "conversational pages: cap on each generated chat message (goal and usability; default 300)").argParser(
      intArg({ min: 20, max: 2000 }),
    ),
  jobWaitMs: () =>
    new Option(
      "--job-wait-ms <ms>",
      "goal and usability: while the page shows an in-progress status (\"Simulating…\", aria-busy, a job \"is running\"), " +
        "waits keep waiting with backoff — and a model 'blocked' is deferred — up to this budget (default: --reply-ceiling-ms, 180000); " +
        "it also bounds a busy indicator the app visibly keeps working behind (live progress, a job poll) before it is a hang, " +
        "and a wait the page documents (\"usually takes a minute\") can raise it",
    ).argParser(positiveIntArg),
  deny: () =>
    new Option(
      "--deny <pattern>",
      "a control no mission may click (repeatable): an accessible-name regex (/Archive/i or Archive) or a descriptor role=button;name=Archive. " +
        "Session-ending (Sign out), destructive (Delete, Revoke, Rotate) and paid (Buy, Run simulation, Generate, Send invite) controls are refused by default",
    )
      .default([] as string[])
      .argParser(collect),
  paid: () =>
    new Option(
      "--paid <pattern>",
      "an app control that costs money or credits (repeatable; same syntax as --deny), e.g. /^(Analyze|Draft|Improve)\\b/i: treated like the built-in paid " +
        "vocabulary — the budget guard sees it, hang replays never repeat it, and a goal that asks for it may still click it",
    )
      .default([] as string[])
      .argParser(collect),
  allowDestructive: () =>
    new Option(
      "--allow-destructive",
      "let missions click session-ending, destructive and paid controls (a --deny pattern still holds). A goal run already may click one its goal asks for",
    ),
  dialogs: () =>
    new Option(
      "--dialogs <policy>",
      "native window.confirm/prompt dialogs: dismiss (default) or accept. accept still dismisses one whose message names a session-ending, " +
        "destructive or paid action the run may not take (without --allow-destructive or a goal asking for it); every dialog is logged",
    ),
  readRpc: () =>
    new Option(
      "--read-rpc <glob>",
      "a POST request that only READS (repeatable): an RPC-method glob (Estimate*, pkg.Service/Preview*) or a path glob (/api/search*). " +
        "gRPC-web/Connect Get*/List*/Search*/Find*/Watch*/Stream*/Count*/Describe*/Read* methods are reads already. Reads are never guarded or reported as duplicate writes",
    )
      .default([] as string[])
      .argParser(collect),
  hangReplays: () =>
    new Option("--hang-replays <n>", "fresh-context replays that confirm a hang (default 2; 0 = don't replay, the hang is reported unconfirmed)").argParser(
      nonNegativeIntArg,
    ),
  settleIgnore: () =>
    new Option("--settle-ignore <pattern>", "a request URL pattern the target marks as background (never pending work; repeatable, * wildcard)")
      .default([] as string[])
      .argParser(collect),
  longPollMs: () =>
    new Option("--long-poll-ms <n>", "a request pending this long on an interactive page is a long-poll (default 5000)").argParser(nonNegativeIntArg),
  apiPrefix: () =>
    new Option("--api-prefix <path>", "a path prefix whose requests are the app's API in the timing summary (repeatable), e.g. /api/")
      .default([] as string[])
      .argParser(collect),
  ignoreNoProgress: () =>
    new Option("--ignore-no-progress <pattern>", "a route / action label / busy indicator where ui-no-progress is expected (repeatable, * wildcard)")
      .default([] as string[])
      .argParser(collect),
  allowSecretCmd: () =>
    new Option(
      "--allow-secret-cmd",
      "opt-in: a --secret-field <descriptor>=cmd:<command> may run its command (in a shell, at type time, 60s timeout) and type its output (operator-declared only; refused otherwise)",
    ).default(false),
  secretCmdAttempts: () =>
    new Option(
      "--secret-cmd-attempts <n>",
      "#359: how many times one cmd: secret field's command may run in this run (default 3); past it, typing that field fails without running the command again (read-the-code commands usually have side effects)",
    ).argParser(positiveIntArg),
} as const;

export type GoalRunOptionName = keyof typeof GOAL_RUN_OPTIONS;

/** The flags (commander-parsed) the resolvers below read. */
export interface GoalRunFlags extends EmulationFlags, ScreenshotsFlags {
  successWhen?: string;
  allowVacuousChecks?: boolean;
  actionDeltas?: boolean;
  secret: string[];
  secretField: string[];
  totp: string[];
  allowSecretCmd?: boolean;
  secretCmdAttempts?: number;
  typeFixture: string[];
  fixture?: string;
  saveStorageState?: string;
  replyWaitMs?: string | number;
  replyQuietMs?: string | number;
  replyCeilingMs?: string | number;
  replyMaxChars?: string | number;
  jobWaitMs?: string | number;
  deny: string[];
  paid: string[];
  allowDestructive?: boolean;
  dialogs?: string;
  readRpc: string[];
  hangReplays?: number;
  settleIgnore: string[];
  longPollMs?: string | number;
  apiPrefix: string[];
  ignoreNoProgress: string[];
  allowWrites?: boolean;
  allowWrite?: string[];
  hangReplayWrites?: boolean;
}

/** A goal-run flag the command must refuse (exit 64): `code` + the user-facing message. */
export class GoalRunFlagError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "GoalRunFlagError";
  }
}

/** A refusal keeps its own code when it has a typed one (a session file in the project, a bad targets.json); the rest are E_EXPLORE_ARGS. */
const asError = (err: unknown): GoalRunFlagError =>
  err instanceof GoalRunFlagError
    ? err
    : new GoalRunFlagError(
        err instanceof SessionFileInProjectError || err instanceof TargetConfigError ? err.code : "E_EXPLORE_ARGS",
        err instanceof Error ? err.message : String(err),
      );

/** `--dialogs`: a mistyped value never silently means "dismiss" (#334). */
export function dialogsFromFlags(o: Pick<GoalRunFlags, "dialogs">): DialogPolicy | undefined {
  if (o.dialogs === undefined) return undefined;
  if (o.dialogs !== "dismiss" && o.dialogs !== "accept") {
    throw new GoalRunFlagError("E_EXPLORE_ARGS", `--dialogs must be dismiss or accept, got ${JSON.stringify(o.dialogs)}`);
  }
  return o.dialogs;
}

/** `--success-when`: final | held | each. */
export function successWhenFromFlags(o: Pick<GoalRunFlags, "successWhen">): SuccessWhen | undefined {
  if (o.successWhen === undefined) return undefined;
  if (o.successWhen !== "held" && o.successWhen !== "final" && o.successWhen !== "each") {
    throw new GoalRunFlagError("E_EXPLORE_ARGS", `--success-when must be "final", "held" or "each", got ${JSON.stringify(o.successWhen)}`);
  }
  return o.successWhen;
}

/** The conversational-page tuning (`--reply-*`, `--job-wait-ms`), validated. */
export function conversationFromFlags(o: Pick<GoalRunFlags, "replyWaitMs" | "replyQuietMs" | "replyCeilingMs" | "replyMaxChars" | "jobWaitMs">): ConversationOptions {
  const conversation = {
    ...(o.replyWaitMs === undefined ? {} : { replyWaitMs: Number(o.replyWaitMs) }),
    ...(o.replyQuietMs === undefined ? {} : { replyQuietMs: Number(o.replyQuietMs) }),
    ...(o.replyCeilingMs === undefined ? {} : { replyCeilingMs: Number(o.replyCeilingMs) }),
    ...(o.replyMaxChars === undefined ? {} : { replyMaxChars: Number(o.replyMaxChars) }),
    ...(o.jobWaitMs === undefined ? {} : { jobWaitMs: Number(o.jobWaitMs) }),
  };
  if (
    (conversation.replyWaitMs !== undefined && !(Number.isInteger(conversation.replyWaitMs) && conversation.replyWaitMs > 0)) ||
    (conversation.replyCeilingMs !== undefined && !(Number.isInteger(conversation.replyCeilingMs) && conversation.replyCeilingMs > 0)) ||
    (conversation.replyMaxChars !== undefined &&
      !(Number.isInteger(conversation.replyMaxChars) && conversation.replyMaxChars >= 20 && conversation.replyMaxChars <= 2000))
  ) {
    throw new GoalRunFlagError("E_EXPLORE_ARGS", "--reply-wait-ms and --reply-ceiling-ms must be positive integers; --reply-max-chars an integer in 20..2000");
  }
  if (conversation.jobWaitMs !== undefined && !(Number.isInteger(conversation.jobWaitMs) && conversation.jobWaitMs > 0)) {
    throw new GoalRunFlagError("E_EXPLORE_ARGS", "--job-wait-ms must be a positive integer");
  }
  return conversation;
}

/** `--secret-field` / `--totp` bindings, resolved from the environment (#72; `cmd:` needs `--allow-secret-cmd`, #324). */
export function secretFieldsFromFlags(
  o: Pick<GoalRunFlags, "secretField" | "totp" | "allowSecretCmd">,
  env: Readonly<Record<string, string | undefined>> = process.env,
): SecretField[] {
  try {
    return [
      ...o.secretField.map((s) => parseSecretField(s, "value", env, { allowCmd: o.allowSecretCmd === true })),
      ...o.totp.map((s) => parseSecretField(s, "totp", env)),
    ];
  } catch (err) {
    throw asError(err);
  }
}

/** The `targets.json` flag overlay (patterns added, numbers and opt-ins winning). */
export function targetFlagsFromFlags(o: Partial<GoalRunFlags>, dialogs: DialogPolicy | undefined): TargetFlags {
  return {
    settleIgnore: o.settleIgnore ?? [],
    ignoreNoProgress: o.ignoreNoProgress ?? [],
    apiPrefixes: o.apiPrefix ?? [],
    deny: o.deny ?? [],
    paid: o.paid ?? [],
    readRpc: o.readRpc ?? [],
    ...(o.allowDestructive === true ? { allowDestructive: true } : {}),
    ...(dialogs === undefined ? {} : { dialogs }),
    ...(o.allowWrites === true ? { allowWrites: true } : {}),
    allowWrite: o.allowWrite ?? [],
    ...(o.hangReplayWrites === true ? { hangReplayWrites: true } : {}),
    ...(o.longPollMs === undefined ? {} : { longPollMs: Number(o.longPollMs) }),
  };
}

/** Everything a goal run takes from these flags (the `runExploration` options of the same names). */
export interface GoalRunShaping {
  readonly successWhen?: SuccessWhen;
  readonly allowVacuousChecks?: boolean;
  readonly actionDeltas?: boolean;
  readonly secrets?: readonly string[];
  readonly secretFields?: readonly SecretField[];
  readonly secretCommand?: SecretCommandRunner;
  readonly secretCommandAttempts?: number;
  readonly typeFixtures?: readonly TypeFixture[];
  readonly fixture?: string;
  readonly saveStorageState?: string;
  readonly screenshots?: ScreenshotsSpec;
  readonly emulation?: EmulationSpec;
  readonly target?: TargetConfig;
  readonly hangReplays?: number;
  readonly conversation?: ConversationOptions;
}

export interface ResolveGoalRunDeps {
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly targetsConfigPath?: string;
  /** Where a literal `--secret`'s warning goes (stderr). */
  readonly warn?: (text: string) => void;
}

/**
 * Validates and resolves every shared goal-run flag — before any browser opens — into the goal
 * run's options. Throws `GoalRunFlagError` (exit 64) on the first unusable one.
 */
export function resolveGoalRunFlags(o: GoalRunFlags, url: string, deps: ResolveGoalRunDeps = {}): GoalRunShaping {
  const env = deps.env ?? process.env;
  try {
    const dialogs = dialogsFromFlags(o);
    const successWhen = successWhenFromFlags(o);
    if (o.saveStorageState !== undefined) assertSessionFileOutsideProject(o.saveStorageState, "--save-storage-state");
    const resolved = resolveSecretArgs(o.secret, env, "--secret");
    if (resolved.literals > 0) deps.warn?.(LITERAL_SECRET_WARNING);
    const screenshots = parseScreenshotsArg(o.screenshots);
    const conversation = conversationFromFlags(o);
    validateDenyPatterns(o.deny);
    validateDenyPatterns(o.paid, "--paid");
    const emulation = emulationFromFlags(o);
    const secretFields = secretFieldsFromFlags(o, env);
    const typeFixtures = o.typeFixture.length === 0 ? [] : loadTypeFixtures(o.typeFixture);
    let target: TargetConfig | undefined;
    try {
      target = resolveTargetConfig(loadTargetsFile(deps.targetsConfigPath), new URL(url).origin, targetFlagsFromFlags(o, dialogs));
    } catch (err) {
      // An unparseable URL is refused by the authorized-target guard.
      if (!(err instanceof TypeError)) throw err;
    }
    return {
      ...(successWhen === undefined ? {} : { successWhen }),
      ...(o.allowVacuousChecks === true ? { allowVacuousChecks: true } : {}),
      ...(o.actionDeltas === true ? { actionDeltas: true } : {}),
      ...(resolved.secrets.length === 0 ? {} : { secrets: resolved.secrets }),
      ...(secretFields.length === 0 ? {} : { secretFields }),
      ...(secretFields.some((f) => f.kind === "cmd") ? { secretCommand: secretCommandRunner() } : {}),
      ...(o.secretCmdAttempts === undefined ? {} : { secretCommandAttempts: o.secretCmdAttempts }),
      ...(typeFixtures.length === 0 ? {} : { typeFixtures }),
      ...(o.fixture === undefined ? {} : { fixture: o.fixture }),
      ...(o.saveStorageState === undefined ? {} : { saveStorageState: o.saveStorageState }),
      ...(screenshots === undefined ? {} : { screenshots }),
      ...(emulation === undefined ? {} : { emulation }),
      ...(target === undefined ? {} : { target }),
      ...(o.hangReplays === undefined ? {} : { hangReplays: o.hangReplays }),
      ...(Object.keys(conversation).length === 0 ? {} : { conversation }),
    };
  } catch (err) {
    throw asError(err);
  }
}
