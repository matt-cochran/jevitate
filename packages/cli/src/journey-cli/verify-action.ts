// verify-action.ts — the `journey verify` action handler, split into named phase helpers.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { HttpCheckOffAllowlistError } from "../http-probe.js";
import type { Command } from "commander";
import { clock } from "@jevitate/domain";
import { ParamValidationError, secretParamValues, type Journey } from "@jevitate/journey";
import { ok, fail } from "../envelope.js";
import { SiteGateRefusedError } from "@jevitate/runtime";
import { UnknownJourneyError, JourneyRequiresAuthError } from "../journey-api.js";
import { ExtensionMismatchError } from "../browser-run-options.js";
import { withSiteGate } from "../site-gate-cli.js";
import { secretFieldErrorOf, warnSecretParamsOnArgv, withBoundSecretParams, withCommandSecretParams, type BoundSecretParams } from "../secret-params.js";
import { buildMissionFixtures, checkSetupRefs, type FixtureFlags } from "../fixture-cli.js";
import { FixtureSetupError, FixtureSpecError, UnboundSetupRefError } from "../mission-fixtures.js";
import { withRecordedFixtures, fixtureDriftFor, type FixtureDrift } from "../journey-fixtures.js";
import { currentBuildTree, currentEngineInfo, withEngine } from "../engine.js";
import { JourneyVerifyStalledError, loadJourneyToVerify, planJourneyVerification, proofInactivityMs, verifyAssertionLine, verifyExitCode, verifyJourneyMutations, verifyNoResetLine, type JourneyVerifyReport } from "../journey-verify.js";
import { JourneyVerifyResumeRefusedError, browserBindingOf, checkpointKeyPath, hookBindingOf, readVerifyProgress, verifyCheckpointPath, verifyProgressLine } from "../journey-verify-checkpoint.js";
import { ProofHoldRefusedError } from "../journey-run-hooks.js";
import { VerifyReceiptPreflightError } from "../journey-review-store.js";
import { EXIT_CODES } from "../exit-codes.js";
import { artifactStamp } from "../mission-journal.js";
import { homeDataRoot, logsDirFor } from "../project-dir.js";
import { writeVerifyEvidence } from "../journey-verify-evidence-file.js";
import { registerTerminalResult, type TerminalResultDeps, type TerminalResultHandle } from "../terminal-result.js";
import { environmentFromFlags, fixtureRebaseUrl, isEnvironmentError, replayAllowFromFlags, type EnvironmentFlags, type ResolvedJourneyEnvironment } from "../environments.js";
import {
  type CliDeps,
  resolveDbPath,
  type BrowserLaunchFlags,
  browserRunFromFlags,
  type DemoFlags,
  type EmulationFlags,
  emulationFromFlags,
  emitJson,
  commandSecretSeams,
  environmentSeams,
} from "../cli-shared.js";
import { journeyTargetSafety } from "../journey-target-policy.js";
import { flaggedCatalogDir, journeyLayout, targetsOpts } from "./shared.js";
import { TargetConfigError } from "../target-config.js";
import { appVersionFlagProblem, envAppVersion } from "../app-version.js";
import { resolveCatalogDir } from "../catalog-api.js";
import { loadProjectConfig, ProjectConfigError } from "../project-config.js";
import { normalizeMutationProofPolicy, type MutationProofPolicyMode } from "../mutation-proof-policy.js";

/** Test seams: the replay `verifyJourneyMutations` runs, and the terminal layer's process. */
export interface JourneyVerifySeams {
  readonly run?: Parameters<typeof verifyJourneyMutations>[1];
  readonly terminal?: TerminalResultDeps;
}

/** Whether anything is set to reset the app around a replay: flags, the environment, or the Journey's recorded fixtures. Reads no file and runs no hook. */
function resetDeclared(journey: Journey, flags: FixtureFlags, environment: ResolvedJourneyEnvironment | undefined): boolean {
  return [flags.fixtures, flags.before, flags.after, environment?.fixtures, environment?.hooks?.before, environment?.hooks?.after, journey.metadata.fixtures].some((set) => set !== undefined);
}

