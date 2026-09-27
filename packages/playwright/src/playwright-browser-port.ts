import { chromium, type BrowserContext, type BrowserContextOptions, type Page } from "playwright";
import type { BrowserPort, BrowserSession, OpenOptions } from "./browser-port.js";
import { BrowserPool, DEFAULT_OPEN_TIMEOUT_MS, withOpenDeadline, type BrowserPoolOptions, type ContextLease } from "./browser-pool.js";
import { PageLivenessWatchdog, pageUnresponsiveMsFromEnv } from "./page-liveness.js";
import { createResourceSignals } from "./select-resource-signals.js";
import { emulationContextOptions, resolveEmulation } from "./emulation.js";

/**
 * Chromium switches applied on Linux regardless of caller args. They are the
 * minimum for Chromium to start reliably where the kernel sandbox or a large
 * `/dev/shm` is unavailable — WSL2, containers, CI runners:
 *  - `--no-sandbox`: the setuid/namespace sandbox is commonly unavailable there.
 *  - `--disable-dev-shm-usage`: `/dev/shm` is often tiny; spill to /tmp instead.
 */
export const DEFAULT_LINUX_CHROMIUM_ARGS: readonly string[] = Object.freeze([
  "--no-sandbox",
  "--disable-dev-shm-usage",
]);

/**
 * The effective Chromium switches for a launch. Rule: caller args EXTEND the
 * platform defaults (defaults first, then caller args in order, exact
 * duplicates dropped) — they never replace them. Rationale: the Linux defaults
 * are what makes a launch succeed at all on WSL/containers, so passing one
 * unrelated tuning flag (e.g. `--lang=de`) must not silently drop them and
 * turn a working launch into a crashing one. Non-Linux platforms have no
 * defaults, so there the caller's args are used as given.
 */
export function resolveLaunchArgs(
  callerArgs: readonly string[] | undefined,
  platform: NodeJS.Platform = process.platform,
): string[] {
  const defaults = platform === "linux" ? DEFAULT_LINUX_CHROMIUM_ARGS : [];
  return [...new Set([...defaults, ...(callerArgs ?? [])])];
}

/** Thrown when the Chromium binary to launch is not on disk. Actionable by construction. */
export class BrowserNotInstalledError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "BrowserNotInstalledError";
  }
}

/** Playwright's own wording when the resolved browser executable is absent. */
const MISSING_EXECUTABLE = /Executable doesn't exist at ([^\r\n]+)/;

/**
 * Maps a launch failure to an actionable error when (and only when) it is a
 * missing browser binary; every other failure is returned unchanged so the
 * caller rethrows the original. Never falls back to another browser.
 */
export function explainLaunchFailure(err: unknown, opts: Pick<OpenOptions, "executablePath" | "channel">): unknown {
  const message = err instanceof Error ? err.message : String(err);
  const match = MISSING_EXECUTABLE.exec(message);
  if (match === null) return err;
  const where = match[1]!.trim();
  if (opts.executablePath !== undefined) {
    return new BrowserNotInstalledError(
      `browser executable not found at ${where} (from --browser-executable); point it at an installed Chromium binary`,
      { cause: err },
    );
  }
  if (opts.channel !== undefined) {
    return new BrowserNotInstalledError(
      `browser channel "${opts.channel}" is not installed (expected at ${where}); run: npx playwright install ${opts.channel}`,
      { cause: err },
    );
  }
  return new BrowserNotInstalledError(
    `Playwright's pinned Chromium is not installed (expected at ${where}); run: npx playwright install chromium`,
    { cause: err },
  );
}

/** The pool type the Playwright port runs on. */
export type PlaywrightBrowserPool = BrowserPool<BrowserContext, BrowserContextOptions>;

/**
 * Parses an optional positive-integer env override; a set-but-invalid value
 * throws (a typo must not silently mean "default").
 */
function envPositiveInt(env: NodeJS.ProcessEnv, name: string): number | undefined {
  const raw = env[name];
  if (raw === undefined || raw === "") return undefined;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) throw new RangeError(`${name} must be a positive integer, got ${JSON.stringify(raw)}`);
  return n;
}

/**
 * Pool options from the environment:
 *  - `JEVITATE_BROWSER_MAX_CONTEXTS`: concurrent context cap (default derived from cores/memory).
 *  - `JEVITATE_ADMISSION_TIMEOUT_MS`: bounded admission wait (default 5 min).
 */
