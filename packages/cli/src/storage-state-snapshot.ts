import { writeFileSync } from "node:fs";
import { isLoginLikeUrl } from "@jevitate/explore";

/**
 * `--save-storage-state` must survive a crash or a kill signal (#159), not just a clean exit: a
 * rotating refresh token means the OLD `--storage-state` file is already stale by the time a run
 * ends — losing the write on a crash/SIGTERM starts the next mission logged out.
 *
 * The crashed-run case is solved in each mission's own `finally` (a thrown error still reaches it —
 * see `persistStorageState` in `explore-api.ts`/`ux-api.ts`). The KILLED case cannot: `kill-signal.ts`
 * writes its partial result and exits SYNCHRONOUSLY, in the same turn the signal arrives (deliberately
 * — see its own doc comment), and capturing Playwright's `storageState()` is async. There is no way to
 * `await` it there without reopening the exact race that module exists to close.
 *
 * The fix: keep a cheap, best-effort, in-memory snapshot that is refreshed after every SETTLED step —
 * so by the time a signal lands, `snapshot()` already holds a recent one, and the kill switch can
 * write it with a plain synchronous `writeFileSync`.
 *
 * Never overwrites a good session with a lost/logged-out one: a refresh is skipped whenever the
 * CURRENT page looks login-like (`isLoginLikeUrl`, the same #82 pattern `seedRedirectReason` uses) —
 * so the snapshot held at that moment is the last one taken while the session still looked good, and
 * that is what both the kill switch and the mission's own `finally` fallback end up writing. Nothing
 * here is ever logged; the snapshot text is the same storageState JSON `--save-storage-state` writes.
 */
export class StorageStateSnapshotter {
  #last: string | undefined;
  #pending = false;

  constructor(
    private readonly session: { captureStorageState?(): Promise<string> },
    /** `false` when `--save-storage-state` was not given: every call below is then a no-op that
     *  never touches the browser (a run without the flag pays nothing). */
    private readonly enabled: boolean,
  ) {}

  /**
   * Call after each settled step, with the page's CURRENT url. Fire-and-forget: never awaited by the
   * mission loop (the capture cost must never slow down the run), never throws, and coalesces — a
   * capture already in flight is left to finish rather than started twice.
   */
  noteSettledStep(currentUrl: string | undefined): void {
    if (!this.enabled || this.#pending || this.session.captureStorageState === undefined) return;
    if (currentUrl !== undefined && isLoginLikeUrl(currentUrl)) return;
    this.#pending = true;
    this.session
      .captureStorageState()
      .then((json) => {
        this.#last = json;
      })
      .catch(() => {
        // Best-effort: a failed capture just leaves the previous (still good) snapshot in place.
      })
      .finally(() => {
        this.#pending = false;
      });
  }

  /** The last known-good snapshot, or `undefined` if none was ever safely captured. */
  snapshot(): string | undefined {
    return this.#last;
  }
}

/**
 * The kill switch's synchronous write (#159): called from `onKillSignal` for each armed mission that
 * declared a `--save-storage-state` path and has a snapshot to write. Mode 0600 (owner read/write
 * only — the file holds live session cookies); a failed write is swallowed the same way every other
 * best-effort step in the kill path is (a full disk must never keep the OTHER armed missions from
 * being flushed, nor keep the process from exiting).
 */
export function writeKillSnapshot(path: string, json: string): void {
  try {
    writeFileSync(path, json, { encoding: "utf8", mode: 0o600 });
  } catch {
    // Best-effort, like every other write in the kill path.
  }
}
