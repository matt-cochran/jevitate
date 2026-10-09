import { TAG_FLAG, TAG_HELP, collectTag, taggedAction } from "./run-tags-cli.js";
import { existsSync } from "node:fs";
import { Command } from "commander";
import { ParamValidationError } from "@jevitate/journey";
import { journeyExitCode } from "@jevitate/domain";
import { ok, fail } from "./envelope.js";
import { SiteGateRefusedError } from "@jevitate/runtime";
import { UnknownJourneyError, JourneyRequiresAuthError } from "./journey-api.js";
import { withSiteGate } from "./site-gate-cli.js";
import { withEngine } from "./engine.js";
import { addSource, listSources, pullSource, updateSource, removeSource, trustJourney } from "./source-api.js";
import { runSourceJourney, realResolvedJourneyRunner, type SourceRunApiDeps } from "./source-run-api.js";
import {
  UnknownSourceError,
  EmbeddedSecretError,
  UndeclaredOriginError,
  UndeclaredTouError,
  HashMismatchError,
  UntrustedRiskyJourneyError,
  SourceValidationError,
} from "@jevitate/sources";
import { type EmulationSpec } from "@jevitate/playwright";
import {
  type CliDeps,
  resolveDbPath,
  resolveSourceApiDeps,
  resolveApprovedBy,
  type BrowserLaunchFlags,
  withBrowserLaunchFlags,
  browserOption,
  type EmulationFlags,
  withEmulationFlags,
  emulationFromFlags,
  collectParam,
  emitJson,
  writeRawResult,
} from "./cli-shared.js";

