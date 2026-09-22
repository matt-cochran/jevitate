import { chromium, type BrowserContext } from "playwright";
import type { BrowserPort, BrowserSession, OpenOptions } from "./browser-port.js";

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

type LaunchPersistentContext = typeof chromium.launchPersistentContext;

export interface PlaywrightBrowserPortDeps {
  /** Testing seam — defaults to Playwright's `chromium.launchPersistentContext`. */
  readonly launchPersistentContext?: LaunchPersistentContext;
  /** Testing seam — defaults to `process.platform`. */
  readonly platform?: NodeJS.Platform;
}

export class PlaywrightBrowserPort implements BrowserPort {
  readonly #launch: LaunchPersistentContext;
  readonly #platform: NodeJS.Platform;

  constructor(deps: PlaywrightBrowserPortDeps = {}) {
    this.#launch = deps.launchPersistentContext ?? ((dir, options) => chromium.launchPersistentContext(dir, options));
    this.#platform = deps.platform ?? process.platform;
  }

  async open(opts: OpenOptions): Promise<BrowserSession> {
    // TODO(M3): enforce allowedOrigins via route interception; currently unenforced.
    let context: BrowserContext;
    try {
      context = await this.#launch(opts.profileDir, {
        headless: opts.headless,
        baseURL: opts.baseUrl,
        args: resolveLaunchArgs(opts.args, this.#platform),
        ...(opts.executablePath !== undefined ? { executablePath: opts.executablePath } : {}),
        ...(opts.channel !== undefined ? { channel: opts.channel } : {}),
      });
    } catch (err) {
      throw explainLaunchFailure(err, opts);
    }
    const page = context.pages()[0] ?? (await context.newPage());
    return {
      page,
      async startTracing() {
        await context.tracing.start({ screenshots: true, snapshots: true });
      },
      async stopTracingToFile(file: string) {
        await context.tracing.stop({ path: file });
      },
      async close() {
        await context.close();
      },
    };
  }
}
