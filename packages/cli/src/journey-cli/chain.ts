import { resolve as resolvePath } from "node:path";
import { JourneyRunRefusedError } from "@jevitate/mcp-facade";
import { existsSync, readFileSync } from "node:fs";
import { Command } from "commander";
import {
  type BrowserLaunchFlags,
  browserRunFromFlags,
  type CliDeps,
  collectParam,
  emitJson,
  type EmulationFlags,
  emulationFromFlags,
  commandSecretSeams,
  environmentSeams,
  resolveDbPath,
  withBrowserLaunchFlags,
  withEmulationFlags,
  writeRawResult,
} from "../cli-shared.js";
import { REPLAY_SECRET_FIELD_HELP, collectSecretField, secretFieldErrorOf, warnSecretParamsOnArgv, withBoundSecretParams, withCommandSecretParams, type BoundSecretParams } from "../secret-params.js";
import {
  type EnvironmentFlags,
  environmentFromFlags,
  isEnvironmentError,
  replayAllowFromFlags,
  type ResolvedJourneyEnvironment,
  withEnvironmentFlags,
  withReplayAllowFlag,
} from "../environments.js";
import { fail, ok } from "../envelope.js";
import { UnknownJourneyError } from "../journey-api.js";
import { chainExitCode, JourneyChainError, runJourneyChain } from "../journey-chain.js";
import { resolveCatalogDir } from "../catalog-api.js";
import { doneCheckPolicyOf } from "../journey-done-check-hook.js";
import { withSiteGate } from "../site-gate-cli.js";
import { withProjectFlags } from "../project-layout.js";
import { DEPRECATED_DIR_HELP, journeyLayout } from "./shared.js";
import { type EmulationSpec } from "@jevitate/playwright";

/**
 * #580: `jevitate journey chain --from <id> --to <id> --requests <file>` (docs/journey-chain-contract.md §5)
 * runs a discover Journey once, then a prepare-only reply Journey once per matched request. Exits 0 only
 * when every request matched and every run was `ok`.
 */
