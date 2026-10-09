import { chromium, type BrowserContext, type BrowserContextOptions, type Page } from "playwright";
import type { BrowserPort, BrowserSession, OpenOptions } from "./browser-port.js";
import { BrowserPool, DEFAULT_OPEN_TIMEOUT_MS, withOpenDeadline, type BrowserPoolOptions, type ContextLease } from "./browser-pool.js";
import { PageLivenessWatchdog, pageUnresponsiveMsFromEnv } from "./page-liveness.js";
import { createResourceSignals } from "./select-resource-signals.js";
import { emulationContextOptions, resolveEmulation } from "./emulation.js";
import { probeReachable } from "./reachability.js";
import { ExtensionLoadError, extensionLaunchArgs, extensionOrigin, type UnpackedExtension } from "./extensions.js";
import { ownerMarkerArg } from "./browser-processes.js";
import { sharedResourceGovernor, type GovernorTicket, type ResourceGovernor, type ResourceLimits } from "./resource-governor.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
    `Playwright's pinned Chromium is not installed (expected at ${where}); run: jevitate install-browser`,
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
  /** #213: testing seam for the sessions' pre-flight reachability probe (default `probeReachable`). */
  readonly probe?: (url: string) => Promise<string | null>;
  /** #205: the resource governor every session is admitted by (default: the process-wide `sharedResourceGovernor()`). */
  readonly governor?: ResourceGovernor;
}

/**
 * #205: the owner marker (`--jevitate-owner=<pid>@<start>`) is appended to every REAL launch, so the
 * browser's memory can be attributed to this process and an orphan left by a killed jevitate can be
 * found and closed (browser-processes.ts). Not part of a launch configuration's identity (`launchKey`).
 */
function marked<T extends { args?: string[] | readonly string[] }>(options: T | undefined): T {
  return { ...(options as T), args: [...(options?.args ?? []), ownerMarkerArg()] };
}

/**
 * `BrowserPort` over Playwright Chromium. By default every `open()` is a fresh,
 * isolated context on the pooled browser (admission-controlled); auth carries
 * across sessions only through explicit Playwright `storageState` files.
 * `persistentProfile` is the explicit opt-in for a real on-disk Chromium
 * profile (its own browser process, outside the pool).
 */
/**
 * #329: with a `geolocation`, the `geolocation` permission is granted to the session's allowed
 * origins only (http(s) origins; a pattern or a non-web origin is skipped), so the page reads the
 * position without a prompt — and no other site can.
 */
async function grantGeolocation(context: BrowserContext, opts: OpenOptions): Promise<void> {
  if (opts.geolocation === undefined) return;
  const origins = new Set<string>();
  for (const o of [...opts.allowedOrigins, opts.baseUrl]) {
    try {
      const u = new URL(o);
      if (u.protocol === "http:" || u.protocol === "https:") origins.add(u.origin);
    } catch {
      // not a URL (e.g. a wildcard pattern): nothing to grant it
    }
  }
  for (const origin of origins) await context.grantPermissions(["geolocation"], { origin });
}

export class PlaywrightBrowserPort implements BrowserPort {
  readonly #launch: Launch;
  readonly #launchPersistent: LaunchPersistentContext;
  readonly #platform: NodeJS.Platform;
  readonly #pool: PlaywrightBrowserPool | undefined;
  readonly #liveness: { readonly unresponsiveMs?: number } | false;
  readonly #openTimeoutMs: number;
  readonly #probe: (url: string) => Promise<string | null>;
  readonly #governor: ResourceGovernor | undefined;

  constructor(deps: PlaywrightBrowserPortDeps = {}) {
    this.#governor = deps.governor;
    this.#liveness = deps.liveness ?? {};
    this.#openTimeoutMs = deps.openTimeoutMs ?? DEFAULT_OPEN_TIMEOUT_MS;
    this.#launch = deps.launch ?? ((options) => chromium.launch(marked(options)));
    this.#launchPersistent = deps.launchPersistentContext ?? ((dir, options) => chromium.launchPersistentContext(dir, marked(options)));
    this.#platform = deps.platform ?? process.platform;
    this.#pool = deps.pool;
    this.#probe = deps.probe ?? ((url) => probeReachable(url));
  }

  async open(opts: OpenOptions): Promise<BrowserSession> {
    // TODO(M3): allowedOrigins is not enforced here (no route interception): subresource requests to
    // any origin load. The acting origin is checked by the missions after each settle, and writes are
    // blocked by their own guards (read-only find-out goals, adversarial misuse #403) — docs/safety.md.
    // Refused BEFORE any browser opens: an unregistered --device name, or --viewport + --device together.
    const emulation = resolveEmulation({ viewport: opts.viewport, device: opts.device });
    // #205: admitted by the resource governor (machine-wide browser cap, throttling) before anything
    // launches; the session's page is then watched against the memory ceiling until it closes.
    const governor = this.#governor ?? sharedResourceGovernor();
    const ticket = await governor.enter(opts.resources);
    let session: BrowserSession;
    try {
      session = await this.#openAdmitted(opts, emulation);
    } catch (err) {
      ticket.release();
      throw err;
    }
    return governed(session, governor, ticket, opts.resources);
  }

