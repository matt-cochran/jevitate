import type { Assertion, NetworkCheck, OutcomeWait } from "@jevitate/recording";
import { canonicalJson } from "@jevitate/domain";
import type { Journey } from "./journey.js";

export type MutationKind = "skip" | "block-write" | "stale-value" | "swap-param" | "truncate-param" | "guard-param";

export interface JourneyMutation {
  readonly kind: MutationKind;
  /**
   * 1-based, the way `--at-step` counts. For a param mutation: the first step whose action reads
   * the parameter (where the mutation takes effect).
   */
  readonly step: number;
  /** `<kind>:<step>` (e.g. `skip:3`), or `<kind>:<param>` for a param mutation — what a report and `provedBy` name. */
  readonly id: string;
  /** #565: the parameter a `swap-param`/`truncate-param` alters (a name, never a value). */
  readonly param?: string;
  /**
   * #579: where a planned `swap-param`'s wrong value comes from — a human-reviewed `mutationValues`
   * entry, another enabled live `<select>` option, or a generated alteration. Never the value itself.
   */
  readonly source?: SwapSource;
}

/** #579: the origin of a `swap-param`'s wrong value (`JourneyMutation.source`). */
export type SwapSource = "reviewed" | "option" | "generated";

/** One (assertion site, mutation) pair: the mutation must make that assertion fail. */
export interface MutationPair {
  /** The site key (`assertionSiteKey`). */
  readonly site: string;
  /** The mutation id. */
  readonly mutation: string;
  /** Declared in `metadata.mutationPairs` (else derived from the Journey). */
  readonly declared?: true;
}

export interface MutationPlan {
  readonly mutations: readonly JourneyMutation[];
  readonly pairs: readonly MutationPair[];
}

/** Where a mutated replay failed. `postcondition`: the step's own assertion failed (not its action). */
export type MutationFailedSite =
  | { readonly where: "step"; readonly step: number; readonly postcondition: boolean }
  | { readonly where: "step-request"; readonly step: number; readonly checkIndex: number; readonly evaluated?: true }
  | { readonly where: "end-state"; readonly index: number }
  | { readonly where: "unevaluable" };

/**
 * #609 — a bounded TARGETED proof: an assertion that only looks like a `cascade` because an EARLIER
 * intentional defense caught the paired mutation first. Each `relaxedSites` entry is an earlier
 * `step:<n>` postcondition weakened in a cloned Journey so the replay could reach the target; the
 * target assertion itself is never relaxed.
 */
export interface TargetedProof {
  readonly site: string;
  readonly relaxedSites: readonly string[];
  readonly outcome: MutationRunResult["outcome"];
  readonly failedSites: readonly MutationFailedSite[];
  /** Set when no further relaxation is allowed: why the target stays a cascade. */
  readonly refused?: string;
  /** The unmutated control replay's outcome (`targetedControlReplay`), run before a targeted failure counts. */
  readonly control?: MutationRunResult["outcome"];
  /** #616: a DECLARED plan chose this proof's relaxations, not the automatic bound search. */
  readonly declared?: true;
  /** #785: what the failed control replay did, against the base replay. Set only when a control ran and did not pass. */
  readonly controlDiagnostics?: TargetedControlDiagnostics;
}

/**
 * #785: what one replay did, in counts and booleans only: never a storage value, token, URL or page
 * text. Storage counts are `null` when the page could not be read at that moment.
 */
interface ReplayDiagnostics {
  readonly stepsTotal: number;
  readonly stepsCompleted: number;
  readonly sessionsOpened: number;
  /** The session's page or browser context changed during the replay. */
  readonly pageReplaced: boolean;
  /** First-party or not, the page's non-GET/HEAD/OPTIONS requests: sent, answered, failed (aborted), neither. */
  readonly writesSent: number;
  readonly writesAnswered: number;
  readonly writesAborted: number;
  readonly writesUnfinished: number;
  /** Key and cookie counts as the last step ended, before the end state's reload. */
  readonly storageBeforeEndState: StorageCounts | null;
  /** Key and cookie counts on the final page, after the end state's reload. */
  readonly storageAfterEndState: StorageCounts | null;
  /** How each wait kept on a relaxed site ended (`RelaxedSiteWait`). */
  readonly relaxedWaits: readonly { readonly site: string; readonly ending: RelaxedWaitEnding; readonly waitedMs: number }[];
}