export function registerJourneyChain(journey: Command, program: Command, deps: CliDeps): void {
  withReplayAllowFlag(withEnvironmentFlags(withBrowserLaunchFlags(withEmulationFlags(withProjectFlags(journey.command("chain"))))))
    .requiredOption("--from <id>", "the discover Journey, run once to produce the records")
    .requiredOption("--to <id>", "the prepare-only reply Journey, run once per matched request")
    .requiredOption("--requests <file>", "JSON Lines file of approved requests ({commentId, account, replyText})")
    .option("--param <kv>", "param as key=value (repeatable)", collectParam, {} as Record<string, string>)
    .option("--secret-field <binding>", `${REPLAY_SECRET_FIELD_HELP}. Binds the discover (--from) Journey's secret parameters`, collectSecretField, [] as string[])
    .option("--dir <path>", DEPRECATED_DIR_HELP)
    .option("--storage-state <file>", "Playwright storageState JSON to start each run authenticated; must exist")
    .option("--allow-draft", "also run Journeys that are not promoted (authoring); without it both must be promoted")
    .option("--json", "emit a JSON envelope")
    .action(async function (this: Command) {
      const locationFlags = this.opts<{ dir?: string; project?: string; journeysDir?: string }>();
      const layout = journeyLayout(program, deps, { dir: locationFlags.dir, project: locationFlags.project, journeysDir: locationFlags.journeysDir });
      if (layout === null) return;
      const chainJourneysDir = layout.journeysDir;
      const { from, to, requests: requestsFile, storageState: storageStateFlag, json, allowDraft, param: paramFlags, secretField } = this.opts<{
        secretField: string[];
        from: string;
        to: string;
        requests: string;
        storageState?: string;
        json?: boolean;
        allowDraft?: boolean;
        param: Record<string, string>;
      }>();
      await warnSecretParamsOnArgv(program.configureOutput().writeErr, chainJourneysDir, [from, to], paramFlags, "journey chain");
      const { env: envName, baseUrl } = this.opts<EnvironmentFlags>();
      // #247: --env/--base-url choose where both runs go (unknown env / bad file → 64, nothing opened).
      let environment: ResolvedJourneyEnvironment | undefined;
      let allow: string[];
      try {
        allow = replayAllowFromFlags(this.opts<{ allow: string[] }>().allow);
        environment = environmentFromFlags(
          { ...(envName === undefined ? {} : { env: envName }), ...(baseUrl === undefined ? {} : { baseUrl }) },
          environmentSeams(deps),
        );
      } catch (err) {
        if (!isEnvironmentError(err)) throw err;
        emitJson(program, fail(err.code, err.message));
        return;
      }
      // #827: the producer's secret parameters from the environment (--secret-field, targets.json), off the command line.
      let param: Record<string, string>;
      let bound: BoundSecretParams | undefined;
      try {
        ({ params: param, bound } = await withCommandSecretParams({ dir: chainJourneysDir, ids: [from], params: paramFlags, flags: secretField, environment, env: deps.explore?.env ?? process.env, seams: commandSecretSeams(deps, chainJourneysDir) }));
      } catch (err) {
        const e = secretFieldErrorOf(err, "E_CHAIN_ARGS");
        if (e === undefined) throw err;
        emitJson(program, fail(e.code, e.message));
        return;
      }
      const storageState = storageStateFlag ?? environment?.storageState;
      if (storageState !== undefined && !existsSync(storageState)) {
        emitJson(program, fail("E_CHAIN_ARGS", `storage state not found: ${storageState}`));
        return;
      }
      let requests: string;
      try {
        requests = readFileSync(requestsFile, "utf8");
      } catch (err) {
        emitJson(program, fail("E_CHAIN_ARGS", `could not read requests file ${requestsFile}: ${err instanceof Error ? err.message : String(err)}`));
        return;
      }
      let browser: ReturnType<typeof browserRunFromFlags>;
      try {
        browser = browserRunFromFlags(this.opts<BrowserLaunchFlags>(), deps.explore?.env ?? process.env);
      } catch (err) {
        emitJson(program, fail("E_CHAIN_ARGS", err instanceof Error ? err.message : String(err)));
        return;
      }
      let emulation: EmulationSpec | undefined;
      try {
        emulation = emulationFromFlags(this.opts<EmulationFlags>());
      } catch (err) {
        emitJson(program, fail("E_CHAIN_ARGS", err instanceof Error ? err.message : String(err)));
        return;
      }

      // H5: every run in the chain reads its job's done check, with this project's catalog and policy.
      const catalogDir = resolveCatalogDir(deps.catalogDir);
      try {
        const result = await withSiteGate(resolveDbPath(deps), (siteGate) => withBoundSecretParams(bound, () =>
          runJourneyChain({
            catalogDir,
            from,
            to,
            requests,
            // #827 (§5.3): a hold the producer reaches resumes the whole chain from this file.
            requestsPath: resolvePath(requestsFile),
            ...(Object.keys(param).length === 0 ? {} : { params: param }),
            dir: chainJourneysDir,
            requirePromoted: allowDraft !== true,
            ...(siteGate === undefined ? {} : { siteGate }),
            browserPortFactory: deps.explore?.browserPortFactory,
            ...(browser === undefined ? {} : { browser }),
            ...(emulation === undefined ? {} : { emulation }),
            ...(storageState !== undefined ? { storageState } : {}),
            ...(environment === undefined ? {} : { environment }),
            ...(allow.length === 0 ? {} : { allow }),
          })),
        );
        const envelope = ok(result);
        if (json) emitJson(program, envelope);
        else writeRawResult(program, result);
        // §5 step 5: 0 only when every request matched and every run was `ok`; H5: with every job verdict folded in
        // (a job not achieved 1, an unverified pass 2 under `require`, owner decisions 2/3).
        process.exitCode = chainExitCode(result, doneCheckPolicyOf(catalogDir));
      } catch (err) {
        if (err instanceof JourneyChainError) {
          emitJson(program, fail(err.code, err.message));
        } else if (err instanceof JourneyRunRefusedError) {
          emitJson(program, fail(err.code, err.message));
        } else if (err instanceof UnknownJourneyError) {
          emitJson(program, fail("E_UNKNOWN_JOURNEY", String(err.message)));
        } else if (isEnvironmentError(err)) {
          emitJson(program, fail(err.code, err.message));
        } else {
          emitJson(program, fail("E_CHAIN", String(err instanceof Error ? err.message : err)));
        }
      }
    });
}
