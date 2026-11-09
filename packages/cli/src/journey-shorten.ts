import { clock } from "@jevitate/domain";
import { FsJourneyStore, JourneyRegistry, isDoneCheckIssues, parseDoneCheck, doneCheckScope, type Journey } from "@jevitate/journey";
import { DEFAULT_SHORTEN_BUDGET, shortenRecording, type ShortenReport, type ShortenVerdict } from "@jevitate/regression";
import type { BrowserPort } from "@jevitate/playwright";
import { inMcpInvocation, noteMcpRefusal } from "./approval-provenance.js";
import { loadCatalog } from "./catalog-api.js";
import { findJob } from "./catalog.js";
import { DoneCheckRun } from "./journey-done-check-hook.js";
import { effectiveAllowedOrigins, runJourneyProgrammatically, UnknownJourneyError, type RunJourneyProgrammaticallyOptions } from "./journey-api.js";
import { resolveRunTarget, runModeRefusal } from "./journey-run-mode-gate.js";
import { prepareMcpRunGuard } from "./mcp-run-guard.js";

/**
 * #801 `jevitate journey shorten <id> --job <jobId> [--budget n]`: a model-free search for a shorter
 * path to the same job. Candidates are the Journey with steps removed (ddmin, `@jevitate/regression`
 * `shortenRecording`); each one is a full replay of the stored Journey with those steps skipped, its
 * fixtures set up before and restored after (the reset between candidates), and decided ONLY by the
 * job's done check, read in a fresh browser context before and after (the `DoneCheckRun` hooks). A
 * candidate that drops a confirmation click, or deep-links past one, is refused before it costs a replay.
 *
 * Authoring time only: the output is a NEW, unpromoted draft Journey and a report (original steps,
 * shortest found, replays used). Nothing is promoted or changed on the source Journey; a person reviews
 * and promotes the draft. Over MCP (`shorten_journey`) a promoted Journey is refused, and before any
 * replay the run-mode gate and the #789 guard decide as they do for `run_journey` (each replay arms them again).
 * The wording is always "shortest found within budget": ddmin is not an optimality proof.
 */

export const SHORTEST_FOUND = "shortest found within budget";

export class JourneyShortenError extends Error {
  constructor(
    readonly code: "E_JOURNEY_SHORTEN_ARGS" | "E_JOURNEY_SHORTEN_JOB" | "E_JOURNEY_SHORTEN_PROMOTED" | "E_JOURNEY_SHORTEN_EXISTS",
    message: string,
  ) {
    super(message);
    this.name = "JourneyShortenError";
  }
}

export interface ShortenJourneyOptions {
  readonly dir: string;
  readonly id: string;
  readonly jobId: string;
  /** The project data dir holding `jobs.json` (null: none, which refuses: nothing would decide a candidate). */
  readonly catalogDir: string | null;
  /** Replays the search may spend, the recorded path's included. Default 30. */
  readonly budget?: number;
  /** The draft's id (default `<id>-shortest`); refused when a Journey with it exists. */
  readonly outId?: string;
  readonly params?: Readonly<Record<string, string>>;
  readonly storageState?: string;
  /** Fixtures set up before and restored after EVERY candidate replay (the reset between candidates). */
  readonly fixtures?: RunJourneyProgrammaticallyOptions["fixtures"];
  readonly browserPortFactory?: () => BrowserPort;
  /** `~/.jevitate/targets.json` (default): the target's trust, mode and `mcpRun` rules. */
  readonly targetsFile?: string;
  /** Told as each candidate replay starts (1-based), for progress lines. */
  readonly onReplay?: (replay: number, steps: number) => void;
}

/** One removed step: its 1-based position in the original and its kind (never a value). */
export interface ShortenRemovedStep {
  readonly step: number;
  readonly kind: string;
}

export interface ShortenJourneyReport {
  readonly wording: typeof SHORTEST_FOUND;
  readonly journeyId: string;
  readonly job: string;
  readonly originalSteps: number;
  readonly shortestSteps: number;
  readonly replaysUsed: number;
  readonly budget: number;
  readonly stopped: ShortenReport["stopped"];
  readonly baseline: ShortenVerdict;
  readonly removed: readonly ShortenRemovedStep[];
  /** Candidates the confirmation guard refused (no replay spent on them). */
  readonly refused: number;
  /** The unpromoted draft written, when a shorter path achieved the job; absent otherwise. */
  readonly draftId?: string;
}

/** The draft: the source Journey's own metadata, unpromoted, with nothing an approval or a step index carried. */
function draftOf(source: Journey, id: string, jobId: string, report: ShortenReport): Journey {
  const {
    approval: _approval,
    acceptedWeak: _acceptedWeak,
    anchors: _anchors,
    mutationPairs: _mutationPairs,
    targetedProofs: _targetedProofs,
    ...metadata
  } = source.metadata;
  return {
    ...source,
    metadata: {
      ...metadata,
      id,
      name: `${source.metadata.name} (${SHORTEST_FOUND})`,
      description:
        `${SHORTEST_FOUND} from '${source.metadata.id}': ${report.originalSteps} → ${report.shortestSteps} steps in ${report.replaysUsed} of ${report.budget} replays, ` +
        `each decided by job '${jobId}'s done check. Unpromoted: review it, then promote it.`,
      promoted: false,
      job: jobId,
      createdAtIso: clock.nowIso(),
    },
    recording: report.recording,
  };
}