/** Everything the proof phase needs, resolved by the earlier phase helpers. */
interface VerifyReplayInputs {
  readonly verifyJourneysDir: string;
  readonly id: string;
  readonly checkpointPath: string;
  readonly resume: boolean;
  readonly param: Record<string, string>;
  readonly environment: ResolvedJourneyEnvironment | undefined;
  readonly browser: ReturnType<typeof browserRunFromFlags>;
  readonly emulation: ReturnType<typeof emulationFromFlags>;
  readonly appVersion: string | undefined;
  readonly proofMode: MutationProofPolicyMode;
  readonly storageState: string | undefined;
  readonly fixtureFlags: FixtureFlags;
  readonly runParams: Record<string, string>;
  readonly bound: BoundSecretParams | undefined;
  readonly allow: string[];
  readonly json: boolean;
}

/** `--status`: read the durable progress receipt and print it (JSON or one line); runs nothing. */
function readVerifyStatus(program: Command, id: string, checkpointPath: string, json: boolean, plan: boolean, resume: boolean): void {
  // `--mutate --status` reads as well as `--status`: it names the proof being asked about, and runs none.
  if (plan === true || resume === true) {
    emitJson(program, fail("E_JOURNEY_VERIFY_ARGS", "journey verify --status only reads: it takes neither --plan nor --resume"));
    return;
  }
  const progress = readVerifyProgress(checkpointPath, checkpointKeyPath(), id);
  if (json) emitJson(program, ok(withEngine(progress)));
  else program.configureOutput().writeOut?.(verifyProgressLine(progress));
}

/** Parses the launch and emulation flags; undefined means a refusal was already emitted. */
function resolveVerifyBrowserEmulation(self: Command, deps: CliDeps, emulationFlags: EmulationFlags, program: Command): { readonly browser: ReturnType<typeof browserRunFromFlags>; readonly emulation: ReturnType<typeof emulationFromFlags> } | undefined {
  try {
    return {
      browser: browserRunFromFlags(self.opts<BrowserLaunchFlags & DemoFlags>(), deps.explore?.env ?? process.env),
      emulation: emulationFromFlags(emulationFlags),
    };
  } catch (err) {
    emitJson(program, fail("E_JOURNEY_VERIFY_ARGS", err instanceof Error ? err.message : String(err)));
    return undefined;
  }
}

/** `--plan`: preview the exact mutation/assertion pairing without opening a browser. */
async function runVerifyPlanPhase(input: {
  readonly program: Command;
  readonly deps: CliDeps;
  readonly verifyJourneysDir: string;
  readonly id: string;
  readonly param: Record<string, string>;
  readonly browser: ReturnType<typeof browserRunFromFlags>;
  readonly emulation: ReturnType<typeof emulationFromFlags>;
  readonly envName: string | undefined;
  readonly baseUrl: string | undefined;
  readonly fixtureFlags: FixtureFlags;
  readonly json: boolean;
}): Promise<void> {
  const { program, deps, verifyJourneysDir, id, param, browser, emulation, envName, baseUrl, fixtureFlags, json } = input;
  try {
    // #763: the recorded-origin read-request policy `journey review` and the planner share.
    const planned = await loadJourneyToVerify(verifyJourneysDir, id);
    const readRequests = journeyTargetSafety(planned, targetsOpts(deps).targetsFile)?.readRequests;
    const report = await planJourneyVerification({ dir: verifyJourneysDir, id, params: param, ...(readRequests === undefined ? {} : { readRequests }), ...(browser === undefined ? {} : { browser }), ...(emulation === undefined ? {} : { emulation }) });
    const planEnvironment = environmentFromFlags({ ...(envName === undefined ? {} : { env: envName }), ...(baseUrl === undefined ? {} : { baseUrl }) }, environmentSeams(deps));
    const noReset = resetDeclared(planned, fixtureFlags, planEnvironment) ? undefined : verifyNoResetLine(report.summary);
    if (json) emitJson(program, ok(withEngine(noReset === undefined ? report : { ...report, noReset })));
    else {
      const out = program.configureOutput().writeOut;
      for (const mutation of report.mutations) {
        const sites = report.pairs.filter((pair) => pair.mutation === mutation.id).map((pair) => pair.site);
        out?.(`${mutation.id} (step ${mutation.step}) -> ${sites.length === 0 ? "unpaired" : sites.join(", ")}\n`);
      }
      for (const assertion of report.assertions) if (assertion.mutations.length === 0) out?.(`unpaired ${assertion.site} ${assertion.check}\n`);
      for (const { note } of report.isolationNotes ?? []) out?.(`note: ${note}\n`);
      if (noReset !== undefined) out?.(`${noReset}\n`);
      out?.(
        `planned — journey '${report.journeyId}': ${report.summary.mutations} mutations, ${report.summary.pairs} pairs, ${report.summary.assertions} assertions, ${report.summary.unpaired} unpaired, at least ${report.summary.minimumReplays} replays\n`,
      );
    }
  } catch (err) {
    if (err instanceof UnknownJourneyError) emitJson(program, fail("E_UNKNOWN_JOURNEY", String(err.message)));
    else if (err instanceof TargetConfigError) emitJson(program, fail("E_TARGET_CONFIG", err.message));
    else if (isEnvironmentError(err)) emitJson(program, fail(err.code, err.message));
    else throw err;
  }
}

