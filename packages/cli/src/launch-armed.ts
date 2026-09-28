import type { HostHealthSampler } from "@jevitate/explore";
import type { HostHealthSummary } from "@jevitate/domain";
import { startHostHealth } from "./host-health-run.js";
import { armMissionKillSwitch, type KillableMission } from "./kill-signal.js";
import { StorageStateSnapshotter } from "./storage-state-snapshot.js";

/**
 * #226: what an armed mission's kill-switch hooks read before the host sampler and the browser exist:
 * `undefined` until the launch finished, the live values after.
 */
export interface ArmedHooks {
  readonly hostHealth: () => HostHealthSummary | undefined;
  readonly snapshot: () => string | undefined;
}

export interface LaunchArmedOptions<S> {
  /** The mission the kill switch reports on — built from `hooks`, never from the (not yet open) session. */
  readonly mission: (hooks: ArmedHooks) => KillableMission;
  /** Test seam (#203): the run's host-health sampler. Default: this host's. */
  readonly hostHealth?: HostHealthSampler;
  /** `--save-storage-state` was given: the snapshotter captures after settled steps. */
  readonly saveStorageState: boolean;
  /** Opens the run's browser session. */
  readonly open: () => Promise<S>;
}

/**
 * THE way a mission runner launches its browser (#226): the kill switch is armed FIRST — before the
 * host sampler and the browser launch (Chromium can take seconds to start on a loaded host) — so a
 * SIGTERM/SIGINT at any point from here writes and prints the partial result instead of exiting
 * 143/130 with nothing. A failed launch stops the sampler and disarms the switch before rethrowing
 * (the command reports that error itself).
 */
export async function launchArmed<S extends { captureStorageState?(): Promise<string> }>(
  opts: LaunchArmedOptions<S>,
): Promise<{ disarmKillSwitch: () => void; health: HostHealthSampler; session: S; snapshotter: StorageStateSnapshotter }> {
  let health: HostHealthSampler | undefined;
  let snapshotter: StorageStateSnapshotter | undefined;
  const disarmKillSwitch = armMissionKillSwitch(
    opts.mission({ hostHealth: () => health?.summary(), snapshot: () => snapshotter?.snapshot() }),
  );
  let started: HostHealthSampler | undefined;
  try {
    started = await startHostHealth(opts.hostHealth);
    const session = await opts.open();
    // #159: refreshed after each settled step; the kill switch writes whatever this holds synchronously.
    const snap = new StorageStateSnapshotter(session, opts.saveStorageState);
    health = started;
    snapshotter = snap;
    return { disarmKillSwitch, health: started, session, snapshotter: snap };
  } catch (e) {
    started?.stop();
    disarmKillSwitch();
    throw e;
  }
}
