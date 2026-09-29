import { mkdir, writeFile } from "node:fs/promises";
import { logsDirFor } from "./project-dir.js";
import { join } from "node:path";
import { assertAuthorizedExploreTarget, normalizeAllowlist } from "@jevitate/explore";
import { PlaywrightBrowserPort, type BrowserPort, type BrowserSession } from "@jevitate/playwright";
import type { Recording } from "@jevitate/recording";
import { Recorder } from "@jevitate/recorder";
import { resolveDataDir } from "./data-dir.js";

/**
 * The programmatic surface behind `jevitate record` — opens a real browser on
 * an authorized origin, lets the user demonstrate a flow, and captures it into
 * a schema-valid `Recording` (record-by-demonstration via `@jevitate/recorder`)
 * which is then persisted under `.jevitate/logs/<date>`.
 *
 * The authorized-target guard runs FIRST (fail-closed), BEFORE any browser is
 * opened — an unauthorized origin never launches Chromium. Both the browser
 * port and the recorder are injectable (`browserPortFactory`/`recorderFactory`)
 * and the "user demonstrates then signals done" wait is a plain injected
 * promise (`waitForStop`), so the whole flow is unit-testable without a real
 * browser, a real recorder, or interactive input.
 */

/**
 * The subset of `@jevitate/recorder`'s `Recorder` that `runRecording` drives.
 * A structural interface (not the concrete class) so tests can inject a fake
 * that never touches Playwright — the real `Recorder` satisfies it.
 */
export interface RecorderLike {
  install(): Promise<void>;
  start(intent?: string): Promise<void>;
  stop(retro?: string): Promise<Recording>;
}

export interface RunRecordingOptions {
  /** Start URL the user demonstrates from (must be an authorized origin). */
  readonly url: string;
  readonly allowlist: readonly string[];
  /** The user's own framing of the journey, carried to `Recording.intent`. */
  readonly intent?: string;
  /** Optional retrospective note carried to `Recording.retro`. */
  readonly retro?: string;
  /** Where the Recording is written. Default `.jevitate/logs/<date>` (project, else `~/.jevitate`). */
  readonly outDir?: string;
  /** Testing seam — defaults to a real `PlaywrightBrowserPort`. */
  readonly browserPortFactory?: () => BrowserPort;
  /** Testing seam — defaults to a real `Recorder` bound to the session. */
  readonly recorderFactory?: (session: BrowserSession, site: string) => RecorderLike;
  /**
   * Resolves when the user signals the demonstration is complete. Defaults to
   * `waitForEnterKey` (a single Enter on stdin). Injecting an immediately-
   * resolved promise makes the capture core testable without interactive input.
   */
  readonly waitForStop?: () => Promise<void>;
  /** Run headless? Default `false` — a record session is a live demonstration. */
  readonly headless?: boolean;
  /** ISO clock for the recording filename. Default `Date.now()`. */
  readonly nowIso?: () => string;
}

export interface RunRecordingResult {
  readonly recording: Recording;
  readonly recordingPath: string;
  /** Total captured steps across every page segment. */
  readonly steps: number;
  /** Number of page segments in the Recording. */
  readonly pages: number;
  readonly finalUrl: string;
}

export async function runRecording(opts: RunRecordingOptions): Promise<RunRecordingResult> {
  // Guardrail #1 — authorize BEFORE opening a browser. Throws on refusal.
  const origin = assertAuthorizedExploreTarget(opts.url, opts.allowlist);

  const portFactory = opts.browserPortFactory ?? (() => new PlaywrightBrowserPort());
  const port = portFactory();
  const session = await port.open({
    headless: opts.headless ?? false,
    allowedOrigins: [...opts.allowlist],
    baseUrl: origin,
  });

  try {
    const recorder = (opts.recorderFactory ?? ((s, site) => new Recorder(s, site)))(session, origin);

    // Arm capture, begin the recording, THEN navigate to the start URL so the
    // opening navigation is captured as the recording's first step (replay must
    // itself start by landing on that page).
    await recorder.install();
    await recorder.start(opts.intent);
    await session.page.goto(opts.url);

    // The demonstration: the user drives the browser until they signal done.
    await (opts.waitForStop ?? waitForEnterKey)();

    const recording = await recorder.stop(opts.retro);
    const finalUrl = session.page.url();

    const outDir = opts.outDir ?? logsDirFor();
    await mkdir(outDir, { recursive: true });
    const iso = (opts.nowIso ?? (() => new Date().toISOString()))();
    const recordingPath = join(outDir, `record-${iso.replace(/[:.]/g, "-")}.json`);
    await writeFile(recordingPath, `${JSON.stringify(recording, null, 2)}\n`, "utf8");

    const steps = recording.pages.reduce((n, p) => n + p.steps.length, 0);
    return { recording, recordingPath, steps, pages: recording.pages.length, finalUrl };
  } finally {
    await session.close();
  }
}

/**
 * The authorized-origins allowlist for a record session: explicit `--allow`
 * origins when given, otherwise the target URL's own origin (you asked to
 * record on it). An unparseable URL yields an empty allowlist → the guard
 * fails closed. Mirrors `resolveExploreAllowlist`.
 */
export function resolveRecordAllowlist(url: string, allow: readonly string[]): string[] {
  if (allow.length > 0) return [...allow];
  return normalizeAllowlist([url]);
}

/**
 * The default stop signal for an interactive `jevitate record` session: resolves the first time
 * the user presses Enter on stdin, OR on SIGINT (Ctrl-C, #124) — both end the take the SAME way,
 * through `recorder.stop()` + the write to disk in `runRecording`'s normal path, so a take is
 * never silently lost. SIGINT matters most for `--headless` (no visible window to interact with,
 * so Ctrl-C is the natural way to signal "done"): registering a listener here means Node does NOT
 * fall back to its default "kill the process" SIGINT behavior — the take is saved first.
 * Best-effort on stdin — if it is not a TTY / not readable, resolves immediately rather than
 * hanging the capture forever (SIGINT still works either way).
 */
export function waitForEnterKey(): Promise<void> {
  return new Promise<void>((resolve) => {
    let settled = false;
    const stdin = process.stdin;
    const onSigint = (): void => finish();
    const onData = (chunk: Buffer): void => {
      if (chunk.includes(0x0a) || chunk.includes(0x0d)) finish();
    };
    function cleanup(): void {
      process.off("SIGINT", onSigint);
      if (stdin && stdin.readable) {
        stdin.off("data", onData);
        try {
          stdin.pause();
        } catch {
          // stdin may already be closed; nothing to pause.
        }
      }
    }
    function finish(): void {
      if (settled) return;
      settled = true;
      cleanup();
      resolve();
    }

    process.on("SIGINT", onSigint);

    if (!stdin || !stdin.readable) {
      finish();
      return;
    }
    try {
      stdin.resume();
      stdin.on("data", onData);
    } catch {
      finish();
    }
  });
}
