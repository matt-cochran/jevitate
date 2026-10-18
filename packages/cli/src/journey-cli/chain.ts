import { existsSync, readFileSync } from "node:fs";
import { Command } from "commander";
import {
  type BrowserLaunchFlags,
  browserRunFromFlags,
  type CliDeps,
  emitJson,
  type EmulationFlags,
  emulationFromFlags,
  environmentSeams,
  resolveDbPath,
  resolveJourneysDir,
  withBrowserLaunchFlags,
  withEmulationFlags,
  writeRawResult,
} from "../cli-shared.js";
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
import { chainSucceeded, JourneyChainError, runJourneyChain } from "../journey-chain.js";
import { withSiteGate } from "../site-gate-cli.js";
import { type EmulationSpec } from "@jevitate/playwright";

/**
 * #580: `jevitate journey chain --from <id> --to <id> --requests <file>` (docs/journey-chain-contract.md §5)
 * runs a discover Journey once, then a prepare-only reply Journey once per matched request. Exits 0 only
 * when every request matched and every run was `ok`.
 */
export function registerJourneyChain(journey: Command, program: Command, deps: CliDeps): void {
  withReplayAllowFlag(withEnvironmentFlags(withBrowserLaunchFlags(withEmulationFlags(journey.command("chain")))))
    .requiredOption("--from <id>", "the discover Journey, run once to produce the records")
    .requiredOption("--to <id>", "the prepare-only reply Journey, run once per matched request")
    .requiredOption("--requests <file>", "JSON Lines file of approved requests ({commentId, account, replyText})")
    .option("--dir <path>", "journeys directory (default: the repo's .jevitate/journeys; outside a repo ~/.jevitate/journeys)")
    .option("--storage-state <file>", "Playwright storageState JSON to start each run authenticated; must exist")
    .option("--allow-draft", "also run Journeys that are not promoted (authoring); without it both must be promoted")
    .option("--json", "emit a JSON envelope")
    .action(async function (this: Command) {
      const { from, to, requests: requestsFile, dir, storageState: storageStateFlag, json, allowDraft } = this.opts<{
        from: string;
        to: string;
        requests: string;
        dir?: string;
        storageState?: string;
        json?: boolean;
        allowDraft?: boolean;
      }>();
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

      try {
        const result = await withSiteGate(resolveDbPath(deps), (siteGate) =>
          runJourneyChain({
            from,
            to,
            requests,
            dir: resolveJourneysDir(deps, dir),
            requirePromoted: allowDraft !== true,
            ...(siteGate === undefined ? {} : { siteGate }),
            browserPortFactory: deps.explore?.browserPortFactory,
            ...(browser === undefined ? {} : { browser }),
            ...(emulation === undefined ? {} : { emulation }),
            ...(storageState !== undefined ? { storageState } : {}),
            ...(environment === undefined ? {} : { environment }),
            ...(allow.length === 0 ? {} : { allow }),
          }),
        );
        const envelope = ok(result);
        if (json) emitJson(program, envelope);
        else writeRawResult(program, result);
        // §5 step 5: 0 only when every request matched and every run was `ok`.
        process.exitCode = chainSucceeded(result) ? 0 : 1;
      } catch (err) {
        if (err instanceof JourneyChainError) {
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
