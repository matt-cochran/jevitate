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
  journeyParamSchema,
  judgeAssertions,
  mutationProofVerdict,
  mutationReplay,
  needsRelaxedReplay,
  paceEndStateFloorMs,
  paceFloorMs,
  paceTailMs,
  pacedReplay,
  planJourneyMutations,
  relaxedMutationReplay,
  runDeclaredTargetedProof,
  runTargetedProof,
  sitesOutranBy,
  sitesReachedEarly,
  suggestTargetedProofPlan,
  thinSites,
  validateParams,
  type AssertionVerdict,
  type Journey,
  type JourneyMutation,
  type JourneyTargetedProofPlan,
  type MutationFailedSite,
  type MutationProofVerdict,
  type MutationReplay,
  type MutationRunResult,
  type ReplayPace,
  type TargetedProof,
} from "@jevitate/journey";
import { DEFAULT_STEP_RESPONSE_TIMEOUT_MS, describeCheck, evaluateNetworkCheckAwaiting, monitorFor, type BlockedWrite, type RequestCapture } from "@jevitate/explore";
import { clock } from "@jevitate/domain";
import { checkAssertion, waitForOutcome, type StepObserver } from "@jevitate/interpreter";
import { AssertionRefError, assertionRefs, resolveAssertionRefs } from "@jevitate/recording";
import { BrowseTheWebToken, type Actor } from "@jevitate/screenplay";
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
import {
  JourneyVerifyResumeRefusedError,
  RETRY_REASON_NOT_KEPT,
  checkpointPairOf,
  checkpointReplayOf,
  openProofCheckpoint,
  resumeRefusalAgainstBase,
  reusedProofFields,
  type CheckpointPair,
  type CheckpointReplay,
  type ProofCheckpointRequest,
  type ProofCheckpointSession,
} from "./journey-verify-checkpoint.js";
import { composeObservers } from "./run-screenshots.js";

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
  /** #787: keep durable progress for this proof, and with `resume` reuse the pairs an earlier run finished. */
  readonly checkpoint?: ProofCheckpointRequest;
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
    // A relaxed site's kept response wait (`RelaxedSiteWait`) runs per request check, one after another.
    replay += ACTION_BOUND_MS + SITE_GATE_WAIT_MS + RELOAD_BOUND_MS + (recorded.responseTimeoutMs ?? responseDefault) * Math.max(1, recorded.expectRequests?.length ?? 0);
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
function trackedPortFactory(factory: () => BrowserPort, onOpened: () => void): { factory: () => BrowserPort; abandon: () => Promise<void> } {
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
    onOpened();
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
  onSessionOpened: () => void,
): Promise<T> {
  const tracked = trackedPortFactory(portFactory, onSessionOpened);
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

type TargetedControlDiagnostics = NonNullable<TargetedProof["controlDiagnostics"]>;
type ReplayDiagnostics = TargetedControlDiagnostics["control"];
type StorageCounts = NonNullable<ReplayDiagnostics["storageBeforeEndState"]>;
type RelaxedSiteWait = NonNullable<MutationReplay["relaxedSiteWaits"]>[number];
type RelaxedWaitEnding = ReplayDiagnostics["relaxedWaits"][number]["ending"];

/**
 * #785: code's reading of a failed control against the base replay. A request short of the base's, or
 * storage short of it before the reload, is timing; storage that was there before the reload and gone
 * after it, against a base that kept it, is clearing.
 */
export function controlFailureIndications(control: ReplayDiagnostics, base: ReplayDiagnostics | undefined, contextOptionsMatchBase: boolean | undefined): TargetedControlDiagnostics["indicates"][number][] {
  const out: TargetedControlDiagnostics["indicates"][number][] = [];
  if (control.stepsCompleted < control.stepsTotal || (base !== undefined && control.writesSent < base.writesSent)) out.push("action-omission");
  if (control.pageReplaced || control.sessionsOpened > 1 || contextOptionsMatchBase === false) out.push("browser-context-replacement");
  const keys = (c: StorageCounts | null): number | null => (c === null ? null : c.sessionStorageKeys + c.localStorageKeys + c.cookies);
  const before = keys(control.storageBeforeEndState);
  const baseBefore = base === undefined ? null : keys(base.storageBeforeEndState);
  const after = keys(control.storageAfterEndState);
  const baseAfter = base === undefined ? null : keys(base.storageAfterEndState);
  const writesShort = base !== undefined && control.writesSent >= base.writesSent && control.writesAnswered < base.writesAnswered;
  const storageShort = before !== null && baseBefore !== null && before < baseBefore;
  if (writesShort || storageShort) out.push("end-state-timing");
  else if (before !== null && baseBefore !== null && after !== null && baseAfter !== null && after < baseAfter) out.push("storage-clearing");
  return out;
}

const siteKeyOf = (f: MutationFailedSite): string =>
  f.where === "step" ? `step:${f.step}` : f.where === "step-request" ? `step-request:${f.step}:${f.checkIndex}` : f.where === "end-state" ? `end-state:${f.index}` : "unevaluable";

/**
 * #785: runs the waits a replay's relaxed sites keep (`RelaxedSiteWait`), as each step ends. Each is
 * bounded, and how it ended is only recorded: an observer never changes the replay's verdict.
 */
function relaxedWaitObserver(
  waits: () => readonly RelaxedSiteWait[],
  params: Readonly<Record<string, string>>,
  responseTimeoutMs: number,
  record: (ended: ReplayDiagnostics["relaxedWaits"][number]) => void,
): StepObserver {
  const captures = new Map<number, RequestCapture>();
  const stopCapture = (actor: Actor, index: number): void => {
    const capture = captures.get(index);
    if (capture === undefined) return;
    monitorFor(actor.ability(BrowseTheWebToken).session.page).stopCapture(capture);
    captures.delete(index);
  };
  const ownWaits = (index: number): readonly RelaxedSiteWait[] => waits().filter((w) => w.step === index + 1);
  const pageWait = async (actor: Actor, w: Extract<RelaxedSiteWait, { kind: "page" }>, step: number): Promise<RelaxedWaitEnding> => {
    let assertion = w.assertion;
    if (assertionRefs(assertion).length > 0) {
      try {
        assertion = resolveAssertionRefs(assertion, (name) => (Object.hasOwn(params, name) ? { value: params[name]!, secret: false } : undefined));
      } catch (err) {
        if (err instanceof AssertionRefError) return "unresolved";
        throw err;
      }
    }
    if (w.wait !== undefined) return (await waitForOutcome(actor, assertion, w.wait, step)).ending;
    return (await checkAssertion(actor, assertion)) ? "held" : "timeout";
  };
  return {
    beforeStep: async ({ actor, index }) => {
      if (!ownWaits(index).some((w) => w.kind === "response")) return;
      await monitorFor(actor.ability(BrowseTheWebToken).session.page).instrument();
      stopCapture(actor, index);
      captures.set(index, monitorFor(actor.ability(BrowseTheWebToken).session.page).startCapture());
    },
    afterStep: async ({ actor, index, outcome }) => {
      try {
        if (outcome !== "done") return;
        for (const w of ownWaits(index)) {
          const startedAt = clock.monotonicMs();
          let ending: RelaxedWaitEnding = "not-run";
          try {
            if (w.kind === "page") ending = await pageWait(actor, w, index + 1);
            else {
              const capture = captures.get(index);
              if (capture !== undefined) {
                const { result } = await evaluateNetworkCheckAwaiting(w.check, () => ({ requests: capture.sent(), truncated: capture.truncated }), w.responseTimeoutMs ?? responseTimeoutMs);
                ending = result.passed ? "held" : "timeout";
              }
            }
          } catch {
            // A closed or broken page ends the wait. The replay's own next action reports it.
          }
          record({ site: w.site, ending, waitedMs: Math.round(clock.monotonicMs() - startedAt) });
        }
      } finally {
        stopCapture(actor, index);
      }
    },
  };
}

const READ_METHODS: ReadonlySet<string> = new Set(["GET", "HEAD", "OPTIONS"]);
/** How long a diagnostic read of the page may take: a frozen renderer must not hold up a replay's close. */
const STORAGE_READ_BOUND_MS = 1_000;

/** A page can redefine what these read, so anything but a real count is no reading: page text never reaches a report. */
const isCount = (n: unknown): n is number => typeof n === "number" && Number.isSafeInteger(n) && n >= 0;

/** Key and cookie counts of the page, never a value. Null when the page cannot say in time, or says anything but a count. */
async function readStorageCounts(page: BrowserSession["page"]): Promise<StorageCounts | null> {
  let timer: ReturnType<typeof clock.setTimeout> | undefined;
  const read = async (): Promise<StorageCounts | null> => {
    const [sessionStorageKeys, localStorageKeys, cookies] = await Promise.all([
      page.evaluate("sessionStorage.length") as Promise<unknown>,
      page.evaluate("localStorage.length") as Promise<unknown>,
      page.context().cookies(),
    ]);
    return isCount(sessionStorageKeys) && isCount(localStorageKeys) ? { sessionStorageKeys, localStorageKeys, cookies: cookies.length } : null;
  };
  try {
    return await Promise.race([
      read(),
      new Promise<null>((resolve) => {
        timer = clock.setTimeout(() => resolve(null), STORAGE_READ_BOUND_MS);
      }),
    ]);
  } catch {
    return null;
  } finally {
    clock.clearTimeout(timer);
  }
}

/**
 * #785: watches one replay for the counts a failed control's diagnostics compare with the base
 * replay's. Observation only: it adds listeners and reads counts, and never acts on the page.
 */
class ReplayProbe {
  #stepsCompleted = 0;
  #sessionsOpened = 0;
  #pageReplaced = false;
  #writesSent = 0;
  #writesAnswered = 0;
  #writesAborted = 0;
  #before: StorageCounts | null = null;
  #after: StorageCounts | null = null;
  #openedPage: BrowserSession["page"] | undefined;
  #openOptions: string | undefined;
  readonly #stepsTotal: number;
  readonly #relaxedWaits: ReplayDiagnostics["relaxedWaits"][number][] = [];
  readonly #beforeClose: ((writesSent: number) => Promise<void>) | undefined;
  #writesInFlightAtClose = 0;

  constructor(stepsTotal: number, beforeClose?: (writesSent: number) => Promise<void>) {
    this.#stepsTotal = stepsTotal;
    this.#beforeClose = beforeClose;
  }

  /** Writes the replay still had open as its session closed: each may yet land in the next replay. */
  get writesInFlightAtClose(): number {
    return this.#writesInFlightAtClose;
  }

  get openOptions(): string | undefined {
    return this.#openOptions;
  }

  recordWait(ended: ReplayDiagnostics["relaxedWaits"][number]): void {
    this.#relaxedWaits.push(ended);
  }

  #watch(session: BrowserSession): void {
    const page = session.page;
    this.#openedPage = page;
    if (typeof page?.on !== "function") return;
    const isWrite = (r: { method(): string }): boolean => !READ_METHODS.has(r.method().toUpperCase());
    page.on("request", (r) => void (isWrite(r) && (this.#writesSent += 1)));
    page.on("requestfinished", (r) => void (isWrite(r) && (this.#writesAnswered += 1)));
    page.on("requestfailed", (r) => void (isWrite(r) && (this.#writesAborted += 1)));
  }

  /** The port factory with this probe on every session it opens, reading the final page before it closes. */
  wrap(factory: () => BrowserPort): () => BrowserPort {
    return () => {
      const port = factory();
      return {
        open: async (o) => {
          this.#sessionsOpened += 1;
          try {
            this.#openOptions = JSON.stringify(o);
          } catch {
            // Options that cannot be compared stay unknown: observation never stops a replay.
          }
          const session = await port.open(o);
          this.#watch(session);
          return new Proxy(session, {
            get: (target, prop) => {
              const value: unknown = Reflect.get(target, prop, target);
              if (prop === "close") {
                return async () => {
                  await this.#beforeClose?.(this.#writesSent);
                  this.#writesInFlightAtClose = Math.max(0, this.#writesSent - this.#writesAnswered - this.#writesAborted);
                  if (typeof target.page?.evaluate === "function") this.#after = await readStorageCounts(target.page);
                  return target.close();
                };
              }
              return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(target) : value;
            },
          });
        },
      };
    };
  }

  observer(): StepObserver {
    return {
      afterStep: async ({ actor, index, outcome }) => {
        if (outcome !== "done") return;
        this.#stepsCompleted += 1;
        const page = actor.ability(BrowseTheWebToken).session.page;
        if (this.#openedPage !== undefined && page !== this.#openedPage) this.#pageReplaced = true;
        if (index === this.#stepsTotal - 1 && typeof page?.evaluate === "function") this.#before = await readStorageCounts(page);
      },
    };
  }

  read(): ReplayDiagnostics | undefined {
    if (this.#sessionsOpened === 0) return undefined;
    return {
      stepsTotal: this.#stepsTotal,
      stepsCompleted: this.#stepsCompleted,
      sessionsOpened: this.#sessionsOpened,
      pageReplaced: this.#pageReplaced,
      writesSent: this.#writesSent,
      writesAnswered: this.#writesAnswered,
      writesAborted: this.#writesAborted,
      writesUnfinished: Math.max(0, this.#writesSent - this.#writesAnswered - this.#writesAborted),
      storageBeforeEndState: this.#before,
      storageAfterEndState: this.#after,
      relaxedWaits: [...this.#relaxedWaits],
    };
  }
}

/**
 * One replay's time against the base's (`ReplayPace`), from `originIndex`'s start. As each step ends it
 * holds the replay to `floor`, then notes how long it had taken. Observation and waiting only: it never
 * acts on the page or changes how a step ended.
 */
class ReplayPacer {
  readonly reachedMs: (number | undefined)[] = [];
  endStateReachedMs: number | undefined;
  readonly #createdAt = clock.monotonicMs();
  #originAt: number | undefined;

  constructor(
    readonly originIndex: number,
    readonly floor: (index: number) => number | undefined,
  ) {}

  /** Holds until `untilMs` from the origin (from the replay's creation, when it stopped before the origin). */
  hold(untilMs: number | undefined): Promise<void> {
    const left = (untilMs ?? 0) - (clock.monotonicMs() - (this.#originAt ?? this.#createdAt));
    return left > 0 ? clock.sleep(left) : Promise.resolve();
  }

  /** Notes how long the replay had taken to get to its end state. */
  noteEndState(): void {
    if (this.#originAt !== undefined) this.endStateReachedMs = clock.monotonicMs() - this.#originAt;
  }

  observer(): StepObserver {
    return {
      beforeStep: async ({ index }) => {
        if (index === this.originIndex) this.#originAt = clock.monotonicMs();
      },
      afterStep: async ({ index, outcome }) => {
        if (this.#originAt === undefined) return;
        if (outcome === "done") await this.hold(this.floor(index));
        this.reachedMs[index] = clock.monotonicMs() - this.#originAt;
      },
    };
  }
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
    /** Sites this replay failed at sooner than the base replay passed them, so its failure counts for nothing. */
    readonly waitsCut?: readonly string[];
  };
  /** #609: targeted proofs run for assertion sites this mutation left as a cascade. */
  readonly targeted?: readonly TargetedProof[];
  /** Sites this replay failed at sooner than the base replay passed them, so its failure counts for nothing. */
  readonly waitsCut?: readonly string[];
  /** How the fresh unmutated replay ended, when a site this mutation read sensitive had little to spare over the base replay. */
  readonly control?: MutationRunResult["outcome"];
  /** What that replay did against the base, when it did not pass. */
  readonly controlDiagnostics?: TargetedControlDiagnostics;
  /**
   * #778: a replay of this mutation (first, relaxed or targeted) errored and was run once more. One
   * entry per retry, with the error it followed. The replay's own result above is the retry's.
   */
  readonly retries?: readonly { readonly reason: string }[];
  /**
   * #787: this result came from a checkpoint and no replay of it ran in this process. The checkpoint
   * keeps what the verdict reads and nothing the app wrote, so `reason`, `blockedWrites` and
   * `controlDiagnostics` are absent here, and a `retries` entry or a targeted `refused` says its wording is not kept.
   */
  readonly reused?: true;
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
  /** #787: how many of `mutations` were reused from a checkpoint rather than run by this process. 0 on a run that did not resume. */
  readonly reusedPairs: number;
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
  const owned: { session?: ProofCheckpointSession } = {};
  try {
    return await proveJourneyMutations(opts, run, owned);
  } catch (err) {
    // In an MCP server the process outlives the proof, so its pid no longer says the proof is running.
    owned.session?.interrupted();
    throw err;
  } finally {
    endHold();
  }
}

/** Why a replay that closed with more writes open than the base may have decided another. Named by mutation id only. */
function notIsolatedBy(id: string): string {
  return `a replay of ${id} closed with a write still unanswered, which may land inside a later replay; the proof cannot say which replay it decided`;
}

/** A pair's result from its checkpoint, in the report's shape. */
function reusedMutation(pair: CheckpointPair): JourneyVerifyMutation {
  return {
    kind: pair.kind,
    step: pair.step,
    id: pair.id,
    ...(pair.param === undefined ? {} : { param: pair.param }),
    ...(pair.source === undefined ? {} : { source: pair.source }),
    ...reusedProofFields(pair),
    ...(pair.retries === 0 ? {} : { retries: Array.from({ length: pair.retries }, () => ({ reason: RETRY_REASON_NOT_KEPT })) }),
    reused: true,
  };
}

async function proveJourneyMutations(opts: VerifyJourneyOptions, run: Run, owned: { session?: ProofCheckpointSession }): Promise<JourneyVerifyReport> {
  const journey = await loadJourneyToVerify(opts.dir, opts.id);
  // #711: receipt authority is proven before the first baseline/mutation replay spends a browser.
  const receiptDestination = await preflightVerifyRecord(opts.dir, journey.metadata.id);
  const { readRequests, onProgress, slotGovernor: _slotGovernor, checkpoint: checkpointRequest, ...runOpts } = opts;
  const inactivityMs = proofInactivityMs(journey, opts);
  const portFactory = opts.browserPortFactory ?? ((): BrowserPort => new PlaywrightBrowserPort());
  let replays = 0;
  // Every replay of the proof goes through here: it is reported, and it is bounded.
  let sessionsOpened = 0;
  // A replay's restore may fail whether it passes, fails or throws, so the run reports it as it happens.
  let restoreFailed = false;
  const lintOpts = readRequests === undefined ? {} : { readRequests };
  const journeyHash = journeyContentHash(journey);
  const sites = journeyAssertions(journey);
  const plan = planJourneyMutations(journey, { ...lintOpts, params: opts.params });
  // #787: claimed before the first replay: a refused resume spends no browser and runs no hook.
  // Bad params are the replay's own refusal, raised here too so a mistyped command cannot replace a checkpoint.
  if (checkpointRequest !== undefined) validateParams(journeyParamSchema(journey), opts.params);
  const opened = checkpointRequest === undefined ? {} : await openProofCheckpoint(checkpointRequest, { journey, journeyHash, plan, params: opts.params, sites });
  const checkpoint = opened.session;
  if (checkpoint !== undefined) owned.session = checkpoint;
  const resuming = opened.resume;
  // A taint belongs to the whole proof: an earlier run's stands, or a resume could read `proven` where the uninterrupted proof could not.
  if (resuming?.restoreFailed === true) restoreFailed = true;
  const boundedRun = (options: Parameters<Run>[0], mutation: NonNullable<Parameters<Run>[1]>, m?: Pick<JourneyMutation, "id">, retry = false, probe?: ReplayProbe): ReturnType<Run> => {
    replays += 1;
    checkpoint?.replayStarted(replays);
    const where: JourneyVerifyProgress = { replay: replays, ...(m === undefined ? {} : { mutation: m.id }), ...(retry ? { retry: true as const } : {}) };
    onProgress?.(retry && m !== undefined ? { ...where, mutation: `${m.id} (retry after error)` } : where);
    return replayWithinBound((browserPortFactory) => run({ ...options, browserPortFactory }, { ...mutation, onFixtureRestoreFailed: () => {
          restoreFailed = true;
          checkpoint?.taint({ restoreFailed: true });
        } }), probe === undefined ? portFactory : probe.wrap(portFactory), where, inactivityMs, () => void (sessionsOpened += 1));
  };

  const stepsTotal = flatJourneySteps(journey).length;
  const baseProbe = new ReplayProbe(stepsTotal);
  const basePacer = new ReplayPacer(0, () => undefined);
  const base = await boundedRun({ ...runOpts, observer: composeObservers(baseProbe.observer(), basePacer.observer()) }, { structuredFailures: true, afterEndState: () => basePacer.noteEndState() }, undefined, false, baseProbe);
  // Every other replay waits as this one did, so this one is their control (`pacedReplay`).
  const pace: ReplayPace = { stepEndMs: basePacer.reachedMs.filter((ms): ms is number => ms !== undefined), ...(basePacer.endStateReachedMs === undefined ? {} : { endStateMs: basePacer.endStateReachedMs }) };
  // Why a replay may have decided another: it closed with more writes open than the base did.
  let notIsolated: string | undefined = resuming === undefined || resuming.notIsolatedBy === null ? undefined : notIsolatedBy(resuming.notIsolatedBy);
  const baseFields = { outcome: base.outcome, ...(base.outcome === "quarantined" ? { reason: base.reason } : {}) };
  const checkOf = new Map(sites.map((s) => [assertionSiteKey(s), describeCheck(s.check)]));
  if (resuming !== undefined) {
    // Nothing is reused against an app whose as-recorded flow no longer passes, or a base it was not paced for.
    if (base.outcome !== "ok") {
      const why = base.outcome === "quarantined" ? redactSecretParams({ reason: base.reason }, journey, opts.params).reason : base.outcome;
      throw new JourneyVerifyResumeRefusedError("base-failed", `the Journey as recorded did not pass the re-run of the base replay (${why})`);
    }
    const refused = resumeRefusalAgainstBase(resuming, plan, sites, pace, baseProbe.writesInFlightAtClose);
    if (refused !== undefined) throw refused;
  }

  const mutations: JourneyVerifyMutation[] = [];
  // #616: automatic targeted proofs stopped at their relaxation bound, each a reviewable start.
  const suggested: JourneyTargetedProofPlan[] = [];
  const seenSuggestions = new Set<string>();
  // #787: this pair's replays as records, by kind, for a later base to be held against.
  let pairReplays: CheckpointReplay[] = [];
  let replayWritesInFlight = 0;
  if (base.outcome === "ok") {
    // One mutated replay, as `mutationReplay` (or #554's `relaxedMutationReplay`) describes it.
    type Replayed = NonNullable<JourneyVerifyMutation["relaxed"]> & { readonly diagnostics?: TargetedControlDiagnostics; readonly reachedMs?: readonly (number | undefined)[]; readonly endStateReachedMs?: number };
    // #565: a param mutation's replay runs with altered params (never a secret's), so it needs them.
    const replayOpts = { ...lintOpts, params: opts.params };
    // The replay is DESCRIBED, not fixed: `mutateJourney` re-describes it on the Journey the run moved
    // onto the environment (#247), so a mutated copy never drops `--env`/`--base-url`.
    const attemptReplay = async (m: JourneyMutation, describe: (j: Journey) => MutationReplay, retry: boolean, kind: "control" | "other"): Promise<Replayed> => {
      try {
        const paced = (j: Journey): MutationReplay => pacedReplay(j, describe(j), m, pace);
        const how = paced(journey);
        // A control is held to no floor: it must not have had longer than the mutated replay it answers for (`evidenceRefusal`).
        const pacer = new ReplayPacer(m.step - 1, kind === "control" ? () => undefined : (index) => paceFloorMs(pace, m, index));
        // #785: a control's counts say, on failure, what it did against the base replay. Any replay that
        // sent a write stays open as long as the base did, so what it started lands before its restore.
        const probe = new ReplayProbe(stepsTotal, async (writesSent) => {
          if (writesSent > 0) await pacer.hold(paceTailMs(pace, m));
        });
        // Described on the Journey the run moved onto the environment, as the mutated copy is.
        let waits: readonly RelaxedSiteWait[] = how.relaxedSiteWaits ?? [];
        const params = how.params ?? opts.params;
        const observer = composeObservers(
          waits.length === 0 ? undefined : relaxedWaitObserver(() => waits, params, opts.stepResponseTimeoutMs ?? DEFAULT_STEP_RESPONSE_TIMEOUT_MS, (ended) => probe.recordWait(ended)),
          kind === "control" ? probe.observer() : undefined,
          pacer.observer(),
        );
        const r = await boundedRun(
          { ...runOpts, ...(how.params === undefined ? {} : { params: { ...how.params } }), observer },
          {
            structuredFailures: true,
            beforeEndState: async () => {
              await pacer.hold(kind === "control" ? undefined : paceEndStateFloorMs(pace, m));
              pacer.noteEndState();
            },
            ...(how.relaxedStepRequests === undefined ? {} : { relaxedStepRequests: how.relaxedStepRequests }),
            ...(how.journey === journey
              ? {}
              : {
                  mutateJourney: (j) => {
                    const onEnvironment = paced(j);
                    waits = onEnvironment.relaxedSiteWaits ?? [];
                    return onEnvironment.journey;
                  },
                }),
            ...(how.skipIndex === undefined ? {} : { skipStep: (i: number) => i === how.skipIndex }),
            ...(how.swapSelectAtStep === undefined ? {} : { selectAlternativeAtStep: how.swapSelectAtStep }),
            ...(how.blockIndex === undefined ? {} : { blockWritesAtStep: how.blockIndex }),
          },
          m,
          retry,
          probe,
        );
        replayWritesInFlight = Math.max(replayWritesInFlight, probe.writesInFlightAtClose);
        if (probe.writesInFlightAtClose > baseProbe.writesInFlightAtClose && notIsolated === undefined) {
          notIsolated = notIsolatedBy(m.id);
          checkpoint?.taint({ notIsolatedBy: m.id });
        }
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
        const failedSites = failedSitesOf(r, r.outcomeFailures ?? []);
        const early = kind === "control" ? [] : sitesReachedEarly(failedSites, m, pace, pacer.reachedMs, pacer.endStateReachedMs);
        const control = r.outcome === "quarantined" && kind === "control" ? probe.read() : undefined;
        const baseDiagnostics = baseProbe.read();
        const contextOptionsMatchBase = baseProbe.openOptions === undefined || probe.openOptions === undefined ? undefined : baseProbe.openOptions === probe.openOptions;
        return {
          outcome: r.outcome === "quarantined" ? "failed" : "passed",
          failedSites,
          ...blockedFields,
          ...(r.outcome === "quarantined" ? { reason: r.reason } : {}),
          ...(early.length === 0 ? {} : { waitsCut: early }),
          reachedMs: pacer.reachedMs,
          ...(pacer.endStateReachedMs === undefined ? {} : { endStateReachedMs: pacer.endStateReachedMs }),
          ...(control === undefined
            ? {}
            : {
                diagnostics: {
                  failedSites: failedSites.map(siteKeyOf),
                  control,
                  ...(baseDiagnostics === undefined ? {} : { base: baseDiagnostics }),
                  ...(contextOptionsMatchBase === undefined ? {} : { contextOptionsMatchBase }),
                  indicates: controlFailureIndications(control, baseDiagnostics, contextOptionsMatchBase),
                },
              }),
        };
      } catch (err) {
        // A stall ends the proof: it never reads as one mutation's error, which could still end `proven`.
        if (err instanceof JourneyVerifyStalledError) throw err;
        return { outcome: "error", failedSites: [], reason: err instanceof Error ? err.message : String(err) };
      }
    };
    const retriesOf = new Map<string, { readonly reason: string }[]>();
    // #778: one infrastructure error must not cost the proof, so a replay that errored before opening a
    // browser, as on an admission timeout, runs once more. One that opened a browser may have changed the
    // app, and a retry failing on that leftover state would read as proof, so it stays an error. A
    // `failed` replay is a result and a stall ends the proof: neither gets here. A replay that never
    // started (`describe` refused it, as a targeted proof's bad relaxation) would only be refused again.
    const attemptWithRetry = async (m: JourneyMutation, describe: (j: Journey) => MutationReplay, kind: "control" | "other"): Promise<Replayed> => {
      const before = replays;
      const sessionsBefore = sessionsOpened;
      const first = await attemptReplay(m, describe, false, kind);
      if (first.outcome !== "error" || replays === before || sessionsOpened !== sessionsBefore) return first;
      retriesOf.set(m.id, [...(retriesOf.get(m.id) ?? []), { reason: first.reason ?? "unknown error" }]);
      return attemptReplay(m, describe, true, kind);
    };
    // #787: the one place a replay of a pair runs, so each is kept as a record of its kind. A new kind is a new name here and in `REPLAY_RECORD_KINDS`.
    const runReplay = async (m: JourneyMutation, describe: (j: Journey) => MutationReplay, record: string, kind: "control" | "other" = "other"): Promise<Replayed> => {
      replayWritesInFlight = 0;
      const ran = await attemptWithRetry(m, describe, kind);
      pairReplays.push(checkpointReplayOf(record, ran, replayWritesInFlight));
      return ran;
    };
    // #402: a named mutation lowers to its `MutationReplay`; #609's targeted proof passes one directly.
    const replay = (m: JourneyMutation, describe: typeof mutationReplay, record: string): Promise<Replayed> => runReplay(m, (j) => describe(j, m, replayOpts), record);
    const reported = ({ reachedMs: _reachedMs, endStateReachedMs: _endStateReachedMs, ...result }: Replayed): Omit<Replayed, "reachedMs" | "endStateReachedMs"> => result;
    const siteByKey = new Map(sites.map((s) => [assertionSiteKey(s), s]));
    // #616: a proof the automatic bound stopped names the plan a human could declare instead.
    const noteSuggestion = (proof: TargetedProof, m: JourneyMutation): void => {
      const suggestion = suggestTargetedProofPlan(proof, m);
      if (suggestion === null) return;
      const key = `${suggestion.check}\u0000${suggestion.mustFailWhen}\u0000${suggestion.relax.join(",")}`;
      if (seenSuggestions.has(key)) return;
      seenSuggestions.add(key);
      suggested.push(suggestion);
    };
    for (const m of plan.mutations) {
      // #787: a finished pair is not run again. It reaches the same judging below as a pair just run.
      const kept = resuming?.pairs.get(m.id);
      if (kept !== undefined) {
        mutations.push(reusedMutation(kept));
        for (const proof of kept.targeted ?? []) noteSuggestion(proof as TargetedProof, m);
        continue;
      }
      checkpoint?.startPair(m.id);
      pairReplays = [];
      const firstRun = await replay(m, mutationReplay, "first");
      // #554: a first failure at the mutated step's own postcondition hides the LATER paired sites
      // behind it; one relaxed replay (same action, the step's own expect/waitFor left out) judges them.
      const relaxedRun = needsRelaxedReplay(plan, m, firstRun) ? await replay(m, relaxedMutationReplay, "relaxed") : undefined;
      const resultOf = (f: Replayed, r: Replayed | undefined): MutationRunResult => ({ outcome: f.outcome, failedSites: f.failedSites, ...(f.waitsCut === undefined ? {} : { waitsCut: f.waitsCut }), ...(r === undefined ? {} : { relaxed: r }) });
      // A site this mutation would read sensitive, reached with little to spare: only then is a fresh
      // unmutated replay run, once per mutation. It must pass, and get there no later than the mutated replay did.
      const thinOf = (r: Replayed): string[] => thinSites(r.failedSites, m, pace, r.reachedMs ?? [], r.endStateReachedMs);
      const wouldCount = plan.pairs.some((p) => {
        const site = siteByKey.get(p.site);
        return p.mutation === m.id && site !== undefined && classifyMutation(site, m, resultOf(firstRun, relaxedRun)) === "sensitive" && [...thinOf(firstRun), ...(relaxedRun === undefined ? [] : thinOf(relaxedRun))].includes(p.site);
      });
      const fresh = wouldCount ? await runReplay(m, (j) => ({ journey: j }), "control", "control") : undefined;
      const checked = (r: Replayed): Replayed => {
        if (fresh === undefined) return r;
        const cut = fresh.outcome === "passed" ? sitesOutranBy(r.failedSites, r.reachedMs ?? [], r.endStateReachedMs, fresh) : thinOf(r);
        return cut.length === 0 ? r : { ...r, waitsCut: [...new Set([...(r.waitsCut ?? []), ...cut])] };
      };
      const first = reported(checked(firstRun));
      const relaxed = relaxedRun === undefined ? undefined : reported(checked(relaxedRun));
      const controlFields = fresh === undefined ? {} : { control: fresh.outcome, ...(fresh.diagnostics === undefined ? {} : { controlDiagnostics: fresh.diagnostics }) };
      const initial: MutationRunResult = { ...resultOf(first, relaxed), ...controlFields };
      // #609: a later assertion still a `cascade` is only hidden by an earlier postcondition; a
      // targeted proof relaxes them one at a time (in a clone) to reach the target itself.
      const targeted: TargetedProof[] = [];
      // One control per set of relaxations: sites of this mutation that relax the same ones share it.
      const controls = new Map<string, Promise<Replayed>>();
      const targetedReplay = (describe: (j: Journey) => MutationReplay, kind: "targeted" | "control", controlKey?: string): Promise<Replayed> => {
        if (kind !== "control") return runReplay(m, describe, "targeted");
        const key = controlKey ?? "";
        const known = controls.get(key);
        if (known !== undefined) return known;
        const running = runReplay(m, describe, "targeted-control", "control");
        controls.set(key, running);
        return running;
      };
      for (const pair of plan.pairs) {
        if (pair.mutation !== m.id) continue;
        const site = siteByKey.get(pair.site);
        if (site === undefined || classifyMutation(site, m, initial) !== "cascade") continue;
        // #616: a declared plan (reviewed earlier relaxations) replaces the automatic bound search.
        const declared = declaredTargetedProofFor(journey, m, pair.site);
        targeted.push(
          declared === undefined
            ? await runTargetedProof(journey, plan, m, site, initial, targetedReplay, replayOpts)
            : await runDeclaredTargetedProof(journey, plan, m, site, declared, targetedReplay, replayOpts),
        );
        noteSuggestion(targeted[targeted.length - 1]!, m);
      }
      const finished: JourneyVerifyMutation = {
        kind: m.kind,
        step: m.step,
        id: m.id,
        ...(m.param === undefined ? {} : { param: m.param }),
        ...(m.source === undefined ? {} : { source: m.source }),
        ...first,
        ...(relaxed === undefined ? {} : { relaxed }),
        ...controlFields,
        ...(targeted.length === 0 ? {} : { targeted }),
        ...(retriesOf.has(m.id) ? { retries: retriesOf.get(m.id)! } : {}),
      };
      mutations.push(finished);
      checkpoint?.finishPair(checkpointPairOf(finished, pairReplays));
    }
  }

  const results = new Map<string, MutationRunResult>(
    mutations.map((m) => [
      m.id,
      { outcome: m.outcome, failedSites: m.failedSites, ...(m.waitsCut === undefined ? {} : { waitsCut: m.waitsCut }), ...(m.relaxed === undefined ? {} : { relaxed: m.relaxed }), ...(m.targeted === undefined ? {} : { targeted: m.targeted }) },
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
  const verdictInput = { basePassed: base.outcome === "ok", mutations, assertions: judged };
  // A last replay as recorded, where its result can still change the verdict: a replay's slow job has no
  // request to watch, so a late landing that stuck is only seen here. It cannot see one a restore then cleared.
  // #787: a resume always runs it: nothing from before the interruption can vouch for how the proof ended.
  if (resuming !== undefined || (pace.stepEndMs.length > 0 && mutationProofVerdict({ ...verdictInput, restoreFailed, ...(notIsolated === undefined ? {} : { notIsolated }) }).verdict !== "inconclusive")) {
    checkpoint?.phase("closing");
    try {
      const closing = await boundedRun({ ...runOpts }, { structuredFailures: true }, { id: "closing replay, as recorded" });
      if (closing.outcome !== "ok") notIsolated = "the Journey as recorded no longer passes after the mutated replays, so state one left behind may have decided another; isolate the replays (a fixture restore, or a longer job's end) and run the proof again";
    } catch (err) {
      if (err instanceof JourneyVerifyStalledError) throw err;
      notIsolated = "the closing replay as recorded errored, so the proof cannot say the replays stayed isolated; retry it";
    }
  }
  const { verdict, reason } = mutationProofVerdict({ ...verdictInput, restoreFailed, ...(notIsolated === undefined ? {} : { notIsolated }) });
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
    reusedPairs: resuming?.pairs.size ?? 0,
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
    ...(redacted.reusedPairs === 0 ? {} : { reusedPairs: redacted.reusedPairs }),
    at: clock.nowIso(),
  });
  checkpoint?.finish(redacted.verdict);
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