interface StorageCounts {
  readonly sessionStorageKeys: number;
  readonly localStorageKeys: number;
  readonly cookies: number;
}

/** `unresolved`: the assertion names a value only the replay holds (an `extract` output, `setup.x`), so it could not be waited on. */
type RelaxedWaitEnding = "held" | "timeout" | "hang" | "unresolved" | "not-run";

interface TargetedControlDiagnostics {
  /** Where the control failed, as site keys. */
  readonly failedSites: readonly string[];
  readonly control: ReplayDiagnostics;
  /** The Journey replayed as recorded, for comparison. */
  readonly base?: ReplayDiagnostics;
  /** Both replays opened their session with the same options (false: a different browser context). */
  readonly contextOptionsMatchBase?: boolean;
}

/** What a targeted proof's replay reports back; `diagnostics` only from a control that did not pass. */
export interface TargetedReplayRun {
  readonly outcome: MutationRunResult["outcome"];
  readonly failedSites: readonly MutationFailedSite[];
  readonly diagnostics?: TargetedControlDiagnostics;
  /** Sites this replay failed at sooner than the base replay passed them (`sitesReachedEarly`), so its failure is no evidence. */
  readonly waitsCut?: readonly string[];
  /** Ms from the mutated step's start to when each step began, 0-based by flat step: when this replay got to that site. */
  readonly arrivedMs?: readonly (number | undefined)[];
  /** Ms from the mutated step's start to when it began reading its end state. */
  readonly endStateReachedMs?: number;
  /** How far apart a mutated replay and its control may reach a site and still be compared (`paceMarginOf`). */
  readonly marginMs?: number;
  /** How the fresh unmutated replay this run was checked against ended (`MutationRunResult.control`). */
  readonly control?: MutationRunResult["outcome"];
}

/** A mutated replay: it passed, failed (where), was not applied (nothing to mutate), or errored. */
export interface MutationRunResult {
  readonly outcome: "passed" | "failed" | "not-applied" | "error";
  readonly failedSites: readonly MutationFailedSite[];
  /**
   * Sites this replay failed at sooner than the base replay passed them (`sitesReachedEarly`). Its
   * waiting did not match the base's, so no replay is its control and its failure is no evidence.
   */
  readonly waitsCut?: readonly string[];
  /**
   * #554 — the same mutation replayed with the mutated step's own postcondition relaxed (its action
   * still skipped/blocked/emptied, but its `expect`/`waitFor` left out), so a replay that failed
   * first at that postcondition can still say whether each LATER site is broken or vacuous.
   */
  readonly relaxed?: { readonly outcome: MutationRunResult["outcome"]; readonly failedSites: readonly MutationFailedSite[]; readonly waitsCut?: readonly string[]; readonly atBaseTime?: BaseTimedRun };
  /** #609: targeted proofs run for assertion sites this mutation left as a cascade. */
  readonly targeted?: readonly TargetedProof[];
  /** How the matched unmutated replay ended, when a sensitive reading needed one (`sitesNeedingControl`, `siblingDisagreements`). */
  readonly control?: MutationRunResult["outcome"];
  /** What that replay did against the base, when it did not pass. */
  readonly controlDiagnostics?: TargetedControlDiagnostics;
  /**
   * The matched control failed at the same site, so the hold itself may be what broke it: the same
   * mutated replay, held only as long as the base took. A pass there shows the claim holds without the mutation.
   */
  readonly atBaseTime?: BaseTimedRun;
  /** How this mutation's one re-run ended, when a sibling mutation of its step passed a site it failed (`siblingDisagreements`). */
  readonly rerun?: MutationRunResult["outcome"];
}

/** `MutationRunResult.atBaseTime`. */
export interface BaseTimedRun {
  readonly outcome: MutationRunResult["outcome"];
  readonly failedSites: readonly MutationFailedSite[];
}

/** sensitive: broke for the right reason · insensitive: still passed (vacuous) · cascade: broke elsewhere. */
export type MutationVerdict = "sensitive" | "insensitive" | "cascade" | "not-applied" | "error";
export type AssertionVerdict = MutationVerdict | "unpaired";

