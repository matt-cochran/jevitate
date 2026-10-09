import { writeFile } from "node:fs/promises";
import { Command } from "commander";
import { ok, fail } from "./envelope.js";
import { MissingCredentialError } from "@jevitate/ai-core";
import { GatewaySelectionError, JEV_PROVIDER_FLAG_HELP, emitJson, emitUsageLine, jevProviderArg, resolveJourneysDir, type CliDeps } from "./cli-shared.js";
import { intArg, positiveIntArg } from "./cli-args.js";
import { CATALOG_ID_RE } from "@jevitate/journey";
import { NotImplementedError } from "./not-implemented.js";
import { DRAFT_OUTCOMES_DEFAULT, DRAFT_OUTCOMES_MAX, DRAFT_OUTCOMES_MIN, draftJobOutcomes, renderDraftJobOutcomes } from "./job-draft-api.js";
import { CATALOG_EXPORT_FORMATS, exportCatalogBundle, renderCatalogExport, type CatalogExportFormat } from "./catalog-bundle-api.js";
import { JOURNEEZE_DEFAULT_URL, connectJourneeze, publishToJourneeze, renderPublishJourneeze } from "./journeeze-api.js";
import { buildJevSetup, jevCacheDir, type JevSetup } from "./jev-advisor.js";
import { analyzeCatalog, renderCatalogAnalysis, ANALYZE_PAIR_CAP } from "./catalog-analysis.js";
import { CatalogInputError, UnknownCatalogItemError } from "./catalog.js";
import { StaleCatalogReviewError, approveCatalogItem, catalogJourneysDir, loadCatalog, resolveCatalogDir } from "./catalog-api.js";
import { buildCatalogStatus, buildJobReview, buildPersonaReview, renderCatalogStatus, renderJobReview, renderPersonaReview } from "./catalog-review.js";
import { ApprovalFindingsError } from "./pre-approval.js";
import { EXIT_CODES } from "./exit-codes.js";
import {
  ApprovalArgsError,
  approvalRefusal,
  approvalsReport,
  checkNonInteractiveReason,
  describeProvenance,
  inMcpInvocation,
  makeApprovalConfirm,
  parseAllowedChannels,
  renderApprovals,
} from "./approval-provenance.js";

/**
 * #433 — the catalog commands: `persona review|approve <id>`, `job review|approve <id>` and
 * `catalog status`. Approving is a person's act: these approve commands are CLI only (no MCP tool;
 * MCP gets the read-only `review_persona`, `review_job` and `catalog_status`).
 */

const DIR_HELP = "the project data dir holding personas.json and jobs.json (default: the repo's .jevitate/); its journeys/ are the Journeys";

/**
 * #437/#469: `--allow-channels` help (catalog status; check uses the same text). `pr-review` is a channel a
 * caller can ALLOW, never one it can claim: jevitate records it only after verifying the approving
 * review through the forge API (in CI) — no flag or MCP argument sets it.
 */
export const ALLOW_CHANNELS_HELP =
  "#437: with --require-approvals, the approval channels that pass (comma list of tty, non-interactive, mcp, ci, pr-review; default tty). #469: pr-review is recorded only by jevitate after it verifies an approving review of the merged PR through the forge API — never set by a caller";

/** #434/#435: `--readiness` / `--real` / `--jev-provider` help. */
export const READINESS_FLAG_HELP =
  "#434: add the Readiness section — deterministic checks with INCOSE GtWR rule findings, and (with --real and a judgment key) advisory Jev questions with probabilities";
export const REAL_JEV_FLAG_HELP =
  "#434/#435: ask Jev (advisory; never blocks on its own) — readiness questions and catalog pair classifications, cached by content hash. Without a judgment key the Jev layer is skipped, the deterministic layer still runs";

/** The Jev layer of a catalog command (`--real`), its answer cache under the catalog's data dir. */
export function jevSetupFor(deps: CliDeps, catalogDir: string | null, o: { real?: boolean; jevProvider?: string }): Promise<JevSetup> {
  return buildJevSetup(deps, { ...(o.real === undefined ? {} : { real: o.real }), ...(o.jevProvider === undefined ? {} : { jevProvider: o.jevProvider }), cacheDir: jevCacheDir(catalogDir) });
}

