import { existsSync } from "node:fs";
import { HttpCheckOffAllowlistError } from "../http-probe.js";
import { Command } from "commander";
import { ParamValidationError } from "@jevitate/journey";
import { ok, fail } from "../envelope.js";
import { SiteGateRefusedError } from "@jevitate/runtime";
import { UnknownJourneyError, JourneyRequiresAuthError } from "../journey-api.js";
import { ExtensionMismatchError } from "../browser-run-options.js";
import { withSiteGate } from "../site-gate-cli.js";
import { buildMissionFixtures, checkSetupRefs, withFixtureFlags, type FixtureFlags } from "../fixture-cli.js";
import { FixtureSetupError, FixtureSpecError, UnboundSetupRefError } from "../mission-fixtures.js";
import { withRecordedFixtures, fixtureDriftFor, type FixtureDrift } from "../journey-fixtures.js";
import { withEngine } from "../engine.js";
import { verifyAssertionLine, verifyExitCode, verifyJourneyMutations } from "../journey-verify.js";
import { environmentFromFlags, fixtureRebaseUrl, isEnvironmentError, withEnvironmentFlags, withReplayAllowFlag, replayAllowFromFlags, type EnvironmentFlags, type ResolvedJourneyEnvironment } from "../environments.js";
import { type CliDeps, resolveDbPath, resolveJourneysDir, type BrowserLaunchFlags, withBrowserLaunchFlags, browserRunFromFlags, type DemoFlags, collectParam, emitJson, environmentSeams } from "../cli-shared.js";

/** Registers `jevitate journey verify`. */
export function registerJourneyVerify(journey: Command, program: Command, deps: CliDeps): void {
  // #402 — the negative proof: replay the Journey once as recorded, then once per mutation (skip a
  // write step, abort its writes, type an empty value into a checked fill); each assertion must fail
  // under its paired mutation. `verify` is reserved for proofs: today only `--mutate` exists.
  withReplayAllowFlag(withEnvironmentFlags(withBrowserLaunchFlags(withFixtureFlags(journey.command("verify <id>")))))
    .description("prove each assertion of a Journey can fail: --mutate replays it with each write step skipped or blocked, and each checked fill emptied")
    .option("--mutate", "run the mutation proof (required)")
    .option("--dir <path>", "journeys directory (default: the repo's .jevitate/journeys; outside a repo ~/.jevitate/journeys)")
    .option("--param <kv>", "param as key=value (repeatable)", collectParam, {} as Record<string, string>)
    .option("--storage-state <file>", "Playwright storageState JSON to start each replay authenticated (as journey run)")
    .option("--json", "emit a JSON envelope")
    .action(async function (this: Command, id: string) {
      const { mutate, dir, param, storageState: storageStateFlag, json, env: envName, baseUrl } = this.opts<
        { mutate?: boolean; dir?: string; param: Record<string, string>; storageState?: string; json?: boolean } & EnvironmentFlags
      >();
      if (mutate !== true) {
        emitJson(program, fail("E_JOURNEY_VERIFY_ARGS", "journey verify needs --mutate (the mutation proof is the only verification it runs today)"));
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
      try {
        browser = browserRunFromFlags(this.opts<BrowserLaunchFlags & DemoFlags>(), deps.explore?.env ?? process.env);
      } catch (err) {
        emitJson(program, fail("E_JOURNEY_VERIFY_ARGS", err instanceof Error ? err.message : String(err)));
        return;
      }
      try {
        // #544: no --fixtures → the Journey's recorded fixtures (a missing file is refused before any browser).
        const recorded = await withRecordedFixtures(fixtureFlags, { dir: resolveJourneysDir(deps, dir), id });
        let fixtureDrift: FixtureDrift | undefined;
        const report = await withSiteGate(resolveDbPath(deps), (siteGate) =>
          verifyJourneyMutations({
            ...(siteGate === undefined ? {} : { siteGate }),
            dir: resolveJourneysDir(deps, dir),
            id,
            params: param,
            browserPortFactory: deps.explore?.browserPortFactory,
            ...(browser === undefined ? {} : { browser }),
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
          }),
        );
        const code = verifyExitCode(report.verdict);
        if (json) {
          emitJson(program, ok(withEngine(fixtureDrift === undefined ? report : { ...report, fixtureDrift })));
        } else {
          const out = program.configureOutput().writeOut;
          if (fixtureDrift !== undefined) program.configureOutput().writeErr?.(`warning: ${(fixtureDrift as FixtureDrift).message}\n`);
          for (const a of report.assertions) out?.(`${verifyAssertionLine(a)}\n`);
          const s = report.summary;
          out?.(
            `${report.verdict} — journey '${report.journeyId}': ${s.sensitive} sensitive, ${s.insensitive} insensitive, ${s.cascade} cascade, ${s.notApplied} not applied, ${s.error} error, ${s.unpaired} unpaired` +
              `${report.reason === undefined ? "" : ` (${report.reason})`}\n`,
          );
        }
        process.exitCode = code;
      } catch (err) {
        if (err instanceof SiteGateRefusedError || isEnvironmentError(err) || err instanceof HttpCheckOffAllowlistError) {
          emitJson(program, fail(err.code, err.message));
        } else if (err instanceof UnknownJourneyError) {
          emitJson(program, fail("E_UNKNOWN_JOURNEY", String(err.message)));
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
        } else {
          emitJson(program, fail("E_JOURNEY_VERIFY", String(err instanceof Error ? err.message : err)));
        }
      }
    });
}