/** Runs the search and, when a shorter path achieved the job, writes it as an unpromoted draft. */
export async function shortenJourney(opts: ShortenJourneyOptions): Promise<ShortenJourneyReport> {
  const budget = opts.budget ?? DEFAULT_SHORTEN_BUDGET;
  if (!Number.isInteger(budget) || budget < 1 || budget > 500) throw new JourneyShortenError("E_JOURNEY_SHORTEN_ARGS", "--budget: a whole number of replays from 1 to 500");
  const store = new FsJourneyStore(opts.dir);
  const registry = new JourneyRegistry(store);
  const source = await registry.get(opts.id);
  if (source === null) throw new UnknownJourneyError(`unknown journey '${opts.id}'`);
  if (source.metadata.promoted && inMcpInvocation()) {
    throw new JourneyShortenError("E_JOURNEY_SHORTEN_PROMOTED", `journey '${opts.id}' is promoted: a shortest-path search is authoring-time only and never runs on a promoted Journey over MCP`);
  }
  if (inMcpInvocation()) {
    // The same gate as `run_journey`, before any fixture or browser: the run mode (an unapproved draft on an
    // automation-mode target is refused) and the #789 guard (production, `mcpRun`). Every replay arms both again.
    const target = resolveRunTarget({ origin: source.recording.site, targetsFile: opts.targetsFile });
    const refusal = runModeRefusal(source, target, { mcp: true });
    if (refusal !== undefined) {
      noteMcpRefusal(refusal);
      throw refusal;
    }
    prepareMcpRunGuard({
      site: source.recording.site,
      allowedOrigins: effectiveAllowedOrigins(source, undefined),
      environment: undefined,
      targetsFile: opts.targetsFile,
      mode: target.mode,
      authoredOrigins: source.metadata.allowedOrigins ?? [],
    });
  }
  const draftId = opts.outId ?? `${opts.id}-shortest`;
  if (draftId === opts.id || (await registry.get(draftId)) !== null) {
    throw new JourneyShortenError("E_JOURNEY_SHORTEN_EXISTS", `a Journey '${draftId}' already exists: pass --out-id <id> for the draft`);
  }
  // The job's done check is the only test: a job without a readable one decides nothing, so it is refused.
  const job = findJob(await loadCatalog(opts.catalogDir, opts.dir), opts.jobId);
  if (job === undefined) throw new JourneyShortenError("E_JOURNEY_SHORTEN_JOB", `--job: no job '${opts.jobId}' in ${opts.catalogDir ?? "a .jevitate/ project (none found)"}/jobs.json`);
  if (job.job.done === undefined) throw new JourneyShortenError("E_JOURNEY_SHORTEN_JOB", `--job ${opts.jobId}: the job has no done check, and only a done check decides a candidate (add jobs[].done)`);
  if (isDoneCheckIssues(parseDoneCheck(job.job.done, doneCheckScope(source)))) {
    throw new JourneyShortenError("E_JOURNEY_SHORTEN_JOB", `--job ${opts.jobId}: the job's done check does not lint clean for this Journey (jevitate catalog lint)`);
  }

  let replay = 0;
  const decide = async (kept: readonly number[]): Promise<ShortenVerdict> => {
    replay += 1;
    opts.onReplay?.(replay, kept.length);
    const keep = new Set(kept);
    const check = new DoneCheckRun({
      catalogDir: opts.catalogDir,
      journeysDir: opts.dir,
      jobId: opts.jobId,
      ...(opts.storageState === undefined ? {} : { storageState: opts.storageState }),
      ...(opts.browserPortFactory === undefined ? {} : { sessionPortFactory: opts.browserPortFactory }),
    });
    const result = await check.run(() =>
      runJourneyProgrammatically(
        {
          dir: opts.dir,
          id: opts.id,
          params: { ...(opts.params ?? {}) },
          ...(opts.storageState === undefined ? {} : { storageState: opts.storageState }),
          ...(opts.fixtures === undefined ? {} : { fixtures: opts.fixtures }),
          ...(opts.browserPortFactory === undefined ? {} : { browserPortFactory: opts.browserPortFactory }),
          ...(opts.targetsFile === undefined ? {} : { runGuardTargetsFile: opts.targetsFile }),
        },
        { skipStep: (i) => !keep.has(i) },
      ),
    );
    if (result.outcome !== "ok") return "replay-failed";
    const job = check.job;
    if (job === undefined || job.attainment === "unverified") return "unknown";
    return job.attainment === "achieved" ? "achieved" : "not-achieved";
  };

  const found = await shortenRecording(source.recording, { budget, decide: (kept) => decide(kept) });
  const flat = source.recording.pages.flatMap((p) => p.steps);
  const shorter = found.stopped !== "recorded-path-fails" && found.shortestSteps < found.originalSteps;
  if (shorter) await registry.put(draftOf(source, draftId, opts.jobId, found));
  return {
    wording: SHORTEST_FOUND,
    journeyId: opts.id,
    job: opts.jobId,
    originalSteps: found.originalSteps,
    shortestSteps: found.shortestSteps,
    replaysUsed: found.replaysUsed,
    budget: found.budget,
    stopped: found.stopped,
    baseline: found.baseline,
    removed: found.removed.map((i) => ({ step: i + 1, kind: flat[i]?.step.kind ?? "unknown" })),
    refused: found.candidates.filter((c) => c.verdict === "refused").length,
    ...(shorter ? { draftId } : {}),
  };
}