/** Replay allowlist + environment flags; undefined means an environment refusal was emitted. */
function resolveVerifyReplayEnvironment(program: Command, deps: CliDeps, envName: string | undefined, baseUrl: string | undefined, allowFlags: string[]): { readonly allow: string[]; readonly environment: ResolvedJourneyEnvironment | undefined } | undefined {
  try {
    return {
      allow: replayAllowFromFlags(allowFlags),
      environment: environmentFromFlags({ ...(envName === undefined ? {} : { env: envName }), ...(baseUrl === undefined ? {} : { baseUrl }) }, environmentSeams(deps)),
    };
  } catch (err) {
    if (!isEnvironmentError(err)) throw err;
    emitJson(program, fail(err.code, err.message));
    return undefined;
  }
}

/** #827: a secret parameter from the environment (--secret-field, targets.json), off the command line. */
async function resolveVerifyRunParams(input: {
  readonly program: Command;
  readonly deps: CliDeps;
  readonly verifyJourneysDir: string;
  readonly id: string;
  readonly param: Record<string, string>;
  readonly secretField: string[];
  readonly environment: ResolvedJourneyEnvironment | undefined;
  readonly layout: NonNullable<ReturnType<typeof journeyLayout>>;
}): Promise<Awaited<ReturnType<typeof withCommandSecretParams>> | undefined> {
  const { program, deps, verifyJourneysDir, id, param, secretField, environment, layout } = input;
  try {
    return await withCommandSecretParams({ dir: verifyJourneysDir, ids: [id], params: param, flags: secretField, environment, env: deps.explore?.env ?? process.env, seams: commandSecretSeams(deps, verifyJourneysDir, flaggedCatalogDir(layout)) });
  } catch (err) {
    const e = secretFieldErrorOf(err, "E_JOURNEY_VERIFY_ARGS");
    if (e === undefined) throw err;
    emitJson(program, fail(e.code, e.message));
    return undefined;
  }
}

/** M5: the app version the receipt binds; undefined means a refusal was already emitted. */
function resolveVerifyAppVersion(program: Command, deps: CliDeps, appVersionFlag: string | undefined): { readonly appVersion: string | undefined } | undefined {
  const problem = appVersionFlag === undefined ? undefined : appVersionFlagProblem(appVersionFlag);
  if (problem !== undefined) {
    emitJson(program, fail("E_JOURNEY_VERIFY_ARGS", problem));
    return undefined;
  }
  return { appVersion: appVersionFlag ?? envAppVersion(deps.explore?.env ?? process.env, (line) => program.configureOutput().writeErr?.(line)) };
}

/** The Low: the proof policy deciding whether an uncounted sensitive proof exits 0; undefined means a refusal was emitted. */
function resolveVerifyProofMode(program: Command, deps: CliDeps, layout: NonNullable<ReturnType<typeof journeyLayout>>): MutationProofPolicyMode | undefined {
  try {
    return normalizeMutationProofPolicy(loadProjectConfig(resolveCatalogDir(deps.catalogDir, flaggedCatalogDir(layout))).mutationProofPolicy, (line) => program.configureOutput().writeErr?.(line));
  } catch (err) {
    if (!(err instanceof ProjectConfigError)) throw err;
    emitJson(program, fail(err.code, err.message));
    return undefined;
  }
}