function refuse(program: Command, err: unknown, fallbackCode: string): void {
  const refusal = approvalRefusal(err);
  if (err instanceof NotImplementedError) {
    // 0.10 surface: a registered command whose feature has not landed — exit 2, never a pass.
    emitJson(program, fail(err.code, err.message));
  } else if (refusal !== null) {
    emitJson(program, fail(refusal.code, refusal.message));
  } else if (err instanceof GatewaySelectionError || err instanceof MissingCredentialError) {
    emitJson(program, fail("E_AI_SETUP_REQUIRED", err.message));
  } else if (err instanceof UnknownCatalogItemError) {
    emitJson(program, fail(err.code, err.message));
  } else if (err instanceof CatalogInputError || err instanceof StaleCatalogReviewError) {
    emitJson(program, fail(err.code, err.message));
  } else if (err instanceof ApprovalFindingsError) {
    // #433: a refusal on the item's findings — exit 1 (a gating finding), like E_JOURNEY_WEAK.
    emitJson(program, fail(err.code, err.message));
    process.exitCode = EXIT_CODES.defects;
  } else {
    emitJson(program, fail(fallbackCode, String(err instanceof Error ? err.message : err)));
  }
}

function registerItemCommands(program: Command, deps: CliDeps, kind: "persona" | "job"): void {
  const group = program
    .command(kind)
    .description(
      kind === "persona"
        ? "#433: catalog personas (.jevitate/personas.json) — review a persona's sheet, approve it (a person's sign-off, bound to its content hash)"
        : "#433: catalog jobs — job stories in .jevitate/jobs.json (\"When …, I want to …, so I can ….\") — review a job's sheet, approve it (bound to its content hash)",
    );
  const code = kind === "persona" ? "E_PERSONA" : "E_JOB";
  const argsCode = kind === "persona" ? "E_PERSONA_REVIEW_ARGS" : "E_JOB_REVIEW_ARGS";

  const load = (dir: string | undefined) => loadCatalog(resolveCatalogDir(deps.catalogDir, dir), catalogJourneysDir(dir, resolveJourneysDir(deps)));
  const sheet = async (dir: string | undefined, id: string, action: "review" | "persona approve" | "job approve", opts: { readiness: boolean; jev: JevSetup }) => {
    const catalog = await load(dir);
    if (kind === "persona") {
      const review = await buildPersonaReview(catalog, id, action, opts);
      return { catalog, review, render: (style: "markdown" | "text") => renderPersonaReview(review, style) };
    }
    const review = await buildJobReview(catalog, id, action, opts);
    return { catalog, review, render: (style: "markdown" | "text") => renderJobReview(review, style) };
  };

  group
    .command("review <id>")
    .description(
      kind === "persona"
        ? "a persona's review sheet: who it is, the jobs it serves, the Journeys linked to it, its approval state (stale = needs re-review), the pre-approval findings, its content hash"
        : "a job's review sheet: its story, its personas and which have a promoted Journey for it, the gaps, its Journeys, its approval state, the pre-approval findings, its content hash",
    )
    .option("--dir <path>", DIR_HELP)
    .option("--markdown", "render the sheet as Markdown")
    .option("--out <file>", "write the sheet (JSON with --json, Markdown with --markdown, else text) to this file")
    .option("--readiness", READINESS_FLAG_HELP)
    .option("--real", REAL_JEV_FLAG_HELP)
    .option("--jev-provider <provider>", JEV_PROVIDER_FLAG_HELP, jevProviderArg)
    .option("--json", "emit a JSON envelope (the schema-checked sheet)")
    .action(async function (this: Command, id: string) {
      const { dir, json, markdown, out: outFile, readiness, real, jevProvider } = this.opts<{ dir?: string; json?: boolean; markdown?: boolean; out?: string; readiness?: boolean; real?: boolean; jevProvider?: string }>();
      if (json === true && markdown === true) {
        emitJson(program, fail(argsCode, "--json and --markdown are exclusive: pick one rendering"));
        return;
      }
      try {
        const jev = await jevSetupFor(deps, resolveCatalogDir(deps.catalogDir, dir), { real, jevProvider });
        const { review, render } = await sheet(dir, id, "review", { readiness: readiness === true, jev });
        const rendered = json ? `${JSON.stringify(review, null, 2)}\n` : render(markdown ? "markdown" : "text");
        if (outFile !== undefined) await writeFile(outFile, rendered, { mode: 0o600 });
        if (json) emitJson(program, ok(review));
        else if (outFile !== undefined) program.configureOutput().writeOut?.(`review sheet for ${kind} '${review.id}' written to ${outFile} (content hash ${review.contentHash})\n`);
        else program.configureOutput().writeOut?.(rendered);
        emitUsageLine(program, review.jev);
        // #434: a review never fails on its findings (readiness and Jev answers are advice).
        process.exitCode = 0;
      } catch (err) {
        refuse(program, err, `${code}_REVIEW`);
      }
    });

  group
    .command("approve <id>")
    .description(
      `approve a ${kind} (a person's sign-off; CLI only, never an MCP tool): shows its review sheet, runs the pre-approval findings, then records {contentHash, at} in ${kind === "persona" ? "personas.json" : "its jobs file"}. Editing it later makes it — and its Journeys — "needs re-review"`,
    )
    .option("--dir <path>", DIR_HELP)
    .option("--reviewed-hash <hash>", `the content hash of the review sheet you read; refused (E_CATALOG_REVIEW_STALE) if the ${kind} changed since`)
    .option("--accept-findings <reason>", "approve although pre-approval findings need an acknowledgment, recording the reason with the approval")
    .option("--real", `${REAL_JEV_FLAG_HELP}; a conflicting/duplicate pair classification at or above the documented threshold then needs --accept-findings`)
    .option("--jev-provider <provider>", JEV_PROVIDER_FLAG_HELP, jevProviderArg)
    .option(
      "--non-interactive-approval <reason>",
      "#437: approve without a terminal confirmation (a scripted setup), recorded as channel non-interactive (ci under a CI marker) with the reason — never as a person's; check --require-approvals fails it. A coding agent never uses this",
    )
    .option("--json", "emit a JSON envelope")
    .action(async function (this: Command, id: string) {
      const { dir, json, reviewedHash: hashFlag, acceptFindings, real, jevProvider, nonInteractiveApproval } = this.opts<{
        dir?: string;
        json?: boolean;
        reviewedHash?: string;
        acceptFindings?: string;
        real?: boolean;
        jevProvider?: string;
        nonInteractiveApproval?: string;
      }>();
      let reviewedHash = hashFlag?.trim().toLowerCase();
      if (reviewedHash !== undefined && !/^[0-9a-f]{64}$/.test(reviewedHash)) {
        emitJson(program, fail(argsCode, "--reviewed-hash needs the 64-hex content hash a review sheet shows"));
        return;
      }
      if (acceptFindings !== undefined && acceptFindings.trim() === "") {
        emitJson(program, fail(argsCode, "--accept-findings needs a reason"));
        return;
      }
      try {
        checkNonInteractiveReason(nonInteractiveApproval);
        const action = kind === "persona" ? "persona approve" : "job approve";
        // #434/#435: every approval shows readiness and the catalog analysis; Jev only with --real.
        const jev = await jevSetupFor(deps, resolveCatalogDir(deps.catalogDir, dir), { real, jevProvider });
        const { catalog, review, render } = await sheet(dir, id, action, { readiness: true, jev });
        if (!json) {
          // Human mode: the sheet (with its findings) is shown before approving; the approval binds to what was shown.
          program.configureOutput().writeOut?.(`${render("text")}\n`);
          reviewedHash ??= review.contentHash;
        }
        const result = await approveCatalogItem(kind, catalog, id, {
          ...(reviewedHash === undefined ? {} : { reviewedHash }),
          ...(acceptFindings === undefined ? {} : { acceptFindings }),
          jev,
          // #437: a typed confirmation on a TTY (or the escape hatch), recorded as provenance.
          confirm: makeApprovalConfirm(deps.approval, nonInteractiveApproval === undefined ? {} : { nonInteractiveReason: nonInteractiveApproval }),
        });
        emitUsageLine(program, review.jev);
        if (json) emitJson(program, ok(result));
        else {
          program.configureOutput().writeOut?.(
            `approved ${kind} '${id}' (content hash ${result.approval.contentHash}; ${describeProvenance(result.approval.provenance)})${result.previousStatus === "stale" ? " — re-approved: its Journeys no longer need re-review on its account" : ""}\n`,
          );
          process.exitCode = 0;
        }
      } catch (err) {
        refuse(program, err, `${code}_APPROVE`);
      }
    });

  if (kind === "job") registerJobDraftOutcomes(group, program, deps);
}

