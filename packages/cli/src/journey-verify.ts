/**
 * #402 — `journey verify --mutate`: a built-in negative proof that each of a Journey's assertions
 * FAILS when its outcome is absent. The Journey is replayed once as recorded (it must pass), then
 * once per mutation (`planJourneyMutations`: skip a write step, abort its writes, type an empty or
 * stale value into a checked fill, or — #565 — swap or truncate a checked non-secret parameter); each assertion is sensitive only when its paired mutation broke it, at
 * that assertion, with nothing failing before the mutated step.
 *
 * Every replay goes through `runJourneyProgrammatically` — the same path, gate, fixtures and
 * environment as `journey run`. Mutations never send, fabricate or answer a request: they leave a
 * step's action out, ABORT the app's own writes in one step's window, or type `""`.
 */
import {
  FsJourneyStore,
  JourneyRegistry,
  assertionSiteKey,
  classifyMutation,
  declaredTargetedProofFor,
  flatJourneySteps,
  journeyAssertions,
  journeyEndState,
  judgeAssertions,
  mutationProofVerdict,
  mutationReplay,
  needsRelaxedReplay,
  planJourneyMutations,
  relaxedMutationReplay,
  runDeclaredTargetedProof,
  runTargetedProof,
  suggestTargetedProofPlan,
  type AssertionVerdict,
  type Journey,
  type JourneyMutation,
  type JourneyTargetedProofPlan,
  type MutationFailedSite,
  type MutationProofVerdict,
  type MutationReplay,
  type MutationRunResult,
  type TargetedProof,
} from "@jevitate/journey";
import { DEFAULT_STEP_RESPONSE_TIMEOUT_MS, describeCheck, type BlockedWrite } from "@jevitate/explore";
import { clock } from "@jevitate/domain";
import {
  DEFAULT_ADMISSION_TIMEOUT_MS,
  DEFAULT_CLOSE_TIMEOUT_MS,
  DEFAULT_OPEN_TIMEOUT_MS,
  PlaywrightBrowserPort,
  pageUnresponsiveMsFromEnv,
  sharedResourceGovernor,
  type BrowserPort,
  type BrowserSession,
  type ResourceGovernor,
} from "@jevitate/playwright";
import { journeyContentHash } from "./journey-annotate-api.js";
import { journeyReviewHash } from "./journey-review.js";
import { preflightVerifyRecord, writePreflightedVerifyRecord } from "./journey-review-store.js";
import { UnknownJourneyError, redactSecretParams, runJourneyProgrammatically, type RunJourneyProgrammaticallyOptions } from "./journey-api.js";
import type { OutcomeCheckFailure } from "./journey-network-checks.js";
import { journeyProofContext, journeyProofHashForContext } from "./journey-proof-context.js";

/** `journey run`'s options a proof passes through to every replay (params, environment, auth, fixtures, browser, gate). */
export type VerifyJourneyOptions = Omit<
  RunJourneyProgrammaticallyOptions,
  "stopAfterStep" | "interpreter" | "observer" | "session" | "screenshots" | "actionDeltas" | "selfHealer" | "policy"
> & {
  /** Read patterns for the write classifier (as `journey lint`). */
  readonly readRequests?: readonly string[];
  /** Called as each replay starts, in order, targeted proofs' replays included. */
  readonly onProgress?: (progress: JourneyVerifyProgress) => void;
  /** The governor whose machine slot the proof keeps between replays (default: the process-wide one its replays open sessions through). */
  readonly slotGovernor?: ResourceGovernor;
};

/** The replay a proof is starting. Names only: never a parameter value. */
export interface JourneyVerifyProgress {
  /** 1-based over the whole proof; replay 1 is the Journey as recorded. */
  readonly replay: number;
  /**
   * The mutation this replay runs under. Absent on replay 1. On a retry, the name is followed by
   * ` (retry after error)`: a command's progress line prints this field, so that is what tells a reader.
   */
  readonly mutation?: string;
  /** This replay repeats one that errored. */
  readonly retry?: true;
}

