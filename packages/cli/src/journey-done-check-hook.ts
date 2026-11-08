import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { judgeDoneCheck, type DoneCheckEvidence, type DoneReading, type JobVerdict } from "@jevitate/adjudicator";
import { evaluateOutcomeChecks } from "@jevitate/explore";
import { doneCheckScope, isDoneCheckIssues, parseDoneCheck, type DoneCheckSpec, type Journey } from "@jevitate/journey";
import { PlaywrightBrowserPort, type BrowserPort as SessionPort } from "@jevitate/playwright";
import { BrowseTheWeb, CastActor } from "@jevitate/screenplay";
import { loadCatalog } from "./catalog-api.js";
import { linkedJobDone } from "./catalog-refs.js";
import { parseSuccessSpec } from "./explore-specs.js";
import { createHttpProbe } from "./http-probe.js";
import { readDoneCheck, type BrowserPort, type DoneCheckSession } from "./journey-done-check.js";
import { registerRunHooks } from "./journey-run-hooks.js";

/**
 * #800 (design 0.30.0 §3.1, owner exit-code decisions 2/3): `journey run` reads the linked job's done
 * check (`.jevitate/jobs.json` → `jobs[].done`) twice, each time in a FRESH browser context seeded
 * with the run's own auth: once before step 1 (the `validateParams` run hook, before any fixture or
 * the run's browser opens) and once after the last step and the end state (the `readDoneCheck` hook).
 * The readings go into the run's evidence as `doneCheck`, and the verdict (`job: {attainment, basis}`)
 * is handed back to the surface that started the run through a `DoneCheckRun` scope.
 *
 * A run outside a `DoneCheckRun` scope is left alone: the hooks read nothing, so a surface opts in
 * by wrapping its run (`journey run` does). No param value is ever stored or returned: readings carry
 * `Known<boolean>` and code tokens only, and the evidence keeps the spec's placeholders.
 *
 * `registerDoneCheckHooks()` is called once, centrally; this module registers nothing at import.
 */

export const DONE_CHECK_HOOK_OWNER = "done-check";

/** What a surface knows about one run, for its done check. */
export interface DoneCheckRunRequest {
  /** The project data dir holding `jobs.json` (null: no catalog, so no check). */
  readonly catalogDir: string | null;
  readonly journeysDir: string;
  /** The run's target origin (`--env`/`--base-url`); default the Journey's recorded site. */
  readonly origin?: string | undefined;
  /** The run's storageState file: each fresh context is seeded with it. */
  readonly storageState?: string | undefined;
  readonly persona?: string | undefined;
  /** `--no-done-check`: read nothing; the job reads `unverified`, basis `no-check`. */
  readonly skip?: boolean | undefined;
  /** The done check's browser (default: `PlaywrightDoneCheckPort` over `sessionPortFactory`). */
  readonly browserPort?: BrowserPort | undefined;
  /** The browser the default port opens sessions from (default `new PlaywrightBrowserPort()`). */
  readonly sessionPortFactory?: (() => SessionPort) | undefined;
}

interface PendingCheck {
  readonly spec: DoneCheckSpec;
  /** The names a reading may resolve: the Journey's non-secret params and its extract outputs. */
  readonly bound: ReadonlySet<string>;
  readonly origin: string;
  readonly port: BrowserPort;
  readonly before: DoneReading;
}

/** One run's done-check scope: the request in, the verdict out. */
export class DoneCheckRun {
  #job: JobVerdict | undefined;
  readonly pending = new WeakMap<Journey, PendingCheck>();

  constructor(readonly request: DoneCheckRunRequest) {}

  /** Runs `fn` inside this scope: every run it starts reads its done check through this request. */
  run<T>(fn: () => Promise<T>): Promise<T> {
    return scope.run(this, fn);
  }

  /** The verdict the hooks decided; undefined when no hook ran (none registered, or the run threw first). */
  get job(): JobVerdict | undefined {
    return this.#job;
  }

  /** @internal */
  decide(job: JobVerdict): void {
    this.#job = job;
  }
}

const scope = new AsyncLocalStorage<DoneCheckRun>();

function originOf(url: string): string | undefined {
  try {
    return new URL(url).origin;
  } catch {
    return undefined;
  }
}

/** The run's bound, non-secret values a reading may substitute; a value still naming a `${setup.x}` is left unbound. */
function boundValues(bound: ReadonlySet<string>, ...sources: readonly unknown[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const source of sources) {
    if (source === null || typeof source !== "object") continue;
    for (const [k, v] of Object.entries(source as Record<string, unknown>)) {
      if (bound.has(k) && typeof v === "string" && !v.includes("${")) out[k] = v;
    }
  }
  return out;
}

async function specFor(req: DoneCheckRunRequest, journey: Journey): Promise<DoneCheckSpec | "invalid" | undefined> {
  let done: unknown;
  try {
    const catalog = await loadCatalog(req.catalogDir, req.journeysDir);
    done = linkedJobDone(catalog, journey)?.done;
  } catch {
    // A catalog that cannot be read is no check, as `journey find` treats it: the run says `no-check`.
    return undefined;
  }
  if (done === undefined) return undefined;
  const parsed = parseDoneCheck(done, doneCheckScope(journey));
  return isDoneCheckIssues(parsed) ? "invalid" : parsed;
}

function unreadable(at: "pre" | "post"): DoneReading {
  return { value: { known: false, reason: "check-unevaluable" }, session: "fresh", at, durationMs: 0 };
}

