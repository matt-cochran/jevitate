import { existsSync } from "node:fs";
import type { Command } from "commander";
import { ParamValidationError } from "@jevitate/journey";
import { ok, fail } from "../envelope.js";
import { resolveCatalogDir } from "../catalog-api.js";
import { type CliDeps, collectParam, emitJson } from "../cli-shared.js";
import { EXIT_CODES } from "../exit-codes.js";
import { buildMissionFixtures, withFixtureFlags, type FixtureFlags } from "../fixture-cli.js";
import { FixtureSetupError, FixtureSpecError, UnboundSetupRefError } from "../mission-fixtures.js";
import { withRecordedFixtures } from "../journey-fixtures.js";
import { JourneyRequiresAuthError, UnknownJourneyError } from "../journey-api.js";
import { JourneyShortenError, SHORTEST_FOUND, shortenJourney, type ShortenJourneyReport } from "../journey-shorten.js";
import { withEngine } from "../engine.js";
import { withProjectFlags } from "../project-layout.js";
import { flaggedCatalogDir, journeyLayout, targetsOpts } from "./shared.js";

/** The one summary line: always "shortest found within budget", never "optimal". */
export function shortenLine(r: ShortenJourneyReport): string {
  if (r.stopped === "recorded-path-fails") {
    return `nothing shortened — journey '${r.journeyId}': the recorded path did not achieve job '${r.job}' (${r.baseline}) in ${r.replaysUsed} replay, so no shorter path was tried`;
  }
  const head = `${SHORTEST_FOUND} — journey '${r.journeyId}': ${r.originalSteps} → ${r.shortestSteps} steps, ${r.replaysUsed} of ${r.budget} replays`;
  const stop = r.stopped === "budget" ? "; the budget ran out, so a shorter path may remain untried" : "";
  const refused = r.refused > 0 ? `; ${r.refused} candidate(s) refused by the confirmation guard` : "";
  const draft = r.draftId === undefined ? "; no shorter path achieved the job, so no draft was written" : `; unpromoted draft '${r.draftId}': review it, then jevitate journey promote ${r.draftId}`;
  return `${head}${stop}${refused}${draft}`;
}

/** Registers `jevitate journey shorten <id> --job <jobId> [--budget n] [--out-id <id>]` (#801). */
export function registerJourneyShorten(journey: Command, program: Command, deps: CliDeps): void {
  withFixtureFlags(withProjectFlags(journey.command("shorten <id>")))
    .description(
      "authoring time: search for a shorter path to the same job by removing steps (no model); every candidate is a full replay with the fixtures reset around it, decided only by the job's done check in a fresh context; never drops a confirm/agree/accept click. Writes an UNPROMOTED draft and reports the shortest found within budget",
    )
    .requiredOption("--job <jobId>", "the catalog job (.jevitate/jobs.json) whose done check decides every candidate")
    .option("--budget <n>", "replays the search may spend, the recorded path's included (default 30)")
    .option("--out-id <id>", "the draft Journey's id (default <id>-shortest; refused when it exists)")
    .option("--param <kv>", "param as key=value (repeatable)", collectParam, {} as Record<string, string>)
    .option("--storage-state <file>", "Playwright storageState JSON to start each replay (and each done-check reading) authenticated")
    .option("--json", "emit a JSON envelope")
    .action(async function (this: Command, id: string) {
      const flags = this.opts<{ project?: string; journeysDir?: string; job: string; budget?: string; outId?: string; param: Record<string, string>; storageState?: string; json?: boolean } & FixtureFlags>();
      const layout = journeyLayout(program, deps, { project: flags.project, journeysDir: flags.journeysDir });
      if (layout === null) return;
      const dir = layout.journeysDir;
      const budget = flags.budget === undefined ? undefined : Number(flags.budget);
      if (budget !== undefined && (!Number.isInteger(budget) || budget < 1 || budget > 500)) {
        emitJson(program, fail("E_JOURNEY_SHORTEN_ARGS", "--budget: a whole number of replays from 1 to 500"));
        process.exitCode = EXIT_CODES.usage;
        return;
      }
      if (flags.storageState !== undefined && !existsSync(flags.storageState)) {
        emitJson(program, fail("E_JOURNEY_SHORTEN_ARGS", `storage state not found: ${flags.storageState}`));
        process.exitCode = EXIT_CODES.usage;
        return;
      }
      const catalogDir = resolveCatalogDir(deps.catalogDir, flaggedCatalogDir(layout));
      try {
        // No --fixtures → the Journey's recorded fixtures: set up before, and restored after, every candidate.
        const recorded = await withRecordedFixtures(flags, { dir, id });
        const report = await shortenJourney({
          dir,
          id,
          jobId: flags.job,
          catalogDir,
          ...(budget === undefined ? {} : { budget }),
          ...(flags.outId === undefined ? {} : { outId: flags.outId }),
          params: flags.param,
          ...(flags.storageState === undefined ? {} : { storageState: flags.storageState }),
          ...(deps.explore?.browserPortFactory === undefined ? {} : { browserPortFactory: deps.explore.browserPortFactory }),
          ...targetsOpts(deps),
          fixtures: (site, allowedOrigins) =>
            buildMissionFixtures(recorded.flags, {
              allowlist: [...allowedOrigins],
              baseUrl: site,
              ...(flags.storageState === undefined ? {} : { storageState: flags.storageState }),
            }),
          onReplay: (replay, steps) => {
            if (flags.json !== true) program.configureOutput().writeErr?.(`replay ${replay}: ${steps} step(s)\n`);
          },
        });
        if (flags.json === true) emitJson(program, ok(withEngine(report)));
        else program.configureOutput().writeOut?.(`${shortenLine(report)}\n`);
        process.exitCode = report.stopped === "recorded-path-fails" ? EXIT_CODES.inconclusive : EXIT_CODES.ok;
      } catch (err) {
        if (err instanceof JourneyShortenError) {
          emitJson(program, fail(err.code, err.message));
          process.exitCode = err.code === "E_JOURNEY_SHORTEN_ARGS" ? EXIT_CODES.usage : EXIT_CODES.inconclusive;
        } else if (err instanceof UnknownJourneyError) {
          emitJson(program, fail("E_UNKNOWN_JOURNEY", err.message));
        } else if (err instanceof JourneyRequiresAuthError) {
          emitJson(program, fail("E_JOURNEY_REQUIRES_AUTH", err.message));
        } else if (err instanceof ParamValidationError) {
          emitJson(program, fail("E_INVALID_PARAMS", err.message));
        } else if (err instanceof FixtureSpecError || err instanceof UnboundSetupRefError) {
          emitJson(program, fail(err.code, err.message));
        } else if (err instanceof FixtureSetupError) {
          // A candidate never runs on unknown state: the search stops, nothing is written.
          emitJson(program, fail("E_JOURNEY_SHORTEN", `fixture setup failed — the search stopped and wrote nothing: ${err.message}`));
          process.exitCode = EXIT_CODES.inconclusive;
        } else throw err;
      }
    });
}