  async #openAdmitted(opts: OpenOptions, emulation: ReturnType<typeof resolveEmulation>): Promise<BrowserSession> {
    if (opts.persistentProfile !== undefined) return this.#openPersistent(opts, opts.persistentProfile, emulation);
    // #256: Playwright loads extensions only in a persistent context — a throwaway profile per session.
    if (opts.extensions !== undefined && opts.extensions.length > 0) {
      const dir = await mkdtemp(join(tmpdir(), "jevitate-ext-profile-"));
      try {
        return await this.#openPersistent(opts, dir, emulation, dir);
      } catch (err) {
        await rm(dir, { recursive: true, force: true }).catch(() => undefined);
        throw err;
      }
    }
    const launchOptions = {
      headless: opts.headless,
      args: resolveLaunchArgs(opts.args, this.#platform),
      ...(opts.executablePath !== undefined ? { executablePath: opts.executablePath } : {}),
      ...(opts.channel !== undefined ? { channel: opts.channel } : {}),
      ...(opts.slowMo !== undefined && opts.slowMo > 0 ? { slowMo: opts.slowMo } : {}),
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
        ...(opts.geolocation === undefined ? {} : { geolocation: { ...opts.geolocation } }),
        ...(opts.recordVideo === undefined ? {} : { recordVideo: { dir: opts.recordVideo.dir } }),
      },
    );
    let page: Page;
    try {
      await grantGeolocation(lease.context, opts);
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
    return pooledSession(lease, page, this.#watch(page), this.#probe, await videoPathOf(page));
  }

  /**
   * A persistent-context session: the caller's `persistentProfile`, or (#256) a throwaway profile
   * `tempProfile` for a session that loads extensions — removed when the session closes. A
   * throwaway profile has no state of its own, so a `storageState` is applied to it after launch.
   */
  async #openPersistent(opts: OpenOptions, dir: string, emulation: ReturnType<typeof resolveEmulation>, tempProfile?: string): Promise<BrowserSession> {
    if (opts.storageState !== undefined && tempProfile === undefined) {
      throw new Error("storageState cannot be combined with persistentProfile: a persistent profile already carries its own state");
    }
    const extensions = opts.extensions ?? [];
    // #256: the headless shell (Playwright's default headless binary) cannot load extensions; the
    // full Chromium build in new-headless mode can. An explicit channel/executable is kept as given.
    const channel = opts.channel ?? (extensions.length > 0 && opts.headless && opts.executablePath === undefined ? "chromium" : undefined);
    let context: BrowserContext;
    try {
      context = await this.#launchPersistent(dir, {
        headless: opts.headless,
        baseURL: opts.baseUrl,
        args: resolveLaunchArgs([...(opts.args ?? []), ...extensionLaunchArgs(extensions)], this.#platform),
        ...(extensions.length > 0 ? { ignoreDefaultArgs: ["--disable-extensions"] } : {}),
        ...(opts.executablePath !== undefined ? { executablePath: opts.executablePath } : {}),
        ...(channel !== undefined ? { channel } : {}),
        ...(opts.slowMo !== undefined && opts.slowMo > 0 ? { slowMo: opts.slowMo } : {}),
        ...(emulation === undefined ? {} : emulationContextOptions(emulation)),
        ...(opts.geolocation === undefined ? {} : { geolocation: { ...opts.geolocation } }),
        ...(opts.recordVideo === undefined ? {} : { recordVideo: { dir: opts.recordVideo.dir } }),
      });
    } catch (err) {
      throw explainLaunchFailure(err, { executablePath: opts.executablePath, channel });
    }
    try {
      await grantGeolocation(context, opts);
      if (opts.storageState !== undefined) await context.setStorageState(opts.storageState);
      await confirmExtensionsLoaded(context, extensions, this.#openTimeoutMs);
    } catch (err) {
      await context.close().catch(() => undefined);
      throw err;
    }
    const page = context.pages()[0] ?? (await context.newPage());
    const watchdog = this.#watch(page);
    const videoPath = await videoPathOf(page);
    return {
      page,
      admission: undefined,
      ...(videoPath === undefined ? {} : { videoPath }),
      ...(extensions.length > 0 ? { extensions } : {}),
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
      probeReachable: this.#probe,
      async close() {
        watchdog?.stop();
        try {
          await context.close();
        } finally {
          if (tempProfile !== undefined) await rm(tempProfile, { recursive: true, force: true }).catch(() => undefined);
        }
      },
    };
  }

