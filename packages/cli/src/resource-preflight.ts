import { hostname } from "node:os";
import { Command } from "commander";
import {
  cleanupOrphanBrowsers,
  pinnedBrowserReport,
  jevitateBrowsers,
  sharedResourceGovernor,
  type OrphanCleanup,
  type ProcessTable,
  type ResourceGovernor,
  type ResourceLimits,
  type SlotState,
} from "@jevitate/playwright";
import { formatPinnedBrowser } from "./browser-cli.js";
import { fail, ok, type JsonEnvelope } from "./envelope.js";
import { emitJsonOrRefusal } from "./cli-refusal.js";

/**
 * #205: the CLI side of resource governance — run once before every browser-driving command (the
 * action wrapper `withBrowserLaunchFlags` installs) and by `jevitate doctor`.
 *
 * Before a browser run starts:
 *  1. ORPHAN SWEEP (once per process): browsers a killed jevitate left behind — marked with their
 *     owner, owner gone — are closed, and stale machine slots are cleared. Only jevitate-marked
 *     processes are ever signalled.
 *  2. STARVED-HOST REFUSAL: when the host is clearly starved (`throttleDecision` → `starved`: load
 *     ≥ 4/core, or < 512 MiB available) the run refuses to start with `E_HOST_STARVED` (exit 2: it
 *     could not do its work) instead of timing out and reporting the app as hung — unless
 *     `--ignore-host-load`, in which case it runs throttled and its result records that.
 *
 * Both are skipped under `JEVITATE_RESOURCE_GOVERNANCE=off`.
 */

/** Raw commander values of the governance flags. */
export interface GovernanceFlags {
  maxBrowsers?: number;
  /** MiB. */
  maxBrowserMemory?: number;
  ignoreHostLoad?: boolean;
}

/** The run's `ResourceLimits` from its flags, or undefined when none was given. */
export function resourceLimitsFromFlags(o: GovernanceFlags): ResourceLimits | undefined {
  const limits: ResourceLimits = {
    ...(o.maxBrowsers === undefined ? {} : { maxBrowsers: o.maxBrowsers }),
    ...(o.maxBrowserMemory === undefined ? {} : { memoryCeilingBytes: o.maxBrowserMemory * 1024 ** 2 }),
  };
  return Object.keys(limits).length > 0 ? limits : undefined;
}

export interface PreflightDeps {
  readonly governor?: ResourceGovernor;
  /** Restricts what the orphan sweep reads (and so may signal) — tests pass their own processes only. */
  readonly processTable?: ProcessTable;
  readonly warn?: (line: string) => void;
}

let swept = false;

/** Test seam: forget that this process already swept (the sweep runs once per process). */
export function resetPreflightSweep(): void {
  swept = false;
}

/** The startup sweep: closes orphaned jevitate browsers and clears stale machine slots (once per process). */
export async function sweepOnce(deps: PreflightDeps = {}): Promise<void> {
  if (swept) return;
  swept = true;
  const governor = deps.governor ?? sharedResourceGovernor();
  const warn = deps.warn ?? ((line: string) => process.stderr.write(line));
  try {
    const cleanup = await cleanupOrphanBrowsers({ ...(deps.processTable === undefined ? {} : { table: deps.processTable }) });
    const closed = cleanup.orphans.filter((o) => o.result === "terminated" || o.result === "killed");
    if (closed.length > 0) warn(`jevitate: closed ${closed.length} orphaned browser process(es) left by a jevitate that exited: pid ${closed.map((o) => o.pid).join(", ")}\n`);
    governor.slots.clearStale();
  } catch (err) {
    // Housekeeping, not the run's business: reported, and the run goes on.
    warn(`warning: orphan cleanup skipped: ${err instanceof Error ? err.message : String(err)}\n`);
  }
}

/**
 * The pre-run checks; returns the refusal envelope when the run must not start (`E_HOST_STARVED`),
 * else null.
 */
