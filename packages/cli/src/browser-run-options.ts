/**
 * Demo mode (#245): how a run's browser is SHOWN — a visible window, slowed down, recorded to video,
 * with the on-page overlay — resolved in ONE place. Every runner (every explore strategy, `journey
 * run`, `verify-fix`, regression capture/replay, observers and hang-replay sessions) builds its
 * `BrowserPort.open` options with `sessionLaunchOptions`, never with its own `headless: true`, so a
 * `--headed` run shows every window it opens and a run without the flags is unchanged: headless,
 * no slowMo, no video, no overlay.
 */
import { readdirSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { BrowserLaunchOptions, OpenOptions } from "@jevitate/playwright";

/** The browser options a runner takes: how Chromium is launched, plus how the run is shown (#245). */
export interface BrowserRunOptions extends BrowserLaunchOptions {
  /** A visible browser window (`--headed` / `JEVITATE_HEADED=1` / a suite item's `headed`). Default: headless. */
  readonly headed?: boolean;
  /**
   * Record a Playwright video of every browser context the run opens (`--record-video [dir]`).
   * `dir` absent ⇒ next to the run's output. Works headless too.
   */
  readonly recordVideo?: { readonly dir?: string };
  /** `--no-overlay` (false): a headed explore run shows the on-page demo overlay unless this is false. */
  readonly overlay?: boolean;
}

/** `--slow-mo` when `--headed` is given without one: slow enough for an audience to follow. */
export const HEADED_DEFAULT_SLOW_MO_MS = 250;

/** The launch part of a session's `OpenOptions` — the ONE place headedness, slowMo and video are resolved. */
export type SessionLaunchOptions = BrowserLaunchOptions & Pick<OpenOptions, "headless" | "recordVideo">;

/**
 * `browser` → the launch fields of `BrowserPort.open`: headless unless `headed`; `slowMo` as given,
 * else `HEADED_DEFAULT_SLOW_MO_MS` when headed; `recordVideo` into `videoDir` when the run records
 * (see `runVideoDir`). The demo-only fields (`headed`, `recordVideo`, `overlay`) never reach the port.
 */
export function sessionLaunchOptions(browser: BrowserRunOptions | undefined, videoDir?: string): SessionLaunchOptions {
  const { headed, recordVideo: _video, overlay: _overlay, slowMo, ...launch } = browser ?? {};
  const effectiveSlowMo = slowMo ?? (headed === true ? HEADED_DEFAULT_SLOW_MO_MS : undefined);
  return {
    ...launch,
    headless: headed !== true,
    ...(effectiveSlowMo === undefined ? {} : { slowMo: effectiveSlowMo }),
    ...(videoDir === undefined ? {} : { recordVideo: { dir: videoDir } }),
  };
}

/** The explore config's `demoOverlay` (#245): shown on a headed run unless `--no-overlay`. */
export function demoOverlayOf(browser: BrowserRunOptions | undefined): boolean {
  return browser?.headed === true && browser.overlay !== false;
}

/**
 * Where one run's videos go, or `undefined` when it does not record: a per-run folder named for the
 * run's artifact (`<stem>.videos/`), under `--record-video <dir>` or else beside `artifactPath` —
 * so a run's `videoPaths` are exactly the files in it, never another run's.
 */
export function runVideoDir(browser: BrowserRunOptions | undefined, artifactPath: string): string | undefined {
  if (browser?.recordVideo === undefined) return undefined;
  const stem = basename(artifactPath).replace(/\.json$/, "");
  return join(browser.recordVideo.dir ?? dirname(artifactPath), `${stem}.videos`);
}

/**
 * The video files in a run's video folder, oldest first (absolute paths). Synchronous so a killed
 * run's partial result can list them too. A missing folder (nothing recorded yet) is an empty list.
 */
export function listVideos(videoDir: string): string[] {
  let names: string[];
  try {
    names = readdirSync(videoDir).filter((n) => n.endsWith(".webm"));
  } catch {
    return [];
  }
  const files = names.map((n) => join(videoDir, n));
  const mtime = (f: string): number => {
    try {
      return statSync(f).mtimeMs;
    } catch {
      return 0;
    }
  };
  return files.sort((a, b) => mtime(a) - mtime(b) || a.localeCompare(b));
}

/**
 * #245: a video is finalized only when its browser context closes — so a recording run closes its
 * session(s) BEFORE its result is written, then lists the files. `close` must be idempotent (the
 * runner's own `finally` calls it again; see `closeOnce`). Not recording: nothing closes early, `{}`.
 */
export async function finalizeVideos(videoDir: string | undefined, close: () => Promise<void>): Promise<{ videoPaths?: string[] }> {
  if (videoDir === undefined) return {};
  await close();
  return { videoPaths: listVideos(videoDir) };
}

/** Wraps an async teardown so only its first call runs; later calls await the same promise. */
export function closeOnce(close: () => Promise<void>): () => Promise<void> {
  let done: Promise<void> | undefined;
  return () => (done ??= close());
}

/** Headed without a display (#245): refused before any browser launches, a usage error (exit 64). */
export class HeadedWithoutDisplayError extends Error {
  constructor() {
    super(
      "--headed needs a display, but neither DISPLAY nor WAYLAND_DISPLAY is set (on WSL2 a visible window needs WSLg). " +
        "Run headless and record it instead: --record-video",
    );
    this.name = "HeadedWithoutDisplayError";
  }
}

/** Throws `HeadedWithoutDisplayError` for a headed run on Linux with no X11/Wayland display. */
export function assertHeadedDisplay(
  headed: boolean,
  env: Readonly<Record<string, string | undefined>> = process.env,
  platform: NodeJS.Platform = process.platform,
): void {
  if (!headed || platform !== "linux") return;
  if ((env.DISPLAY ?? "") === "" && (env.WAYLAND_DISPLAY ?? "") === "") throw new HeadedWithoutDisplayError();
}

/** `JEVITATE_HEADED=1` (or `true`) turns `--headed` on for every command that takes it. */
export function headedFromEnv(env: Readonly<Record<string, string | undefined>>): boolean {
  const v = env.JEVITATE_HEADED?.trim().toLowerCase();
  return v === "1" || v === "true";
}

/** The one-line warning for a headed run that opens several windows at once (#245: warn, never refuse). */
export function multiWindowWarning(what: string): string {
  return `warning: --headed with ${what} opens several browser windows; each is shown.\n`;
}
