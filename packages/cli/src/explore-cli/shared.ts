import { type InvariantSpec } from "@jevitate/recording";
import { type SecretField, type TypeFixture } from "@jevitate/explore";
import { secretCommandRunner } from "../secret-command.js";
import { type JsonEnvelope } from "../envelope.js";
import { type ScreenshotsSpec } from "../run-screenshots.js";
import { type TargetConfig } from "../target-config.js";
import { type FixtureFlags } from "../fixture-cli.js";
import type { FilingConfig, IssueFilerPort } from "@jevitate/domain";
import { nonNegativeIntArg } from "../cli-args.js";
import { type ServerLogOptions } from "../explore-api.js";
import { type MissionActors } from "../mission-actors.js";
import { type EmulationSpec } from "@jevitate/playwright";
import { type CliDeps, type BrowserLaunchFlags, type DemoFlags, type ScreenshotsFlags, browserRunFromFlags, type EmulationFlags } from "../cli-shared.js";
import { type EnvironmentFlags } from "../environments.js";
import { resolveJourneyPrefix, type JourneyPrefix } from "../journey-prefix.js";
import type { ConversationOptions } from "../conversation-options.js";

/** #427: the app root of a start URL bound from --fixtures (`<origin>${setup.x}`), or undefined without an origin. */
export function fixtureBoundUrlRoot(url: string): string | undefined {
  try {
    return `${new URL(url.slice(0, url.indexOf("${"))).origin}/`;
  } catch {
    return undefined;
  }
}

/** #427: how long the pre-flight auth check (and a refresh's sign-in) may take to load a page. */
export const AUTH_PREFLIGHT_TIMEOUT_MS = 30_000;

/**
 * #293: the flags a sweep sets on each of its missions itself (the rest of the command line is
 * forwarded to every mission as given).
 */
export const SWEEP_OWNED: ReadonlySet<string> = new Set([
  "fromJourney", "atStep", "strategy", "journeysDir", "param", "env", "baseUrl", "storageState", "maxActions", "maxDecisions",
  "goal", "success", "appClass", "real", "fakeAi", "fixtures", "before", "after", "allowShellHooks", "hookTimeoutMs",
]);

/**
 * Registers `jevitate explore` (every strategy: goal, coverage, exploratory, adversarial, usability, feature, multi-run).
 * `buildProgram` builds a fresh program for each run of a multi-run (#141/#143).
/** The parsed `jevitate explore` options (commander's `this.opts()`). */
export type ExploreOpts = {
    invariants: string[];
    logSource: string[];
    logTriage?: boolean;
    allowLogCmd?: boolean;
    logDefect: string[];
    logQuietOk: string[];
    logIgnore: string[];
    logScope: string[];
    logCorrelationHeader: string[];
    logIdPattern: string[];
    serverLogDrainMs?: string;
    actor: string[];
    repeat?: string;
    minAgreement?: string;
    persona: string[];
    personas?: string;
    minControlCoverage?: string;
    requireFormSubmit: boolean;
    fileIssues?: boolean;
    issueRepo?: string;
    /** Parsed by commander's `nonNegativeIntArg` (#275: a number, not a string). */
    hangReplays?: number;
    settleIgnore: string[];
    apiPrefix: string[];
    longPollMs?: string;
    ignoreNoProgress: string[];
    jevitateRepo?: string;
    url?: string;
    strategy?: string;
    goal?: string;
    appClass?: string;
    minConfidence?: string;
    maxFindingsPerPage?: string;
    show?: string;
    product?: string;
    polish?: boolean;
    probeGuards?: boolean;
    success: string[];
    successWhen?: string;
    allowVacuousChecks?: boolean;
    actionDeltas?: boolean;
    feature?: string;
    route: string[];
    scope?: string;
    allow: string[];
    secret: string[];
    secretField: string[];
    totp: string[];
    allowSecretCmd?: boolean;
    secretCmdAttempts?: number;
    typeFixture: string[];
    fixture?: string;
    storageState?: string;
    authCheck?: string;
    saveStorageState?: string;
    maxActions?: string;
    maxDecisions?: string;
    minActions?: number;
    minDistinctStates?: number;
    stallTimeout?: string | number;
    replyWaitMs?: string;
    replyQuietMs?: string;
    replyCeilingMs?: string;
    replyMaxChars?: string;
    jobWaitMs?: string;
    deny: string[];
    paid: string[];
    allowControl?: string[];
    allowDestructive?: boolean;
    dialogs?: string;
    allowWrites?: boolean;
    allowWrite: string[];
    hangReplayWrites?: boolean;
    readRpc: string[];
    real?: boolean;
    fakeAi?: boolean;
    jevProvider?: string;
    out?: string;
    checkOverflow?: boolean;
    ignoreOverflow: string[];
    json?: boolean;
    evidenceVideo?: boolean;
    fromJourney?: string;
    atStep?: string;
    param: Record<string, string>;
    journeysDir?: string;
  } & BrowserLaunchFlags & DemoFlags & FixtureFlags & EmulationFlags & ScreenshotsFlags & EnvironmentFlags;

/** What the pre-flight part of the action resolved and every strategy runner needs. */
export interface ExploreRunContext<S extends string = string> {
  deps: CliDeps;
  o: ExploreOpts;
  emitExplore: (envelope: JsonEnvelope<unknown>, exitCode?: number, human?: (data: unknown) => string) => void;
  strategy: S;
  target: TargetConfig | undefined;
  browser: ReturnType<typeof browserRunFromFlags>;
  screenshotsOpt: { screenshots?: ScreenshotsSpec; evidenceVideo?: boolean };
  emulation: EmulationSpec | undefined;
  overflow: { checkOverflow: boolean; ignoreSelectors: string[] };
  withInvariants: { invariants?: InvariantSpec; invariantAuthTokens?: Map<string, string> };
  serverLog: ServerLogOptions | undefined;
  withServerLog: { serverLog?: ServerLogOptions };
  withPrefix: { journeyPrefix?: JourneyPrefix };
  emitJourneyFailure: (err: unknown) => boolean;
  withEvidence: <R extends object>(result: R) => Promise<R>;
  runFiling: FilingConfig | undefined;
  issueFiler: (() => IssueFilerPort) | undefined;
  conversation: ConversationOptions;
  secretFields: SecretField[];
  secretCommand: ReturnType<typeof secretCommandRunner> | undefined;
  actors: MissionActors | null;
  primaryStorageState: string | undefined;
  invariants: InvariantSpec | undefined;
  journeyPrefix: JourneyPrefix | undefined;
  prefixRequest: Parameters<typeof resolveJourneyPrefix>[0] | undefined;
  typeFixtures: TypeFixture[];
}