export async function resourcePreflight(o: GovernanceFlags, deps: PreflightDeps = {}): Promise<JsonEnvelope<never> | null> {
  const governor = deps.governor ?? sharedResourceGovernor();
  if (!governor.config.enabled) return null;
  await sweepOnce({ ...deps, governor });
  const decision = await governor.decide();
  if (decision.level !== "starved" || o.ignoreHostLoad === true) return null;
  return fail(
    "E_HOST_STARVED",
    `the host is starved (${decision.reasons.join("; ")}): a browser run now would only time out and read as the app hanging, so it did not start. ` +
      "Wait for the load to drop (see `jevitate doctor`), or pass --ignore-host-load to run anyway (throttled; the result records it)",
  );
}

function rootOf(cmd: Command): Command {
  let c = cmd;
  while (c.parent !== null) c = c.parent;
  return c;
}

/**
 * Installs the pre-run checks on a browser-driving command: its action (registered AFTER this, by
 * the command's own `.action(...)`) runs only when `resourcePreflight` lets it; a refusal is emitted
 * through the shared refusal path and the action never runs.
 */
export function withResourcePreflight(cmd: Command, deps: PreflightDeps = {}): Command {
  const register = cmd.action.bind(cmd);
  cmd.action = (fn: (...args: any[]) => void | Promise<void>): Command =>
    register(async function (this: Command, ...args: any[]): Promise<void> {
      const refusal = await resourcePreflight(this.opts<GovernanceFlags>(), deps);
      if (refusal !== null) {
        emitJsonOrRefusal(rootOf(this), refusal);
        return;
      }
      await fn.apply(this, args);
    });
  return cmd;
}

// ── jevitate doctor ───────────────────────────────────────────────────────────────────────────

export interface DoctorReport {
  readonly host: string;
  readonly governance: {
    readonly enabled: boolean;
    readonly maxBrowsers: number;
    readonly memoryCeilingBytes: number | null;
  };
  readonly load: { readonly level: string; readonly reasons: readonly string[]; readonly loadPerCore: number | null; readonly memAvailableBytes: number | null };
  readonly slots: Array<{ readonly index: number; readonly pid: number | null; readonly host: string | null; readonly acquiredAt: string | null; readonly stale: string | null }>;
  /** Every jevitate-launched browser on this machine; null where the platform has no process reader. */
  readonly browsers: Array<{ readonly pid: number; readonly ownerPid: number; readonly orphan: string | null }> | null;
  readonly cleanup?: {
    readonly orphans: OrphanCleanup["orphans"];
    readonly staleSlotsCleared: number;
  };
}

const slotRow = (s: SlotState): DoctorReport["slots"][number] => ({
  index: s.index,
  pid: s.holder?.pid ?? null,
  host: s.holder?.host ?? null,
  acquiredAt: s.holder?.acquiredAt ?? null,
  stale: s.stale,
});

/** `jevitate doctor`'s report; with `cleanup`, orphaned browsers are closed and stale slots cleared first. */
export async function doctorReport(opts: { readonly cleanup?: boolean } & PreflightDeps = {}): Promise<DoctorReport> {
  const governor = opts.governor ?? sharedResourceGovernor();
  const table = opts.processTable;
  let cleanup: DoctorReport["cleanup"];
  if (opts.cleanup === true) {
    const orphans = await cleanupOrphanBrowsers({ ...(table === undefined ? {} : { table }) });
    const cleared = governor.slots.clearStale();
    cleanup = { orphans: orphans.orphans, staleSlotsCleared: cleared.length };
  }
  const decision = await governor.decide();
  const browsers = jevitateBrowsers(...(table === undefined ? [] : [table]));
  return {
    host: hostname(),
    governance: { enabled: governor.config.enabled, maxBrowsers: governor.config.maxBrowsers, memoryCeilingBytes: governor.config.memoryCeilingBytes },
    load: {
      level: decision.level,
      reasons: decision.reasons,
      loadPerCore: decision.sample.loadPerCore ?? null,
      memAvailableBytes: decision.sample.memAvailableBytes ?? null,
    },
    slots: governor.slots.list().map(slotRow),
    browsers: browsers === undefined ? null : browsers.map((b) => ({ pid: b.pid, ownerPid: b.owner.pid, orphan: b.orphan })),
    ...(cleanup === undefined ? {} : { cleanup }),
  };
}

