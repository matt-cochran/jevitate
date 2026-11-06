import { existsSync } from "node:fs";
import { join } from "node:path";
import { HttpCheckOffAllowlistError } from "../http-probe.js";
import { Command } from "commander";
import { clock } from "@jevitate/domain";
import { ParamValidationError, secretParamValues, type Journey } from "@jevitate/journey";
import { ok, fail } from "../envelope.js";
import { SiteGateRefusedError } from "@jevitate/runtime";
import { UnknownJourneyError, JourneyRequiresAuthError } from "../journey-api.js";
import { ExtensionMismatchError } from "../browser-run-options.js";
import { withSiteGate } from "../site-gate-cli.js";
import { warnSecretParamsOnArgv } from "../secret-params.js";
import { buildMissionFixtures, checkSetupRefs, withFixtureFlags, type FixtureFlags } from "../fixture-cli.js";
import { FixtureSetupError, FixtureSpecError, UnboundSetupRefError } from "../mission-fixtures.js";
import { withRecordedFixtures, fixtureDriftFor, type FixtureDrift } from "../journey-fixtures.js";
import { currentBuildTree, currentEngineInfo, withEngine } from "../engine.js";
import { JourneyVerifyStalledError, loadJourneyToVerify, planJourneyVerification, proofInactivityMs, verifyAssertionLine, verifyExitCode, verifyJourneyMutations, verifyNoResetLine } from "../journey-verify.js";
import { JourneyVerifyResumeRefusedError, browserBindingOf, checkpointKeyPath, hookBindingOf, readVerifyProgress, verifyCheckpointPath, verifyProgressLine } from "../journey-verify-checkpoint.js";
import { VerifyReceiptPreflightError } from "../journey-review-store.js";
import { EXIT_CODES } from "../exit-codes.js";
import { artifactStamp } from "../mission-journal.js";
import { homeDataRoot, logsDirFor } from "../project-dir.js";
import { registerTerminalResult, type TerminalResultDeps, type TerminalResultHandle } from "../terminal-result.js";
import { environmentFromFlags, fixtureRebaseUrl, isEnvironmentError, withEnvironmentFlags, withReplayAllowFlag, replayAllowFromFlags, type EnvironmentFlags, type ResolvedJourneyEnvironment } from "../environments.js";
import {
  type CliDeps,
  resolveDbPath,
  type BrowserLaunchFlags,
  withBrowserLaunchFlags,
  browserRunFromFlags,
  type DemoFlags,
  type EmulationFlags,
  withEmulationFlags,
  emulationFromFlags,
  collectParam,
  emitJson,
  environmentSeams,
} from "../cli-shared.js";
import { withProjectFlags } from "../project-layout.js";
import { TargetConfigError } from "../target-config.js";
import { journeyTargetSafety } from "../journey-target-policy.js";
import { DEPRECATED_DIR_HELP, journeyLayout, targetsOpts } from "./shared.js";

/** Test seams: the replay `verifyJourneyMutations` runs, and the terminal layer's process. */
export interface JourneyVerifySeams {
  readonly run?: Parameters<typeof verifyJourneyMutations>[1];
  readonly terminal?: TerminalResultDeps;
}

/** Whether anything is set to reset the app around a replay: flags, the environment, or the Journey's recorded fixtures. Reads no file and runs no hook. */
function resetDeclared(journey: Journey, flags: FixtureFlags, environment: ResolvedJourneyEnvironment | undefined): boolean {
  return [flags.fixtures, flags.before, flags.after, environment?.fixtures, environment?.hooks?.before, environment?.hooks?.after, journey.metadata.fixtures].some((set) => set !== undefined);
}