/**
 * #465b: `job draft-outcomes <jobId>` — 1–3 desired outcomes drafted by the generation model and
 * written into the jobs file as `provenance: ai_draft` for the team to review. It never approves
 * (MCP `draft_job_outcomes` mirrors it; approving stays `job approve`, CLI only).
 */
function registerJobDraftOutcomes(group: Command, program: Command, deps: CliDeps): void {
  group
    .command("draft-outcomes <jobId>")
    .description(
      `#465: draft ${DRAFT_OUTCOMES_MIN}–${DRAFT_OUTCOMES_MAX} desired outcomes for a job with the generation model and write them into its jobs file marked provenance ai_draft, for the team to review. Never approves: an approved job becomes "needs re-review"`,
    )
    .option("--dir <path>", DIR_HELP)
    .option("--count <n>", `how many outcomes to draft (${DRAFT_OUTCOMES_MIN}-${DRAFT_OUTCOMES_MAX}, default ${DRAFT_OUTCOMES_DEFAULT})`, intArg({ min: DRAFT_OUTCOMES_MIN, max: DRAFT_OUTCOMES_MAX }))
    .option("--real", "draft with the live OpenRouter generation gateway (requires keys)", false)
    .option("--fake-ai", "draft with the deterministic fake generator (pipeline smoke only)", false)
    .option("--json", "emit a JSON envelope")
    .action(async function (this: Command, jobId: string) {
      const { dir, json, count, real, fakeAi } = this.opts<{ dir?: string; json?: boolean; count?: number; real?: boolean; fakeAi?: boolean }>();
      if (!CATALOG_ID_RE.test(jobId)) {
        emitJson(program, fail("E_JOB_DRAFT_ARGS", `<jobId> must be a catalog id (1-64 of [A-Za-z0-9._-], starting alphanumeric), got ${JSON.stringify(jobId)}`));
        return;
      }
      if ((real === true) === (fakeAi === true)) {
        emitJson(program, fail("E_JOB_DRAFT_ARGS", "drafting needs exactly one generation gateway: --real (live) or --fake-ai (deterministic)"));
        return;
      }
      try {
        const result = await draftJobOutcomes(
          {
            catalogDir: resolveCatalogDir(deps.catalogDir, dir),
            journeysDir: catalogJourneysDir(dir, resolveJourneysDir(deps)),
            jobId,
            count: count ?? DRAFT_OUTCOMES_DEFAULT,
            ai: { real: real === true, fakeAi: fakeAi === true },
          },
          deps,
        );
        if (json) emitJson(program, ok(result));
        else program.configureOutput().writeOut?.(renderDraftJobOutcomes(result));
        process.exitCode = 0;
      } catch (err) {
        refuse(program, err, "E_JOB_DRAFT");
      }
    });
}