/** Hands a proof's bound the Journey it is sized from. */
export async function loadJourneyToVerify(dir: string, id: string): Promise<Journey> {
  const journey = await new JourneyRegistry(new FsJourneyStore(dir)).get(id);
  if (!journey) throw new UnknownJourneyError(`unknown journey '${id}'`);
  return journey;
}

// What one replay can legally wait for, by the bounds of the code it runs.
const ACTION_BOUND_MS = 30_000; // `page.goto` and default actions (Playwright's default).
const RELOAD_BOUND_MS = 15_000; // `outcome-wait.ts`, `act.ts`.
const SITE_GATE_WAIT_MS = 5_000; // `site-gate.ts`.
/** A hook's default limit, before and after a replay. A spec that sets longer limits leans on the rest of the budget. */
const FIXTURE_ALLOWANCE_MS = 120_000;
/** The least a replay is given, however short its Journey. */
const REPLAY_FLOOR_MS = 360_000;
const MAX_TIMER_MS = 2_147_483_647;
/** How long after the inactivity limit the in-process bound fires, so a CLI's terminal layer ends the run first. */
const STALL_MARGIN_MS = 30_000;
/** How long a stalled replay's session close and its own unwinding (fixture restore) may take. */
const STALL_TEARDOWN_MS = 90_000;

function admissionBoundMs(env: NodeJS.ProcessEnv = process.env): number {
  const set = Number(env["JEVITATE_ADMISSION_TIMEOUT_MS"]);
  return Number.isInteger(set) && set > 0 ? set : DEFAULT_ADMISSION_TIMEOUT_MS;
}

/**
 * The longest a proof can legally go between two replays' progress: a machine-slot admission wait,
 * then the longest legal single replay of THIS Journey, each step at its worst. A sum of worst cases,
 * so it is far above a typical replay. It limits silence and never the whole run: a proof whose
 * replays keep starting is never ended, however long it takes (#778).
 */
export function proofInactivityMs(journey: Journey, opts: Pick<VerifyJourneyOptions, "stepResponseTimeoutMs"> = {}): number {
  const responseDefault = opts.stepResponseTimeoutMs ?? DEFAULT_STEP_RESPONSE_TIMEOUT_MS;
  let replay = DEFAULT_OPEN_TIMEOUT_MS + pageUnresponsiveMsFromEnv() + DEFAULT_CLOSE_TIMEOUT_MS + FIXTURE_ALLOWANCE_MS;
  for (const { recorded } of flatJourneySteps(journey)) {
    const wait = "waitFor" in recorded.step ? recorded.step.waitFor : undefined;
    replay += ACTION_BOUND_MS + SITE_GATE_WAIT_MS + RELOAD_BOUND_MS + (recorded.responseTimeoutMs ?? responseDefault);
    // A wait's last poll can start just before `maxMs` and still reload.
    if (wait !== undefined) replay += wait.maxMs + ACTION_BOUND_MS;
  }
  replay += journeyEndState(journey).length * (ACTION_BOUND_MS + RELOAD_BOUND_MS);
  return Math.min(admissionBoundMs() + Math.max(REPLAY_FLOOR_MS, replay), MAX_TIMER_MS - STALL_MARGIN_MS);
}

/**
 * A replay went past the proof's inactivity limit: the proof ended with no verdict and no receipt.
 * A CLI run normally ends at the terminal layer's own limit first, so this is what an MCP call (where
 * that layer stays out) and `journey readiness` get. Its text carries names only, never a value.
 */
export class JourneyVerifyStalledError extends Error {
  readonly code = "E_TERMINAL_WATCHDOG";
  constructor(
    readonly where: JourneyVerifyProgress,
    readonly inactivityMs: number,
    /** Every session this replay opened has closed. False: its close was still pending when the teardown bound ran out. */
    readonly sessionsClosed: boolean,
  ) {
    const at = where.mutation === undefined ? `replay ${where.replay}` : `replay ${where.replay}, mutation ${where.mutation}`;
    super(`journey verify: no progress for the ${inactivityMs}ms inactivity limit at ${at}; no verdict, and any earlier receipt stands${sessionsClosed ? "" : ". Its browser session did not close in time"}`);
    this.name = "JourneyVerifyStalledError";
  }
}

