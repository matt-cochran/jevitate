/**
 * #402 — `journey verify --mutate`: a built-in negative proof that each of a Journey's assertions
 * FAILS when its outcome is absent. The Journey is replayed as recorded (it must pass), then
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
  classifyReplay,
  controlCanChangeVerdict,
  declaredTargetedProofFor,
  flatJourneySteps,
  heldSites,
  journeyAssertions,
  ParamValidationError,
  journeyEndState,
  journeyParamSchema,
  journeyWriteSteps,
  judgeAssertions,
  mutationErrored,
  mutationProofVerdict,
  mutationReplay,
  needsRelaxedReplay,
  paceBeforeMutationMs,
  paceEndStateFloorMs,
  paceFloorMs,
  paceMarginBoundMs,
  paceMarginOf,
  paceTailMs,
  pacedReplay,
  planJourneyMutations,
  relaxedMutationReplay,
  runDeclaredTargetedProof,
  runTargetedProof,
  siblingDisagreements,
  sitesReachedEarly,
  sitesUnmatchedBy,
  suggestTargetedProofPlan,
  targetedMutationReplay,
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
  type SiteArrivals,
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
import { UnknownJourneyError, effectiveAllowedOrigins, redactSecretParams, runJourneyProgrammatically, type RunJourneyProgrammaticallyOptions } from "./journey-api.js";
import type { OutcomeCheckFailure } from "./journey-network-checks.js";
import { journeyProofContext, journeyProofHashForContext } from "./journey-proof-context.js";
import {
  JourneyVerifyResumeRefusedError,
  RETRY_REASON_NOT_KEPT,
  type IsolationNote,
  checkpointPairOf,
  checkpointReplayOf,
  isRepairableIsolation,
  openProofCheckpoint,
  resumeRefusalAgainstBase,
  reusedProofFields,
  type CheckpointPair,
  type CheckpointReplay,
  type ProofCheckpointRequest,
  type ProofCheckpointSession,
  type ResumeState,
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
  let longestStepMs = 0;
  for (const { recorded } of flatJourneySteps(journey)) {
    const wait = "waitFor" in recorded.step ? recorded.step.waitFor : undefined;
    // A relaxed site's kept response wait (`RelaxedSiteWait`) runs per request check, one after another.
    let stepMs = ACTION_BOUND_MS + SITE_GATE_WAIT_MS + RELOAD_BOUND_MS + (recorded.responseTimeoutMs ?? responseDefault) * Math.max(1, recorded.expectRequests?.length ?? 0);
    // A wait's last poll can start just before `maxMs` and still reload.
    if (wait !== undefined) stepMs += wait.maxMs + ACTION_BOUND_MS;
    replay += stepMs;
    longestStepMs = Math.max(longestStepMs, stepMs);
  }
  // Only a Journey with steps is paced: its floors' margin, and waiting for open writes before its end state and its close.
  if (longestStepMs > 0) replay += paceMarginBoundMs(longestStepMs) + 2 * (Math.max(responseDefault, longestStepMs) + ABORTED_WRITE_GRACE_MS);
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
/** How long a replay stays open after a write the browser gave up on: the server may still be working, and nothing will say when it stops. */
const ABORTED_WRITE_GRACE_MS = 2_000;
/** How often a replay waiting for its open writes looks again. */
const OPEN_WRITE_POLL_MS = 50;
/** How long the replay that follows a failed independence replay waits: past most of what the failed one started. */
const QUIET_GAP_MIN_MS = 5_000;
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

const lineOfRequest = (method: string, url: string): string => `${method.toUpperCase()} ${pathOf(url)}`;

/**
 * Which writes can land in a later replay and are worth waiting for: to the Journey's own origins, or
 * on a line it recorded. A line it did not record that repeats within a replay, or was seen repeating
 * in the base, is the page's background (a keepalive, telemetry), and so is one that stayed open
 * through both the base and the replay after it (a long-lived connection): those are not waited for.
 */
class WriteScope {
  readonly #origins: ReadonlySet<string>;
  readonly #recorded: ReadonlySet<string>;
  readonly #background = new Set<string>();

  constructor(allowedOrigins: readonly string[], recordedLines: readonly string[]) {
    this.#origins = new Set(
      allowedOrigins.flatMap((o) => {
        try {
          return [new URL(o).origin];
        } catch {
          return [];
        }
      }),
    );
    this.#recorded = new Set(recordedLines.flatMap((l) => {
      const m = REQUEST_LINE.exec(l.trim());
      return m === null ? [] : [lineOfRequest(m[1]!, m[2]!)];
    }));
  }

  counts(line: string, url: string): boolean {
    if (this.#recorded.has(line)) return true;
    try {
      return this.#origins.has(new URL(url).origin);
    } catch {
      return false;
    }
  }

  isBackground(line: string, sentThisReplay: number): boolean {
    return !this.#recorded.has(line) && (sentThisReplay >= 2 || this.#background.has(line));
  }

  isRecorded(line: string): boolean {
    return this.#recorded.has(line);
  }

  addBackground(lines: Iterable<string>): void {
    for (const line of lines) this.#background.add(line);
  }
}

/** A request as the context reports it; a test double may have less. */
type WatchedRequest = { method(): string; url(): string; failure?(): { errorText: string } | null; isNavigationRequest?(): boolean };

