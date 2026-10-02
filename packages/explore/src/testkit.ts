/**
 * Shared browser/test helpers for @jevitate/explore's Playwright-backed tests.
 * NOT part of the built package (excluded in tsconfig): it depends on
 * `@jevitate/example-site` (a devDependency) and is only ever imported from
 * `*.test.ts`. Vitest resolves it directly via the source alias.
 */
import { PlaywrightBrowserPort, type BrowserSession } from "@jevitate/playwright";
import type { Answer, JudgmentPort, JudgmentState, Question } from "@jevitate/ai-core";
import type { Op } from "./actions.js";
import { TimeSkippingClock, clock, installClock, resetClock } from "@jevitate/domain";
import { chromium, type Page } from "playwright";
import { afterAll, afterEach, beforeAll, beforeEach } from "vitest";

const port = new PlaywrightBrowserPort();

/**
 * Opens a fresh persistent context (its own profile dir → no shared state),
 * runs `body`, and always tears down. `baseUrl` defaults to a harmless
 * loopback origin so `setContent`-only tests need no server.
 */
export async function withSession<T>(
  prefix: string,
  body: (session: BrowserSession) => Promise<T>,
  baseUrl = "http://127.0.0.1:1/",
): Promise<T> {
  const session = await port.open({
    headless: true,
    allowedOrigins: [baseUrl],
    baseUrl,
  });
  try {
    return await body(session);
  } finally {
    await session.close();
  }
}

/** A minimal static login-ish DOM for snapshot/act/decide fixtures. */
export const LOGIN_FIXTURE_HTML = `<!doctype html><html><body>
  <h1>Sign in</h1>
  <form>
    <label>Username <input name="username" aria-label="Username" /></label>
    <label>Password <input name="password" type="password" aria-label="Password" /></label>
    <button type="submit">Sign in</button>
  </form>
  <a href="/help">Need help?</a>
</body></html>`;

/** A different DOM, to prove the freshness signature changes across states. */
export const INBOX_FIXTURE_HTML = `<!doctype html><html><body>
  <h1>Inbox</h1>
  <ul><li><a href="/thread/1">First thread</a></li></ul>
  <button type="button">Compose</button>
</body></html>`;

/** One scripted decision: an op and, for a target op, the control index it acts on. */
export interface ScriptedStep {
  readonly op: Op;
  readonly target?: string;
  readonly confidence?: number;
  /** This decision's answer to the advisory "goal already met?" head (#91); unanswered when absent. */
  readonly goalMet?: number;
}

/** The candidate-action id decide() offers for a scripted step: `<op>:<index>` or a bare op. */
export function actionId(step: ScriptedStep): string {
  return step.target !== undefined ? `${step.op}:${step.target}` : step.op;
}

/**
 * A JudgmentPort that plays a fixed sequence of decisions in decide()'s candidate-action format
 * (`{ action: choice("<op>:<index>" | "<op>") }`), repeating the last step once exhausted. Every
 * call's arguments are kept for payload assertions.
 */