/** Prints the proof's report, drift warning and no-reset line (JSON envelope or human lines). */
function reportVerifyOutcome(program: Command, report: JourneyVerifyReport, fixtureDrift: FixtureDrift | undefined, noReset: string | undefined, json: boolean): void {
  if (json) {
    emitJson(program, ok(withEngine({ ...report, ...(fixtureDrift === undefined ? {} : { fixtureDrift }), ...(noReset === undefined ? {} : { noReset }) })));
  } else {
    const out = program.configureOutput().writeOut;
    if (fixtureDrift !== undefined) program.configureOutput().writeErr?.(`warning: ${(fixtureDrift as FixtureDrift).message}\n`);
    for (const a of report.assertions) out?.(`${verifyAssertionLine(a)}\n`);
    if (noReset !== undefined) out?.(`${noReset}\n`);
    if (report.nativeReport !== undefined) program.configureOutput().writeErr?.(`native report: ${report.nativeReport.path} (sha256 ${report.nativeReport.sha256})\n`);
    const s = report.summary;
    const targeted = s.targeted > 0 ? `, ${s.targeted} targeted` : "";
    const reused = report.reusedPairs > 0 ? `, ${report.reusedPairs} pairs reused from a checkpoint` : "";
    out?.(
      `${report.verdict} — journey '${report.journeyId}': ${s.sensitive} sensitive, ${s.insensitive} insensitive, ${s.cascade} cascade, ${s.notApplied} not applied, ${s.error} error, ${s.unpaired} unpaired${targeted}${reused}` +
        `${report.reason === undefined ? "" : ` (${report.reason})`}\n`,
    );
  }
}

/** Maps a thrown proof failure to its envelope and exit code; completes the terminal unless it already failed it. */
function failJourneyVerify(program: Command, err: unknown, terminal: TerminalResultHandle | undefined): void {
  if (err instanceof JourneyVerifyResumeRefusedError) {
    emitJson(program, { ...fail(err.code, err.message), data: { reason: err.reason, exitCode: EXIT_CODES.inconclusive } });
    process.exitCode = EXIT_CODES.inconclusive;
  } else if (err instanceof ProofHoldRefusedError) {
    // 0.30.0 §5.4: a proof never holds; it reached a step only a person can do, and nothing was held.
    emitJson(program, { ...fail(err.code, err.message), data: { outcome: "inconclusive", kind: err.kind, step: err.step, exitCode: EXIT_CODES.inconclusive } });
    process.exitCode = EXIT_CODES.inconclusive;
  } else if (err instanceof JourneyVerifyStalledError) {
    // Only where the terminal layer stays out (an MCP call) does this run: elsewhere it ended the process first.
    emitJson(program, {
      ...fail(err.code, err.message),
      data: { trigger: "watchdog", inactivityMs: err.inactivityMs, progress: err.where, sessionsClosed: err.sessionsClosed, exitCode: EXIT_CODES.inconclusive },
    });
    process.exitCode = EXIT_CODES.inconclusive;
  } else if (err instanceof SiteGateRefusedError || isEnvironmentError(err) || err instanceof HttpCheckOffAllowlistError) {
    emitJson(program, fail(err.code, err.message));
  } else if (err instanceof UnknownJourneyError) {
    emitJson(program, fail("E_UNKNOWN_JOURNEY", String(err.message)));
  } else if (err instanceof TargetConfigError) {
    emitJson(program, fail("E_TARGET_CONFIG", err.message));
  } else if (err instanceof JourneyRequiresAuthError) {
    emitJson(program, fail("E_JOURNEY_REQUIRES_AUTH", String(err.message)));
  } else if (err instanceof ExtensionMismatchError) {
    emitJson(program, fail(err.code, err.message));
  } else if (err instanceof FixtureSpecError || err instanceof UnboundSetupRefError) {
    emitJson(program, fail(err.code, err.message));
  } else if (err instanceof ParamValidationError) {
    emitJson(program, fail("E_INVALID_PARAMS", String(err.message)));
  } else if (err instanceof FixtureSetupError) {
    emitJson(program, fail("E_JOURNEY_VERIFY", `fixture setup failed — nothing verified: ${err.message}`));
  } else if (err instanceof VerifyReceiptPreflightError || terminal === undefined) {
    emitJson(program, fail("E_JOURNEY_VERIFY", String(err instanceof Error ? err.message : err)));
  } else {
    terminal.fail(err);
    return;
  }
  terminal?.complete();
}

