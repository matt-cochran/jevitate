import { type CliDeps, JEV_PROVIDER_FLAG_HELP, jevProviderArg, resolveJourneysDir, emitJson, GatewaySelectionError } from "../cli-shared.js";
import { REAL_JEV_FLAG_HELP, jevSetupFor } from "../catalog-cli.js";
import { readFile } from "node:fs/promises";
import { Command } from "commander";
import { MissingCredentialError } from "@jevitate/ai-core";
import { ok, fail } from "../envelope.js";
import { promoteJourney, WeakJourneyError, UnknownJourneyError, StaleReviewError, JourneyProposalArgsError } from "../journey-api.js";
import { reviewRenderOptions } from "../review-render-options.js";
import { type JourneyReviewAttention } from "@jevitate/journey";
import { ReviewSheetError, renderReviewText, reviewSheetHash } from "../journey-review.js";
import { reviewJourneyById } from "../journey-review-api.js";
import { ReviewSidecarError } from "../journey-review-store.js";
import { JourneyProposalInvalidError, JourneyProposalNotFoundError, JourneyProposalProofError, JourneyProposalStaleError, isProposalId } from "../journey-proposal-store.js";
import { rejectionProvenance, approvalRefusal, checkNonInteractiveReason, describeProvenance, makeApprovalConfirm } from "../approval-provenance.js";
import { UnvettedLinksError, resolveCatalogDir } from "../catalog-api.js";
import { CatalogInputError } from "../catalog.js";
import { ApprovalFindingsError } from "../pre-approval.js";
import { TargetConfigError } from "../target-config.js";
import { FULL_FLAG_HELP, lintFindingLine, targetsOpts } from "./shared.js";