export interface AssertionProof {
  readonly site: string;
  /** An unpaired own request or network/persistence end-state is a required unresolved obligation. */
  readonly required?: true;
  readonly verdict: AssertionVerdict;
  /** The mutation that proved it sensitive. */
  readonly provedBy?: string;
  /** #609: the earlier postconditions a targeted proof weakened to reach a sensitive verdict. */
  readonly relaxedSites?: readonly string[];
  /** #609: why a targeted proof was refused, when the verdict stays a cascade. */
  readonly targetedRefusal?: string;
  /** Independent propositions: a UI action witness cannot discharge value/data sensitivity. */
  readonly obligations?: readonly {
    readonly kind: "data" | "action";
    readonly verdict: MutationVerdict;
    readonly provedBy?: string;
    readonly relaxedSites?: readonly string[];
    readonly targetedRefusal?: string;
  }[];
}

/** Exact symbolic outcome ownership; display metadata never locates a target. */
export function outcomeIdentity(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(outcomeIdentity);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).filter(([key]) => !["display", "tflowId", "testIdAttr"].includes(key)).map(([key, v]) => [key, outcomeIdentity(v)]));
}

/**
 * One mutated replay. `params`, when set, are the params the replay runs with in place of the
 * supplied ones (a param mutation; never a secret's value altered).
 */
export interface MutationReplay {
  readonly journey: Journey;
  /** #708: private verifier mask; stored checks/indices and request capture remain unchanged. */
  readonly relaxedStepRequests?: readonly string[];
  /** #785: the waiting each relaxed site did; the verifier runs them as the step ends and ignores how they end. */
  readonly relaxedSiteWaits?: readonly RelaxedSiteWait[];
  readonly skipIndex?: number;
  readonly blockIndex?: number;
  readonly blockRequests?: readonly string[];
  /** Observed or declared method/path matchers; not fabricated recorded request lines. */
  readonly blockMatchers?: readonly { readonly method: string; readonly pathGlob: string; readonly literal?: true }[];
  readonly params?: Readonly<Record<string, string>>;
  /**
   * #579: instead of altering a parameter (a `select` cannot be swapped by rewriting params), pick a
   * DIFFERENT enabled live option at this 0-based flat step while avoiding the supplied value.
   */
  readonly swapSelectAtStep?: { readonly index: number; readonly avoid: string };
}

/**
 * #785: an assertion also WAITS. A relaxed site must stop being able to fail the replay and go on
 * waiting as it did, or the replay moves on before what it was waiting for has landed (a reload that
 * aborts a write still in flight), and the failure that follows is timing, not evidence.
 *
 * Bounded and never fatal: a `page` wait polls the site's original assertion (its own `waitFor`, else
 * the interpreter's postcondition bound), a `response` wait holds until the step's matching requests
 * are answered (its `responseTimeoutMs`, else the run's). Neither can turn a failure into a pass: only
 * the unrelaxed assertions judge the replay. `pacedReplay` bounds these waits as it does a judged one.
 */
export type RelaxedSiteWait =
  | { readonly kind: "page"; readonly site: string; readonly step: number; readonly assertion: Assertion; readonly wait?: OutcomeWait }
  | { readonly kind: "response"; readonly site: string; readonly step: number; readonly check: NetworkCheck; readonly responseTimeoutMs?: number };

/**
 * How the base replay paced itself: ms from its first step's start to each step's end, 0-based by flat
 * step. Measured, never recorded, so it is what this app took just now. Empty: nothing was measured,
 * and a replay is held to no pace.
 */
export interface ReplayPace {
  readonly stepEndMs: readonly number[];
  /** When its end state's checks ended: they settle before they read, which no step's end shows. */
  readonly endStateMs?: number;
  /**
   * When each step's own claim had held, 0-based by flat step. A step goes on after that (its request
   * checks wait on their responses), so a claim site is compared with this, not with the step's end.
   */
  readonly claimHeldMs?: readonly (number | undefined)[];
}


/** What the pacer held a replay for before it got to each site, 0-based by flat step, and before its end state. */
export interface ReplayHolds {
  readonly heldMs?: readonly (number | undefined)[];
  readonly endStateHeldMs?: number;
}

/** When a replay got to each site: `TargetedReplayRun.arrivedMs` and `endStateReachedMs`. */
export interface SiteArrivals {
  readonly arrivedMs?: readonly (number | undefined)[];
  readonly endStateReachedMs?: number;
}

/** A site one mutation failed and a sibling mutation of the same step passed. */
export interface SiblingDisagreement {
  readonly site: string;
  readonly sensitive: string;
  readonly passed: string;
}