/** The proof itself: registers the terminal, runs the paired replays, reports and sets the exit code. */
async function runVerifyProofPhase(program: Command, deps: CliDeps, seams: JourneyVerifySeams, inputs: VerifyReplayInputs): Promise<void> {
  const { verifyJourneysDir, id, checkpointPath, resume, param, environment, browser, emulation, appVersion, proofMode, storageState, fixtureFlags, runParams, bound, allow, json } = inputs;
  let terminal: TerminalResultHandle | undefined;
  try {
    // Before any browser opens: from here on, every way of not finishing still ends with a result.
    const proved = await loadJourneyToVerify(verifyJourneysDir, id);
    const readRequests = journeyTargetSafety(proved, targetsOpts(deps).targetsFile)?.readRequests;
    // The proof's result and its evidence folder share one stem, so retention prunes them together.
    const runStem = `journey-verify-${id.replace(/[^A-Za-z0-9._-]/g, "_")}-${artifactStamp(clock.nowIso())}`;
    const logsDir = logsDirFor();
    terminal = registerTerminalResult(
      {
        command: "journey verify",
        json: json === true,
        secrets: secretParamValues(proved, runParams),
        artifactPath: join(logsDir, `${runStem}.json`),
        inactivityMs: proofInactivityMs(proved),
      },
      seams.terminal,
    );
    const progress = terminal;
    // #544: no --fixtures → the Journey's recorded fixtures (a missing file is refused before any browser).
    const recorded = await withRecordedFixtures(fixtureFlags, { dir: verifyJourneysDir, id });
    let fixtureDrift: FixtureDrift | undefined;
    const report = await withSiteGate(resolveDbPath(deps), (siteGate) => withBoundSecretParams(bound, () =>
      verifyJourneyMutations(
        {
          ...(siteGate === undefined ? {} : { siteGate }),
          dir: verifyJourneysDir,
          id,
          params: runParams,
          onEvidence: (evidence) => {
            const problem = writeVerifyEvidence(join(logsDir, runStem), evidence);
            if (problem !== undefined) program.configureOutput().writeErr?.(`${problem}\n`);
          },
          ...(readRequests === undefined ? {} : { readRequests }),
          ...(appVersion === undefined ? {} : { appVersion }),
          onProgress: ({ replay, mutation }) => progress.progress({ phase: mutation === undefined ? "as recorded" : undefined, replay, mutation }),
          browserPortFactory: deps.explore?.browserPortFactory,
          checkpoint: {
            path: checkpointPath,
            keyFile: checkpointKeyPath(),
            resume: resume === true,
            build: { ...currentEngineInfo(), tree: currentBuildTree() },
            config: {
              hook: hookBindingOf(recorded.flags, environment?.fixtures),
              origin: { readRequests, name: environment?.name, baseUrl: environment?.baseUrl, allowedOrigins: environment?.allowedOrigins, origins: environment?.origins, sourceOrigins: environment?.sourceOrigins, allow },
              browser: browserBindingOf(browser, emulation, storageState, environment?.secretFields),
            },
            onNotice: (text) => program.configureOutput().writeErr?.(`${text}\n`),
          },
          ...(browser === undefined ? {} : { browser }),
          ...(emulation === undefined ? {} : { emulation }),
          ...(storageState !== undefined ? { storageState } : {}),
          ...(environment === undefined ? {} : { environment }),
          ...(allow.length === 0 ? {} : { allow }),
          // Fixtures run around EVERY replay, so each mutation starts from the same state as the base.
          fixtures: (site, allowedOrigins, sourceSite) => {
            // #543: the replay's effective allowlist (#542), so a fixture can reset an allowed outbox.
            fixtureDrift = fixtureDriftFor(recorded.recorded, { allowlist: [...allowedOrigins], baseUrl: site });
            // #561: fixture step URLs on a named secondary origin move with the environment's origins.
            const rebaseUrl = fixtureRebaseUrl(environment, sourceSite);
            const fx = buildMissionFixtures(recorded.flags, {
              allowlist: [...allowedOrigins],
              baseUrl: site,
              ...(rebaseUrl === undefined ? {} : { rebaseUrl }),
              ...(storageState !== undefined ? { storageState } : {}),
              ...(environment?.fixtures === undefined ? {} : { targetFixtures: environment.fixtures }),
            });
            checkSetupRefs({ "--param": Object.values(param) }, fx);
            return fx;
          },
        },
        seams.run,
      )),
    );
    // Proof role (owner 2026-11-09): under require-sensitive only a countsForGate proof counts, so only it exits 0.
    const code = verifyExitCode(report.verdict, { countsForGate: report.countsForGate, mode: proofMode });
    // #818: the report was persisted (or why not) before this output; a failure is never silent.
    if (report.nativeReportError !== undefined) program.configureOutput().writeErr?.(`warning: ${report.nativeReportError}\n`);
    const noReset = resetDeclared(proved, recorded.flags, environment) ? undefined : verifyNoResetLine((await planJourneyVerification({ dir: verifyJourneysDir, id, params: param, ...(readRequests === undefined ? {} : { readRequests }) })).summary);
    reportVerifyOutcome(program, report, fixtureDrift, noReset, json);
    process.exitCode = code;
    terminal.complete();
  } catch (err) {
    failJourneyVerify(program, err, terminal);
  }
}