export function registerCatalogCommands(program: Command, deps: CliDeps): void {
  registerItemCommands(program, deps, "persona");
  registerItemCommands(program, deps, "job");

  const catalog = program.command("catalog").description("#433: the human-vetted catalog of personas, jobs and the Journeys linked to them");
  catalog
    .command("status")
    .description("the jobs × personas matrix (which have a promoted Journey), approved jobs with no promoted Journey, Journeys linked to nothing, dangling links and stale approvals")
    .option("--dir <path>", DIR_HELP)
    .option("--require-approvals", "#437: exit 1 when a promoted Journey or an approved persona/job has a missing or stale approval, or one made over a channel not allowed (--allow-channels)")
    .option("--allow-channels <list>", ALLOW_CHANNELS_HELP)
    .option("--json", "emit a JSON envelope (the schema-checked report)")
    .action(async function (this: Command) {
      const { dir, json, requireApprovals, allowChannels } = this.opts<{ dir?: string; json?: boolean; requireApprovals?: boolean; allowChannels?: string }>();
      try {
        if (allowChannels !== undefined && requireApprovals !== true) throw new ApprovalArgsError("--allow-channels needs --require-approvals");
        const allowed = requireApprovals === true ? parseAllowedChannels(allowChannels) : undefined;
        const catalog = await loadCatalog(resolveCatalogDir(deps.catalogDir, dir), catalogJourneysDir(dir, resolveJourneysDir(deps)));
        // #437: every recorded approval and how it was made; with --require-approvals, the violations.
        const approvals = approvalsReport([catalog], allowed);
        const report = { ...buildCatalogStatus(catalog), approvals };
        const failed = (approvals.requirement?.violations.length ?? 0) > 0;
        if (json) emitJson(program, ok(report));
        else program.configureOutput().writeOut?.(`${renderCatalogStatus(report)}${renderApprovals(approvals)}`);
        process.exitCode = failed ? EXIT_CODES.defects : 0;
      } catch (err) {
        refuse(program, err, "E_CATALOG_STATUS");
      }
    });

  catalog
    .command("analyze")
    .description(
      "#435: problems BETWEEN catalog items, grouped by INCOSE GtWR set characteristic — candidate pairs (paired by code: shared persona/terms, opposing writes, same role) classified by Jev (with --real) as compatible/duplicate/overlapping/conflicting/dependent, " +
        "completeness gaps, and update advice (stale approvals, Journeys whose last mutation proof fails). Read-only and advisory: it never changes the catalog and never gates",
    )
    .option("--dir <path>", DIR_HELP)
    .option("--real", "#435: classify the candidate pairs with Jev (advisory; cached by content hash). Without a judgment key: the deterministic layer only")
    .option("--jev-provider <provider>", JEV_PROVIDER_FLAG_HELP, jevProviderArg)
    .option("--max-pairs <n>", `the most candidate pairs to judge (default ${ANALYZE_PAIR_CAP}); the rest are listed as overflow, never dropped`, positiveIntArg)
    .option("--markdown", "render the report as Markdown")
    .option("--json", "emit a JSON envelope (the schema-checked report)")
    .action(async function (this: Command) {
      const { dir, json, markdown, real, jevProvider, maxPairs } = this.opts<{ dir?: string; json?: boolean; markdown?: boolean; real?: boolean; jevProvider?: string; maxPairs?: number }>();
      if (json === true && markdown === true) {
        emitJson(program, fail("E_CATALOG_ANALYZE_ARGS", "--json and --markdown are exclusive: pick one rendering"));
        return;
      }
      try {
        const catalogDir = resolveCatalogDir(deps.catalogDir, dir);
        const loaded = await loadCatalog(catalogDir, catalogJourneysDir(dir, resolveJourneysDir(deps)));
        const jev = await jevSetupFor(deps, catalogDir, { real, jevProvider });
        const { report } = await analyzeCatalog(loaded, { jev, ...(maxPairs === undefined ? {} : { pairCap: maxPairs }) });
        if (json) emitJson(program, ok(report));
        else program.configureOutput().writeOut?.(renderCatalogAnalysis(report, markdown ? "markdown" : "text"));
        emitUsageLine(program, report.jev);
        // Advisory: the report's findings never change the exit code.
        process.exitCode = 0;
      } catch (err) {
        refuse(program, err, "E_CATALOG_ANALYZE");
      }
    });

  // #464: the Journeeze catalog bundle — written under --out; never uploads, never approves.
  catalog
    .command("export")
    .description(
      "#464: write the catalog (personas, jobs, Journeys with their approvals, links, checks, findings; no media) as a Journeeze catalog bundle (bundle.json) under --out. Never uploads (publish journeeze) and never approves",
    )
    .requiredOption("--format <format>", `the bundle format (${CATALOG_EXPORT_FORMATS.join(" | ")})`)
    .requiredOption("--out <dir>", "the directory bundle.json is written to (created if missing)")
    .option("--dir <path>", DIR_HELP)
    .option("--json", "emit a JSON envelope")
    .action(async function (this: Command) {
      const { dir, json, format, out } = this.opts<{ dir?: string; json?: boolean; format: string; out: string }>();
      if (!(CATALOG_EXPORT_FORMATS as readonly string[]).includes(format)) {
        emitJson(program, fail("E_CATALOG_EXPORT_ARGS", `--format must be one of ${CATALOG_EXPORT_FORMATS.join(" | ")} (got ${JSON.stringify(format)})`));
        return;
      }
      if (out.trim() === "" || out.includes("\0")) {
        emitJson(program, fail("E_CATALOG_EXPORT_ARGS", "--out needs a directory path"));
        return;
      }
      try {
        const result = await exportCatalogBundle({
          format: format as CatalogExportFormat,
          catalogDir: resolveCatalogDir(deps.catalogDir, dir),
          journeysDir: catalogJourneysDir(dir, resolveJourneysDir(deps)),
          outDir: out,
        });
        if (json) emitJson(program, ok(result));
        else program.configureOutput().writeOut?.(renderCatalogExport(result));
        process.exitCode = 0;
      } catch (err) {
        refuse(program, err, "E_CATALOG_EXPORT");
      }
    });

  // #464: `connect journeeze` — CLI ONLY (it handles the upload key: read from stdin without echo,
  // never from a flag or argument); there is no MCP tool for it (mcp-cli-parity.test.ts EXCLUDED).
  const connect = program.command("connect").description("#464: connect this project to a service it publishes to (stores the service's key in jevitate's secret store; a person at a terminal)");
  connect
    .command("journeeze")
    .description(
      `#464: connect this project to a Journeeze product: reads the product's upload key from stdin without echo (never a flag), checks it (whoami), asks you to confirm the product, and stores key + URL in jevitate's secret store. CLI only — never an MCP tool`,
    )
    .option("--url <url>", `the Journeeze base URL (default ${JOURNEEZE_DEFAULT_URL})`)
    .option("--json", "emit a JSON envelope (never contains the key)")
    .action(async function (this: Command) {
      const { json, url } = this.opts<{ json?: boolean; url?: string }>();
      const baseUrl = url ?? JOURNEEZE_DEFAULT_URL;
      let parsed: URL | undefined;
      try {
        parsed = new URL(baseUrl);
      } catch {
        parsed = undefined;
      }
      if (parsed === undefined || (parsed.protocol !== "https:" && parsed.protocol !== "http:") || parsed.username !== "" || parsed.password !== "" || parsed.search !== "") {
        emitJson(program, fail("E_CONNECT_ARGS", `--url must be an http(s) base URL with no credentials or query (got ${JSON.stringify(baseUrl)})`));
        return;
      }
      if (inMcpInvocation()) {
        // Belt and braces: no MCP tool maps here, but the key is never handled inside an MCP call.
        emitJson(program, fail("E_CONNECT_NEEDS_HUMAN", "connect journeeze is a person's act at their own terminal (it reads the upload key); it never runs over MCP"));
        return;
      }
      try {
        const result = await connectJourneeze({ baseUrl: parsed.origin + parsed.pathname.replace(/\/+$/, ""), projectDir: resolveCatalogDir(deps.catalogDir) });
        if (json) emitJson(program, ok(result));
        else program.configureOutput().writeOut?.(`connected to Journeeze product '${result.product.name}' (key ${result.keyPrefix}…) at ${result.baseUrl}\n`);
        process.exitCode = 0;
      } catch (err) {
        refuse(program, err, "E_CONNECT");
      }
    });

  // #464: `publish journeeze` — export + upload with the key jevitate resolves itself (secret store
  // or JOURNEEZE_UPLOAD_KEY in CI). MCP `publish_to_journeeze` mirrors it and never sees the key.
  const publish = program.command("publish").description("#464: publish this project's catalog to a connected service");
  publish
    .command("journeeze")
    .description(
      "#464: export the catalog bundle and upload it to the connected Journeeze product (key from jevitate's secret store, or JOURNEEZE_UPLOAD_KEY in CI — never an argument), then wait for it to be imported or refused. Never approves",
    )
    .option("--dir <path>", DIR_HELP)
    .option("--dry-run", "export and validate the bundle and resolve the connection, but send nothing")
    .option("--json", "emit a JSON envelope (never contains the key)")
    .action(async function (this: Command) {
      const { dir, json, dryRun } = this.opts<{ dir?: string; json?: boolean; dryRun?: boolean }>();
      try {
        const result = await publishToJourneeze({ catalogDir: resolveCatalogDir(deps.catalogDir, dir), journeysDir: catalogJourneysDir(dir, resolveJourneysDir(deps)), dryRun: dryRun === true });
        if (json) emitJson(program, ok(result));
        else program.configureOutput().writeOut?.(renderPublishJourneeze(result));
        process.exitCode = result.status === "refused" ? EXIT_CODES.defects : 0;
      } catch (err) {
        refuse(program, err, "E_PUBLISH_JOURNEEZE");
      }
    });
}