  /** #220: the session page's liveness watchdog (undefined when turned off). */
  #watch(page: Page): PageLivenessWatchdog | undefined {
    if (this.#liveness === false) return undefined;
    return new PageLivenessWatchdog(page, { unresponsiveMs: this.#liveness.unresponsiveMs ?? pageUnresponsiveMsFromEnv() });
  }
}

/**
 * #256: proves each extension actually loaded — its `manifest.json` opens at
 * `chrome-extension://<id>/` in a scratch page — so a browser that silently ignored
 * `--load-extension` (branded Chrome ≥ 137, the headless shell, a policy) fails here with the
 * reason instead of as an unexplained blocked navigation mid-run.
 */
async function confirmExtensionsLoaded(context: BrowserContext, extensions: readonly UnpackedExtension[], timeoutMs: number): Promise<void> {
  if (extensions.length === 0) return;
  const probe = await context.newPage();
  try {
    for (const e of extensions) {
      const url = `${extensionOrigin(e.id)}/manifest.json`;
      try {
        await probe.goto(url, { timeout: timeoutMs });
      } catch (err) {
        // Cross-check: extensions the browser DID start (service workers / background pages) under
        // other ids mean the pre-launch id computation drifted from Chromium's, not a refused load.
        const running = (await runningExtensionIds(context, timeoutMs)).filter((id) => !extensions.some((x) => x.id === id));
        throw new ExtensionLoadError(
          running.length > 0
            ? `the browser loaded an extension under id ${running.join(", ")}, not the id ${e.id} computed for ${e.name}@${e.version} from ${e.dir}: ` +
                "the extension id computation does not match this browser's (a jevitate bug — please report it with the platform and path)"
            : `the browser did not load the extension ${e.name}@${e.version} from ${e.dir} (id ${e.id}): ${url} is not reachable. ` +
                "Use Playwright's bundled Chromium (no --browser-channel, or --browser-channel chromium); branded Google Chrome no longer loads unpacked extensions from the command line",
          { cause: err },
        );
      }
    }
  } finally {
    await probe.close().catch(() => undefined);
  }
}

/**
 * Ids of the extensions running in `context` (from their service workers' and background pages'
 * origins). Error path only: when none has registered yet, waits up to 2s for a service worker.
 */
async function runningExtensionIds(context: BrowserContext, timeoutMs: number): Promise<string[]> {
  const ids = (): string[] => {
    const out = new Set<string>();
    for (const w of [...context.serviceWorkers(), ...context.backgroundPages()]) {
      const m = EXTENSION_WORKER_URL.exec(w.url());
      if (m !== null) out.add(m[1]!);
    }
    return [...out];
  };
  // #410: an extension's worker can start seconds after launch on a slow machine. Wait for one
  // (the site's own service worker doesn't count), bounded by the load probe's timeout, so the
  // diagnosis — refused load vs a drifted id — never depends on runner speed.
  if (ids().length === 0) {
    await context
      .waitForEvent("serviceworker", { predicate: (w) => EXTENSION_WORKER_URL.test(w.url()), timeout: Math.min(timeoutMs, EXTENSION_WORKER_WAIT_MS) })
      .catch(() => undefined);
  }
  return ids();
}

/** The longest the drift cross-check waits for an extension's worker (only on the failure path). */
const EXTENSION_WORKER_WAIT_MS = 10_000;

/** A `chrome-extension://<id>/` worker or background page URL; group 1 is the id. */
const EXTENSION_WORKER_URL = /^chrome-extension:\/\/([a-p]{32})\//;

/** #245: the page's video file path when its context records one, else undefined (never throws). */
async function videoPathOf(page: Page): Promise<string | undefined> {
  try {
    return (await page.video()?.path()) ?? undefined;
  } catch {
    return undefined;
  }
}

/** #205: the session with its memory watch and governor ticket released when it closes (exactly once). */
function governed(session: BrowserSession, governor: ResourceGovernor, ticket: GovernorTicket, limits: ResourceLimits | undefined): BrowserSession {
  const unwatch = governor.watchMemory(session.page, limits);
  return {
    ...session,
    // The session's own close keeps its semantics (idempotent, a crash surfaced); unwatch/release are idempotent.
    async close() {
      unwatch();
      try {
        await session.close();
      } finally {
        ticket.release();
      }
    },
  };
}

function pooledSession(
  lease: ContextLease<BrowserContext>,
  page: Page,
  watchdog: PageLivenessWatchdog | undefined,
  probe: (url: string) => Promise<string | null>,
  videoPath: string | undefined,
): BrowserSession {
  const context = lease.context;
  /** After a browser crash every session operation surfaces the crash, not a vague "target closed". */
  const alive = (): void => {
    if (lease.crash !== undefined) throw lease.crash;
  };
  return {
    page,
    admission: lease.admission,
    ...(videoPath === undefined ? {} : { videoPath }),
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
    probeReachable: probe,
    async close() {
      watchdog?.stop();
      await lease.release();
    },
  };
}
