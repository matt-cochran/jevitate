import { Command } from "commander";
import { FsJourneyStore, journeyProofHash } from "@jevitate/journey";
import { clock } from "@jevitate/domain";
import { CI_ENV_MARKERS, inMcpInvocation, makeApprovalConfirm, approvalRefusal } from "./approval-provenance.js";
import { type CliDeps } from "./cli-shared.js";
import { withProjectFlags } from "./project-layout.js";
import { journeyLayout } from "./journey-cli/shared.js";
import { journeyReviewHash } from "./journey-review.js";
import { readVerifyRecord, writeProofWaiver, ReviewSidecarError } from "./journey-review-store.js";
import { evaluateMutationProofPolicy, mutationReceiptDigest, type ProofWaiver } from "./mutation-proof-policy.js";
import { emitJsonOrRefusal } from "./cli-refusal.js";
import { fail } from "./envelope.js";

class ProofWaiverInputError extends Error {
  readonly code = "E_PROOF_WAIVER_ARGS";
}

/** The waiver has no noninteractive escape hatch and is never an MCP tool. */
export function registerJourneyProofWaiver(journey: Command, program: Command, deps: CliDeps): void {
  withProjectFlags(journey.command("waive-proof <id>"))
    .description("record a person's reasoned waiver of one fresh inconclusive mutation attempt (interactive terminal only)")
    .requiredOption("--reason <text>", "why this exact inconclusive attempt is acceptable; stored beside the Journey")
    .action(async function (this: Command, id: string) {
      const env = deps.approval?.env ?? process.env;
      const interactive = (deps.approval?.stdinIsTTY?.() ?? process.stdin.isTTY === true) && (deps.approval?.stdoutIsTTY?.() ?? process.stdout.isTTY === true);
      if (inMcpInvocation() || !interactive || CI_ENV_MARKERS.some((k) => env[k] !== undefined)) {
        emitJsonOrRefusal(program, fail("E_APPROVAL_NEEDS_HUMAN", "waive-proof requires a person's interactive local terminal; MCP, CI and noninteractive invocations cannot record it"));
        return;
      }
      const flags = this.opts<{ reason: string; project?: string; journeysDir?: string }>();
      const reason = flags.reason.trim();
      if (reason.length === 0 || reason.length > 2048) {
        emitJsonOrRefusal(program, fail("E_PROOF_WAIVER_ARGS", "--reason must contain 1 to 2048 characters"));
        return;
      }
      const layout = journeyLayout(program, deps, flags);
      if (layout === null) return;
      try {
        const stored = await new FsJourneyStore(layout.journeysDir).get(id);
        if (stored === null) throw new ProofWaiverInputError(`unknown Journey '${id}'`);
        const record = await readVerifyRecord(layout.journeysDir, id);
        const contentHash = journeyReviewHash(stored);
        const policy = evaluateMutationProofPolicy({ journey: stored, contentHash, record, mode: "require-attempt" });
        if (!policy.waiverRequired || record === null) throw new ProofWaiverInputError("only a fresh inconclusive mutation attempt can be waived; run journey verify --mutate first");
        const provenance = await makeApprovalConfirm(deps.approval)({ kind: "journey", id, contentHash, waivers: [{ flag: "waive-proof", reason, detail: policy.reason }] });
        if (provenance.channel !== "tty") throw new ReviewSidecarError("proof waiver requires typed terminal confirmation");
        // Re-read after the prompt: a concurrent Journey/proof edit must not receive this waiver.
        const latest = await new FsJourneyStore(layout.journeysDir).get(id);
        const latestRecord = await readVerifyRecord(layout.journeysDir, id);
        if (latest === null || latestRecord === null || journeyReviewHash(latest) !== contentHash || mutationReceiptDigest(latestRecord) !== mutationReceiptDigest(record)) throw new ProofWaiverInputError("Journey or proof changed during confirmation; review and retry");
        const waiver: ProofWaiver = { v: 1, journeyId: id, contentHash, proofHash: journeyProofHash(stored), receiptDigest: mutationReceiptDigest(record), reason, at: clock.nowIso(), provenance: { channel: "tty", agentSignals: [...provenance.agentSignals], ...(provenance.user === undefined ? {} : { user: provenance.user }) } };
        await writeProofWaiver(layout.journeysDir, waiver);
        program.configureOutput().writeOut?.(`waived this inconclusive proof for '${id}': ${reason}\n`);
        process.exitCode = 0;
      } catch (err) {
        const refusal = approvalRefusal(err);
        emitJsonOrRefusal(program, fail(refusal?.code ?? (err instanceof ProofWaiverInputError ? err.code : "E_PROOF_WAIVER"), refusal?.message ?? (err instanceof Error ? err.message : String(err))));
      }
    });
}