/**
 * The sessions one replay opens, so a stalled replay can be ended from outside: `runJourneyProgrammatically`
 * takes no cancel signal, but closing its session makes every page call it is waiting on reject, and
 * it then unwinds by its own paths, fixture restore included. An open still pending at the stall is
 * closed the moment it lands.
 */
function trackedPortFactory(factory: () => BrowserPort): { factory: () => BrowserPort; abandon: () => Promise<void> } {
  const pending = new Set<Promise<unknown>>();
  const opened = new Set<BrowserSession>();
  let abandoned = false;
  const closeOf = (session: BrowserSession): Promise<unknown> => session.close().catch(() => undefined);
  const openOn = async (port: BrowserPort, o: Parameters<BrowserPort["open"]>[0]): Promise<BrowserSession> => {
    const session = await port.open(o);
    if (abandoned) {
      await closeOf(session);
      throw new Error("the replay was abandoned while its browser session opened");
    }
    opened.add(session);
    return session;
  };
  return {
    factory: () => {
      const port = factory();
      return {
        open: (o) => {
          const opening = openOn(port, o);
          const done = (): void => void pending.delete(opening);
          pending.add(opening);
          opening.then(done, done);
          return opening;
        },
      };
    },
    abandon: async () => {
      abandoned = true;
      await Promise.allSettled([...[...opened].map(closeOf), ...pending]);
    },
  };
}

/** `start` under the limit. Past it: close what the replay opened, give it a bounded time to unwind, and throw. */
async function replayWithinBound<T>(
  start: (factory: () => BrowserPort) => Promise<T>,
  portFactory: () => BrowserPort,
  where: JourneyVerifyProgress,
  inactivityMs: number,
): Promise<T> {
  const tracked = trackedPortFactory(portFactory);
  const running = start(tracked.factory);
  let timer: ReturnType<typeof clock.setTimeout> | undefined;
  const stalled = new Promise<{ readonly stalled: true }>((resolve) => {
    // Ref'd: a replay with nothing else left to hold the process open still reaches this bound.
    timer = clock.setTimeout(() => resolve({ stalled: true }), inactivityMs + STALL_MARGIN_MS);
  });
  try {
    const first = await Promise.race([running.then((value) => ({ stalled: false as const, value })), stalled]);
    if (!first.stalled) return first.value;
  } finally {
    clock.clearTimeout(timer);
  }
  let sessionsClosed = false;
  let teardownTimer: ReturnType<typeof clock.setTimeout> | undefined;
  const closing = tracked.abandon().then(() => {
    sessionsClosed = true;
  });
  await Promise.race([
    Promise.allSettled([closing, running]),
    new Promise<void>((resolve) => {
      teardownTimer = clock.setTimeout(resolve, STALL_TEARDOWN_MS);
    }),
  ]);
  clock.clearTimeout(teardownTimer);
  throw new JourneyVerifyStalledError(where, inactivityMs, sessionsClosed);
}

export interface JourneyVerifyMutation {
  readonly kind: JourneyMutation["kind"];
  readonly step: number;
  readonly id: string;
  /** #565: the parameter a `swap-param`/`truncate-param` altered (its name, never a value). */
  readonly param?: string;
  /** #579: where a `swap-param`'s wrong value came from (`reviewed`, `option`, `generated`), never the value. */
  readonly source?: JourneyMutation["source"];
  readonly outcome: MutationRunResult["outcome"];
  readonly failedSites: readonly MutationFailedSite[];
  /** block-write: what was aborted (`METHOD path`). */
  readonly blockedWrites?: readonly string[];
  /** Why the replay failed, was not applied, or errored. */
  readonly reason?: string;
  /**
   * #554 — the same mutation replayed with the mutated step's own postcondition relaxed, present
   * only when the first replay failed at that postcondition and a later site is paired with it.
   */
  readonly relaxed?: {
    readonly outcome: MutationRunResult["outcome"];
    readonly failedSites: readonly MutationFailedSite[];
    readonly blockedWrites?: readonly string[];
    readonly reason?: string;
  };
  /** #609: targeted proofs run for assertion sites this mutation left as a cascade. */
  readonly targeted?: readonly TargetedProof[];
  /**
   * #778: a replay of this mutation (first, relaxed or targeted) errored and was run once more. One
   * entry per retry, with the error it followed. The replay's own result above is the retry's.
   */
  readonly retries?: readonly { readonly reason: string }[];
}

