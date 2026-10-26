import { type CliDeps, JEV_PROVIDER_FLAG_HELP, emitUsageLine, jevProviderArg, emitJson, GatewaySelectionError } from "../cli-shared.js";
import { withProjectFlags } from "../project-layout.js";
import { READINESS_FLAG_HELP, REAL_JEV_FLAG_HELP, jevSetupFor } from "../catalog-cli.js";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Command } from "commander";
import { MissingCredentialError } from "@jevitate/ai-core";
import { EXIT_CODES } from "../exit-codes.js";
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
import { FULL_FLAG_HELP, DEPRECATED_DIR_HELP, flaggedCatalogDir, journeyLayout, targetsOpts } from "./shared.js";
import { loadJourneezeHintPreference, renderJourneezeHint } from "../journeeze-hint.js";

async function reviewJourneezeHint(json: boolean, outFile: string | undefined): Promise<string> {
  if (json || outFile !== undefined) return "";
  try {
    const raw: unknown = JSON.parse(await readFile(join(process.cwd(), "jevitate.lock"), "utf8"));
    const sharedSource = raw !== null && typeof raw === "object" && !Array.isArray(raw) && Array.isArray((raw as Record<string, unknown>).sources) && (raw as { sources: unknown[] }).sources.length > 0;
    return renderJourneezeHint(
      { sharedSource, journeyAuthors: [], unresolvedFindings: 0, strictReviewApproved: false },
      await loadJourneezeHintPreference(),
      { isTTY: process.stdout.isTTY === true, json },
    ) ?? "";
  } catch {
    return "";
  }
}

/** Registers `jevitate journey review`. */
export function registerJourneyReview(journey: Command, program: Command, deps: CliDeps): void {
  // #432 — the review sheet a reviewer reads before `journey promote`: what the Journey does, what it
  // changes, what it proves, what changed since its last approval, and the content hash to bind to.
  withProjectFlags(journey
    .command("review [id]"))
    .description(
      "a human-readable review sheet for promotion sign-off: summary, steps, side effects, inputs (names only), proof, change since last approval, content hash. #467: --stale (no id) lists every promoted Journey whose approval is stale, labelling step-id-only changes",
    )
    .option("--dir <path>", DEPRECATED_DIR_HELP)
    .option("--markdown", "render the sheet as Markdown")
    .option("--full", FULL_FLAG_HELP)
    .option("--out <file>", "write the sheet (JSON with --json, Markdown with --markdown, else text) to this file")
    .option("--readiness", READINESS_FLAG_HELP)
    .option("--real", REAL_JEV_FLAG_HELP)
    .option("--jev-provider <provider>", JEV_PROVIDER_FLAG_HELP, jevProviderArg)
    .option("--strict", "#523: exit 1 (defects) when the sheet has any ⚠ attention item, and run the code-only readiness link checks (missing job / persona) even without --readiness; advisory ○ items and Jev never fail it. With --json the envelope also carries strict: { passed, warnings }")
    .option("--stale", "#467: instead of one sheet, list every promoted Journey whose approval is stale (needs re-approval), labelling the ones whose only change is minted step ids")
    .option("--json", "emit a JSON envelope (the schema-checked sheet)")
    .action(async function (this: Command, id: string | undefined) {
      const locationFlags = this.opts<{ dir?: string; project?: string; journeysDir?: string }>();
      const layout = journeyLayout(program, deps, { dir: locationFlags.dir, project: locationFlags.project, journeysDir: locationFlags.journeysDir });
      if (layout === null) return;
      const reviewJourneysDir = layout.journeysDir;
      const { json, markdown, full, out: outFile, readiness, real, jevProvider, stale, strict } = this.opts<{ dir?: string; json?: boolean; full?: boolean; markdown?: boolean; out?: string; readiness?: boolean; real?: boolean; jevProvider?: string; stale?: boolean; strict?: boolean }>();
      if (json === true && markdown === true) {
        emitJson(program, fail("E_JOURNEY_REVIEW_ARGS", "--json and --markdown are exclusive: pick one rendering"));
        return;
      }
      if (stale === true) {
        // #467: the stale list — read-only; one sheet's flags do not apply to it.
        if (id !== undefined || markdown === true || full === true || outFile !== undefined || readiness === true || real === true || jevProvider !== undefined || strict === true) {
          emitJson(program, fail("E_JOURNEY_REVIEW_ARGS", "--stale lists every stale Journey: it takes no <id> and none of --markdown/--full/--out/--readiness/--real/--jev-provider/--strict"));
          return;
        }
        try {
          const result = await listStaleJourneys({ journeysDir: reviewJourneysDir, catalogDir: resolveCatalogDir(deps.catalogDir, flaggedCatalogDir(layout)) });
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
        const jev = await jevSetupFor(deps, resolveCatalogDir(deps.catalogDir, flaggedCatalogDir(layout)), { real, jevProvider });
        const { review } = await reviewJourneyById(reviewJourneysDir, id, { ...targetsOpts(deps), catalogDir: resolveCatalogDir(deps.catalogDir, flaggedCatalogDir(layout)), readiness: readiness === true, strict: strict === true, jev });
        const warnings = (review.attention ?? []).filter((a) => a.severity === "warn").length;
        const strictVerdict = { passed: warnings === 0, warnings };
        const renderOpts = reviewRenderOptions({ full: full === true, toFile: outFile !== undefined });
        const rendered = json ? `${JSON.stringify(review, null, 2)}\n` : markdown ? renderReviewMarkdown(review, renderOpts) : renderReviewText(review, renderOpts);
        if (outFile !== undefined) await writeFile(outFile, rendered, { mode: 0o600 });
        if (json) {
          emitJson(program, strict === true ? Object.assign(ok(review), { strict: strictVerdict }) : ok(review));
        } else if (outFile !== undefined) {
          program.configureOutput().writeOut?.(`review sheet for journey '${review.id}' written to ${outFile} (content hash ${review.contentHash})\n`);
        } else {
          program.configureOutput().writeOut?.(`${rendered}${await reviewJourneezeHint(false, outFile)}`);
        }
        emitUsageLine(program, review.jev);
        // #434: a plain review never fails on its findings (readiness and Jev answers are advice).
        // #523: --strict fails (defects) on any ⚠ attention item; ○ items never do.
        process.exitCode = strict === true && !strictVerdict.passed ? EXIT_CODES.defects : 0;
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