/** Registers `jevitate journey verify`. */
export function registerJourneyVerify(journey: Command, program: Command, deps: CliDeps, seams: JourneyVerifySeams = {}): void {
  // #402 — the negative proof: replay the Journey once as recorded, then once per mutation (skip a
  // write step, abort its writes, type an empty value into a checked fill); each assertion must fail
  // under its paired mutation. `--plan` previews that exact pairing without opening a browser.
  withReplayAllowFlag(withEnvironmentFlags(withBrowserLaunchFlags(withEmulationFlags(withFixtureFlags(withProjectFlags(journey.command("verify <id>")))))))
    .description("preview or prove that each Journey assertion fails when its outcome is absent")
    .option("--mutate", "run the mutation proof")
    .option("--plan", "print the static mutation/assertion plan without opening a browser")
    .option("--status", "read a proof's durable progress and whether its verifier is live, exited or stale; no browser, no hook, nothing of the app's")
    .option("--resume", "with --mutate: continue an interrupted proof of the same Journey and configuration, or one that ended inconclusive on errored replays, reusing finished pairs after the base replay passes again and running errored pairs again; any mismatch, a damaged or over-24h checkpoint, or a live verifier is refused and never starts over")
    .option("--dir <path>", DEPRECATED_DIR_HELP)
    .option("--param <kv>", "param as key=value (repeatable)", collectParam, {} as Record<string, string>)
    .option("--storage-state <file>", "Playwright storageState JSON to start each replay authenticated (as journey run)")
    .option("--json", "emit a JSON envelope")
    .action(async function (this: Command, id: string) {
      const locationFlags = this.opts<{ dir?: string; project?: string; journeysDir?: string }>();
      const layout = journeyLayout(program, deps, { dir: locationFlags.dir, project: locationFlags.project, journeysDir: locationFlags.journeysDir });
      if (layout === null) return;
      const verifyJourneysDir = layout.journeysDir;
      const { mutate, plan, status, resume, param, storageState: storageStateFlag, json, env: envName, baseUrl, ...emulationFlags } = this.opts<
        { mutate?: boolean; plan?: boolean; status?: boolean; resume?: boolean; dir?: string; param: Record<string, string>; storageState?: string; json?: boolean } & EnvironmentFlags & EmulationFlags
      >();
      const checkpointPath = verifyCheckpointPath(layout.projectDir ?? homeDataRoot(), verifyJourneysDir, id);
      await warnSecretParamsOnArgv(program.configureOutput().writeErr, verifyJourneysDir, [id], param);
      if (status === true) {
        // `--mutate --status` reads as well as `--status`: it names the proof being asked about, and runs none.
        if (plan === true || resume === true) {
          emitJson(program, fail("E_JOURNEY_VERIFY_ARGS", "journey verify --status only reads: it takes neither --plan nor --resume"));
          return;
        }
        const progress = readVerifyProgress(checkpointPath, checkpointKeyPath(), id);
        if (json) emitJson(program, ok(withEngine(progress)));
        else program.configureOutput().writeOut?.(verifyProgressLine(progress));
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
      if (plan === true) {
        try {
          // #763: the recorded-origin read-request policy `journey review` and the planner share.
          const planned = await loadJourneyToVerify(verifyJourneysDir, id);
          const readRequests = journeyTargetSafety(planned, targetsOpts(deps).targetsFile)?.readRequests;
          const report = await planJourneyVerification({ dir: verifyJourneysDir, id, params: param, ...(readRequests === undefined ? {} : { readRequests }) });
          const planEnvironment = environmentFromFlags({ ...(envName === undefined ? {} : { env: envName }), ...(baseUrl === undefined ? {} : { baseUrl }) }, environmentSeams(deps));
          const noReset = resetDeclared(planned, this.opts<FixtureFlags>(), planEnvironment) ? undefined : verifyNoResetLine(report.summary);
          if (json) emitJson(program, ok(withEngine(noReset === undefined ? report : { ...report, noReset })));
          else {
            const out = program.configureOutput().writeOut;
            for (const mutation of report.mutations) {
              const sites = report.pairs.filter((pair) => pair.mutation === mutation.id).map((pair) => pair.site);
              out?.(`${mutation.id} (step ${mutation.step}) -> ${sites.length === 0 ? "unpaired" : sites.join(", ")}\n`);
            }
            for (const assertion of report.assertions) if (assertion.mutations.length === 0) out?.(`unpaired ${assertion.site} ${assertion.check}\n`);
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
        return;
      }
      let environment: ResolvedJourneyEnvironment | undefined;
      let allow: string[];
      try {
        allow = replayAllowFromFlags(this.opts<{ allow: string[] }>().allow);
        environment = environmentFromFlags({ ...(envName === undefined ? {} : { env: envName }), ...(baseUrl === undefined ? {} : { baseUrl }) }, environmentSeams(deps));
      } catch (err) {
        if (!isEnvironmentError(err)) throw err;
        emitJson(program, fail(err.code, err.message));
        return;
      }
      const ownFixtureFlags = this.opts<FixtureFlags>();
      const fixtureFlags: FixtureFlags = {
        ...ownFixtureFlags,
        ...(ownFixtureFlags.before === undefined && environment?.hooks?.before !== undefined ? { before: environment.hooks.before } : {}),
        ...(ownFixtureFlags.after === undefined && environment?.hooks?.after !== undefined ? { after: environment.hooks.after } : {}),
      };
      const storageState = storageStateFlag ?? environment?.storageState;
      if (storageState !== undefined && !existsSync(storageState)) {
        emitJson(program, fail("E_JOURNEY_VERIFY_ARGS", `storage state not found: ${storageState}`));
        return;
      }
      let browser: ReturnType<typeof browserRunFromFlags>;
      let emulation: ReturnType<typeof emulationFromFlags>;
      try {
        browser = browserRunFromFlags(this.opts<BrowserLaunchFlags & DemoFlags>(), deps.explore?.env ?? process.env);
        emulation = emulationFromFlags(emulationFlags);
      } catch (err) {
        emitJson(program, fail("E_JOURNEY_VERIFY_ARGS", err instanceof Error ? err.message : String(err)));
        return;
      }
      let terminal: TerminalResultHandle | undefined;
      try {
        // Before any browser opens: from here on, every way of not finishing still ends with a result.
        const proved = await loadJourneyToVerify(verifyJourneysDir, id);
        const readRequests = journeyTargetSafety(proved, targetsOpts(deps).targetsFile)?.readRequests;
        terminal = registerTerminalResult(
          {
            command: "journey verify",
            json: json === true,
            secrets: secretParamValues(proved, param),
            artifactPath: join(logsDirFor(), `journey-verify-${id.replace(/[^A-Za-z0-9._-]/g, "_")}-${artifactStamp(clock.nowIso())}.json`),
            inactivityMs: proofInactivityMs(proved),
          },
          seams.terminal,
        );
        const progress = terminal;
        // #544: no --fixtures → the Journey's recorded fixtures (a missing file is refused before any browser).
        const recorded = await withRecordedFixtures(fixtureFlags, { dir: verifyJourneysDir, id });
        let fixtureDrift: FixtureDrift | undefined;
        const report = await withSiteGate(resolveDbPath(deps), (siteGate) =>
          verifyJourneyMutations(
            {
              ...(siteGate === undefined ? {} : { siteGate }),
              dir: verifyJourneysDir,
              id,
              params: param,
              ...(readRequests === undefined ? {} : { readRequests }),
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
          ),
        );
        const code = verifyExitCode(report.verdict);
        const noReset = resetDeclared(proved, recorded.flags, environment) ? undefined : verifyNoResetLine((await planJourneyVerification({ dir: verifyJourneysDir, id, params: param, ...(readRequests === undefined ? {} : { readRequests }) })).summary);
        if (json) {
          emitJson(program, ok(withEngine({ ...report, ...(fixtureDrift === undefined ? {} : { fixtureDrift }), ...(noReset === undefined ? {} : { noReset }) })));
        } else {
          const out = program.configureOutput().writeOut;
          if (fixtureDrift !== undefined) program.configureOutput().writeErr?.(`warning: ${(fixtureDrift as FixtureDrift).message}\n`);
          for (const a of report.assertions) out?.(`${verifyAssertionLine(a)}\n`);
          if (noReset !== undefined) out?.(`${noReset}\n`);
          const s = report.summary;
          const targeted = s.targeted > 0 ? `, ${s.targeted} targeted` : "";
          const reused = report.reusedPairs > 0 ? `, ${report.reusedPairs} pairs reused from a checkpoint` : "";
          out?.(
            `${report.verdict} — journey '${report.journeyId}': ${s.sensitive} sensitive, ${s.insensitive} insensitive, ${s.cascade} cascade, ${s.notApplied} not applied, ${s.error} error, ${s.unpaired} unpaired${targeted}${reused}` +
              `${report.reason === undefined ? "" : ` (${report.reason})`}\n`,
          );
        }
        process.exitCode = code;
        terminal.complete();
      } catch (err) {
        if (err instanceof JourneyVerifyResumeRefusedError) {
          emitJson(program, { ...fail(err.code, err.message), data: { reason: err.reason, exitCode: EXIT_CODES.inconclusive } });
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
    });
}