/**
 * The `journey verify` action body, moved out of `registerJourneyVerify` and split into phase
 * helpers: resolve inputs/flags, build options, execute, report and exit.
 */
export async function runJourneyVerifyAction(this: Command, id: string, program: Command, deps: CliDeps, seams: JourneyVerifySeams = {}): Promise<void> {
  const locationFlags = this.opts<{ dir?: string; project?: string; journeysDir?: string }>();
  const layout = journeyLayout(program, deps, { dir: locationFlags.dir, project: locationFlags.project, journeysDir: locationFlags.journeysDir });
  if (layout === null) return;
  const verifyJourneysDir = layout.journeysDir;
  const { mutate, plan, status, resume, param, secretField, storageState: storageStateFlag, json, env: envName, baseUrl, ...emulationFlags } = this.opts<
    { mutate?: boolean; plan?: boolean; status?: boolean; resume?: boolean; dir?: string; param: Record<string, string>; secretField: string[]; storageState?: string; json?: boolean } & EnvironmentFlags & EmulationFlags
  >();
  const checkpointPath = verifyCheckpointPath(layout.projectDir ?? homeDataRoot(), verifyJourneysDir, id);
  await warnSecretParamsOnArgv(program.configureOutput().writeErr, verifyJourneysDir, [id], param, "journey verify");
  if (status === true) {
    readVerifyStatus(program, id, checkpointPath, json === true, plan === true, resume === true);
    return;
  }
  if ((mutate === true) === (plan === true)) {
    emitJson(program, fail("E_JOURNEY_VERIFY_ARGS", "journey verify needs exactly one of --plan, --mutate or --status"));
    return;
  }
  if (resume === true && mutate !== true) {
    emitJson(program, fail("E_JOURNEY_VERIFY_ARGS", "journey verify --resume continues a proof: it needs --mutate"));
    return;
  }
  // Parsed before the plan as well: the plan reports the native execution identity they bind.
  const parsed = resolveVerifyBrowserEmulation(this, deps, emulationFlags, program);
  if (parsed === undefined) return;
  const { browser, emulation } = parsed;
  const ownFixtureFlags = this.opts<FixtureFlags>();
  if (plan === true) {
    await runVerifyPlanPhase({ program, deps, verifyJourneysDir, id, param, browser, emulation, envName, baseUrl, fixtureFlags: ownFixtureFlags, json: json === true });
    return;
  }
  const env = resolveVerifyReplayEnvironment(program, deps, envName, baseUrl, this.opts<{ allow: string[] }>().allow);
  if (env === undefined) return;
  const { allow, environment } = env;
  const fixtureFlags: FixtureFlags = {
    ...ownFixtureFlags,
    ...(ownFixtureFlags.before === undefined && environment?.hooks?.before !== undefined ? { before: environment.hooks.before } : {}),
    ...(ownFixtureFlags.after === undefined && environment?.hooks?.after !== undefined ? { after: environment.hooks.after } : {}),
  };
  const resolvedParams = await resolveVerifyRunParams({ program, deps, verifyJourneysDir, id, param, secretField, environment, layout });
  if (resolvedParams === undefined) return;
  const appVersionResolved = resolveVerifyAppVersion(program, deps, this.opts<{ appVersion?: string }>().appVersion);
  if (appVersionResolved === undefined) return;
  const proofMode = resolveVerifyProofMode(program, deps, layout);
  if (proofMode === undefined) return;
  const storageState = storageStateFlag ?? environment?.storageState;
  if (storageState !== undefined && !existsSync(storageState)) {
    emitJson(program, fail("E_JOURNEY_VERIFY_ARGS", `storage state not found: ${storageState}`));
    return;
  }
  await runVerifyProofPhase(program, deps, seams, {
    verifyJourneysDir,
    id,
    checkpointPath,
    resume: resume === true,
    param,
    environment,
    browser,
    emulation,
    appVersion: appVersionResolved.appVersion,
    proofMode,
    storageState,
    fixtureFlags,
    runParams: resolvedParams.params,
    bound: resolvedParams.bound,
    allow,
    json: json === true,
  });
}