export function browserPoolOptionsFromEnv(env: NodeJS.ProcessEnv = process.env): Omit<BrowserPoolOptions, "signals"> {
  const maxContexts = envPositiveInt(env, "JEVITATE_BROWSER_MAX_CONTEXTS");
  const admissionTimeoutMs = envPositiveInt(env, "JEVITATE_ADMISSION_TIMEOUT_MS");
  return {
    ...(maxContexts !== undefined ? { maxContexts } : {}),
    ...(admissionTimeoutMs !== undefined ? { admissionTimeoutMs } : {}),
  };
}

/** A Playwright-typed pool (for callers that need their own, e.g. a dedicated cap or fixture signals). */
export function createBrowserPool(options: BrowserPoolOptions): PlaywrightBrowserPool {
  return new BrowserPool<BrowserContext, BrowserContextOptions>(options);
}

let shared: PlaywrightBrowserPool | undefined;
let sharedOverrides: Partial<BrowserPoolOptions> | undefined;

/**
 * The process-wide pool: ONE browser process per launch configuration per
 * jevitate process, created lazily with this platform's resource signals.
 */
export function sharedBrowserPool(): PlaywrightBrowserPool {
  shared ??= createBrowserPool({
    signals: createResourceSignals(),
    ...browserPoolOptionsFromEnv(),
    ...sharedOverrides,
  });
  return shared;
}

/**
 * Sets the options the shared pool is created with (e.g. a test harness's own admission config:
 * injected resource signals so admission never waits on unrelated host load). Must be called
 * before the pool is first used; calling it after is a configuration error, never ignored.
 */
export function configureSharedBrowserPool(overrides: Partial<BrowserPoolOptions>): void {
  if (shared !== undefined) throw new Error("configureSharedBrowserPool: the shared pool already exists");
  sharedOverrides = overrides;
}

/** Closes the shared pool's browsers now (e.g. at CLI exit) instead of waiting for the idle timer. */
export async function closeSharedBrowserPool(): Promise<void> {
  const pool = shared;
  shared = undefined;
  if (pool !== undefined) await pool.close();
}

type Launch = typeof chromium.launch;
type LaunchPersistentContext = typeof chromium.launchPersistentContext;

export interface PlaywrightBrowserPortDeps {
  /** Testing seam — defaults to Playwright's `chromium.launch` (the pooled path). */
  readonly launch?: Launch;
  /** Testing seam — defaults to `chromium.launchPersistentContext` (only for `persistentProfile`). */
  readonly launchPersistentContext?: LaunchPersistentContext;
  /** Testing seam — defaults to `process.platform`. */
  readonly platform?: NodeJS.Platform;
  /** Defaults to the process-wide `sharedBrowserPool()`. */
  readonly pool?: PlaywrightBrowserPool;
  /**
   * #220: every session's page is watched by a `PageLivenessWatchdog`; a page that answers nothing
   * for `unresponsiveMs` (default `JEVITATE_PAGE_UNRESPONSIVE_MS`, else 60s) is closed with the
   * reason, so the run ends instead of hanging. `false` turns the watchdog off.
   */
  readonly liveness?: { readonly unresponsiveMs?: number } | false;
  /** #220: bound on opening the session's first page (default 60s). */
  readonly openTimeoutMs?: number;
}

/**
 * `BrowserPort` over Playwright Chromium. By default every `open()` is a fresh,
 * isolated context on the pooled browser (admission-controlled); auth carries
 * across sessions only through explicit Playwright `storageState` files.
 * `persistentProfile` is the explicit opt-in for a real on-disk Chromium
 * profile (its own browser process, outside the pool).
 */
export class PlaywrightBrowserPort implements BrowserPort {
  readonly #launch: Launch;
  readonly #launchPersistent: LaunchPersistentContext;
  readonly #platform: NodeJS.Platform;
  readonly #pool: PlaywrightBrowserPool | undefined;
  readonly #liveness: { readonly unresponsiveMs?: number } | false;
  readonly #openTimeoutMs: number;

  constructor(deps: PlaywrightBrowserPortDeps = {}) {
    this.#liveness = deps.liveness ?? {};
    this.#openTimeoutMs = deps.openTimeoutMs ?? DEFAULT_OPEN_TIMEOUT_MS;
    this.#launch = deps.launch ?? ((options) => chromium.launch(options));
    this.#launchPersistent = deps.launchPersistentContext ?? ((dir, options) => chromium.launchPersistentContext(dir, options));
    this.#platform = deps.platform ?? process.platform;
    this.#pool = deps.pool;
  }