/**
 * #785: watches one replay for the counts a failed control's diagnostics compare with the base
 * replay's, and for the writes it still has open. Observation only: it adds listeners and reads
 * counts, and never acts on the page. It watches the context, so a popup's requests count too.
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
  readonly #scope: WriteScope | undefined;
  readonly #open = new Map<unknown, { readonly line: string; readonly seq: number }>();
  #requestSeq = 0;
  #navigationSeq = 0;
  readonly #sent = new Map<string, number>();
  #lastAbortAt: number | undefined;
  #openAtClose: readonly string[] = [];

  constructor(stepsTotal: number, beforeClose?: (writesSent: number) => Promise<void>, scope?: WriteScope) {
    this.#stepsTotal = stepsTotal;
    this.#beforeClose = beforeClose;
    this.#scope = scope;
  }

  /** Writes in scope the replay still had open as its session closed: each may yet land in the next replay. */
  get writesInFlightAtClose(): number {
    return this.#openAtClose.length;
  }

  /** The lines of those writes (`METHOD /path`). */
  get openLinesAtClose(): readonly string[] {
    return this.#openAtClose;
  }

  /** Lines this replay sent more than once and never recorded: the page's own background. */
  get repeatedLines(): readonly string[] {
    return [...this.#sent].filter(([line, n]) => n >= 2 && this.#scope?.isRecorded(line) !== true).map(([line]) => line);
  }

  #openInScope(): string[] {
    return [...this.#open.values()].map((o) => o.line).filter((line) => this.#scope?.isBackground(line, this.#sent.get(line) ?? 0) !== true);
  }

  /**
   * Waits for the writes in scope to be answered, new ones they lead to included, up to `boundMs`,
   * then a moment more after one the browser gave up on: a browser-side abort does not mean the server stopped.
   */
  async settleOpenWrites(boundMs: number): Promise<void> {
    const startedAt = clock.monotonicMs();
    while (clock.monotonicMs() - startedAt < boundMs) {
      const graceLeft = this.#lastAbortAt === undefined ? 0 : this.#lastAbortAt + ABORTED_WRITE_GRACE_MS - clock.monotonicMs();
      if (this.#openInScope().length === 0 && graceLeft <= 0) return;
      await clock.sleep(Math.min(OPEN_WRITE_POLL_MS, boundMs - (clock.monotonicMs() - startedAt)));
    }
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
    const context = typeof page?.context === "function" ? page.context() : undefined;
    const source = (typeof context?.on === "function" ? context : page) as { on?(event: string, listener: (r: WatchedRequest) => void): unknown } | undefined;
    if (typeof source?.on !== "function") return;
    const isWrite = (r: WatchedRequest): boolean => !READ_METHODS.has(r.method().toUpperCase());
    source.on("request", (r) => {
      this.#requestSeq += 1;
      if (r.isNavigationRequest?.() === true) this.#navigationSeq = this.#requestSeq;
      if (!isWrite(r)) return;
      this.#writesSent += 1;
      const line = lineOfRequest(r.method(), r.url());
      this.#sent.set(line, (this.#sent.get(line) ?? 0) + 1);
      if (this.#scope?.counts(line, r.url()) === true) this.#open.set(r, { line, seq: this.#requestSeq });
    });
    // A new document drops what the old one had open, and the browser may report nothing: that is an abort too.
    if (typeof page?.on === "function") {
      page.on("domcontentloaded", () => {
        for (const [r, o] of this.#open) {
          if (o.seq >= this.#navigationSeq) continue;
          this.#open.delete(r);
          this.#lastAbortAt = clock.monotonicMs();
        }
      });
    }
    source.on("requestfinished", (r) => {
      if (!isWrite(r)) return;
      this.#writesAnswered += 1;
      this.#open.delete(r);
    });
    source.on("requestfailed", (r) => {
      if (!isWrite(r)) return;
      this.#writesAborted += 1;
      // A block of ours never left the browser. Any other abort may have reached the server, which goes on working.
      if (this.#open.delete(r) && r.failure?.()?.errorText.includes("BLOCKED_BY_CLIENT") !== true) this.#lastAbortAt = clock.monotonicMs();
    });
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
                  this.#openAtClose = this.#openInScope();
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
  /** Ms from the origin to each step's end. */
  readonly reachedMs: (number | undefined)[] = [];
  /** Ms from the origin to each step's start: when the replay got to that site. */
  readonly arrivedMs: (number | undefined)[] = [];
  /** How long this replay had been held for when it got to each step. */
  readonly heldMs: (number | undefined)[] = [];
  /** Ms from the origin to the moment each step's own claim had held. */
  readonly claimHeldMs: (number | undefined)[] = [];
  endStateReachedMs: number | undefined;
  endStateHeldMs: number | undefined;
  #heldSoFar = 0;
  #firstStepAt: number | undefined;
  #originAt: number | undefined;

  constructor(
    readonly originIndex: number,
    readonly floor: (index: number) => number | undefined,
    /** How long the base took to reach the origin: what a replay that stopped before it is measured against. */
    readonly beforeOriginMs: number = 0,
    /** A step nothing reads the time after: it is not held, and counts as if it had been. */
    readonly notHeld: (index: number) => boolean = () => false,
  ) {}

  /** Ms since this replay's first step began. */
  elapsedMs(): number {
    return this.#firstStepAt === undefined ? 0 : clock.monotonicMs() - this.#firstStepAt;
  }

  /** Holds until `untilMs` from the origin. A replay that stopped before the origin counts from its first step, as far as the base's origin. */
  async hold(untilMs: number | undefined): Promise<void> {
    if (untilMs === undefined) return;
    const left = this.#originAt !== undefined ? untilMs - (clock.monotonicMs() - this.#originAt) : this.#firstStepAt === undefined ? 0 : untilMs + this.beforeOriginMs - this.elapsedMs();
    if (left <= 0) return;
    await clock.sleep(left);
    this.#heldSoFar += left;
  }

  /** Time the replay spent waiting for something it would not otherwise have waited for, counted as held. */
  async holding(wait: () => Promise<void>): Promise<void> {
    const startedAt = clock.monotonicMs();
    await wait();
    this.#heldSoFar += clock.monotonicMs() - startedAt;
  }

  /** Notes how long the replay had taken to get to its end state. */
  noteEndState(): void {
    if (this.#originAt === undefined) return;
    this.endStateReachedMs = clock.monotonicMs() - this.#originAt;
    this.endStateHeldMs = this.#heldSoFar;
  }

  /** First among a replay's observers, so it sees a step's claim hold before anything else that step waits for. */
  claimObserver(): StepObserver {
    return {
      afterStep: async ({ index, outcome }) => {
        if (this.#originAt !== undefined && outcome === "done") this.claimHeldMs[index] = clock.monotonicMs() - this.#originAt;
      },
    };
  }

  observer(): StepObserver {
    return {
      beforeStep: async ({ index }) => {
        this.#firstStepAt ??= clock.monotonicMs();
        if (index === this.originIndex) this.#originAt = clock.monotonicMs();
        if (this.#originAt !== undefined) {
          this.arrivedMs[index] = clock.monotonicMs() - this.#originAt;
          this.heldMs[index] = this.#heldSoFar;
        }
      },
      afterStep: async ({ index, outcome }) => {
        if (this.#originAt === undefined) return;
        const floor = this.floor(index);
        if (outcome === "done" && !this.notHeld(index)) await this.hold(floor);
        const reached = clock.monotonicMs() - this.#originAt;
        this.reachedMs[index] = outcome === "done" && this.notHeld(index) ? Math.max(reached, floor ?? 0) : reached;
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
    readonly atBaseTime?: MutationRunResult["atBaseTime"];
  };
  /** #609: targeted proofs run for assertion sites this mutation left as a cascade. */
  readonly targeted?: readonly TargetedProof[];
  /** Sites this replay failed at sooner than the base replay passed them, so its failure counts for nothing. */
  readonly waitsCut?: readonly string[];
  /** How the fresh unmutated replay ended, when a site this mutation read sensitive had little to spare over the base replay. */
  readonly control?: MutationRunResult["outcome"];
  /** What that replay did against the base, when it did not pass. */
  readonly controlDiagnostics?: TargetedControlDiagnostics;
  /** A reading that would have needed a control kept none, because the proof's verdict was already decided. */
  readonly controlSkipped?: true;
  /** The same replay held only as long as the base took, run when the control failed at the same site (`MutationRunResult.atBaseTime`). */
  readonly atBaseTime?: MutationRunResult["atBaseTime"];
  /** How this mutation's one re-run ended, when a sibling mutation of its step passed a site it failed. */
  readonly rerun?: MutationRunResult["outcome"];
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
 * What a proof that reaches a verdict runs when nothing needs more: the base, the independence replay,
 * one per mutation, and the closing replay, which only a verdict that can still change gets. Relaxed and
 * targeted replays, controls and re-runs add to it. A proof that fails or is tainted partway stops sooner.
 */
function minimumReplaysOf(plan: { readonly mutations: readonly unknown[]; readonly pairs: readonly unknown[] }): number {
  if (plan.mutations.length === 0) return 1;
  return plan.mutations.length + (plan.pairs.length === 0 ? 2 : 3);
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
      minimumReplays: minimumReplaysOf(plan),
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

function paramsAccepted(journey: Journey, params: Record<string, string>): boolean {
  try {
    validateParams(journeyParamSchema(journey), params);
    return true;
  } catch (err) {
    if (err instanceof ParamValidationError) return false;
    throw err;
  }
}

const CROSSED = "so state from one replay may cross into the next (a job it started, by any route, still running); isolate the replays or let the job end, and run the proof again";

/** Why a replay may have decided another, from names alone, so an interrupted proof can give the same reason. */
function isolationReason(note: IsolationNote, by: string | null): string {
  if (note === "write-open") return `a replay of ${by ?? "a mutation"} closed with a write still unanswered, which may land inside a later replay; the proof cannot say which replay it decided`;
  if (note === "base-write-open") return "the base replay closed with a write still unanswered, which may land inside a later replay; the proof cannot say which replay it decided";
  if (note === "state-crossed") return `the Journey as recorded failed straight after the base replay and passed after a quiet gap, ${CROSSED}`;
  if (note === "state-stuck") return `the Journey as recorded no longer passes after the base replay, ${CROSSED}`;
  if (note === "independence-errored") return "the replay as recorded after the base errored, so the proof cannot say the replays are independent; retry it (--resume keeps what finished and runs this replay again)";
  return "sibling mutations disagree on a site, and a control and a re-run could not settle it; run the proof again";
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
    ...(pair.controlSkipped === undefined ? {} : { controlSkipped: pair.controlSkipped }),
    ...(pair.retries === 0 ? {} : { retries: Array.from({ length: pair.retries }, () => ({ reason: RETRY_REASON_NOT_KEPT })) }),
    reused: true,
  };
}

// One mutated replay, as `mutationReplay` (or #554's `relaxedMutationReplay`) describes it.
type Replayed = NonNullable<JourneyVerifyMutation["relaxed"]> & {
  readonly diagnostics?: TargetedControlDiagnostics;
  readonly reachedMs?: readonly (number | undefined)[];
  readonly arrivedMs?: readonly (number | undefined)[];
  readonly heldMs?: readonly (number | undefined)[];
  readonly endStateReachedMs?: number;
  readonly endStateHeldMs?: number;
  readonly marginMs?: number;
};
/**
 * Every kind of replay a proof runs after the base. `first`, `relaxed`, `targeted` and `rerun` carry
 * the mutation. `control`, `targeted-control` and `independence` are as recorded (a targeted control
 * with its relaxations), on the same floors. `at-base-time` is the mutation again, with no margin on its floors.
 */
type ReplayKind = "first" | "relaxed" | "targeted" | "control" | "targeted-control" | "independence" | "rerun" | "at-base-time";
const isUnmutated = (kind: ReplayKind): boolean => kind === "control" || kind === "targeted-control" || kind === "independence";
const labelOf = (m: JourneyMutation, kind: ReplayKind): string => {
  if (kind === "control" || kind === "targeted-control") return `control for step ${m.step}`;
  if (kind === "independence") return "independence replay, as recorded";
  if (kind === "rerun") return `${m.id} (re-run)`;
  if (kind === "at-base-time") return `${m.id} (at the base's time)`;
  return m.id;
};

type BoundedRun = (options: Parameters<Run>[0], mutation: NonNullable<Parameters<Run>[1]>, m?: Pick<JourneyMutation, "id">, retry?: boolean, probe?: ReplayProbe) => ReturnType<Run>;
type ReplayOptions = Omit<VerifyJourneyOptions, "readRequests" | "onProgress" | "slotGovernor" | "checkpoint">;
type Taint = (note: IsolationNote, by?: string | null, detail?: string) => void;

/** What one replay of a proof needs from the proof it is part of. */
interface ReplayContext {
  readonly opts: VerifyJourneyOptions;
  readonly runOpts: ReplayOptions;
  readonly journey: Journey;
  readonly pace: ReplayPace;
  readonly stepsTotal: number;
  readonly settleBoundMs: number;
  readonly writeScope: WriteScope;
  readonly writeSteps: ReturnType<typeof journeyWriteSteps>;
  readonly baseProbe: ReplayProbe;
  readonly boundedRun: BoundedRun;
  readonly taint: Taint;
  readonly noteWritesInFlight: (n: number) => void;
  readonly noteIndependenceOpen: (lines: readonly string[]) => void;
}

/** What a pair's replays, and the re-runs that settle a disagreement, need from the proof. */
interface PairContext {
  readonly journey: Journey;
  readonly plan: ReturnType<typeof planJourneyMutations>;
  readonly pace: ReplayPace;
  readonly siteByKey: ReadonlyMap<string, ReturnType<typeof journeyAssertions>[number]>;
  readonly replayOpts: Parameters<typeof mutationReplay>[2];
  readonly mutations: JourneyVerifyMutation[];
  readonly checkpoint: ProofCheckpointSession | undefined;
  readonly tainted: () => boolean;
  readonly taint: Taint;
  readonly replay: (m: JourneyMutation, describe: typeof mutationReplay, kind: ReplayKind) => Promise<Replayed>;
  readonly runReplay: (m: JourneyMutation, describe: (j: Journey) => MutationReplay, kind: ReplayKind, matchTo?: SiteArrivals) => Promise<Replayed>;
  readonly controlFor: (m: JourneyMutation, runs: readonly Replayed[], sitesAtStake: readonly string[]) => Promise<Replayed>;
  readonly resultsSoFar: (extra?: readonly [string, MutationRunResult]) => ReadonlyMap<string, MutationRunResult>;
  readonly noteSuggestion: (proof: TargetedProof, m: JourneyMutation) => void;
  readonly retriesOf: ReadonlyMap<string, readonly { readonly reason: string }[]>;
  /** This pair's replays as records. Cleared as a pair starts. */
  readonly pairReplays: CheckpointReplay[];
}

interface ConcludeContext {
  readonly opts: VerifyJourneyOptions;
  readonly runOpts: ReplayOptions;
  readonly journey: Journey;
  readonly journeyHash: string;
  readonly plan: ReturnType<typeof planJourneyMutations>;
  readonly sites: ReturnType<typeof journeyAssertions>;
  readonly checkOf: ReadonlyMap<string, string>;
  readonly base: Awaited<ReturnType<Run>>;
  readonly baseFields: JourneyVerifyReport["base"];
  readonly pace: ReplayPace;
  readonly mutations: readonly JourneyVerifyMutation[];
  readonly suggested: readonly JourneyTargetedProofPlan[];
  readonly receiptDestination: Awaited<ReturnType<typeof preflightVerifyRecord>>;
  readonly boundedRun: BoundedRun;
  readonly checkpoint: ProofCheckpointSession | undefined;
  readonly resuming: ResumeState | undefined;
  /** A closing replay's restore can still fail, so this is read when it is needed. */
  readonly restoreFailed: () => boolean;
  readonly notIsolated: string | undefined;
}

const resultOfEntry = (m: JourneyVerifyMutation): MutationRunResult => ({
  outcome: m.outcome,
  failedSites: m.failedSites,
  ...(m.waitsCut === undefined ? {} : { waitsCut: m.waitsCut }),
  ...(m.relaxed === undefined ? {} : { relaxed: m.relaxed }),
  ...(m.targeted === undefined ? {} : { targeted: m.targeted }),
  ...(m.atBaseTime === undefined ? {} : { atBaseTime: m.atBaseTime }),
});

const reported = ({ reachedMs: _reachedMs, arrivedMs: _arrivedMs, heldMs: _heldMs, endStateReachedMs: _end, endStateHeldMs: _endHeld, marginMs: _margin, ...result }: Replayed): Omit<Replayed, "reachedMs" | "arrivedMs" | "heldMs" | "endStateReachedMs" | "endStateHeldMs" | "marginMs"> => result;

// The replay is DESCRIBED, not fixed: `mutateJourney` re-describes it on the Journey the run moved
// onto the environment (#247), so a mutated copy never drops `--env`/`--base-url`.
async function attemptReplay(c: ReplayContext, m: JourneyMutation, describe: (j: Journey) => MutationReplay, retry: boolean, kind: ReplayKind, matchTo?: SiteArrivals): Promise<Replayed> {
  const { opts, runOpts, journey, pace, stepsTotal, settleBoundMs, writeScope, writeSteps, baseProbe, boundedRun, taint } = c;
  const lastIndex = stepsTotal - 1;
  const baseOpenLines = baseProbe.openLinesAtClose;
  const noEndState = journeyEndState(journey).length === 0;
  try {
    const paced = (j: Journey): MutationReplay => pacedReplay(j, describe(j), m, pace);
    const how = paced(journey);
    const withMargin = kind !== "at-base-time";
    // Nothing reads the time after a last step with no end state, so holding it would only cost.
    // A control also gets to each site no sooner than the mutated replay it answers for did, dead waits included.
    const atLeast = (floor: number | undefined, arrival: number | undefined): number | undefined => (floor === undefined || arrival === undefined ? (floor ?? arrival) : Math.max(floor, arrival));
    const pacer = new ReplayPacer(m.step - 1, (index) => atLeast(paceFloorMs(pace, m, index, withMargin), matchTo?.arrivedMs?.[index + 1]), paceBeforeMutationMs(pace, m), (index) => index === lastIndex && noEndState);
    // #785: a control's counts say, on failure, what it did against the base replay. Any replay that
    // sent a write stays open as long as the base did, then until its writes have settled, so what it
    // started lands before its restore.
    const probe: ReplayProbe = new ReplayProbe(stepsTotal, async (writesSent) => {
      if (writesSent > 0) await pacer.hold(paceTailMs(pace, m));
      await probe.settleOpenWrites(settleBoundMs);
    }, writeScope);
    // Described on the Journey the run moved onto the environment, as the mutated copy is.
    let waits: readonly RelaxedSiteWait[] = how.relaxedSiteWaits ?? [];
    const params = how.params ?? opts.params;
    const observer = composeObservers(
      waits.length === 0 ? undefined : relaxedWaitObserver(() => waits, params, opts.stepResponseTimeoutMs ?? DEFAULT_STEP_RESPONSE_TIMEOUT_MS, (ended) => probe.recordWait(ended)),
      isUnmutated(kind) ? probe.observer() : undefined,
      pacer.observer(),
    );
    // The step's own lines stay blocked for the rest of the replay. A later step that records the same line sends its own.
    const blockLines = how.blockRequests ?? [];
    const lineOfRecorded = (line: string): string | undefined => {
      const parsed = REQUEST_LINE.exec(line.trim());
      return parsed === null ? undefined : lineOfRequest(parsed[1]!, parsed[2]!);
    };
    const heldLines = blockLines.flatMap((l) => lineOfRecorded(l) ?? []);
    const r = await boundedRun(
      { ...runOpts, ...(how.params === undefined ? {} : { params: { ...how.params } }), observer },
      {
        structuredFailures: true,
        beforeEndState: async () => {
          await pacer.hold(atLeast(paceEndStateFloorMs(pace, m, withMargin), matchTo?.endStateReachedMs));
          // A claim is judged with what the app was already doing finished, as far as the Journey allows.
          await pacer.holding(() => probe.settleOpenWrites(settleBoundMs));
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
        ...(how.blockIndex === undefined
          ? {}
          : {
              blockWritesAtStep: how.blockIndex,
              blockAfterWindow: {
                requests: heldLines,
                exemptSteps: writeSteps.filter((w) => w.step - 1 !== how.blockIndex && w.requests.some((l) => { const line = lineOfRecorded(l); return line !== undefined && heldLines.includes(line); })).map((w) => w.step - 1),
              },
            }),
      },
      { id: labelOf(m, kind) },
      retry,
      probe,
    );
    c.noteWritesInFlight(probe.writesInFlightAtClose);
    if (kind === "independence") c.noteIndependenceOpen(probe.openLinesAtClose);
    const excused = kind === "independence" && probe.openLinesAtClose.every((line) => baseOpenLines.includes(line));
    if (probe.writesInFlightAtClose > 0 && !excused) {
      taint("write-open", m.id);
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
    // The block did not hold: a server answered the step's own write after its window.
    if (how.blockIndex !== undefined && (r.blockEscaped?.length ?? 0) > 0) {
      return { outcome: "not-applied", failedSites: [], ...blockedFields, reason: `step ${m.step}'s own write was answered after it was blocked (${r.blockEscaped!.join(", ")}), so the mutation did not hold` };
    }
    const failedSites = failedSitesOf(r, r.outcomeFailures ?? []);
    const early = isUnmutated(kind) ? [] : sitesReachedEarly(failedSites, m, pace, pacer.reachedMs, pacer.endStateReachedMs);
    const control = r.outcome === "quarantined" && isUnmutated(kind) ? probe.read() : undefined;
    const baseDiagnostics = baseProbe.read();
    const contextOptionsMatchBase = baseProbe.openOptions === undefined || probe.openOptions === undefined ? undefined : baseProbe.openOptions === probe.openOptions;
    return {
      outcome: r.outcome === "quarantined" ? "failed" : "passed",
      failedSites,
      ...blockedFields,
      ...(r.outcome === "quarantined" ? { reason: r.reason } : {}),
      ...(early.length === 0 ? {} : { waitsCut: early }),
      reachedMs: pacer.reachedMs,
      arrivedMs: pacer.arrivedMs,
      heldMs: pacer.heldMs,
      marginMs: paceMarginOf(pace, m),
      ...(pacer.endStateReachedMs === undefined ? {} : { endStateReachedMs: pacer.endStateReachedMs }),
      ...(pacer.endStateHeldMs === undefined ? {} : { endStateHeldMs: pacer.endStateHeldMs }),
      ...(control === undefined
        ? {}
        : {
            diagnostics: {
              failedSites: failedSites.map(siteKeyOf),
              control,
              ...(baseDiagnostics === undefined ? {} : { base: baseDiagnostics }),
              ...(contextOptionsMatchBase === undefined ? {} : { contextOptionsMatchBase }),
            },
          }),
    };
  } catch (err) {
    // A stall ends the proof: it never reads as one mutation's error, which could still end `proven`.
    if (err instanceof JourneyVerifyStalledError) throw err;
    return { outcome: "error", failedSites: [], reason: err instanceof Error ? err.message : String(err) };
  }
}

/** One planned mutation with all its replays: first, relaxed, control, at the base's time, targeted. */
async function runPair(c: PairContext, m: JourneyMutation): Promise<void> {
  const { journey, plan, pace, siteByKey, replayOpts, mutations, checkpoint, tainted, replay, runReplay, controlFor, resultsSoFar, noteSuggestion, retriesOf, pairReplays } = c;
  checkpoint?.startPair(m.id);
  pairReplays.length = 0;
  const firstRun = await replay(m, mutationReplay, "first");
  // #554: a first failure at the mutated step's own postcondition hides the LATER paired sites
  // behind it; one relaxed replay (same action, the step's own expect/waitFor left out) judges them.
  const relaxedRun = !tainted() && needsRelaxedReplay(plan, m, firstRun) ? await replay(m, relaxedMutationReplay, "relaxed") : undefined;
  const resultOf = (f: Replayed, r: Replayed | undefined): MutationRunResult => ({ outcome: f.outcome, failedSites: f.failedSites, ...(f.waitsCut === undefined ? {} : { waitsCut: f.waitsCut }), ...(r === undefined ? {} : { relaxed: r }) });
  // The sites this mutation reads sensitive that a matched control must vouch for: thin, or held.
  const provisional = resultOf(firstRun, relaxedRun);
  const wouldCount = new Set(plan.pairs.filter((p) => p.mutation === m.id).map((p) => p.site).filter((key) => {
    const site = siteByKey.get(key);
    return site !== undefined && classifyMutation(site, m, provisional) === "sensitive";
  }));
  const needing = (r: Replayed): string[] => [...new Set([...thinSites(r.failedSites, m, pace, r.reachedMs ?? [], r.endStateReachedMs), ...heldSites(r.failedSites, r)])].filter((key) => wouldCount.has(key));
  const atStake = [...new Set([...needing(firstRun), ...(relaxedRun === undefined ? [] : needing(relaxedRun))])];
  const wanted = atStake.length > 0;
  const canChange = (keys: readonly string[]): boolean => !tainted() && controlCanChangeVerdict(journey, plan, resultsSoFar([m.id, provisional]), keys);
  const fresh = wanted && canChange(atStake) ? await controlFor(m, relaxedRun === undefined ? [firstRun] : [firstRun, relaxedRun], atStake) : undefined;
  const checked = async (r: Replayed, describe: typeof mutationReplay): Promise<Replayed> => {
    if (fresh === undefined) return r;
    const keys = needing(r);
    if (keys.length === 0) return r;
    const held = r.failedSites.filter((f) => keys.includes(siteKeyOf(f)));
    const cut = fresh.outcome === "passed" ? sitesUnmatchedBy(held, r, fresh, paceMarginOf(pace, m)) : keys;
    if (cut.length === 0) return r;
    const withCut: Replayed = { ...r, waitsCut: [...new Set([...(r.waitsCut ?? []), ...cut])] };
    // The unmutated replay failed at this very site on these floors, so the hold may be what broke it. Only
    // the mutation at the base's own time can say the claim holds without it.
    const controlFailedHere = fresh.outcome === "failed" && cut.some((key) => fresh.failedSites.some((f) => siteKeyOf(f) === key));
    if (!controlFailedHere || !canChange(cut)) return withCut;
    const timed = await replay(m, describe, "at-base-time");
    return { ...withCut, atBaseTime: { outcome: timed.outcome, failedSites: timed.failedSites } };
  };
  const first = reported(await checked(firstRun, mutationReplay));
  const relaxed = relaxedRun === undefined ? undefined : reported(await checked(relaxedRun, relaxedMutationReplay));
  const controlFields = fresh === undefined ? {} : { control: fresh.outcome, ...(fresh.diagnostics === undefined ? {} : { controlDiagnostics: fresh.diagnostics }) };
  const initial: MutationRunResult = { ...resultOf(first, relaxed), ...(first.atBaseTime === undefined ? {} : { atBaseTime: first.atBaseTime }), ...controlFields };
  // #609: a later assertion still a `cascade` is only hidden by an earlier postcondition; a
  // targeted proof relaxes them one at a time (in a clone) to reach the target itself.
  const targeted: TargetedProof[] = [];
  // One replay per set of relaxations: sites of this mutation that relax the same ones share it, and its control.
  const targetedRuns = new Map<string, Promise<Replayed>>();
  const targetedReplay = (describe: (j: Journey) => MutationReplay, kind: "targeted" | "control", key?: string): Promise<Replayed> => {
    const memoKey = `${kind}\u0000${key ?? ""}`;
    const known = targetedRuns.get(memoKey);
    if (known !== undefined) return known;
    // The proof is already over: a targeted proof's next replay is not run, and whatever it reads, the verdict is decided.
    if (tainted()) return Promise.resolve({ outcome: "error", failedSites: [], reason: "not run: the proof had already ended" });
    // A control runs after the targeted replay it answers for, and gets to each site no sooner than it did.
    const running = kind === "control" ? (targetedRuns.get(`targeted\u0000${key ?? ""}`) ?? Promise.resolve(undefined)).then((run) => runReplay(m, describe, "targeted-control", run)) : runReplay(m, describe, "targeted");
    targetedRuns.set(memoKey, running);
    return running;
  };
  for (const pair of plan.pairs) {
    if (tainted()) break;
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
    ...(wanted && fresh === undefined && !tainted() ? { controlSkipped: true as const } : {}),
    ...(targeted.length === 0 ? {} : { targeted }),
    ...(retriesOf.has(m.id) ? { retries: retriesOf.get(m.id)! } : {}),
  };
  mutations.push(finished);
  // A tainted proof ends here, and a pair cut short by the taint is not a result a resume could stand on.
  if (!tainted()) checkpoint?.finishPair(checkpointPairOf(finished, pairReplays));
}

/**
 * Point 3 of the experiment: one sibling failed a site another passed. The reading stands only if a
 * matched control passes and the failure reproduces on one re-run. If it does not reproduce, the
 * failure is struck and the site falls to the sibling's pass: `insensitive`, since a replay that
 * passed with the mutation applied saw the claim hold without it, twice over. If the two cannot be
 * told apart (the re-run stopped short, the control did not match), neither reading is trusted and
 * the proof is `inconclusive`: a false `insensitive` is as wrong as a false `proven`.
 */
async function settleDisagreements(c: PairContext): Promise<void> {
  const { journey, plan, pace, siteByKey, replayOpts, mutations, checkpoint, tainted, taint, runReplay, controlFor, resultsSoFar } = c;
  // A resume runs these again: only a finished pair is kept, and a re-run answers for the proof it is part of.
  if (plan.mutations.length > 0) checkpoint?.phase("disagreements");
  const settled = new Set<string>();
  for (;;) {
    if (tainted()) break;
    const next = siblingDisagreements(journey, plan, resultsSoFar()).find((d) => !settled.has(`${d.site}\u0000${d.sensitive}`));
    if (next === undefined) break;
    settled.add(`${next.site}\u0000${next.sensitive}`);
    const index = mutations.findIndex((e) => e.id === next.sensitive);
    const entry = mutations[index]!;
    const m = plan.mutations.find((x) => x.id === entry.id)!;
    const site = siteByKey.get(next.site)!;
    // Which replay made this reading, so it is the one run again.
    const proof = entry.targeted?.find((t) => t.site === next.site && t.refused === undefined);
    const fromRelaxed = entry.relaxed !== undefined && !(site.where === "step" && site.step === m.step) && entry.failedSites.some((f) => f.where === "step" && f.step === m.step && f.postcondition);
    const describe = proof !== undefined ? (j: Journey): MutationReplay => targetedMutationReplay(j, m, next.site, proof.relaxedSites, replayOpts) : (j: Journey): MutationReplay => (fromRelaxed ? relaxedMutationReplay : mutationReplay)(j, m, replayOpts);
    const rerun = await runReplay(m, describe, "rerun");
    if (tainted()) {
      mutations[index] = { ...entry, rerun: rerun.outcome };
      break;
    }
    const control = await controlFor(m, [rerun], [next.site]);
    const undecided = `sibling mutations disagree on ${next.site} (${next.sensitive} failed it, ${next.passed} passed it), and a control and a re-run could not settle it; run the proof again`;
    const controlFields = { control: control.outcome, ...(control.diagnostics === undefined ? {} : { controlDiagnostics: control.diagnostics }) };
    if (rerun.outcome === "error" || control.outcome === "error") {
      mutations[index] = { ...entry, ...controlFields, rerun: rerun.outcome };
      continue;
    }
    const reread = classifyReplay(site, m, rerun);
    const strike = (e: JourneyVerifyMutation): JourneyVerifyMutation => {
      const cut = (r: { readonly waitsCut?: readonly string[] }): { waitsCut: string[] } => ({ waitsCut: [...new Set([...(r.waitsCut ?? []), next.site])] });
      if (proof !== undefined) {
        return { ...e, targeted: e.targeted!.map((t) => (t === proof ? { ...t, refused: `${next.sensitive} failed ${next.site} once and did not reproduce, while ${next.passed} passed it` } : t)) };
      }
      return fromRelaxed ? { ...e, relaxed: { ...e.relaxed!, ...cut(e.relaxed!) } } : { ...e, ...cut(e) };
    };
    const firstReading = fromRelaxed ? entry.relaxed! : entry;
    const matched = control.outcome === "passed" && sitesUnmatchedBy(firstReading.failedSites.filter((f) => siteKeyOf(f) === next.site), rerun, control, paceMarginOf(pace, m)).length === 0;
    if (reread === "insensitive") mutations[index] = { ...strike(entry), ...controlFields, rerun: rerun.outcome };
    else if (reread === "sensitive" && matched) mutations[index] = { ...entry, ...controlFields, rerun: rerun.outcome };
    else if (control.outcome === "failed" && reread === "sensitive") mutations[index] = { ...strike(entry), ...controlFields, rerun: rerun.outcome };
    else {
      mutations[index] = { ...entry, ...controlFields, rerun: rerun.outcome };
      taint("siblings-undecided", null, undecided);
    }
  }
}

/** The last replay as recorded, the verdict, the report and its receipt. */
async function concludeProof(c: ConcludeContext): Promise<JourneyVerifyReport> {
  const { opts, runOpts, journey, journeyHash, plan, sites, checkOf, base, baseFields, pace, mutations, suggested, receiptDestination, boundedRun, checkpoint, resuming, restoreFailed } = c;
  let notIsolated = c.notIsolated;
  const tainted = (): boolean => restoreFailed() || notIsolated !== undefined;
  const results = new Map<string, MutationRunResult>(mutations.map((m) => [m.id, resultOfEntry(m)]));
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
  if (!tainted() && (resuming !== undefined || (pace.stepEndMs.length > 0 && mutationProofVerdict({ ...verdictInput, restoreFailed: restoreFailed(), ...(notIsolated === undefined ? {} : { notIsolated }) }).verdict !== "inconclusive"))) {
    checkpoint?.phase("closing");
    try {
      const closing = await boundedRun({ ...runOpts }, { structuredFailures: true }, { id: "closing replay, as recorded" });
      if (closing.outcome !== "ok") notIsolated = "the Journey as recorded no longer passes after the mutated replays, so state one left behind may have decided another; isolate the replays (a fixture restore, or a longer job's end) and run the proof again";
    } catch (err) {
      if (err instanceof JourneyVerifyStalledError) throw err;
      notIsolated = "the closing replay as recorded errored, so the proof cannot say the replays stayed isolated; retry it";
    }
  }
  const { verdict, reason } = mutationProofVerdict({ ...verdictInput, restoreFailed: restoreFailed(), ...(notIsolated === undefined ? {} : { notIsolated }) });
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
  const errorGap = checkpoint !== undefined && isRepairableIsolation(checkpoint.body.taint) ? true : !tainted() && mutations.some(mutationErrored);
  checkpoint?.finish(redacted.verdict, errorGap);
  return redacted;
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
  // Params the replay will refuse keep no progress, so a mistyped command cannot replace a checkpoint. The replay raises its own refusal.
  const opened = checkpointRequest === undefined || (!checkpointRequest.resume && !paramsAccepted(journey, opts.params)) ? {} : await openProofCheckpoint(checkpointRequest, { journey, journeyHash, plan, params: opts.params, sites });
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
  const writeSteps = journeyWriteSteps(journey, lintOpts);
  const writeScope = new WriteScope(effectiveAllowedOrigins(journey, opts.environment, opts.allow), writeSteps.flatMap((w) => w.requests));
  const longestResponseMs = Math.max(opts.stepResponseTimeoutMs ?? DEFAULT_STEP_RESPONSE_TIMEOUT_MS, ...flatJourneySteps(journey).map(({ recorded }) => recorded.responseTimeoutMs ?? 0));
  const basePacer = new ReplayPacer(0, () => undefined);
  // The base stays open until its writes have settled: what it started must not land in the next replay.
  const baseProbe: ReplayProbe = new ReplayProbe(stepsTotal, () => baseProbe.settleOpenWrites(Math.max(longestResponseMs, basePacer.elapsedMs())), writeScope);
  const base = await boundedRun({ ...runOpts, observer: composeObservers(baseProbe.observer(), basePacer.observer()) }, { structuredFailures: true, earliestObserver: basePacer.claimObserver(), afterEndState: () => basePacer.noteEndState() }, undefined, false, baseProbe);
  // Every other replay waits as this one did, so this one is their control (`pacedReplay`).
  const pace: ReplayPace = { stepEndMs: basePacer.reachedMs.filter((ms): ms is number => ms !== undefined), ...(basePacer.endStateReachedMs === undefined ? {} : { endStateMs: basePacer.endStateReachedMs }), claimHeldMs: [...basePacer.claimHeldMs] };
  const baseMs = basePacer.elapsedMs();
  const settleBoundMs = Math.max(longestResponseMs, baseMs);
  writeScope.addBackground(baseProbe.repeatedLines);
  // Why a replay may have decided another (a write still open at a close, state crossing replays).
  const resumedNote = resuming === undefined ? null : (resuming.isolation ?? (resuming.notIsolatedBy === null ? null : "write-open"));
  let notIsolated: string | undefined = resumedNote === null ? undefined : isolationReason(resumedNote, resuming?.notIsolatedBy ?? null);
  // Once set it stays, and an interrupted proof keeps it: a resume could otherwise read `proven` where the uninterrupted proof could not.
  const taint = (note: IsolationNote, by: string | null = null, detail?: string): void => {
    if (notIsolated !== undefined) return;
    notIsolated = detail ?? isolationReason(note, by);
    checkpoint?.taint({ isolation: note, notIsolatedBy: by });
  };
  // Once a replay may have decided another, the proof is `inconclusive` whatever is left: nothing else is run.
  const tainted = (): boolean => restoreFailed || notIsolated !== undefined;
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
  const pairReplays: CheckpointReplay[] = [];
  let replayWritesInFlight = 0;
  if (base.outcome === "ok") {
    // #565: a param mutation's replay runs with altered params (never a secret's), so it needs them.
    const replayOpts = { ...lintOpts, params: opts.params };
    const baseOpenLines = baseProbe.openLinesAtClose;
    let independenceOpen: readonly string[] = [];
    const replayContext: ReplayContext = {
      opts, runOpts, journey, pace, stepsTotal, settleBoundMs, writeScope, writeSteps, baseProbe, boundedRun, taint,
      noteWritesInFlight: (n) => void (replayWritesInFlight = Math.max(replayWritesInFlight, n)),
      noteIndependenceOpen: (lines) => void (independenceOpen = lines),
    };
    const retriesOf = new Map<string, { readonly reason: string }[]>();
    // #778: one infrastructure error must not cost the proof, so a replay that errored before opening a
    // browser, as on an admission timeout, runs once more. One that opened a browser may have changed the
    // app, and a retry failing on that leftover state would read as proof, so it stays an error. A
    // `failed` replay is a result and a stall ends the proof: neither gets here. A replay that never
    // started (`describe` refused it, as a targeted proof's bad relaxation) would only be refused again.
    const attemptWithRetry = async (m: JourneyMutation, describe: (j: Journey) => MutationReplay, kind: ReplayKind, matchTo?: SiteArrivals): Promise<Replayed> => {
      const before = replays;
      const sessionsBefore = sessionsOpened;
      const first = await attemptReplay(replayContext, m, describe, false, kind, matchTo);
      if (first.outcome !== "error" || replays === before || sessionsOpened !== sessionsBefore) return first;
      retriesOf.set(m.id, [...(retriesOf.get(m.id) ?? []), { reason: first.reason ?? "unknown error" }]);
      return attemptReplay(replayContext, m, describe, true, kind, matchTo);
    };
    // #787: the one place a replay of a pair runs, so each is kept as a record of its kind. A new kind is a new name here and in `REPLAY_RECORD_KINDS`.
    const runReplay = async (m: JourneyMutation, describe: (j: Journey) => MutationReplay, kind: ReplayKind, matchTo?: SiteArrivals): Promise<Replayed> => {
      replayWritesInFlight = 0;
      const ran = await attemptWithRetry(m, describe, kind, matchTo);
      pairReplays.push(checkpointReplayOf(kind, ran, replayWritesInFlight));
      return ran;
    };
    // #402: a named mutation lowers to its `MutationReplay`; #609's targeted proof passes one directly.
    const replay = (m: JourneyMutation, describe: typeof mutationReplay, kind: ReplayKind): Promise<Replayed> => runReplay(m, (j) => describe(j, m, replayOpts), kind);
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
    const asRecorded = (j: Journey): MutationReplay => ({ journey: j });
    // Sibling mutations of a step have the same floors, so they share a matched control while it reached their sites together with them.
    const stepControls = new Map<number, Replayed[]>();
    const controlFor = async (m: JourneyMutation, runs: readonly Replayed[], sitesAtStake: readonly string[]): Promise<Replayed> => {
      const known = (stepControls.get(m.step) ?? []).find((c) => runs.every((r) => sitesUnmatchedBy(r.failedSites.filter((f) => sitesAtStake.includes(siteKeyOf(f))), r, c, paceMarginOf(pace, m)).length === 0));
      if (known !== undefined) {
        // Each pair keeps a record of the control it read, whoever ran it: one that left a write open ended the proof.
        pairReplays.push(checkpointReplayOf("control", known, 0));
        return known;
      }
      const latest = (of: (r: Replayed) => number | undefined): number | undefined => {
        const known = runs.map(of).filter((ms): ms is number => ms !== undefined);
        return known.length === 0 ? undefined : Math.max(...known);
      };
      const longest = Math.max(0, ...runs.map((r) => r.arrivedMs?.length ?? 0));
      const end = latest((r) => r.endStateReachedMs);
      const matchTo: SiteArrivals = { arrivedMs: Array.from({ length: longest }, (_, i) => latest((r) => r.arrivedMs?.[i])), ...(end === undefined ? {} : { endStateReachedMs: end }) };
      const ran = await runReplay(m, asRecorded, "control", matchTo);
      stepControls.set(m.step, [...(stepControls.get(m.step) ?? []), ran]);
      return ran;
    };
    const resultsSoFar = (extra?: readonly [string, MutationRunResult]): ReadonlyMap<string, MutationRunResult> => new Map([...mutations.map((e): [string, MutationRunResult] => [e.id, resultOfEntry(e)]), ...(extra === undefined ? [] : [extra])]);

    /**
     * A replay straight after the base, floored as the first mutated replay will be. What the base left
     * running, however it started (a GET, a socket, a popup), meets it where it would meet that replay.
     * A failure alone cannot say whether state crossed over or the floor itself breaks a claim that only
     * lasts so long, so it is run again after a quiet gap: a pass means state crossed. A second failure
     * is the floor if the Journey still passes unheld, and state that stuck if it does not.
     */
    const proveIndependence = async (first: JourneyMutation): Promise<void> => {
      const floored = await runReplay(first, asRecorded, "independence");
      // A write still open at the bound in the base and the next replay is a long-lived connection. Open only in the base, it was a real one.
      if (baseOpenLines.some((line) => !independenceOpen.includes(line))) {
        taint("base-write-open");
        return;
      }
      writeScope.addBackground(baseOpenLines);
      if (floored.outcome === "error") {
        taint("independence-errored");
        return;
      }
      if (floored.outcome === "passed") {
        stepControls.set(first.step, [floored]);
        checkpoint?.independence("passed");
        return;
      }
      if (tainted()) return;
      await clock.sleep(Math.max(QUIET_GAP_MIN_MS, 2 * baseMs));
      const again = await runReplay(first, asRecorded, "independence");
      if (again.outcome === "passed") {
        taint("state-crossed");
        return;
      }
      if (again.outcome === "error") {
        taint("independence-errored");
        return;
      }
      if (tainted()) return;
      const unheldProbe: ReplayProbe = new ReplayProbe(stepsTotal, () => unheldProbe.settleOpenWrites(settleBoundMs), writeScope);
      try {
        const unheld = await boundedRun({ ...runOpts, observer: unheldProbe.observer() }, { structuredFailures: true }, { id: "independence replay, unheld" }, false, unheldProbe);
        if (unheld.outcome !== "ok") taint("state-stuck");
      } catch (err) {
        if (err instanceof JourneyVerifyStalledError) throw err;
        taint("independence-errored");
        return;
      }
      if (tainted()) return;
      stepControls.set(first.step, [again]);
      checkpoint?.independence("hold-breaks-claim");
    };

    const pairContext: PairContext = { journey, plan, pace, siteByKey, replayOpts, mutations, checkpoint, tainted, taint, replay, runReplay, controlFor, resultsSoFar, noteSuggestion, retriesOf, pairReplays };
    const firstMutation = plan.mutations[0];
    // On a resume too: it answers for the base just measured, so a checkpoint never stands in for it.
    if (firstMutation !== undefined && pace.stepEndMs.length > 0 && !tainted()) {
      checkpoint?.phase("independence");
      if (baseOpenLines.some((line) => writeScope.isRecorded(line))) {
        taint("base-write-open");
      } else {
        await proveIndependence(firstMutation);
      }
    }
    for (const m of plan.mutations) {
      if (tainted()) break;
      // #787: a finished pair is not run again. It reaches the same judging below as a pair just run.
      const kept = resuming?.pairs.get(m.id);
      if (kept !== undefined) {
        mutations.push(reusedMutation(kept));
        for (const proof of reusedProofFields(kept).targeted ?? []) noteSuggestion(proof, m);
        continue;
      }
      await runPair(pairContext, m);
    }

    await settleDisagreements(pairContext);
  }

  return concludeProof({ opts, runOpts, journey, journeyHash, plan, sites, checkOf, base, baseFields, pace, mutations, suggested, receiptDestination, boundedRun, checkpoint, resuming, restoreFailed: () => restoreFailed, notIsolated });
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
