import { clock } from "@jevitate/domain";
import { evaluateNetworkCheckAwaiting, monitorFor, type RequestCapture } from "@jevitate/explore";
import { checkAssertion, waitForOutcome, type StepObserver } from "@jevitate/interpreter";
import type { MutationFailedSite, MutationReplay, TargetedProof } from "@jevitate/journey";
import { type BrowserPort, type BrowserSession } from "@jevitate/playwright";
import { AssertionRefError, assertionRefs, resolveAssertionRefs } from "@jevitate/recording";
import { BrowseTheWebToken, type Actor } from "@jevitate/screenplay";

const REQUEST_LINE = /^(\S+)\s+(\S+)/;

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
/**
 * How long a replay stays open once a `no-store` response's body has been reported and the browser has not said it ended.
 * Chromium never says so for such a body the page does not read, but one the page reads, clones or beacons reports its
 * bytes as they come, so this can be a body still streaming.
 */
const RESPONDED_BODY_GRACE_MS = 2_000;
/** How long a replay waits to watch a page's bodies. It takes milliseconds, so past this the browser is wedged: no body is seen, and the replay carries on. */
const BODY_WATCH_BOUND_MS = 2_000;
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

function pathOf(p: string): string {
  try {
    return /^https?:\/\//i.test(p) ? new URL(p).pathname : p.split("?")[0]!;
  } catch {
    return p;
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
type WatchedRequest = { method(): string; url(): string; failure?(): { errorText: string } | null; isNavigationRequest?(): boolean; frame?(): unknown };

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
  readonly #open = new Map<unknown, { readonly line: string; readonly seq: number; responded?: boolean }>();
  /** Writes in scope the browser has not said ended, by its own request id: the document that sent it, whether the response is `no-store`, and when its body was reported. */
  readonly #bodies = new Map<string, { readonly line: string; readonly loaderId: string | undefined; noStore: boolean; arrivedAt?: number }>();
  /** The opened page's top frame and its latest document, as the browser names them. */
  #topFrame: string | undefined;
  #topLoader: string | undefined;
  readonly #responded = new WeakSet<object>();
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

  /** The replay opened a browser. */
  get opened(): boolean {
    return this.#sessionsOpened > 0;
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
    // A response with no reported body is a server still working. Playwright's requests can't be matched to the browser's ids, so
    // this counts by line: as many answered writes as the line has reported bodies that have not ended. It is worked out each time,
    // so a body that ends stops counting for whichever write was read as answered by it.
    const bodies = new Map<string, number>();
    for (const b of this.#bodies.values()) if (b.arrivedAt !== undefined) bodies.set(b.line, (bodies.get(b.line) ?? 0) + 1);
    const open = [...this.#open.values()].filter((o) => {
      const left = bodies.get(o.line) ?? 0;
      if (o.responded !== true || left === 0) return true;
      bodies.set(o.line, left - 1);
      return false;
    });
    return open.map((o) => o.line).filter((line) => this.#scope?.isBackground(line, this.#sent.get(line) ?? 0) !== true);
  }

  /**
   * Waits for the writes in scope to be answered, new ones they lead to included, up to `boundMs`,
   * then a moment more after one the browser gave up on: a browser-side abort does not mean the server stopped.
   * A reported `no-store` body gets a moment too. Past that it reads as answered: Chromium never reports the end of
   * such a body the page does not read. Any other response keeps the write open until it finishes, so a server that
   * answers and keeps working is waited for, up to the bound. See "What a proof assumes" in docs/outcomes.md for what is left.
   */
  async settleOpenWrites(boundMs: number): Promise<void> {
    const startedAt = clock.monotonicMs();
    while (clock.monotonicMs() - startedAt < boundMs) {
      const graceUntil = Math.max(this.#lastAbortAt === undefined ? 0 : this.#lastAbortAt + ABORTED_WRITE_GRACE_MS, ...[...this.#bodies.values()].map((b) => (b.arrivedAt === undefined ? 0 : b.arrivedAt + RESPONDED_BODY_GRACE_MS)));
      const graceLeft = graceUntil - clock.monotonicMs();
      if (this.#openInScope().length === 0 && graceLeft <= 0) return;
      await clock.sleep(Math.max(0, Math.min(OPEN_WRITE_POLL_MS, boundMs - (clock.monotonicMs() - startedAt))));
    }
  }

  get openOptions(): string | undefined {
    return this.#openOptions;
  }

  recordWait(ended: ReplayDiagnostics["relaxedWaits"][number]): void {
    this.#relaxedWaits.push(ended);
  }

  /**
   * Listens for `Network.dataReceived`, the one thing that tells a complete unread `no-store` body from one the server has
   * not finished: Chromium reports such a body's bytes only when it ends. Any other body reports bytes as they come, and
   * reaches `requestfinished`, so only `no-store` counts. Observation only: it reads no body. With no CDP, or if this fails
   * or takes too long, no body is ever seen and the write stays open, which reads `inconclusive` rather than a verdict nothing supports.
   */
  async #watchBodies(page: BrowserSession["page"] | undefined): Promise<void> {
    const context = typeof page?.context === "function" ? page.context() : undefined;
    if (typeof context?.newCDPSession !== "function") return;
    const attach = async (target: NonNullable<BrowserSession["page"]>): Promise<void> => {
      const cdp = await context.newCDPSession(target);
      cdp.on("Network.requestWillBeSent", ({ requestId, request, loaderId, frameId, type }) => {
        if (target === page && type === "Document" && requestId === loaderId && (this.#topFrame ?? frameId) === frameId) {
          this.#topFrame = frameId;
          this.#topLoader = loaderId;
        }
        const line = lineOfRequest(request.method, request.url);
        // A redirect keeps its id, and may have turned the write into a read.
        if (READ_METHODS.has(request.method.toUpperCase()) || this.#scope?.counts(line, request.url) !== true) this.#bodies.delete(requestId);
        else this.#bodies.set(requestId, { line, loaderId, noStore: false });
      });
      cdp.on("Network.responseReceived", ({ requestId, response }) => {
        const body = this.#bodies.get(requestId);
        const cacheControl = Object.entries(response.headers).find(([name]) => name.toLowerCase() === "cache-control")?.[1] ?? "";
        if (body !== undefined) body.noStore = /(?:^|[\s,])no-store(?:$|[\s,;])/i.test(cacheControl);
      });
      cdp.on("Network.dataReceived", ({ requestId }) => {
        const body = this.#bodies.get(requestId);
        if (body !== undefined && body.noStore && body.arrivedAt === undefined) body.arrivedAt = clock.monotonicMs();
      });
      cdp.on("Network.loadingFinished", ({ requestId }) => void this.#bodies.delete(requestId));
      cdp.on("Network.loadingFailed", ({ requestId }) => void this.#bodies.delete(requestId));
      await cdp.send("Network.enable");
    };
    const attaching = async (target: NonNullable<BrowserSession["page"]>): Promise<void> => {
      let timer: ReturnType<typeof clock.setTimeout> | undefined;
      try {
        await Promise.race([attach(target), new Promise<void>((resolve) => (timer = clock.setTimeout(resolve, BODY_WATCH_BOUND_MS)))]);
      } catch {
        // A page that closed first has nothing to watch. Observation never stops a replay.
      } finally {
        clock.clearTimeout(timer);
      }
    };
    context.on("page", (popup) => void attaching(popup));
    await attaching(page!);
  }

  #watch(session: BrowserSession): void {
    const page = session.page;
    this.#openedPage = page;
    const context = typeof page?.context === "function" ? page.context() : undefined;
    const source = (typeof context?.on === "function" ? context : page) as { on?(event: string, listener: (r: WatchedRequest) => void): unknown } | undefined;
    if (typeof source?.on !== "function") return;
    const isWrite = (r: WatchedRequest): boolean => !READ_METHODS.has(r.method().toUpperCase());
    // Only the opened page's top frame replaces the document that sent a write. A frame or a popup starting to load does not,
    // and Playwright throws for a popup's first request. Anything it can't say keeps the write open.
    const startsNewDocument = (r: WatchedRequest): boolean => {
      try {
        const top = page?.mainFrame?.();
        return top !== undefined && r.isNavigationRequest?.() === true && r.frame?.() === top;
      } catch {
        return false;
      }
    };
    source.on("request", (r) => {
      this.#requestSeq += 1;
      if (startsNewDocument(r)) this.#navigationSeq = this.#requestSeq;
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
        // A body an older document had reported may never say it ended. The new document's own writes keep theirs, and with no way to tell whose it is, it goes, which reads as open.
        for (const [id, b] of this.#bodies) if (b.arrivedAt !== undefined && (b.loaderId === undefined || b.loaderId !== this.#topLoader)) this.#bodies.delete(id);
      });
    }
    source.on("response", (res) => {
      const r = (res as unknown as { request(): WatchedRequest }).request();
      if (!isWrite(r)) return;
      this.#writesAnswered += 1;
      this.#responded.add(r);
      const open = this.#open.get(r);
      if (open !== undefined) open.responded = true;
    });
    source.on("requestfinished", (r) => {
      if (!isWrite(r)) return;
      if (!this.#responded.has(r)) this.#writesAnswered += 1;
      this.#open.delete(r);
    });
    source.on("requestfailed", (r) => {
      if (!isWrite(r)) return;
      // Answered, then the page stopped reading: it was no dropped write, but the server may still be working.
      if (this.#responded.has(r)) {
        if (this.#open.delete(r)) this.#lastAbortAt = clock.monotonicMs();
        return;
      }
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
          await this.#watchBodies(session.page);
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

/** Corresponding top-level boundaries only; admission and cleanup never enter this record. */
function finalObservation(stepCount: number): {
  anchors: number[]; valid: boolean; finalDone: boolean; closes: number; close?: number;
  observer: StepObserver; captureClose: () => Promise<void>;
} {
  const record = {
    anchors: [] as number[], valid: true, finalDone: false, closes: 0,
    close: undefined as number | undefined,
    observer: {} as StepObserver,
    captureClose: async (): Promise<void> => {
      const now = clock.monotonicMs();
      record.closes++;
      if (record.closes !== 1 || !Number.isFinite(now) || now < 0 || now < (record.anchors.at(-1) ?? now)) record.valid = false;
      record.close = now;
    },
  };
  record.observer = {
    beforeStep: async ({ index }) => {
      const now = clock.monotonicMs();
      if (index !== record.anchors.length || index >= stepCount || !Number.isFinite(now) || now < 0 || now < (record.anchors.at(-1) ?? now)) { record.valid = false; return; }
      record.anchors.push(now);
    },
    afterStep: async ({ index, outcome }) => {
      if (index === stepCount - 1) record.finalDone = outcome === "done";
    },
  };
  return record;
}
type FinalObservation = ReturnType<typeof finalObservation>;


export {
  ACTION_BOUND_MS,
  ABORTED_WRITE_GRACE_MS,
  FIXTURE_ALLOWANCE_MS,
  MAX_TIMER_MS,
  QUIET_GAP_MIN_MS,
  READ_METHODS,
  RELOAD_BOUND_MS,
  REPLAY_FLOOR_MS,
  REQUEST_LINE,
  SITE_GATE_WAIT_MS,
  STALL_MARGIN_MS,
  STALL_TEARDOWN_MS,
  WriteScope,
  finalObservation,
  lineOfRequest,
  relaxedWaitObserver,
  replayWithinBound,
  ReplayPacer,
  ReplayProbe,
  siteKeyOf,
};
export type { FinalObservation, RelaxedSiteWait, TargetedControlDiagnostics };