export class ScriptedJudge implements JudgmentPort {
  #i = 0;
  readonly calls: Array<{ state: JudgmentState; questions: Record<string, Question> }> = [];
  /** Every goal-completion (noul-only) call, for payload assertions. */
  readonly goalCalls: Array<{ state: JudgmentState; questions: Record<string, Question> }> = [];
  constructor(private readonly seq: readonly ScriptedStep[]) {
    if (seq.length === 0) throw new Error("ScriptedJudge needs at least one step");
  }
  /** The (redacted) state shown on each call. */
  get states(): JudgmentState[] {
    return this.calls.map((c) => c.state);
  }
  /** The candidate action ids offered on each call. */
  get actionOptions(): Array<readonly string[]> {
    return this.calls.map((c) => {
      const q = c.questions.action;
      return q?.kind === "choice" ? q.options : [];
    });
  }
  /**
   * The answer to every noul question (the goal-completion check a proposed `done` triggers):
   * P(yes). Default 0.9 — a scripted `done` is grounded unless a test says otherwise.
   */
  goalMetProbability = 0.9;
  /** Per-question overrides of `goalMetProbability`, by noul question name (e.g. the #188 sign-in scope head). */
  noulProbabilities: Record<string, number> = {};
  async systemOne(args: { state: JudgmentState; questions: Record<string, Question> }): Promise<Record<string, Answer>> {
    if (!("action" in args.questions)) {
      this.goalCalls.push(args);
      const out: Record<string, Answer> = {};
      for (const [name, q] of Object.entries(args.questions)) {
        const p = this.noulProbabilities[name] ?? this.goalMetProbability;
        if (q.kind === "noul") out[name] = { kind: "noul", value: p >= 0.5, probability: p };
      }
      return out;
    }
    this.calls.push(args);
    const cur = this.seq[Math.min(this.#i, this.seq.length - 1)];
    this.#i += 1;
    if (cur === undefined) throw new Error("ScriptedJudge: no step");
    const action: Answer = { kind: "choice", value: actionId(cur), confidence: cur.confidence ?? 0.9 };
    if (cur.goalMet === undefined) return { action };
    return { action, goalAlreadyMet: { kind: "noul", value: cur.goalMet >= 0.5, probability: cur.goalMet } };
  }
}

/** One preferred action: an op and (for a target op) the control name it should act on. */
export interface Preference {
  readonly op: Op;
  /** The control's quoted name in the candidate's description (`click button "Save"`), or a pattern. */
  readonly name?: string | RegExp;
}

/**
 * A JudgmentPort that behaves like a model with a fixed intent: on every decision it picks the
 * FIRST preference the page currently offers (by control name, not index — robust to controls being
 * withheld or filtered), else `fallback`. `prefs` may vary by call number. Every chosen candidate's
 * description is kept in `chosen`.
 */
export class PreferenceJudge implements JudgmentPort {
  readonly calls: Array<{ state: JudgmentState; questions: Record<string, Question> }> = [];
  readonly goalCalls: Array<{ state: JudgmentState; questions: Record<string, Question> }> = [];
  readonly chosen: string[] = [];
  goalMetProbability = 0.9;
  constructor(
    private readonly prefs: readonly Preference[] | ((call: number, state: JudgmentState) => readonly Preference[]),
    private readonly fallback: Op = "blocked",
  ) {}
  get states(): JudgmentState[] {
    return this.calls.map((c) => c.state);
  }
  async systemOne(args: { state: JudgmentState; questions: Record<string, Question> }): Promise<Record<string, Answer>> {
    const q = args.questions.action;
    if (q === undefined) {
      this.goalCalls.push(args);
      const out: Record<string, Answer> = {};
      for (const [name, x] of Object.entries(args.questions)) {
        if (x.kind === "noul") out[name] = { kind: "noul", value: this.goalMetProbability >= 0.5, probability: this.goalMetProbability };
      }
      return out;
    }
    this.calls.push(args);
    const options = q.kind === "choice" ? q.options : [];
    const descriptions = q.kind === "choice" ? (q.descriptions ?? {}) : {};
    const prefs = typeof this.prefs === "function" ? this.prefs(this.calls.length - 1, args.state) : this.prefs;
    let pick: string | undefined;
    for (const p of prefs) {
      pick = options.find((id) => {
        if (p.name === undefined) return id === p.op;
        if (!id.startsWith(`${p.op}:`)) return false;
        const d = descriptions[id] ?? "";
        return typeof p.name === "string" ? d.includes(`"${p.name}"`) : p.name.test(d);
      });
      if (pick !== undefined) break;
    }
    const value = pick ?? this.fallback;
    this.chosen.push(descriptions[value] ?? value);
    return { action: { kind: "choice", value, confidence: 0.9 } };
  }
}

// ── Skipping time (#304) ──────────────────────────────────────────────────────────────────────────

/** Options for {@link useSkippingTime}. */
export interface SkippingTimeOptions {
  /** Real ms of no clock activity before an idle wait is skipped. Default 25. */
  readonly idleMs?: number;
  /**
   * A request on the wire blocks skipping until it has been in flight this long (real ms): younger,
   * it is real work about to land; older, it is HELD (a frozen backend) and the waits around it may
   * be skipped. Default 1500. (A browser CALL in flight always blocks skipping.)
   */
  readonly heldMs?: number;
  /**
   * Also drive each watched page's time with `page.clock` (installed at open, advanced by every skip),
   * so in-page timers (a toast, a poll, a documented wait) skip too. Default true. Off for a page that
   * must keep the browser's own clock: a busy loop that spins on `Date.now()` never ends under a fake
   * page clock.
   */
  readonly pageClock?: boolean;
  /**
   * `"each"` (default): a fresh skipping clock per test (`beforeEach`/`afterEach`). `"all"`: one for
   * the whole suite (`beforeAll`/`afterAll`) — register it BEFORE a `beforeAll` that opens a shared
   * session, so that session's page is watched too.
   */
  readonly per?: "each" | "all";
}

interface WatchedPage {
  readonly page: Page;
  readonly requests: Map<object, number>;
}

interface SkippingState {
  readonly clock: TimeSkippingClock;
  readonly pages: Set<WatchedPage>;
  readonly heldMs: number;
  readonly pageClock: boolean;
  readonly restoreOpen: () => void;
}

let skipping: SkippingState | null = null;

/**
 * Runs Node time AND every watched page's time (`page.clock`) on a {@link TimeSkippingClock}: time
 * flows as usual while anything is happening, and jumps over waits where nothing is (a settle
 * window on a quiet page, a hang ceiling over a held request, a liveness bound on a frozen page).
 * Every session opened through a `PlaywrightBrowserPort` while it is on is watched automatically.
 * Assertions are unchanged — only the time source is.
 */
export function startSkippingTime(opts: SkippingTimeOptions = {}): TimeSkippingClock {
  stopSkippingTime();
  const pages = new Set<WatchedPage>();
  const heldMs = opts.heldMs ?? 1_500;
  const canSkip = (): boolean => {
    const now = performance.now();
    // Every Playwright call in this process (a launch, a new context, any page call) shares one client
    // connection; its pending callbacks are the browser work still in flight.
    const conn = (chromium as unknown as { _connection?: { _callbacks?: Map<number, object> } })._connection;
    for (const w of pages) {
      if (w.page.isClosed()) {
        pages.delete(w);
        continue;
      }
      for (const started of w.requests.values()) if (now - started < heldMs) return false;
    }
    // A browser call in flight blocks: it may carry its own real-time timeout (a click, a goto) that
    // a skip would race, and a watchdog behind it must not fire early. The exception is a condition
    // wait (`waitForFunction`): the product bounds those on the clock (`clockBounded`), so skipping
    // to that bound is exactly what the code would do in real time.
    for (const cb of conn?._callbacks?.values() ?? []) {
      const c = cb as { type?: string; method?: string };
      if (!(c.type === "Frame" && c.method === "waitForFunction")) return false;
    }
    return true;
  };
  const onSkip = async (ms: number): Promise<void> => {
    await Promise.all(
      [...pages].filter(() => skipping?.pageClock === true).map((w) =>
        Promise.race([w.page.clock.runFor(Math.round(ms)).catch(() => undefined), new Promise((r) => setTimeout(r, 1_500))]),
      ),
    );
  };
  const skipClock = new TimeSkippingClock({ idleMs: opts.idleMs ?? 25, canSkip, onSkip });
  installClock(skipClock);
  const proto = PlaywrightBrowserPort.prototype;
  const open = proto.open;
  proto.open = async function (this: PlaywrightBrowserPort, ...args: Parameters<typeof open>) {
    const session = await open.apply(this, args);
    await watchPage(session.page as unknown as Page);
    return session;
  };
  skipping = { clock: skipClock, pages, heldMs, pageClock: opts.pageClock ?? true, restoreOpen: () => (proto.open = open) };
  return skipClock;
}

/** Back to the real clock (pages keep their installed clock until they close). */
export function stopSkippingTime(): void {
  if (skipping === null) return;
  skipping.clock.stop();
  skipping.restoreOpen();
  skipping = null;
  resetClock();
}

/** Watch `page` under skipping time: its `page.clock` follows Node time; its requests block skips while young. */
export async function watchPage(page: Page): Promise<void> {
  const state = skipping;
  if (state === null) return;
  const w: WatchedPage = { page, requests: new Map() };
  page.on("request", (r) => w.requests.set(r, performance.now()));
  const done = (r: object): void => void w.requests.delete(r);
  page.on("requestfinished", done);
  page.on("requestfailed", done);
  if (state.pageClock) await page.context().clock.install({ time: clock.now() });
  state.pages.add(w);
}

/** Every test in the enclosing suite (or file) runs on skipping time. */
export function useSkippingTime(opts: SkippingTimeOptions = {}): void {
  if (opts.per === "all") {
    beforeAll(() => void startSkippingTime(opts));
    afterAll(() => stopSkippingTime());
    return;
  }
  beforeEach(() => void startSkippingTime(opts));
  afterEach(() => stopSkippingTime());
}