export interface JourneyVerifyAssertion {
  readonly site: string;
  /** The assertion, in the `--success` spec syntax. */
  readonly check: string;
  readonly verdict: AssertionVerdict;
  readonly provedBy?: string;
  /** #609: the earlier postconditions a targeted proof weakened to reach a sensitive verdict. */
  readonly relaxedSites?: readonly string[];
  /** #609: why a targeted proof was refused, when the verdict stays a cascade. */
  readonly targetedRefusal?: string;
  /** #616: the proving targeted proof came from a declared `metadata.targetedProofs` plan. */
  readonly declaredProof?: true;
}

export interface JourneyVerifyReport {
  readonly journeyId: string;
  /** `journeyContentHash` of the stored Journey: the proof is bound to exactly this content. */
  readonly journeyHash: string;
  readonly base: { readonly outcome: string; readonly reason?: string };
  readonly verdict: MutationProofVerdict;
  readonly reason?: string;
  readonly mutations: readonly JourneyVerifyMutation[];
  readonly assertions: readonly JourneyVerifyAssertion[];
  readonly summary: Readonly<Record<"sensitive" | "insensitive" | "cascade" | "notApplied" | "error" | "unpaired" | "targeted", number>>;
  /** #616: a reviewable `metadata.targetedProofs` entry for each automatic proof stopped at its bound. */
  readonly suggestedTargetedProofs?: readonly JourneyTargetedProofPlan[];
}

export interface JourneyVerifyPlanReport {
  readonly journeyId: string;
  /** `journeyContentHash` of the stored Journey: the preview is bound to exactly this content. */
  readonly journeyHash: string;
  readonly mutations: readonly Pick<JourneyMutation, "kind" | "step" | "id" | "param" | "source">[];
  readonly pairs: readonly { readonly site: string; readonly check: string; readonly mutation: string; readonly declared?: true }[];
  readonly assertions: readonly { readonly site: string; readonly check: string; readonly mutations: readonly string[] }[];
  readonly summary: Readonly<Record<"mutations" | "pairs" | "assertions" | "unpaired" | "minimumReplays", number>>;
}

/**
 * Static preview of `journey verify --mutate`: no browser, fixtures, hooks, target, session or
 * credential is opened. Values of params are used only to derive the plan and are never returned.
 */
export async function planJourneyVerification(
  opts: Pick<VerifyJourneyOptions, "dir" | "id" | "params" | "readRequests">,
): Promise<JourneyVerifyPlanReport> {
  const journey = await new JourneyRegistry(new FsJourneyStore(opts.dir)).get(opts.id);
  if (!journey) throw new UnknownJourneyError(`unknown journey '${opts.id}'`);
  const sites = journeyAssertions(journey);
  const checkOf = new Map(sites.map((site) => [assertionSiteKey(site), describeCheck(site.check)]));
  const plan = planJourneyMutations(journey, {
    ...(opts.readRequests === undefined ? {} : { readRequests: opts.readRequests }),
    params: opts.params,
  });
  const pairs = plan.pairs.map((pair) => ({ ...pair, check: checkOf.get(pair.site) ?? "unknown assertion" }));
  const assertions = sites.map((site) => {
    const key = assertionSiteKey(site);
    return { site: key, check: describeCheck(site.check), mutations: pairs.filter((pair) => pair.site === key).map((pair) => pair.mutation) };
  });
  return {
    journeyId: journey.metadata.id,
    journeyHash: journeyContentHash(journey),
    mutations: plan.mutations,
    pairs,
    assertions,
    summary: {
      mutations: plan.mutations.length,
      pairs: pairs.length,
      assertions: assertions.length,
      unpaired: assertions.filter((assertion) => assertion.mutations.length === 0).length,
      minimumReplays: plan.mutations.length + 1,
    },
  };
}

