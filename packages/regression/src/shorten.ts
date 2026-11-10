import type { Recording, RecordedStep } from "@jevitate/recording";
import { minimizeRecording } from "./minimize.js";

/**
 * #801 — a model-free shortest-path search for a Journey, decided by a job's done check.
 *
 * Candidates come from step removal only (`minimizeRecording`'s ddmin, the experiment's winning arm:
 * `.delivery/rel-030/experiments/path-search.md`); every candidate a person could not take is refused
 * before it costs a replay (the confirmation guard), and every other one is a full replay the caller
 * decides with the job's done check. The result is the shortest path FOUND WITHIN THE BUDGET — never
 * claimed optimal: ddmin is 1-minimal at best, and a budget stop can leave a shorter path untried.
 */

/** How one candidate replay ended, as the caller decided it. Only `achieved` keeps a candidate. */
export type ShortenVerdict = "achieved" | "not-achieved" | "replay-failed" | "unknown";

/** Why the guard refused a candidate without replaying it. */
export type ShortenRefusal = "skipped-confirmation" | "deep-link-past-confirmation";

/** One candidate the search considered, by the 0-based flat indexes of the steps it keeps. */
export interface ShortenCandidate {
  readonly kept: readonly number[];
  readonly verdict: ShortenVerdict | "refused";
  /** The guard's reason, for a refused candidate. */
  readonly refusal?: ShortenRefusal;
  /** True when an identical candidate was already decided (no replay spent). */
  readonly cached?: boolean;
}

export interface ShortenReport {
  readonly originalSteps: number;
  /** Steps of the shortest path found within the budget (the original length when nothing shorter achieved the job). */
  readonly shortestSteps: number;
  /** 0-based flat indexes the shortest found keeps, in order. */
  readonly kept: readonly number[];
  /** 0-based flat indexes it drops, in order. */
  readonly removed: readonly number[];
  /** Replays spent, the recorded path's own included. Refused and cached candidates cost none. */
  readonly replaysUsed: number;
  readonly budget: number;
  /**
   * `searched`: ddmin finished within the budget; `budget`: the budget ran out first (a shorter path may
   * remain untried); `recorded-path-fails`: the recorded path itself did not achieve the job, so nothing
   * shorter was tried.
   */
  readonly stopped: "searched" | "budget" | "recorded-path-fails";
  /** The recorded path's own verdict. */
  readonly baseline: ShortenVerdict;
  readonly candidates: readonly ShortenCandidate[];
  /** The shortest found, as a schema-valid Recording (the original when nothing shorter was found). */
  readonly recording: Recording;
}

export interface ShortenOptions {
  /** Replays the search may spend, the recorded path's included. Default 30. */
  readonly budget?: number;
  /** Replays the candidate keeping these 0-based flat step indexes (after a reset) and decides it by the done check. */
  readonly decide: (kept: readonly number[], candidate: Recording) => Promise<ShortenVerdict>;
}

export const DEFAULT_SHORTEN_BUDGET = 30;

/** A control whose name says it confirms, agrees or accepts: never dropped. */
const CONFIRMATION = /confirm|agree|accept/i;

function controlName(rs: RecordedStep): string {
  const s = rs.step as { readonly target?: { readonly display?: { readonly name?: string }; readonly name?: string; readonly label?: string; readonly text?: string; readonly testId?: string } };
  const t = s.target;
  if (t === undefined) return "";
  return [t.display?.name, t.name, t.label, t.text, t.testId].filter((x): x is string => typeof x === "string").join(" ");
}

/** A click on a confirmation control (its name, label, text or test id matches confirm/agree/accept). */
export function isConfirmationStep(rs: RecordedStep): boolean {
  return rs.step.kind === "click" && CONFIRMATION.test(controlName(rs));
}

/**
 * The confirmation guard: only paths a person could take. A candidate that drops a confirmation click is
 * refused — `deep-link-past-confirmation` when it still navigates straight to a page after the dropped
 * confirmation (a URL past the step a person must take), else `skipped-confirmation`. Null: allowed.
 */
export function refuseShortening(original: readonly RecordedStep[], kept: ReadonlySet<number>): ShortenRefusal | null {
  const dropped = original.map((rs, i) => ({ rs, i })).filter(({ rs, i }) => !kept.has(i) && isConfirmationStep(rs));
  if (dropped.length === 0) return null;
  const first = Math.min(...dropped.map((d) => d.i));
  const deepLink = original.some((rs, j) => j > first && kept.has(j) && rs.step.kind === "navigate");
  return deepLink ? "deep-link-past-confirmation" : "skipped-confirmation";
}

/** The Recording keeping only these flat steps (page groups kept in order; an emptied page dropped). */
export function keepSteps(recording: Recording, kept: ReadonlySet<number>): Recording {
  let i = 0;
  const pages = recording.pages
    .map((page) => ({ ...page, steps: page.steps.filter(() => kept.has(i++)) }))
    .filter((page) => page.steps.length > 0);
  return { ...recording, pages };
}

class BudgetSpent extends Error {}

/** Searches for the shortest path, within `budget` replays, that still achieves the job (see the module note). */
export async function shortenRecording(recording: Recording, opts: ShortenOptions): Promise<ShortenReport> {
  const budget = opts.budget ?? DEFAULT_SHORTEN_BUDGET;
  if (!Number.isInteger(budget) || budget < 1) throw new RangeError("budget: a positive whole number of replays");
  const flat = recording.pages.flatMap((p) => p.steps);
  const indexOf = new Map<RecordedStep, number>(flat.map((rs, i) => [rs, i]));
  const candidates: ShortenCandidate[] = [];
  const seen = new Map<string, ShortenVerdict>();
  let replays = 0;
  let best: readonly number[] = flat.map((_, i) => i);

  const decide = async (kept: readonly number[]): Promise<boolean> => {
    const key = kept.join(",");
    const refusal = refuseShortening(flat, new Set(kept));
    if (refusal !== null) {
      candidates.push({ kept, verdict: "refused", refusal });
      return false;
    }
    const known = seen.get(key);
    if (known !== undefined) {
      candidates.push({ kept, verdict: known, cached: true });
      return known === "achieved";
    }
    if (replays >= budget) throw new BudgetSpent();
    replays += 1;
    const verdict = await opts.decide(kept, keepSteps(recording, new Set(kept)));
    seen.set(key, verdict);
    candidates.push({ kept, verdict });
    if (verdict === "achieved" && kept.length < best.length) best = kept;
    return verdict === "achieved";
  };

  const report = (stopped: ShortenReport["stopped"], baseline: ShortenVerdict): ShortenReport => {
    const keptSet = new Set(best);
    return {
      originalSteps: flat.length,
      shortestSteps: best.length,
      kept: best,
      removed: flat.map((_, i) => i).filter((i) => !keptSet.has(i)),
      replaysUsed: replays,
      budget,
      stopped,
      baseline,
      candidates,
      recording: keepSteps(recording, keptSet),
    };
  };

  // The recorded path first: if it does not achieve the job, nothing shorter can be trusted to.
  const all = flat.map((_, i) => i);
  await decide(all);
  const baseline = seen.get(all.join(",")) ?? "unknown";
  if (baseline !== "achieved") return report("recorded-path-fails", baseline);
  try {
    await minimizeRecording(recording, async (candidate) => decide(candidate.pages.flatMap((p) => p.steps).map((rs) => indexOf.get(rs) ?? -1)));
  } catch (err) {
    if (err instanceof BudgetSpent) return report("budget", baseline);
    throw err;
  }
  return report("searched", baseline);
}
