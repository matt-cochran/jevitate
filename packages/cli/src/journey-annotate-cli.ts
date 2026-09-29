import { existsSync } from "node:fs";
import type { Command } from "commander";
import { ParamValidationError, formatAnnotationChanges } from "@jevitate/journey";
import { MissingCredentialError, SecretLeakError } from "@jevitate/ai-core";
import { SiteGateRefusedError } from "@jevitate/runtime";
import { type EmulationSpec } from "@jevitate/playwright";
import { ok, fail } from "./envelope.js";
import { UnknownJourneyError, JourneyRequiresAuthError } from "./journey-api.js";
import {
  annotateJourney,
  approveJourneyAnnotations,
  AnnotationDraftNotFoundError,
  InvalidAnnotationDraftError,
  StaleAnnotationDraftError,
} from "./journey-annotate-api.js";
import { withSiteGate } from "./site-gate-cli.js";
import { buildMissionFixtures, checkSetupRefs, withFixtureFlags, type FixtureFlags } from "./fixture-cli.js";
import { FixtureSetupError, FixtureSpecError, UnboundSetupRefError } from "./mission-fixtures.js";
import { withEngine } from "./engine.js";
import { EXIT_CODES } from "./exit-codes.js";
import { environmentFromFlags, isEnvironmentError, withEnvironmentFlags, type EnvironmentFlags, type ResolvedJourneyEnvironment } from "./environments.js";
import {
  type CliDeps,
  resolveDbPath,
  resolveJourneysDir,
  type BrowserLaunchFlags,
  withBrowserLaunchFlags,
  browserOption,
  type EmulationFlags,
  withEmulationFlags,
  emulationFromFlags,
  collectParam,
  emitJson,
  emitUsageLine,
  environmentSeams,
  GatewaySelectionError,
  buildGenerationGateway,
} from "./cli-shared.js";

/**
 * #246 — `jevitate journey annotate <id>`: replay the Journey and DRAFT its intent (each step's
 * objective / expected result, the goal and success criteria when missing) into a sidecar file;
 * `--approve` is the human gate that writes a reviewed draft into the Journey (refused when the
 * Journey changed since the draft). The model never edits a Journey on its own.
 */