/** The exit code for a proof's verdict (docs/ci.md): 0 proven · 1 insensitive · 2 inconclusive. */
export function verifyExitCode(verdict: MutationProofVerdict): number {
  return verdict === "proven" ? 0 : verdict === "insensitive" ? 1 : 2;
}

type Run = typeof runJourneyProgrammatically;

const REQUEST_LINE = /^(\S+)\s+(\S+)/;

function pathOf(p: string): string {
  try {
    return /^https?:\/\//i.test(p) ? new URL(p).pathname : p.split("?")[0]!;
  } catch {
    return p;
  }
}

/** Was the step's own recorded write among the blocked? With no recorded request, any blocked write counts. */
function blockedOwnWrite(recorded: readonly string[], blocked: readonly BlockedWrite[]): boolean {
  if (recorded.length === 0) return blocked.length > 0;
  return recorded.some((line) => {
    const m = REQUEST_LINE.exec(line.trim());
    if (m === null) return false;
    return blocked.some((b) => b.method.toUpperCase() === m[1]!.toUpperCase() && pathOf(b.path) === pathOf(m[2]!));
  });
}

function failedSitesOf(result: { outcome: string; reason?: string; at?: number }, failures: readonly OutcomeCheckFailure[]): MutationFailedSite[] {
  if (result.outcome !== "quarantined") return [];
  const structured = failures.map((f): MutationFailedSite =>
    f.where === "step-request" ? { where: "step-request", step: f.step, checkIndex: f.checkIndex } : f.where === "end-state" ? { where: "end-state", index: f.index } : { where: "unevaluable" },
  );
  return result.at === undefined ? structured : [...structured, { where: "step", step: result.at + 1, postcondition: /postcondition failed/.test(result.reason ?? "") }];
}

/**
 * Runs the proof for one Journey by id. Usage errors (unknown id, bad params, an environment that
 * refuses a step, a site-gate refusal) throw exactly as `journey run`'s do, before any mutation.
 * The proof keeps its machine slot between replays unless another process waits for it (#766), so
 * one admission wait cannot cost a proof that took 100 minutes to get there.
 */
export async function verifyJourneyMutations(opts: VerifyJourneyOptions, run: Run = runJourneyProgrammatically): Promise<JourneyVerifyReport> {
  const endHold = (opts.slotGovernor ?? sharedResourceGovernor()).holdSlotBetweenSessions();
  try {
    return await proveJourneyMutations(opts, run);
  } finally {
    endHold();
  }
}

