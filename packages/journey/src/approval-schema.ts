import { z } from "zod";

/**
 * #437 — how an approval was made (`approval.provenance`), recorded on every approval record: a
 * Journey's (`journey promote`, `demo approve`, MCP `promote_journey` / `approve_demo`), a catalog
 * persona's or job's (`persona|job approve`), and on each waiver given with one.
 *
 * - `channel`: `tty` (a person typed the confirmation at an interactive terminal), `non-interactive`
 *   (the `--non-interactive-approval "<reason>"` escape hatch), `ci` (that escape hatch under a CI
 *   marker such as `GITHUB_ACTIONS`), `mcp` (an MCP tool call — an agent's approval).
 * - `agentSignals`: the NAMES of the agent/CI markers found in the environment (`CLAUDECODE`,
 *   `GITHUB_ACTIONS`, …) and `stdin-not-tty` / `stdout-not-tty` — never a value.
 * - `user`: the OS user name (never an email).
 * - `reason`: why a non-interactive approval was made (the escape hatch's argument).
 * - `pr` (#469, only with channel `pr-review`, and required by it): the merged pull request whose
 *   approving review is the approval — see `PrReviewSchema`.
 *
 * `pr-review` (#469) is granted ONLY by jevitate itself after verifying through the forge API (in
 * CI, with the CI environment's token, never the model's) that the commit that last changed the
 * entry came from a merged PR approved by someone other than its author. It is never a flag a
 * caller can set, and no default allow-list includes it (`--allow-channels` defaults to `tty`).
 *
 * Provenance is DETECTION, not proof: a determined process can fake a TTY or clear its environment.
 * The enforcement is git review (CODEOWNERS + branch protection) with `check --require-approvals`.
 */
export const APPROVAL_CHANNELS = ["tty", "non-interactive", "mcp", "ci", "pr-review"] as const;
export type ApprovalChannel = (typeof APPROVAL_CHANNELS)[number];

export const ApprovalChannelSchema = z.enum(APPROVAL_CHANNELS);

/**
 * #469: the pull request a `pr-review` approval was verified against.
 * - `forge`: where it was verified (`github`; absent = `github`).
 * - `number`: the PR number; `url`: its web URL.
 * - `mergedSha`: the commit that last changed the approved entry (the PR's merge result), full hex.
 * - `author`: the PR's author login; `reviewer`: the login of the approving reviewer (never the author).
 * - `reviewedAt`: when that approving review was submitted (ISO 8601).
 * - `codeOwner`: the reviewer is a CODEOWNER of the entry's path (when checked).
 * Logins only — never an email or a token.
 */
export const PrReviewSchema = z
  .object({
    forge: z.enum(["github"]).optional(),
    number: z.number().int().positive(),
    url: z.string().url().max(2000).optional(),
    mergedSha: z.string().regex(/^[0-9a-f]{40}([0-9a-f]{24})?$/, "pr.mergedSha: a full commit sha"),
    author: z.string().min(1).max(256).optional(),
    reviewer: z.string().min(1).max(256),
    reviewedAt: z.string().min(1).optional(),
    codeOwner: z.boolean().optional(),
  })
  .strict();
export type PrReview = z.infer<typeof PrReviewSchema>;

export const ApprovalProvenanceSchema = z
  .object({
    channel: ApprovalChannelSchema,
    agentSignals: z.array(z.string().regex(/^[A-Za-z0-9_-]{1,64}$/, "agentSignals: marker names only")).max(50),
    user: z.string().min(1).max(256).optional(),
    reason: z.string().min(1).max(2000).optional(),
    pr: PrReviewSchema.optional(),
  })
  .strict()
  .refine((p) => (p.channel === "pr-review") === (p.pr !== undefined), {
    message: "provenance: channel `pr-review` carries its verified `pr`, and only it does",
    path: ["pr"],
  });
export type ApprovalProvenance = z.infer<typeof ApprovalProvenanceSchema>;

/** #437: one approval that `check --require-approvals` / `catalog status --require-approvals` refuses. */
export const ApprovalViolationSchema = z
  .object({
    kind: z.enum(["journey", "persona", "job"]),
    id: z.string(),
    /**
     * `missing`: promoted with no approval; `stale`: changed since; `no-provenance`: approved before
     * provenance was recorded; `channel`: made over a channel not allowed; `unverified` (#469): a
     * `pr-review` approval the forge does not confirm (or that could not be re-verified: no token,
     * offline) — never a pass, even when `pr-review` is allowed.
     */
    problem: z.enum(["missing", "stale", "no-provenance", "channel", "unverified"]),
    message: z.string(),
  })
  .strict();
export type ApprovalViolation = z.infer<typeof ApprovalViolationSchema>;

/** #437: every recorded approval, as `catalog status` lists it, and the `--require-approvals` verdict. */
export const ApprovalsReportSchema = z
  .object({
    records: z.array(
      z
        .object({
          kind: z.enum(["journey", "persona", "job"]),
          id: z.string(),
          at: z.string().optional(),
          stale: z.boolean(),
          provenance: ApprovalProvenanceSchema.optional(),
          /** "approved at a terminal by mc", "approved non-interactively (likely an agent: CLAUDECODE)", … */
          how: z.string(),
        })
        .strict(),
    ),
    requirement: z.object({ allowedChannels: z.array(ApprovalChannelSchema), violations: z.array(ApprovalViolationSchema) }).strict().optional(),
  })
  .strict();
export type ApprovalsReport = z.infer<typeof ApprovalsReportSchema>;