export function registerJourneyAnnotateCommand(journey: Command, program: Command, deps: CliDeps): void {
  withEnvironmentFlags(withBrowserLaunchFlags(withEmulationFlags(withFixtureFlags(journey.command("annotate <id>")))))
    .description(
      "draft each step's objective/expected result (and the goal/success criteria when missing) by replaying the Journey; " +
        "writes a reviewable draft, never the Journey — `--approve` applies a reviewed draft (human gate)",
    )
    .option("--dir <path>", "journeys directory (default: ~/.jevitate/journeys)")
    .option("--param <kv>", "param as key=value (repeatable)", collectParam, {} as Record<string, string>)
    .option("--storage-state <file>", "Playwright storageState JSON to start the replay authenticated; must exist")
    .option("--real", "draft with the live OpenRouter generation gateway (requires keys)", false)
    .option("--fake-ai", "draft with the deterministic fake generator (pipeline smoke only)", false)
    .option("--approve", "apply the reviewed draft to the Journey (shows the diff; refused if the Journey changed since the draft)", false)
    .option("--json", "emit a JSON envelope")
    .action(async function (this: Command, id: string) {
      const ownFixtureFlags = this.opts<FixtureFlags>();
      const { dir, param, storageState: storageStateFlag, real, fakeAi, approve, json, env: envName, baseUrl, ...emulationFlags } = this.opts<{
        dir?: string;
        param: Record<string, string>;
        storageState?: string;
        real?: boolean;
        fakeAi?: boolean;
        approve?: boolean;
        json?: boolean;
      } & EmulationFlags & EnvironmentFlags>();
      const out = program.configureOutput().writeOut;
      const journeysDir = resolveJourneysDir(deps, dir);

      if (approve === true) {
        if (real === true || fakeAi === true || Object.keys(param).length > 0 || storageStateFlag !== undefined || envName !== undefined || baseUrl !== undefined) {
          emitJson(program, fail("E_JOURNEY_ANNOTATE_ARGS", "--approve applies an existing draft: it replays nothing, so it takes no --real/--fake-ai/--param/--storage-state/--env/--base-url"));
          return;
        }
        try {
          const result = await approveJourneyAnnotations(journeysDir, id);
          if (json) {
            emitJson(program, ok(result));
          } else {
            out?.(formatAnnotationChanges(result.changes));
            out?.(`applied ${result.changes.length} change(s) to journey '${id}' (${result.coverage.withObjective}/${result.coverage.steps} steps now have an objective)\n`);
            process.exitCode = EXIT_CODES.ok;
          }
        } catch (err) {
          if (err instanceof UnknownJourneyError) emitJson(program, fail("E_UNKNOWN_JOURNEY", err.message));
          else if (err instanceof AnnotationDraftNotFoundError || err instanceof InvalidAnnotationDraftError || err instanceof StaleAnnotationDraftError) {
            emitJson(program, fail(err.code, err.message));
          } else emitJson(program, fail("E_JOURNEY_ANNOTATE", String(err instanceof Error ? err.message : err)));
        }
        return;
      }

      // #247: --env/--base-url choose where the replay runs — the same resolver as `journey run`
      // (unknown env / bad file / secret in environments.json → 64, nothing opened).
      let environment: ResolvedJourneyEnvironment | undefined;
      try {
        environment = environmentFromFlags({ ...(envName === undefined ? {} : { env: envName }), ...(baseUrl === undefined ? {} : { baseUrl }) }, environmentSeams(deps));
      } catch (err) {
        if (!isEnvironmentError(err)) throw err;
        emitJson(program, fail(err.code, err.message));
        return;
      }
      // The environment's fixtures/hooks apply when the flags name none (hooks still need --allow-shell-hooks).
      const fixtureFlags: FixtureFlags = {
        ...ownFixtureFlags,
        ...(ownFixtureFlags.before === undefined && environment?.hooks?.before !== undefined ? { before: environment.hooks.before } : {}),
        ...(ownFixtureFlags.after === undefined && environment?.hooks?.after !== undefined ? { after: environment.hooks.after } : {}),
      };
      // --storage-state wins; else the environment's own session (~/.jevitate/targets.json[<origin>]).
      const storageState = storageStateFlag ?? environment?.storageState;
      if (storageState !== undefined && !existsSync(storageState)) {
        emitJson(program, fail("E_JOURNEY_ANNOTATE_ARGS", `storage state not found: ${storageState}`));
        return;
      }
      let emulation: EmulationSpec | undefined;
      try {
        emulation = emulationFromFlags(emulationFlags);
      } catch (err) {
        emitJson(program, fail("E_JOURNEY_ANNOTATE_ARGS", err instanceof Error ? err.message : String(err)));
        return;
      }
      let gateway: Awaited<ReturnType<typeof buildGenerationGateway>>;
      try {
        gateway = await buildGenerationGateway(deps, { real: real ?? false, fakeAi: fakeAi ?? false });
      } catch (err) {
        if (err instanceof MissingCredentialError || err instanceof GatewaySelectionError) emitJson(program, fail("E_AI_SETUP_REQUIRED", err.message));
        else emitJson(program, fail("E_JOURNEY_ANNOTATE", String(err instanceof Error ? err.message : err)));
        return;
      }

      try {
        const result = await withSiteGate(resolveDbPath(deps), (siteGate) =>
          annotateJourney({
            ...(siteGate === undefined ? {} : { siteGate }),
            dir: journeysDir,
            id,
            params: param,
            gen: gateway.gen,
            browserPortFactory: deps.explore?.browserPortFactory,
            ...browserOption(this.opts<BrowserLaunchFlags>()),
            ...(emulation === undefined ? {} : { emulation }),
            ...(storageState !== undefined ? { storageState } : {}),
            ...(environment === undefined ? {} : { environment }),
            fixtures: (site) => {
              const fx = buildMissionFixtures(fixtureFlags, {
                allowlist: environment === undefined ? [site] : environment.allowedOrigins,
                baseUrl: site,
                ...(storageState !== undefined ? { storageState } : {}),
                ...(environment?.fixtures === undefined ? {} : { targetFixtures: environment.fixtures }),
              });
              checkSetupRefs({ "--param": Object.values(param) }, fx);
              return fx;
            },
          }),
        );
        const data = withEngine({ ...result, usage: gateway.usage.snapshot() });
        // A replay that stopped early drafted only the steps it reached: the command did not finish its work.
        const exit = result.replay.outcome === "completed" ? EXIT_CODES.ok : EXIT_CODES.inconclusive;
        if (json) {
          emitJson(program, ok(data));
        } else {
          const r = result.replay;
          out?.(
            `drafted annotations for journey '${id}' (${r.reachedSteps}/${r.totalSteps} steps replayed${r.outcome === "stopped" ? `; stopped: ${r.reason ?? "unknown"}` : ""}): ` +
              `${result.drafted.objectives} objective(s), ${result.drafted.expectedResults} expected result(s)` +
              `${result.drafted.goal ? ", a goal" : ""}${result.drafted.successCriteria > 0 ? `, ${result.drafted.successCriteria} success criterion(s)` : ""}\n`,
          );
          out?.(formatAnnotationChanges(result.proposed));
          out?.(`draft: ${result.draftPath}\nreview or edit it, then apply it: jevitate journey annotate ${id} --approve\n`);
          emitUsageLine(program, data);
        }
        process.exitCode = exit;
      } catch (err) {
        if (err instanceof SiteGateRefusedError || isEnvironmentError(err)) emitJson(program, fail(err.code, err.message));
        else if (err instanceof UnknownJourneyError) emitJson(program, fail("E_UNKNOWN_JOURNEY", err.message));
        else if (err instanceof JourneyRequiresAuthError) emitJson(program, fail("E_JOURNEY_REQUIRES_AUTH", err.message));
        else if (err instanceof ParamValidationError) emitJson(program, fail("E_INVALID_PARAMS", err.message));
        else if (err instanceof FixtureSpecError || err instanceof UnboundSetupRefError) emitJson(program, fail(err.code, err.message));
        else if (err instanceof FixtureSetupError) emitJson(program, fail("E_JOURNEY_ANNOTATE", err.message));
        else if (err instanceof SecretLeakError) emitJson(program, fail("E_JOURNEY_ANNOTATE_SECRET", err.message));
        else emitJson(program, fail("E_JOURNEY_ANNOTATE", String(err instanceof Error ? err.message : err)));
      }
    });
}
