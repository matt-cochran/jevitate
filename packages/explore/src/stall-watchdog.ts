/** Default bound (ms) on the time between two completed steps of a frontier mission (#114). */
export const DEFAULT_STALL_TIMEOUT_MS = 120_000;

/** Thrown by `StallWatchdog.guard` once the watchdog fired: the run ends with `reason`. */
export class StalledError extends Error {
  constructor(readonly reason: string) {
    super(reason);
    this.name = "StalledError";
  }
}

/**
 * A no-progress watchdog for the frontier missions (coverage, exploratory, `--feature`) — #114.
 *
 * `--max-actions` bounds how many steps a run takes, never how long it may sit between two of them:
 * a reset that waits on a page that will never answer idles until something external kills the run.
 * The watchdog is kicked on every completed step; when `timeoutMs` passes with no kick, `stalled`
 * resolves with the reason and the mission ends `inconclusive` with it, instead of idling.
 */
export class StallWatchdog {
  readonly stalled: Promise<string>;
  private resolveStalled: (reason: string) => void = () => undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private stopped = false;
  private phase = "starting the run";

  constructor(private readonly timeoutMs: number = DEFAULT_STALL_TIMEOUT_MS) {
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      throw new Error(`stall timeout must be a positive number of milliseconds, got ${String(timeoutMs)}`);
    }
    this.stalled = new Promise<string>((resolve) => {
      this.resolveStalled = resolve;
    });
    this.arm();
  }

  /**
   * Awaits `work`, but rejects with `StalledError` the moment the watchdog fires — so a mission's
   * await on a page that never answers ends the run instead of idling in it.
   */
  guard<T>(work: Promise<T>): Promise<T> {
    return Promise.race([
      work,
      this.stalled.then((reason) => {
        throw new StalledError(reason);
      }),
    ]);
  }

  /** A step completed: restart the countdown. `phase` names what the run does next (for the reason). */
  kick(phase?: string): void {
    if (this.stopped) return;
    if (phase !== undefined) this.phase = phase;
    this.arm();
  }

  /** Pauses the countdown during a phase that is bounded on its own; the next `kick` re-arms it. */
  suspend(): void {
    clearTimeout(this.timer);
  }

  /** Names what the run is doing now, without restarting the countdown. */
  during(phase: string): void {
    this.phase = phase;
  }

  stop(): void {
    this.stopped = true;
    clearTimeout(this.timer);
  }

  private arm(): void {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      if (this.stopped) return;
      this.stopped = true;
      this.resolveStalled(`no step completed within ${seconds(this.timeoutMs)}s (while ${this.phase})`);
    }, this.timeoutMs);
    // Never keep the process alive just for the watchdog.
    (this.timer as { unref?: () => void }).unref?.();
  }
}

function seconds(ms: number): string {
  return ms % 1000 === 0 ? String(ms / 1000) : (ms / 1000).toFixed(1);
}