/** Registers the done check's `validateParams` (before) and `readDoneCheck` (after) hooks. Returns the unregistration. */
export function registerDoneCheckHooks(): () => void {
  return registerRunHooks(DONE_CHECK_HOOK_OWNER, {
    validateParams: async (ctx) => {
      const run = scope.getStore();
      if (run === undefined) return;
      const req = run.request;
      if (req.skip === true) {
        run.decide({ attainment: "unverified", basis: "no-check" });
        return;
      }
      const spec = await specFor(req, ctx.journey);
      if (spec === undefined) {
        run.decide({ attainment: "unverified", basis: "no-check" });
        return;
      }
      const origin = req.origin ?? ctx.journey.recording.site;
      if (spec === "invalid" || originOf(origin) === undefined) {
        // A check the lint refuses is never read: nothing decides the job (`reading-unknown`).
        run.decide({ attainment: "unverified", basis: "reading-unknown" });
        return;
      }
      const bound = new Set(doneCheckScope(ctx.journey).bound);
      const port = req.browserPort ?? new PlaywrightDoneCheckPort({ origin, ...(req.sessionPortFactory === undefined ? {} : { sessionPortFactory: req.sessionPortFactory }) });
      const auth = { ...(req.storageState === undefined ? {} : { storageState: req.storageState }), ...(req.persona === undefined ? {} : { persona: req.persona }) };
      const before = await readDoneCheck({ spec, origin, auth, params: boundValues(bound, ctx.params), extracts: {}, browserPort: port, at: "pre" });
      run.pending.set(ctx.journey, { spec, bound, origin, port, before });
      // Until the after reading lands, a run that ends early has no after: nothing decides it.
      run.decide({ attainment: "unverified", basis: "reading-unknown" });
    },
    readDoneCheck: async (ctx) => {
      const run = scope.getStore();
      const pending = run?.pending.get(ctx.journey);
      if (run === undefined || pending === undefined) return;
      run.pending.delete(ctx.journey);
      const req = run.request;
      const auth = { ...(req.storageState === undefined ? {} : { storageState: req.storageState }), ...(req.persona === undefined ? {} : { persona: req.persona }) };
      const output = "output" in ctx.result ? ctx.result.output : undefined;
      const after = await readDoneCheck({
        spec: pending.spec,
        origin: pending.origin,
        auth,
        params: boundValues(pending.bound, ctx.params),
        extracts: boundValues(pending.bound, output),
        browserPort: pending.port,
        at: "post",
      }).catch(() => unreadable("post"));
      const evidence: DoneCheckEvidence = { spec: pending.spec, before: pending.before, after };
      ctx.evidence?.noteDoneCheck(evidence);
      run.decide(judgeDoneCheck(evidence));
    },
  });
}

// --- The real browser: a new Playwright context per reading -------------------------------------------

export interface PlaywrightDoneCheckPortOptions {
  /** The run's target origin: the only origin a reading navigates to or an `http` check may GET. */
  readonly origin: string;
  readonly sessionPortFactory?: () => SessionPort;
  /** Poll bound for a page check (ms). Default 3000. */
  readonly timeoutMs?: number;
  /** Network settle bound before an `http` check (ms). Default 2000. */
  readonly settleMs?: number;
}

/**
 * #800: the done check's `BrowserPort` over `@jevitate/playwright`: every `openContext` opens a new,
 * headless session (its own browser context, never the run's) seeded with the run's storageState,
 * navigates only within the run's origin, and evaluates a `--success`-syntax state check with the
 * same oracle the end state uses (`evaluateOutcomeChecks`). A persona without a storageState file
 * cannot be seeded here: refused, which reads `session-unavailable`.
 */
export class PlaywrightDoneCheckPort implements BrowserPort {
  readonly #opts: PlaywrightDoneCheckPortOptions;

  constructor(opts: PlaywrightDoneCheckPortOptions) {
    this.#opts = opts;
  }

  async openContext(auth: { readonly storageState?: string; readonly persona?: string }): Promise<DoneCheckSession> {
    if (auth.persona !== undefined && auth.storageState === undefined) throw new Error("a persona needs its storageState file to seed a fresh context");
    const origin = new URL(this.#opts.origin).origin;
    const allowedOrigins = [origin];
    const session = await (this.#opts.sessionPortFactory ?? (() => new PlaywrightBrowserPort()))().open({
      headless: true,
      allowedOrigins,
      baseUrl: origin,
      ...(auth.storageState === undefined ? {} : { storageState: auth.storageState }),
    });
    const actor = CastActor.named("done-check").whoCan(new BrowseTheWeb(session, allowedOrigins));
    const timeoutMs = this.#opts.timeoutMs ?? 3000;
    const settleMs = this.#opts.settleMs ?? 2000;
    return {
      id: `done-check-${randomUUID()}`,
      navigate: async (url) => {
        if (new URL(url).origin !== origin) throw new Error("off-origin");
        await session.page.goto(url, { waitUntil: "load" });
      },
      evaluate: async (check) => {
        let parsed: ReturnType<typeof parseSuccessSpec>;
        try {
          parsed = parseSuccessSpec(check);
        } catch {
          return "unevaluable";
        }
        // Only state-naming kinds: a network or reload check is about the run's own page, never a done check.
        if (parsed.kind !== "page" && parsed.kind !== "http") return "unevaluable";
        const [result] = await evaluateOutcomeChecks([parsed], { actor, page: session.page, capture: null, httpProbe: createHttpProbe({ allowlist: allowedOrigins }), timeoutMs, settleMs });
        if (result === undefined || result.unevaluable === true) return "unevaluable";
        return result.passed;
      },
      close: () => session.close(),
    };
  }
}