async function proveJourneyMutations(opts: VerifyJourneyOptions, run: Run): Promise<JourneyVerifyReport> {
  const journey = await loadJourneyToVerify(opts.dir, opts.id);
  // #711: receipt authority is proven before the first baseline/mutation replay spends a browser.
  const receiptDestination = await preflightVerifyRecord(opts.dir, journey.metadata.id);
  const { readRequests, onProgress, slotGovernor: _slotGovernor, ...runOpts } = opts;
  const inactivityMs = proofInactivityMs(journey, opts);
  const portFactory = opts.browserPortFactory ?? ((): BrowserPort => new PlaywrightBrowserPort());
  let replays = 0;
  // Every replay of the proof goes through here: it is reported, and it is bounded.
  const boundedRun = (options: Parameters<Run>[0], mutation: NonNullable<Parameters<Run>[1]>, m?: JourneyMutation, retry = false): ReturnType<Run> => {
    replays += 1;
    const where: JourneyVerifyProgress = { replay: replays, ...(m === undefined ? {} : { mutation: m.id }), ...(retry ? { retry: true as const } : {}) };
    onProgress?.(retry && m !== undefined ? { ...where, mutation: `${m.id} (retry after error)` } : where);
    return replayWithinBound((browserPortFactory) => run({ ...options, browserPortFactory }, mutation), portFactory, where, inactivityMs);
  };
  const lintOpts = readRequests === undefined ? {} : { readRequests };
  const journeyHash = journeyContentHash(journey);

  const base = await boundedRun(runOpts, { structuredFailures: true });
  const baseFields = { outcome: base.outcome, ...(base.outcome === "quarantined" ? { reason: base.reason } : {}) };
  const sites = journeyAssertions(journey);
  const checkOf = new Map(sites.map((s) => [assertionSiteKey(s), describeCheck(s.check)]));
  const plan = planJourneyMutations(journey, { ...lintOpts, params: opts.params });

  const mutations: JourneyVerifyMutation[] = [];
  // #616: automatic targeted proofs stopped at their relaxation bound, each a reviewable start.
  const suggested: JourneyTargetedProofPlan[] = [];
  const seenSuggestions = new Set<string>();
  if (base.outcome === "ok") {
    // One mutated replay, as `mutationReplay` (or #554's `relaxedMutationReplay`) describes it.
    type Replayed = NonNullable<JourneyVerifyMutation["relaxed"]>;
    // #565: a param mutation's replay runs with altered params (never a secret's), so it needs them.
    const replayOpts = { ...lintOpts, params: opts.params };
    // The replay is DESCRIBED, not fixed: `mutateJourney` re-describes it on the Journey the run moved
    // onto the environment (#247), so a mutated copy never drops `--env`/`--base-url`.
    const attemptReplay = async (m: JourneyMutation, describe: (j: Journey) => MutationReplay, retry: boolean): Promise<Replayed> => {
      try {
        const how = describe(journey);
        const r = await boundedRun(
          how.params === undefined ? runOpts : { ...runOpts, params: { ...how.params } },
          {
            structuredFailures: true,
            ...(how.relaxedStepRequests === undefined ? {} : { relaxedStepRequests: how.relaxedStepRequests }),
            ...(how.journey === journey ? {} : { mutateJourney: (j) => describe(j).journey }),
            ...(how.skipIndex === undefined ? {} : { skipStep: (i: number) => i === how.skipIndex }),
            ...(how.swapSelectAtStep === undefined ? {} : { selectAlternativeAtStep: how.swapSelectAtStep }),
            ...(how.blockIndex === undefined ? {} : { blockWritesAtStep: how.blockIndex }),
          },
          m,
          retry,
        );
        const blocked = r.blockedWrites ?? [];
        const blockedFields = how.blockIndex === undefined ? {} : { blockedWrites: blocked.map((b) => `${b.method} ${b.path}`) };
        // #579: a select mutation found no other enabled live option — not applied, never proof.
        if (r.outcome === "quarantined" && /no-alternative/.test(r.reason)) {
          return { outcome: "not-applied", failedSites: [], ...blockedFields, reason: r.reason };
        }
        if (how.blockIndex !== undefined && !blockedOwnWrite(how.blockRequests ?? [], blocked)) {
          return {
            outcome: "not-applied",
            failedSites: [],
            ...blockedFields,
            reason: `step ${m.step}'s own write was not blocked${(how.blockRequests ?? []).length === 0 ? "" : ` (recorded: ${(how.blockRequests ?? []).join(", ")})`}`,
          };
        }
        return {
          outcome: r.outcome === "quarantined" ? "failed" : "passed",
          failedSites: failedSitesOf(r, r.outcomeFailures ?? []),
          ...blockedFields,
          ...(r.outcome === "quarantined" ? { reason: r.reason } : {}),
        };
      } catch (err) {
        // A stall ends the proof: it never reads as one mutation's error, which could still end `proven`.
        if (err instanceof JourneyVerifyStalledError) throw err;
        return { outcome: "error", failedSites: [], reason: err instanceof Error ? err.message : String(err) };
      }
    };
    const retriesOf = new Map<string, { readonly reason: string }[]>();
    // #778: one infrastructure error must not cost the proof, so an errored replay runs once more, its
    // fixtures set up and restored by the run as between any two replays. A `failed` replay is a result
    // and a stall ends the proof: neither gets here. A replay that never started (`describe` refused it,
    // as a targeted proof's bad relaxation) would only be refused again.
    const runReplay = async (m: JourneyMutation, describe: (j: Journey) => MutationReplay): Promise<Replayed> => {
      const before = replays;
      const first = await attemptReplay(m, describe, false);
      if (first.outcome !== "error" || replays === before) return first;
      retriesOf.set(m.id, [...(retriesOf.get(m.id) ?? []), { reason: first.reason ?? "unknown error" }]);
      return attemptReplay(m, describe, true);
    };
    // #402: a named mutation lowers to its `MutationReplay`; #609's targeted proof passes one directly.
    const replay = (m: JourneyMutation, describe: typeof mutationReplay): Promise<Replayed> => runReplay(m, (j) => describe(j, m, replayOpts));
    const siteByKey = new Map(sites.map((s) => [assertionSiteKey(s), s]));
    for (const m of plan.mutations) {
      const first = await replay(m, mutationReplay);
      // #554: a first failure at the mutated step's own postcondition hides the LATER paired sites
      // behind it; one relaxed replay (same action, the step's own expect/waitFor left out) judges them.
      const relaxed = needsRelaxedReplay(plan, m, first) ? await replay(m, relaxedMutationReplay) : undefined;
      const initial: MutationRunResult = { outcome: first.outcome, failedSites: first.failedSites, ...(relaxed === undefined ? {} : { relaxed }) };
      // #609: a later assertion still a `cascade` is only hidden by an earlier postcondition; a
      // targeted proof relaxes them one at a time (in a clone) to reach the target itself.
      const targeted: TargetedProof[] = [];
      for (const pair of plan.pairs) {
        if (pair.mutation !== m.id) continue;
        const site = siteByKey.get(pair.site);
        if (site === undefined || classifyMutation(site, m, initial) !== "cascade") continue;
        // #616: a declared plan (reviewed earlier relaxations) replaces the automatic bound search.
        const declared = declaredTargetedProofFor(journey, m, pair.site);
        targeted.push(
          declared === undefined
            ? await runTargetedProof(journey, plan, m, site, initial, (describe) => runReplay(m, describe), replayOpts)
            : await runDeclaredTargetedProof(journey, plan, m, site, declared, (describe) => runReplay(m, describe), replayOpts),
        );
        // #616: a proof the automatic bound stopped names the plan a human could declare instead.
        const suggestion = suggestTargetedProofPlan(targeted[targeted.length - 1]!, m);
        if (suggestion !== null) {
          const key = `${suggestion.check}\u0000${suggestion.mustFailWhen}\u0000${suggestion.relax.join(",")}`;
          if (!seenSuggestions.has(key)) {
            seenSuggestions.add(key);
            suggested.push(suggestion);
          }
        }
      }
      mutations.push({
        kind: m.kind,
        step: m.step,
        id: m.id,
        ...(m.param === undefined ? {} : { param: m.param }),
        ...(m.source === undefined ? {} : { source: m.source }),
        ...first,
        ...(relaxed === undefined ? {} : { relaxed }),
        ...(targeted.length === 0 ? {} : { targeted }),
        ...(retriesOf.has(m.id) ? { retries: retriesOf.get(m.id)! } : {}),
      });
    }
  }

  const results = new Map<string, MutationRunResult>(
    mutations.map((m) => [
      m.id,
      { outcome: m.outcome, failedSites: m.failedSites, ...(m.relaxed === undefined ? {} : { relaxed: m.relaxed }), ...(m.targeted === undefined ? {} : { targeted: m.targeted }) },
    ]),
  );
  // Base failed: nothing ran, so every paired assertion is an `error` (no proof either way).
  const judged = judgeAssertions(journey, plan, results);
  const assertions: JourneyVerifyAssertion[] = judged.map((a) => ({
    site: a.site,
    check: checkOf.get(a.site) ?? a.site,
    verdict: a.verdict,
    ...(a.provedBy === undefined ? {} : { provedBy: a.provedBy }),
    ...(a.relaxedSites === undefined ? {} : { relaxedSites: a.relaxedSites }),
    ...(a.targetedRefusal === undefined ? {} : { targetedRefusal: a.targetedRefusal }),
    // #616: the proving proof was a declared plan, not the automatic relaxation search.
    ...(a.provedBy !== undefined && results.get(a.provedBy)?.targeted?.some((t) => t.site === a.site && t.declared === true) === true ? { declaredProof: true as const } : {}),
  }));
  const order = new Map(journeyAssertions(journey).map((s, i) => [assertionSiteKey(s), i]));
  const siteOrder = (key: string): number => order.get(key) ?? Number.MAX_SAFE_INTEGER;
  const { verdict, reason } = mutationProofVerdict({ basePassed: base.outcome === "ok", mutations, assertions: judged });
  const count = (v: AssertionVerdict): number => assertions.filter((a) => a.verdict === v).length;
  const report: JourneyVerifyReport = {
    journeyId: journey.metadata.id,
    journeyHash,
    base: baseFields,
    verdict,
    ...(reason === undefined ? {} : { reason }),
    mutations,
    assertions,
    summary: {
      sensitive: count("sensitive"),
      insensitive: count("insensitive"),
      cascade: count("cascade"),
      notApplied: count("not-applied"),
      error: count("error"),
      unpaired: count("unpaired"),
      // #609: assertions proven sensitive through a targeted proof that relaxed earlier sites.
      targeted: assertions.filter((a) => (a.relaxedSites?.length ?? 0) > 0).length,
    },
    // #616: in assertion order, so the first suggestion is the one for the refusal the verdict quotes.
    ...(suggested.length === 0 ? {} : { suggestedTargetedProofs: [...suggested].sort((a, b) => siteOrder(a.check) - siteOrder(b.check)) }),
  };
  // Reasons and check texts can quote what the page showed: a secret parameter never comes back.
  const redacted = redactSecretParams(report, journey, opts.params);
  const proofContext = journeyProofContext(opts.browser, opts.emulation);
  // #432: the verdict is kept beside the Journey (bound to its review hash) for `journey review`.
  await writePreflightedVerifyRecord(receiptDestination, {
    journeyId: journey.metadata.id,
    contentHash: journeyReviewHash(journey),
    proofHash: journeyProofHashForContext(journey, proofContext),
    ...(proofContext === undefined ? {} : { proofContext }),
    verdict: redacted.verdict,
    ...(redacted.reason === undefined ? {} : { reason: redacted.reason }),
    summary: { ...redacted.summary },
    ...(redacted.suggestedTargetedProofs === undefined ? {} : { suggestedTargetedProofs: redacted.suggestedTargetedProofs }),
    at: clock.nowIso(),
  });
  return redacted;
}

/** One human line per assertion — verdict, site, check, and the mutation that proved it. */
export function verifyAssertionLine(a: JourneyVerifyAssertion): string {
  // #609: a sensitive verdict reached by a targeted proof names the earlier postconditions it relaxed.
  // #616: a declared plan's relaxations are named as reviewed, not as an automatic search.
  const relaxed =
    a.relaxedSites === undefined || a.relaxedSites.length === 0 ? "" : a.declaredProof === true ? `, declared plan relaxed ${a.relaxedSites.join(", ")}` : `, relaxed ${a.relaxedSites.join(", ")}`;
  const proved = a.provedBy === undefined ? "" : `  (proved by ${a.provedBy}${relaxed})`;
  const refused = a.targetedRefusal === undefined ? "" : `  (targeted proof refused: ${a.targetedRefusal})`;
  return `${a.verdict.padEnd(11)}  ${a.site.padEnd(18)}  ${a.check}${proved}${refused}`;
}
