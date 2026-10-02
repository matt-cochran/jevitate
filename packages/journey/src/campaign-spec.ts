import { z } from "zod";

/**
 * #293 — the `jevitate campaign run <spec.json>` spec's STRUCTURE (the CLI validates the rest against
 * the Journey store and lists every problem). A campaign is a bounded list of jobs: a promoted
 * Journey, the anchors to branch off and the strategies to run from each, with budgets.
 */

/** The strategies a mission can branch off a Journey with (`explore --from-journey`). */
export const ANCHORED_STRATEGIES = ["goal", "coverage", "exploratory", "adversarial", "usability"] as const;
export type AnchoredStrategy = (typeof ANCHORED_STRATEGIES)[number];

/** A campaign's bounds: jobs, missions (default and ceiling) and per-mission action budget. */
export const CAMPAIGN_LIMITS = { maxJobs: 50, maxRuns: 200, defaultMaxRuns: 50, defaultMaxActions: 40, maxActions: 1000 } as const;

const Budget = z.number().int().positive().max(CAMPAIGN_LIMITS.maxActions);

const CampaignJobSchema = z
  .object({
    /** The job's own name (a safe name: it names the job's results folder). */
    id: z.string(),
    /** The promoted Journey the job branches off. */
    journey: z.string().min(1),
    params: z.record(z.string(), z.string()).optional(),
    storageState: z.string().min(1).optional(),
    /** Anchor names or 1-based step numbers; default: every anchor the Journey declares. */
    /**
     * Anchor names / step numbers, or a sweep: `"all"` (every step) or `"anchors"` (every declared
     * anchor) — a sweep's `maxActions`/`maxDecisions` are its TOTAL, split evenly per stop point.
     */
    anchors: z.union([z.enum(["all", "anchors"]), z.array(z.union([z.string().min(1), z.number().int().positive()])).min(1).max(50)]).optional(),
    strategies: z.array(z.enum(ANCHORED_STRATEGIES)).min(1).max(ANCHORED_STRATEGIES.length),
    /** The job in words (required by goal and usability missions). */
    goal: z.string().min(1).max(2000).optional(),
    /** UX calibration class (required by usability missions). */
    appClass: z.string().min(1).max(100).optional(),
    /** Independent success checks (goal and usability missions), as `explore --success`. */
    success: z.array(z.string().min(1)).max(20).optional(),
    maxActions: Budget.optional(),
    maxDecisions: Budget.optional(),
  })
  .strict();

export const CampaignSpecSchema = z
  .object({
    version: z.literal(1),
    name: z.string().min(1).max(200).optional(),
    /** `--env`: every Journey runs against this named environment. */
    env: z.string().min(1).optional(),
    /** `--base-url`: an ad-hoc environment origin (with env: replaces its baseUrl). */
    baseUrl: z.string().min(1).optional(),
    /** The default session for every job (a job's own wins). */
    storageState: z.string().min(1).optional(),
    /** A `--fixtures` file: its setup runs before, and its restore after, EVERY run (discovery included). */
    fixtures: z.string().min(1).optional(),
    /** Operator shell hooks around every run (need `--allow-shell-hooks`). */
    before: z.string().min(1).optional(),
    after: z.string().min(1).optional(),
    /** Replay each job's whole Journey first (default true); a stale one skips its missions. */
    discovery: z.boolean().optional(),
    /** The campaign's mission cap (default 50, at most 200). */
    maxRuns: z.number().int().positive().max(CAMPAIGN_LIMITS.maxRuns).optional(),
    /** Default per-mission budgets (a job's own win; maxActions defaults to 40). */
    maxActions: Budget.optional(),
    maxDecisions: Budget.optional(),
    jobs: z.array(CampaignJobSchema).min(1).max(CAMPAIGN_LIMITS.maxJobs),
  })
  .strict();
export type CampaignSpec = z.infer<typeof CampaignSpecSchema>;
