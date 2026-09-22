import type { Page } from "playwright";

export interface BrowserSession {
  readonly page: Page;
  startTracing(): Promise<void>;
  stopTracingToFile(file: string): Promise<void>;
  close(): Promise<void>;
}

/**
 * How Chromium is launched — orthogonal to WHAT is browsed. Every field is
 * optional; omitted fields keep Playwright's pinned-Chromium defaults.
 *
 *  - `executablePath`: launch this Chromium binary instead of the pinned one.
 *  - `channel`: a Playwright browser channel (e.g. `chrome`, `msedge`).
 *  - `args`: extra Chromium command-line switches. On Linux these EXTEND
 *    `DEFAULT_LINUX_CHROMIUM_ARGS` (see `resolveLaunchArgs`), never replace it.
 *
 * Headedness is NOT here: `OpenOptions.headless` is its single source of truth.
 */
export interface BrowserLaunchOptions {
  executablePath?: string;
  channel?: string;
  args?: readonly string[];
}

export interface OpenOptions extends BrowserLaunchOptions {
  profileDir: string;
  headless: boolean;
  /** TODO(M3): inert until route-level enforcement lands — not yet a navigation guard. */
  allowedOrigins: string[];
  baseUrl: string;
}

export interface BrowserPort {
  open(opts: OpenOptions): Promise<BrowserSession>;
}