  async open(opts: OpenOptions): Promise<BrowserSession> {
    // TODO(M3): enforce allowedOrigins via route interception; currently unenforced.
    // Refused BEFORE any browser opens: an unregistered --device name, or --viewport + --device together.
    const emulation = resolveEmulation({ viewport: opts.viewport, device: opts.device });
    if (opts.persistentProfile !== undefined) return this.#openPersistent(opts, opts.persistentProfile, emulation);
    const launchOptions = {
      headless: opts.headless,
      args: resolveLaunchArgs(opts.args, this.#platform),
      ...(opts.executablePath !== undefined ? { executablePath: opts.executablePath } : {}),
      ...(opts.channel !== undefined ? { channel: opts.channel } : {}),
    };
    const launchKey = JSON.stringify(launchOptions);
    const pool = this.#pool ?? sharedBrowserPool();
    const lease = await pool.acquire(
      launchKey,
      async () => {
        try {
          return await this.#launch(launchOptions);
        } catch (err) {
          throw explainLaunchFailure(err, opts);
        }
      },
      {
        baseURL: opts.baseUrl,
        ...(opts.storageState !== undefined ? { storageState: opts.storageState } : {}),
        ...(emulation === undefined ? {} : emulationContextOptions(emulation)),
      },
    );
    let page: Page;
    try {
      page = await withOpenDeadline(
        lease.context.newPage(),
        this.#openTimeoutMs,
        `opening a page did not finish within ${this.#openTimeoutMs}ms: the browser is not answering`,
        (late) => {
          late.close().catch(() => undefined);
        },
      );
    } catch (err) {
      await lease.release().catch(() => undefined);
      throw err;
    }
    return pooledSession(lease, page, this.#watch(page));
  }

  async #openPersistent(opts: OpenOptions, dir: string, emulation: ReturnType<typeof resolveEmulation>): Promise<BrowserSession> {
    if (opts.storageState !== undefined) {
      throw new Error("storageState cannot be combined with persistentProfile: a persistent profile already carries its own state");
    }
    let context: BrowserContext;
    try {
      context = await this.#launchPersistent(dir, {
        headless: opts.headless,
        baseURL: opts.baseUrl,
        args: resolveLaunchArgs(opts.args, this.#platform),
        ...(opts.executablePath !== undefined ? { executablePath: opts.executablePath } : {}),
        ...(opts.channel !== undefined ? { channel: opts.channel } : {}),
        ...(emulation === undefined ? {} : emulationContextOptions(emulation)),
      });
    } catch (err) {
      throw explainLaunchFailure(err, opts);
    }
    const page = context.pages()[0] ?? (await context.newPage());
    const watchdog = this.#watch(page);
    return {
      page,
      admission: undefined,
      async startTracing() {
        await context.tracing.start({ screenshots: true, snapshots: true });
      },
      async stopTracingToFile(file: string) {
        await context.tracing.stop({ path: file });
      },
      async saveStorageState(file: string) {
        await context.storageState({ path: file });
      },
      async captureStorageState() {
        return JSON.stringify(await context.storageState());
      },
      async close() {
        watchdog?.stop();
        await context.close();
      },
    };
  }

  /** #220: the session page's liveness watchdog (undefined when turned off). */
  #watch(page: Page): PageLivenessWatchdog | undefined {
    if (this.#liveness === false) return undefined;
    return new PageLivenessWatchdog(page, { unresponsiveMs: this.#liveness.unresponsiveMs ?? pageUnresponsiveMsFromEnv() });
  }
}

function pooledSession(lease: ContextLease<BrowserContext>, page: Page, watchdog: PageLivenessWatchdog | undefined): BrowserSession {
  const context = lease.context;
  /** After a browser crash every session operation surfaces the crash, not a vague "target closed". */
  const alive = (): void => {
    if (lease.crash !== undefined) throw lease.crash;
  };
  return {
    page,
    admission: lease.admission,
    async startTracing() {
      alive();
      await context.tracing.start({ screenshots: true, snapshots: true });
    },
    async stopTracingToFile(file: string) {
      alive();
      await context.tracing.stop({ path: file });
    },
    async saveStorageState(file: string) {
      alive();
      await context.storageState({ path: file });
    },
    async captureStorageState() {
      alive();
      return JSON.stringify(await context.storageState());
    },
    async close() {
      watchdog?.stop();
      await lease.release();
    },
  };
}
