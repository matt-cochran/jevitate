import { type CliDeps, JEV_PROVIDER_FLAG_HELP, emitUsageLine, jevProviderArg, resolveJourneysDir, emitJson, GatewaySelectionError } from "../cli-shared.js";
import { READINESS_FLAG_HELP, REAL_JEV_FLAG_HELP, jevSetupFor } from "../catalog-cli.js";
import { writeFile } from "node:fs/promises";
import { Command } from "commander";
import { MissingCredentialError } from "@jevitate/ai-core";
import { ok, fail } from "../envelope.js";
import { UnknownJourneyError } from "../journey-api.js";
import { reviewRenderOptions } from "../review-render-options.js";
import { renderReviewMarkdown, renderReviewText } from "../journey-review.js";
import { reviewJourneyById } from "../journey-review-api.js";
import { listStaleJourneys, renderStaleJourneys } from "../journey-stale-api.js";
import { ReviewSidecarError } from "../journey-review-store.js";
import { resolveCatalogDir } from "../catalog-api.js";
import { CatalogInputError } from "../catalog.js";
import { TargetConfigError } from "../target-config.js";
import { FULL_FLAG_HELP, targetsOpts } from "./shared.js";

/** Registers `jevitate journey review`. */
export function registerJourneyReview(journey: Command, program: Command, deps: CliDeps): void {
  // #432 — the review sheet a reviewer reads before `journey promote`: what the Journey does, what it
  // changes, what it proves, what changed since its last approval, and the content hash to bind to.
  journey
    .command("review [id]")
    .description(
      "a human-readable review sheet for promotion sign-off: summary, steps, side effects, inputs (names only), proof, change since last approval, content hash. #467: --stale (no id) lists every promoted Journey whose approval is stale, labelling step-id-only changes",
    )
    .option("--dir <path>", "journeys directory (default: the repo's .jevitate/journeys; outside a repo ~/.jevitate/journeys)")
    .option("--markdown", "render the sheet as Markdown")
    .option("--full", FULL_FLAG_HELP)
    .option("--out <file>", "write the sheet (JSON with --json, Markdown with --markdown, else text) to this file")
    .option("--readiness", READINESS_FLAG_HELP)
    .option("--real", REAL_JEV_FLAG_HELP)
    .option("--jev-provider <provider>", JEV_PROVIDER_FLAG_HELP, jevProviderArg)
    .option("--stale", "#467: instead of one sheet, list every promoted Journey whose approval is stale (needs re-approval), labelling the ones whose only change is minted step ids")
    .option("--json", "emit a JSON envelope (the schema-checked sheet)")
    .action(async function (this: Command, id: string | undefined) {
      const { dir, json, markdown, full, out: outFile, readiness, real, jevProvider, stale } = this.opts<{ dir?: string; json?: boolean; full?: boolean; markdown?: boolean; out?: string; readiness?: boolean; real?: boolean; jevProvider?: string; stale?: boolean }>();
      if (json === true && markdown === true) {
        emitJson(program, fail("E_JOURNEY_REVIEW_ARGS", "--json and --markdown are exclusive: pick one rendering"));
        return;
      }
      if (stale === true) {
        // #467: the stale list — read-only; one sheet's flags do not apply to it.
        if (id !== undefined || markdown === true || full === true || outFile !== undefined || readiness === true || real === true || jevProvider !== undefined) {
          emitJson(program, fail("E_JOURNEY_REVIEW_ARGS", "--stale lists every stale Journey: it takes no <id> and none of --markdown/--full/--out/--readiness/--real/--jev-provider"));
          return;
        }
        try {
          const result = await listStaleJourneys({ journeysDir: resolveJourneysDir(deps, dir), catalogDir: resolveCatalogDir(deps.catalogDir) });
          if (json) emitJson(program, ok(result));
          else program.configureOutput().writeOut?.(renderStaleJourneys(result));
          process.exitCode = 0;
        } catch (err) {
          emitJson(program, fail("E_JOURNEY_REVIEW", String(err instanceof Error ? err.message : err)));
        }
        return;
      }
      if (id === undefined) {
        emitJson(program, fail("E_JOURNEY_REVIEW_ARGS", "journey review needs a Journey <id> (or --stale for the list of Journeys needing re-approval)"));
        return;
      }
      try {
        const jev = await jevSetupFor(deps, resolveCatalogDir(deps.catalogDir), { real, jevProvider });
        const { review } = await reviewJourneyById(resolveJourneysDir(deps, dir), id, { ...targetsOpts(deps), catalogDir: resolveCatalogDir(deps.catalogDir), readiness: readiness === true, jev });
        const renderOpts = reviewRenderOptions({ full: full === true, toFile: outFile !== undefined });
        const rendered = json ? `${JSON.stringify(review, null, 2)}\n` : markdown ? renderReviewMarkdown(review, renderOpts) : renderReviewText(review, renderOpts);
        if (outFile !== undefined) await writeFile(outFile, rendered, { mode: 0o600 });
        if (json) {
          emitJson(program, ok(review));
        } else if (outFile !== undefined) {
          program.configureOutput().writeOut?.(`review sheet for journey '${review.id}' written to ${outFile} (content hash ${review.contentHash})\n`);
        } else {
          program.configureOutput().writeOut?.(rendered);
        }
        emitUsageLine(program, review.jev);
        // #434: a review never fails on its findings (readiness and Jev answers are advice).
        process.exitCode = 0;
      } catch (err) {
        if (err instanceof UnknownJourneyError) {
          emitJson(program, fail("E_UNKNOWN_JOURNEY", String(err.message)));
        } else if (err instanceof ReviewSidecarError || err instanceof CatalogInputError) {
          emitJson(program, fail(err.code, err.message));
        } else if (err instanceof TargetConfigError) {
          emitJson(program, fail("E_TARGET_CONFIG", err.message));
        } else if (err instanceof GatewaySelectionError || err instanceof MissingCredentialError) {
          emitJson(program, fail("E_AI_SETUP_REQUIRED", err.message));
        } else if (err instanceof Error && err.message.startsWith("Invalid journey id")) {
          emitJson(program, fail("E_JOURNEY_REVIEW_ARGS", err.message));
        } else {
          emitJson(program, fail("E_JOURNEY_REVIEW", String(err instanceof Error ? err.message : err)));
        }
      }
    });
}
