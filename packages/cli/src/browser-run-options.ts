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
import { describeExtensions, EXTENSION_ID, extensionIdentity, extensionOrigin, sameExtensionBuild, type BrowserLaunchOptions, type ExtensionIdentity, type OpenOptions } from "@jevitate/playwright";
import { normalizeAllowlist } from "@jevitate/explore";

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

/** #256: a `chrome-extension://` target or replay that does not match the loaded `--extension`s (exit 64). */
export class ExtensionMismatchError extends Error {
  readonly code = "E_EXTENSION_ARGS" as const;
  constructor(message: string) {
    super(message);
    this.name = "ExtensionMismatchError";
  }
}

/** #256: the `chrome-extension://<id>` origin of every loaded `--extension`. */
export function extensionOrigins(browser: BrowserLaunchOptions | undefined): string[] {
  return (browser?.extensions ?? []).map((e) => extensionOrigin(e.id));
}

/** #256: what a run records about its loaded extensions (Recording `extensions`), or undefined for none. */
export function loadedExtensions(browser: BrowserLaunchOptions | undefined): ExtensionIdentity[] | undefined {
  const xs = browser?.extensions ?? [];
  return xs.length === 0 ? undefined : xs.map(extensionIdentity);
}

/** #256: `{ extensions }` to spread into a Recording a run wrote, or `{}` when it loaded none. */
export function extensionsStamp(browser: BrowserLaunchOptions | undefined): { extensions?: ExtensionIdentity[] } {
  const xs = loadedExtensions(browser);
  return xs === undefined ? {} : { extensions: xs };
}

/**
 * #256: the `--allow` list a run uses once its loaded extensions' origins are allowed too — ONLY
 * those ids. With no `--allow`, the default (the URL's own origin) plus the extension origins; with
 * `--allow`, those plus the extension origins. No extensions: `allow` unchanged.
 */
export function allowWithExtensions(url: string | undefined, allow: readonly string[], browser: BrowserLaunchOptions | undefined): string[] {
  const ext = extensionOrigins(browser);
  if (ext.length === 0) return [...allow];
  const base = allow.length > 0 ? [...allow] : url === undefined ? [] : normalizeAllowlist([url]);
  return [...new Set([...base, ...ext])];
}

/**
 * #256: a `chrome-extension://<id>/…` start URL must name an extension this run loads — refused
 * before any browser opens otherwise (listing the loaded ids, since an unpacked id is derived from
 * the directory's path). Any other URL passes.
 */
export function assertExtensionTargetLoaded(url: string | undefined, browser: BrowserLaunchOptions | undefined): void {
  if (url === undefined || !url.toLowerCase().startsWith("chrome-extension:")) return;
  let host = "";
  try {
    host = new URL(url).host;
  } catch {
    /* refused below */
  }
  const loaded = browser?.extensions ?? [];
  if (EXTENSION_ID.test(host) && loaded.some((e) => e.id === host)) return;
  const hint = loaded.length === 0 ? "load it with --extension <dir>" : `loaded: ${loaded.map((e) => `${e.name} → ${extensionOrigin(e.id)}/`).join(", ")}`;
  throw new ExtensionMismatchError(`${url} is not a page of a loaded extension (${hint})`);
}

/**
 * #256: a replay (verify-fix, journey run) refuses when the extensions the Recording ran with are
 * not the build loaded now — same ids, names and versions — so a "fixed" verdict is never reached
 * against a different extension build (or without the extension at all).
 */
export function assertSameExtensionBuild(recorded: readonly ExtensionIdentity[] | undefined, browser: BrowserLaunchOptions | undefined, what: string): void {
  const loaded = loadedExtensions(browser);
  if (sameExtensionBuild(recorded, loaded)) return;
  throw new ExtensionMismatchError(
    `${what} was recorded with extensions ${describeExtensions(recorded)} but this run loads ${describeExtensions(loaded)}; ` +
      "pass the same --extension build (an unpacked extension's id follows its directory path unless its manifest pins a \"key\")",
  );
}
