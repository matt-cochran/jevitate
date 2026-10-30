import type { Page } from "playwright";
import type { AdmissionRecord } from "./browser-pool.js";
import type { BlockedNavigation } from "./nav-guard.js";
import type { GeolocationSpec, ViewportSize } from "./emulation.js";
import type { UnpackedExtension } from "./extensions.js";
import type { ResourceLimits } from "./resource-governor.js";
import type { OriginReadiness } from "./reachability.js";

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
  /**
   * #742: the origin's HTTP readiness — which layer (dns/connect/http/ready) failed, the answered
   * status when there was one, and a plain-words detail. Sweeps and campaign preflight use it to
   * tell a missing host from an app that answers a non-ready status. Optional: a test double without
   * it reports no readiness (read it as `session.probeOriginReadiness?.(url)`).
   */
  probeOriginReadiness?(url: string): Promise<OriginReadiness>;
  /**
   * #521: the off-allowlist navigations the navigation guard stopped since the last call (oldest
   * first), then forgets them — a mission drains it after each settle and treats a `main` entry as
   * a departure. Always `[]` for a session opened without `OpenOptions.blockOffAllowlistNavigation`.
   * Optional: a test double that never arms the guard need not implement it (read it as
   * `session.drainBlockedNavigations?.() ?? []`).
   */
  drainBlockedNavigations?(): readonly BlockedNavigation[];
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
  /**
   * The session's authorized origins: scopes the geolocation grant (#329); not a network guard unless
   * `blockOffAllowlistNavigation` is set — the acting origin is checked by the caller after each
   * settle (redirects cannot be intercepted), and writes by `ReadOnlyGuard`; see docs/safety.md.
   */
  allowedOrigins: string[];
  /**
   * #521 (opt-in, default false; mission sessions only — never login, record, Journey replays or
   * demos): arm the navigation guard on the context before the first navigation (popups covered). A
   * main-frame or subframe navigation to an http(s) origin outside `allowedOrigins` + `baseUrl` is
   * answered `204` in the browser (the page stays put, no error page) and reported by
   * `BrowserSession.drainBlockedNavigations`. Subresources and fetch/XHR are untouched; a server
   * redirect still passes (the post-settle check remains the enforcement). Routing disables the
   * context's HTTP cache.
   */
  blockOffAllowlistNavigation?: boolean;
  baseUrl: string;
  viewport?: ViewportSize;
  device?: string;
  /**
   * #329: the context's geolocation; the `geolocation` permission is granted to `allowedOrigins`
   * only (never every origin), so the page reads this position without a prompt.
   */
  geolocation?: GeolocationSpec;
  /** #245: record a Playwright video of this session's context into `dir` (see `BrowserSession.videoPath`). */
  recordVideo?: { dir: string };
}

export interface BrowserPort {
  open(opts: OpenOptions): Promise<BrowserSession>;
}