const mib = (n: number): string => `${Math.round(n / 1024 ** 2)} MiB`;

/** The human `jevitate doctor` text. */
export function formatDoctor(r: DoctorReport): string {
  const lines: string[] = [];
  const g = r.governance;
  lines.push(
    `resource governance: ${g.enabled ? "on" : "off (JEVITATE_RESOURCE_GOVERNANCE=off)"} · max browsers ${g.maxBrowsers} · memory ceiling ${g.memoryCeilingBytes === null ? "off" : mib(g.memoryCeilingBytes)}`,
  );
  const load = [
    r.load.loadPerCore === null ? null : `load ${r.load.loadPerCore.toFixed(2)}/core`,
    r.load.memAvailableBytes === null ? null : `${mib(r.load.memAvailableBytes)} available`,
  ].filter((x) => x !== null);
  lines.push(`host: ${r.load.level}${load.length === 0 ? "" : ` (${load.join(", ")})`}${r.load.reasons.length === 0 ? "" : ` — ${r.load.reasons.join("; ")}`}`);
  lines.push(`machine browser slots held: ${r.slots.length}`);
  for (const s of r.slots) lines.push(`  slot ${s.index}: ${s.pid === null ? "unreadable" : `pid ${s.pid} on ${s.host}`}${s.stale === null ? "" : ` — stale: ${s.stale}`}`);
  if (r.browsers === null) lines.push("jevitate browsers: not listed (no process reader on this platform)");
  else {
    const orphans = r.browsers.filter((b) => b.orphan !== null);
    lines.push(`jevitate browsers: ${r.browsers.length} running, ${orphans.length} orphaned`);
    for (const b of orphans) lines.push(`  pid ${b.pid}: ${b.orphan}`);
  }
  if (r.cleanup !== undefined) {
    const closed = r.cleanup.orphans.filter((o) => o.result === "terminated" || o.result === "killed").length;
    lines.push(`cleanup: closed ${closed} orphaned browser(s), cleared ${r.cleanup.staleSlotsCleared} stale slot(s)`);
  } else if (r.browsers?.some((b) => b.orphan !== null) === true || r.slots.some((s) => s.stale !== null)) {
    lines.push("next: jevitate doctor --cleanup");
  }
  return `${lines.join("\n")}\n`;
}

/** Registers `jevitate doctor [--cleanup] [--json]`. */
export function registerDoctorCommand(program: Command, deps: PreflightDeps = {}): void {
  program
    .command("doctor")
    .description("resource governance on this machine (#205): host load, machine-wide browser slots, jevitate browsers and orphans left by a killed run")
    .option("--cleanup", "close orphaned jevitate browsers (only processes jevitate launched, whose jevitate exited) and clear stale browser slots")
    .option("--json", "emit a JSON envelope")
    .action(async function (this: Command) {
      const o = this.opts<{ cleanup?: boolean; json?: boolean }>();
      try {
        const report = await doctorReport({ ...deps, ...(o.cleanup === true ? { cleanup: true } : {}) });
        const pinnedBrowser = pinnedBrowserReport();
        if (o.json === true) emitJsonOrRefusal(program, ok({ ...report, pinnedBrowser }));
        else program.configureOutput().writeOut?.(`${formatDoctor(report)}${formatPinnedBrowser(pinnedBrowser)}`);
      } catch (err) {
        emitJsonOrRefusal(program, fail("E_DOCTOR", err instanceof Error ? err.message : String(err)));
      }
    });
}