/** Registers `jevitate source`: `add|list|pull|update|remove|trust|run`. */
export function registerSourceCommands(program: Command, deps: CliDeps): void {
  // #18 — manage distributed Journey sources (add/list/pull/update/remove/
  // trust). Trust is an explicit user act, content-hash-bound; add/pull/update
  // never trust anything implicitly.
  const source = program.command("source").description("manage distributed Journey sources (git-backed collections of Journeys)");

  source
    .command("add <name> <gitUrl>")
    .option("--accept-tou", "acknowledge the source's declared Terms of Use (required before its Journeys can run)")
    .option("--json", "emit a JSON envelope")
    .action(async function (this: Command, name: string, gitUrl: string) {
      const { acceptTou, json } = this.opts<{ acceptTou?: boolean; json?: boolean }>();
      try {
        const apiDeps = resolveSourceApiDeps(deps);
        const result = await addSource(apiDeps, {
          name,
          gitUrl,
          acceptTou: acceptTou ?? false,
          ackedBy: resolveApprovedBy(deps),
        });
        const envelope = ok(result);
        if (json) {
          emitJson(program, envelope);
        } else {
          const out = program.configureOutput().writeOut;
          out?.(`added '${name}' pinned at ${result.pinnedCommit}\n`);
          out?.(`Terms of Use for ${result.touSurface.gitUrl}:\n`);
          for (const site of result.touSurface.sites) out?.(`  ${site.origin}\t${site.touBasis}\n`);
          out?.(result.touAccepted ? "ToU acknowledged.\n" : "ToU NOT acknowledged — re-run with --accept-tou before running this source's Journeys.\n");
          process.exitCode = 0;
        }
      } catch (err) {
        if (err instanceof SourceValidationError) {
          emitJson(program, fail("E_SOURCE_INVALID_MANIFEST", err.message));
        } else {
          emitJson(program, fail("E_SOURCE_ADD", String(err instanceof Error ? err.message : err)));
        }
      }
    });

  source
    .command("list")
    .option("--json", "emit a JSON envelope")
    .action(async function (this: Command) {
      const { json } = this.opts<{ json?: boolean }>();
      try {
        const listing = await listSources(resolveSourceApiDeps(deps));
        const envelope = ok(listing);
        if (json) {
          emitJson(program, envelope);
        } else {
          const out = program.configureOutput().writeOut;
          if (listing.length === 0) {
            out?.("no sources yet — add one with `jevitate source add <name> <gitUrl>`\n");
          } else {
            for (const s of listing) {
              out?.(`${s.name}\t${s.gitUrl}\t${s.pinnedCommit}\ttrusted=[${s.trustedJourneys.join(", ")}]\n`);
            }
          }
          process.exitCode = 0;
        }
      } catch (err) {
        emitJson(program, fail("E_SOURCE_LIST", String(err instanceof Error ? err.message : err)));
      }
    });

  source
    .command("pull <name>")
    .option("--json", "emit a JSON envelope")
    .action(async function (this: Command, name: string) {
      const { json } = this.opts<{ json?: boolean }>();
      try {
        const result = await pullSource(resolveSourceApiDeps(deps), name);
        const envelope = ok(result);
        if (json) {
          emitJson(program, envelope);
        } else {
          program.configureOutput().writeOut?.(`pulled '${name}' (pin unchanged at ${result.pinnedCommit}; run 'source update' to advance)\n`);
          process.exitCode = 0;
        }
      } catch (err) {
        if (err instanceof UnknownSourceError) {
          emitJson(program, fail("E_SOURCE_UNKNOWN", err.message));
        } else {
          emitJson(program, fail("E_SOURCE_PULL", String(err instanceof Error ? err.message : err)));
        }
      }
    });

  source
    .command("update <name>")
    .option("--json", "emit a JSON envelope")
    .action(async function (this: Command, name: string) {
      const { json } = this.opts<{ json?: boolean }>();
      try {
        const result = await updateSource(resolveSourceApiDeps(deps), name);
        const envelope = ok(result);
        if (json) {
          emitJson(program, envelope);
        } else {
          program.configureOutput().writeOut?.(`updated '${name}' -> pinned at ${result.pinnedCommit}\n`);
          process.exitCode = 0;
        }
      } catch (err) {
        if (err instanceof UnknownSourceError) {
          emitJson(program, fail("E_SOURCE_UNKNOWN", err.message));
        } else {
          emitJson(program, fail("E_SOURCE_UPDATE", String(err instanceof Error ? err.message : err)));
        }
      }
    });

  source
    .command("remove <name>")
    .option("--json", "emit a JSON envelope")
    .action(async function (this: Command, name: string) {
      const { json } = this.opts<{ json?: boolean }>();
      try {
        const result = await removeSource(resolveSourceApiDeps(deps), name);
        const envelope = ok(result);
        if (json) {
          emitJson(program, envelope);
        } else {
          program.configureOutput().writeOut?.(`removed '${name}'\n`);
          process.exitCode = 0;
        }
      } catch (err) {
        if (err instanceof UnknownSourceError) {
          emitJson(program, fail("E_SOURCE_UNKNOWN", err.message));
        } else {
          emitJson(program, fail("E_SOURCE_REMOVE", String(err instanceof Error ? err.message : err)));
        }
      }
    });

  source
    .command("trust <name> <journeyId>")
    .description("explicitly trust one Journey in a source, bound to its current content hash")
    .option("--json", "emit a JSON envelope")
    .action(async function (this: Command, name: string, journeyId: string) {
      const { json } = this.opts<{ json?: boolean }>();
      try {
        const result = await trustJourney(resolveSourceApiDeps(deps), {
          sourceName: name,
          journeyId,
          approvedBy: resolveApprovedBy(deps),
        });
        // Never emit the Journey's content — only the address + bound hash.
        const view = { sourceId: result.sourceId, journeyId: result.journeyId, contentHash: result.contentHash, approvedBy: result.approvedBy, approvedAtIso: result.approvedAtIso };
        const envelope = ok(view);
        if (json) {
          emitJson(program, envelope);
        } else {
          program.configureOutput().writeOut?.(`trusted '${name}/${journeyId}' at ${result.contentHash}\n`);
          process.exitCode = 0;
        }
      } catch (err) {
        if (err instanceof UnknownSourceError) {
          emitJson(program, fail("E_SOURCE_UNKNOWN", err.message));
        } else if (err instanceof UnknownJourneyError) {
          emitJson(program, fail("E_SOURCE_UNKNOWN_JOURNEY", err.message));
        } else {
          emitJson(program, fail("E_SOURCE_TRUST", String(err instanceof Error ? err.message : err)));
        }
      }
    });

  // #26 — run a Journey that lives in a trusted remote source, THROUGH the
  // existing run-gate (`@jevitate/sources`' `resolveForRun`). RULING: this is a
  // `source run` subcommand (not `journey run --from-source`) because the whole
  // trust boundary is source-scoped — the `<source>/<id>` address, the
  // per-source manifest/ToU-ack/trust records all live under `source`. `journey
  // run` stays the LOCAL FsJourneyStore path; keeping remote runs here keeps the
  // two trust boundaries visibly separate. The run NEVER bypasses a gate: every
  // refusal below is a typed error thrown by `resolveForRun` BEFORE any browser.
  withBrowserLaunchFlags(withEmulationFlags(source.command("run <name> <journeyId>")))
    .description("run a Journey from a trusted remote source through the run-gate")
    .option("--param <kv>", "param as key=value (repeatable)", collectParam, {} as Record<string, string>)
    .option(
      "--storage-state <file>",
      "Playwright storageState JSON to start the session authenticated (#118: required when the journey declares metadata.requiresAuth); must exist",
    )
    .option("--json", "emit a JSON envelope")
    .option(TAG_FLAG, TAG_HELP, collectTag, [])
    .action(taggedAction(program, "source run", async function (this: Command, name: string, journeyId: string) {
      const { param, storageState, json, ...emulationFlags } = this.opts<{
        param: Record<string, string>;
        storageState?: string;
        json?: boolean;
      } & EmulationFlags>();
      if (storageState !== undefined && !existsSync(storageState)) {
        emitJson(program, fail("E_SOURCE_RUN_ARGS", `storage state not found: ${storageState}`));
        return;
      }
      let sourceRunEmulation: EmulationSpec | undefined;
      try {
        sourceRunEmulation = emulationFromFlags(emulationFlags);
      } catch (err) {
        emitJson(program, fail("E_SOURCE_RUN_ARGS", err instanceof Error ? err.message : String(err)));
        return;
      }
      try {
        const apiDeps: SourceRunApiDeps = {
          ...resolveSourceApiDeps(deps),
          runJourney: deps.sources?.runJourney ?? realResolvedJourneyRunner,
        };
        const result = withEngine(await withSiteGate(resolveDbPath(deps), (siteGate) => runSourceJourney(apiDeps, {
          ...(siteGate === undefined ? {} : { siteGate }),
          sourceName: name,
          journeyId,
          params: param,
          ...(sourceRunEmulation === undefined ? {} : { emulation: sourceRunEmulation }),
          ...(storageState !== undefined ? { storageState } : {}),
          ...browserOption(this.opts<BrowserLaunchFlags>()),
        })));
        const envelope = ok(result);
        if (json) {
          emitJson(program, envelope);
          const code = journeyExitCode(result.outcome);
          if (code !== 0) process.exitCode = code;
        } else {
          writeRawResult(program, result);
          process.exitCode = journeyExitCode(result.outcome);
        }
      } catch (err) {
        // Each run-gate refusal maps to a distinct E_SOURCE_RUN* code so a
        // caller can tell WHY the run was refused without string-matching.
        if (err instanceof SiteGateRefusedError) {
          emitJson(program, fail(err.code, err.message));
        } else if (err instanceof UnknownSourceError) {
          emitJson(program, fail("E_SOURCE_RUN_UNKNOWN", err.message));
        } else if (err instanceof HashMismatchError) {
          emitJson(program, fail("E_SOURCE_RUN_HASH_MISMATCH", err.message));
        } else if (err instanceof UntrustedRiskyJourneyError) {
          emitJson(program, fail("E_SOURCE_RUN_UNTRUSTED", err.message));
        } else if (err instanceof UndeclaredOriginError) {
          emitJson(program, fail("E_SOURCE_RUN_ORIGIN", err.message));
        } else if (err instanceof UndeclaredTouError) {
          emitJson(program, fail("E_SOURCE_RUN_TOU", err.message));
        } else if (err instanceof EmbeddedSecretError) {
          emitJson(program, fail("E_SOURCE_RUN_SECRET", err.message));
        } else if (err instanceof SourceValidationError) {
          emitJson(program, fail("E_SOURCE_RUN_INVALID_MANIFEST", err.message));
        } else if (err instanceof ParamValidationError) {
          emitJson(program, fail("E_INVALID_PARAMS", err.message));
        } else if (err instanceof JourneyRequiresAuthError) {
          emitJson(program, fail("E_JOURNEY_REQUIRES_AUTH", err.message));
        } else {
          emitJson(program, fail("E_SOURCE_RUN", String(err instanceof Error ? err.message : err)));
        }
      }
    }));
}
