import type { Page } from "playwright";
import type { AdmissionRecord } from "./browser-pool.js";
import type { ViewportSize } from "./emulation.js";
import type { UnpackedExtension } from "./extensions.js";
import type { ResourceLimits } from "./resource-governor.js";

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
  /**
   * #245: where this session's Playwright video is being written — set only when it was opened with
   * `recordVideo`. The file is finalized when the session closes (its context closes).
   */
  readonly videoPath?: string;
  /**
   * #256: the unpacked extensions this session's browser loaded (`OpenOptions.extensions`), each
   * confirmed loaded — its `chrome-extension://<id>/` pages are navigable in this session.
   */
  readonly extensions?: readonly UnpackedExtension[];
  /**
   * #213: a fast pre-flight check that something is listening at `url`'s origin — a plain-words
   * reason when it definitely is not (connection refused, host not found), else null. Missions call
   * it before the first navigation so a target that is not running fails in milliseconds, not after
   * the 30s navigation timeout. Optional: a test double without it is never probed.
   */
  probeReachable?(url: string): Promise<string | null>;
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
 *  - `slowMo` (#245): Playwright's `slowMo` — every browser operation is slowed by this many ms so an
 *    audience can follow a demo. Absent (the default): no delay.
 *
 * Headedness is NOT here: `OpenOptions.headless` is its single source of truth.
 */
export interface BrowserLaunchOptions {
  executablePath?: string;
  channel?: string;
  args?: readonly string[];
  slowMo?: number;
  /**
   * #256: unpacked extensions to load (`--extension <dir>`, read by `readUnpackedExtension`). A
   * session with extensions runs its own persistent Chromium context (Playwright loads extensions
   * only there) on a throwaway profile, outside the pool; headless it uses the full Chromium build
   * (`channel: "chromium"`, new headless) because the headless shell cannot load extensions.
   */
  extensions?: readonly UnpackedExtension[];
  /**
   * #205: this run's resource limits (`--max-browsers`, `--max-browser-memory`) — override the
   * resource governor's defaults (see `ResourceGovernor`). Absent: the defaults/environment apply.
   */
  resources?: ResourceLimits;
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
  /** #245: record a Playwright video of this session's context into `dir` (see `BrowserSession.videoPath`). */
  recordVideo?: { dir: string };
}

export interface BrowserPort {
  open(opts: OpenOptions): Promise<BrowserSession>;
}