/** Registers `jevitate journey promote`. */
export function registerJourneyPromote(journey: Command, program: Command, deps: CliDeps): void {
  // #124 — promote a local Journey so it becomes discoverable/runnable (journey
  // find / MCP find_capabilities / run_journey), mirroring `mission target
  // promote`'s human-approval-gate semantics: promoting is a deliberate,
  // explicit act, never automatic (an authored Journey's `metadata.promoted`
  // always starts `false` — see `explore-author-journey`/`jevitate record`).
  journey
    .command("promote <id>")
    .description("promote a local Journey (human-approval gate) so it becomes discoverable/runnable; shows its review sheet first and records the approval")
    .option("--dir <path>", "journeys directory (default: the repo's .jevitate/journeys; outside a repo ~/.jevitate/journeys)")
    .option("--accept-weak <reason>", "#401: promote a Journey whose assertions cannot prove its outcome, recording the reason")
    .option("--full", FULL_FLAG_HELP)
    .option("--reviewed-hash <hash>", "#432: the content hash of the review sheet you read; refused (E_JOURNEY_REVIEW_STALE) if the Journey changed since")
    .option("--review-sheet <file>", "#432: the review sheet file you read (journey review --out); its content hash binds the approval like --reviewed-hash")
    .option("--accept-unvetted <reason>", "#433: promote although its linked job/persona is not approved (unknown, draft or stale), recording the reason in approval.waivers")
    .option("--accept-findings <reason>", "#433: promote although pre-approval findings need an acknowledgment, recording the reason in approval.acceptedFindings")
    .option("--real", `${REAL_JEV_FLAG_HELP}; a conflicting/duplicate pair classification at or above the documented threshold then needs --accept-findings`)
    .option("--jev-provider <provider>", JEV_PROVIDER_FLAG_HELP, jevProviderArg)
    .option(
      "--non-interactive-approval <reason>",
      "#437: approve without a terminal confirmation (a scripted setup), recorded as channel non-interactive (ci under a CI marker) with the reason — never as a person's; check --require-approvals fails it. A coding agent never uses this: it hands the approval to a person",
    )
    .option("--proposal <pid>", "#453: accept this pending self-heal proposal (journey review shows it): the Journey is replaced by the proposed revision through every gate, bound to its proposedHash")
    .option("--reject-proposal <pid>", "#453: reject this pending self-heal proposal (needs --reason); the stored Journey is untouched")
    .option("--reason <text>", "#453: why the proposal is rejected (recorded with the rejection)")
    .option("--json", "emit a JSON envelope")
    .action(async function (this: Command, id: string) {
      const { dir, json, full, acceptWeak, reviewedHash: hashFlag, reviewSheet, acceptUnvetted, acceptFindings, real, jevProvider, nonInteractiveApproval, proposal, rejectProposal, reason } = this.opts<{
        proposal?: string;
        rejectProposal?: string;
        reason?: string;
        nonInteractiveApproval?: string;
        dir?: string;
        json?: boolean;
        full?: boolean;
        acceptWeak?: string;
        reviewedHash?: string;
        reviewSheet?: string;
        acceptUnvetted?: string;
        acceptFindings?: string;
        real?: boolean;
        jevProvider?: string;
      }>();
      try {
        checkNonInteractiveReason(nonInteractiveApproval);
        const journeysDir = resolveJourneysDir(deps, dir);
        // #453: the proposal flags, validated before anything is read (an id is 12 hex characters — never a path).
        for (const [flag, value] of [["--proposal", proposal], ["--reject-proposal", rejectProposal]] as const) {
          if (value !== undefined && !isProposalId(value)) {
            emitJson(program, fail("E_JOURNEY_PROPOSAL_ARGS", `${flag} needs a proposal id (12 hex characters, shown by \`journey review\`), not '${value}'`));
            return;
          }
        }
        if (proposal !== undefined && rejectProposal !== undefined) {
          emitJson(program, fail("E_JOURNEY_PROPOSAL_ARGS", "--proposal and --reject-proposal are exclusive: accept or reject, not both"));
          return;
        }
        if (rejectProposal !== undefined && (reason ?? "").trim() === "") {
          emitJson(program, fail("E_JOURNEY_PROPOSAL_ARGS", "--reject-proposal needs --reason <text> (it is recorded with the rejection)"));
          return;
        }
        if (reason !== undefined && rejectProposal === undefined) {
          emitJson(program, fail("E_JOURNEY_PROPOSAL_ARGS", "--reason belongs to --reject-proposal"));
          return;
        }
        if (proposal !== undefined && reviewSheet !== undefined) {
          emitJson(program, fail("E_JOURNEY_PROPOSAL_ARGS", "--review-sheet binds the stored Journey's hash; with --proposal bind with --reviewed-hash <proposedHash>"));
          return;
        }
        if (rejectProposal !== undefined) {
          const rejected = await promoteJourney(journeysDir, id, {
            rejectProposal,
            reason: reason ?? "",
            rejectProvenance: rejectionProvenance(deps.approval, reason ?? ""),
          });
          if (json) emitJson(program, ok({ ...rejected.metadata, rejectedProposal: rejectProposal }));
          else {
            program.configureOutput().writeOut?.(`rejected proposal ${rejectProposal} for journey '${rejected.metadata.id}'; the stored Journey is unchanged\n`);
            process.exitCode = 0;
          }
          return;
        }
        // #432: what the reviewer read — a hash, a sheet file, or (human mode) the sheet shown below.
        let reviewedHash = hashFlag?.trim().toLowerCase();
        if (reviewedHash !== undefined && !/^[0-9a-f]{64}$/.test(reviewedHash)) {
          emitJson(program, fail("E_JOURNEY_REVIEW_ARGS", "--reviewed-hash needs the 64-hex content hash a review sheet shows"));
          return;
        }
        if (reviewSheet !== undefined) {
          let text: string;
          try {
            text = await readFile(reviewSheet, "utf8");
          } catch (e) {
            emitJson(program, fail("E_JOURNEY_REVIEW_ARGS", `cannot read --review-sheet ${reviewSheet}: ${e instanceof Error ? e.message : String(e)}`));
            return;
          }
          const fromSheet = reviewSheetHash(text);
          if (reviewedHash !== undefined && reviewedHash !== fromSheet) {
            emitJson(program, fail("E_JOURNEY_REVIEW_ARGS", "--reviewed-hash and --review-sheet name different content hashes"));
            return;
          }
          reviewedHash = fromSheet;
        }
        // #434/#435: the readiness checks and the catalog analysis run before every approval; Jev only with --real.
        const jev = await jevSetupFor(deps, resolveCatalogDir(deps.catalogDir), { real, jevProvider });
        let attention: readonly JourneyReviewAttention[] | undefined;
        if (!json) {
          // Human mode: the sheet is shown before promoting, and the approval binds to what was shown.
          const { review } = await reviewJourneyById(journeysDir, id, { ...targetsOpts(deps), catalogDir: resolveCatalogDir(deps.catalogDir), readiness: true, jev, action: "journey promote" });
          program.configureOutput().writeOut?.(`${renderReviewText(review, reviewRenderOptions({ full: full === true }))}\n`);
          attention = review.attention;
          reviewedHash ??= proposal === undefined ? review.contentHash : review.proposal?.proposedHash;
        }
        const journeyResult = await promoteJourney(journeysDir, id, {
          jev,
          ...(proposal === undefined ? {} : { proposal }),
          ...(acceptWeak === undefined ? {} : { acceptWeak }),
          ...(reviewedHash === undefined ? {} : { reviewedHash }),
          ...(acceptUnvetted === undefined ? {} : { acceptUnvetted }),
          ...(acceptFindings === undefined ? {} : { acceptFindings }),
          catalogDir: resolveCatalogDir(deps.catalogDir),
          // #437: a typed confirmation on a TTY (or the escape hatch, or the MCP channel), recorded as provenance.
          confirm: ((confirm) => (request: Parameters<typeof confirm>[0]) => confirm(attention === undefined ? request : { ...request, attention }))(
            makeApprovalConfirm(deps.approval, nonInteractiveApproval === undefined ? {} : { nonInteractiveReason: nonInteractiveApproval }),
          ),
        });
        const envelope = ok(journeyResult.metadata);
        if (json) {
          emitJson(program, envelope);
        } else {
          program.configureOutput().writeOut?.(
            `promoted journey '${journeyResult.metadata.id}' (approved content hash ${journeyResult.metadata.approval?.contentHash ?? ""}; ${describeProvenance(journeyResult.metadata.approval?.provenance)})\n`,
          );
          process.exitCode = 0;
        }
      } catch (err) {
        const refusal = approvalRefusal(err);
        if (refusal !== null) {
          emitJson(program, fail(refusal.code, refusal.message));
        } else if (err instanceof UnknownJourneyError) {
          emitJson(program, fail("E_UNKNOWN_JOURNEY", String(err.message)));
        } else if (
          err instanceof JourneyProposalArgsError ||
          err instanceof JourneyProposalNotFoundError ||
          err instanceof JourneyProposalStaleError ||
          err instanceof JourneyProposalProofError ||
          err instanceof JourneyProposalInvalidError
        ) {
          emitJson(program, fail(err.code, err.message));
        } else if (err instanceof StaleReviewError || err instanceof ReviewSheetError || err instanceof ReviewSidecarError || err instanceof TargetConfigError) {
          emitJson(program, fail(err instanceof TargetConfigError ? "E_TARGET_CONFIG" : err.code, err.message));
        } else if (err instanceof WeakJourneyError) {
          // #401: the findings printed before the refusal (human mode); the reason the gate is here.
          if (!json) {
            const out = program.configureOutput().writeOut;
            for (const finding of err.findings) out?.(`${lintFindingLine(finding)}\n`);
          }
          emitJson(program, fail("E_JOURNEY_WEAK", String(err.message)));
          process.exitCode = 1;
        } else if (err instanceof UnvettedLinksError || err instanceof ApprovalFindingsError) {
          // #433: a gate on the catalog — exit 1 (a gating finding), like E_JOURNEY_WEAK.
          emitJson(program, fail(err.code, err.message));
          process.exitCode = 1;
        } else if (err instanceof CatalogInputError) {
          emitJson(program, fail(err.code, err.message));
        } else if (err instanceof GatewaySelectionError || err instanceof MissingCredentialError) {
          emitJson(program, fail("E_AI_SETUP_REQUIRED", err.message));
        } else {
          emitJson(program, fail("E_JOURNEY_PROMOTE", String(err instanceof Error ? err.message : err)));
        }
      }
    });
}
