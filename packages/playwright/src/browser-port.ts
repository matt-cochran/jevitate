import type { Page } from "playwright";
import type { AdmissionRecord } from "./browser-pool.js";
import type { ViewportSize } from "./emulation.js";

export interface BrowserSession {
  readonly page: Page;
  /** What admission control waited for and sampled; undefined for an unpooled `persistentProfile` session. */
  readonly admission: AdmissionRecord | undefined;
  startTracing(): Promise<void>;
  stopTracingToFile(file: string): Promise<void>;
  /** Writes the context's cookies + origin storage as a Playwright `storageState` JSON file. */
  saveStorageState(file: string): Promise<void>;
  /**
   * Captures the context's cookies + origin storage as a `storageState` JSON string, in memory —
   * no file write (#159). Used to keep a cheap "last known-good" snapshot as a mission runs, so a
   * crash or a killed process (SIGTERM/SIGINT, which cannot `await` a live capture) can still
   * persist a recent authenticated session instead of losing it. Optional: real sessions implement
   * it; a test double that never exercises `--save-storage-state` need not.
   */
  captureStorageState?(): Promise<string>;
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

/**
 * One session. By default it is a fresh, isolated context on the pooled browser;
 * nothing survives it unless the caller saves `storageState`.
 *
 *  - `storageState`: seed the context from a Playwright storageState JSON file
 *    (auth persistence across sessions). The file must exist.
 *  - `persistentProfile`: explicit opt-in to a real on-disk Chromium profile
 *    (`launchPersistentContext`) — e.g. headed use of a real profile. Runs its
 *    own browser process outside the pool; cannot combine with `storageState`.
 *  - `viewport` / `device` (#149): per-mission viewport/device emulation, mutually exclusive.
 *    `device` is a name from Playwright's own `devices` registry (validated by
 *    `resolveEmulation`/`UnknownDeviceError` — never an arbitrary UA string) and additionally sets
 *    `deviceScaleFactor`/`isMobile`/`hasTouch`/`userAgent`. Both undefined ⇒ Playwright's default
 *    viewport (documented in `jevitate explore --help`).
 */
export interface OpenOptions extends BrowserLaunchOptions {
  storageState?: string;
  persistentProfile?: string;
  headless: boolean;
  /** TODO(M3): inert until route-level enforcement lands — not yet a navigation guard. */
  allowedOrigins: string[];
  baseUrl: string;
  viewport?: ViewportSize;
  device?: string;
}

export interface BrowserPort {
  open(opts: OpenOptions): Promise<BrowserSession>;
}
