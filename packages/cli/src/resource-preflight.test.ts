import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";
import { MachineBrowserSlots, ResourceGovernor, type HostLoadSample, type ProcessTable } from "@jevitate/playwright";
import { doctorReport, formatDoctor, resetPreflightSweep, resourceLimitsFromFlags, resourcePreflight, withResourcePreflight } from "./resource-preflight.js";
import { browserLaunchFromFlags } from "./cli-shared.js";
import { trackActionCommand } from "./cli-refusal.js";

/** #205: the CLI side — flags → limits, the starved-host refusal, the startup sweep, `jevitate doctor`. */

const GiB = 1024 ** 3;
let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "jev-preflight-"));
  resetPreflightSweep();
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  process.exitCode = undefined;
});

/** An empty process table: the sweep looks at (and can signal) nothing. */
const NO_PROCESSES: ProcessTable = { list: () => [], startOf: () => "0", memoryOf: () => undefined };

const governor = (host: HostLoadSample, enabled = true): ResourceGovernor =>
  new ResourceGovernor({
    config: { enabled, maxBrowsers: 4, memoryCeilingBytes: 4 * GiB },
    slots: new MachineBrowserSlots({ dir }),
    sampleHost: async () => host,
    measureMemory: () => undefined,
  });

describe("flags → limits", () => {
  it("--max-browsers / --max-browser-memory (MiB) become the run's ResourceLimits", () => {
    expect(resourceLimitsFromFlags({})).toBeUndefined();
    expect(resourceLimitsFromFlags({ maxBrowsers: 2, maxBrowserMemory: 1024 })).toEqual({ maxBrowsers: 2, memoryCeilingBytes: GiB });
    expect(browserLaunchFromFlags({ browserArg: [], maxBrowserMemory: 512 })).toEqual({ resources: { memoryCeilingBytes: 512 * 1024 ** 2 } });
    expect(browserLaunchFromFlags({ browserArg: [] })).toBeUndefined();
  });
});

describe("the starved-host refusal", () => {
  it("refuses to start on a starved host with E_HOST_STARVED and the reasons", async () => {
    const r = await resourcePreflight({}, { governor: governor({ loadPerCore: 5, memAvailableBytes: 8 * GiB }), processTable: NO_PROCESSES });
    expect(r).toMatchObject({ ok: false, error: { code: "E_HOST_STARVED" } });
    expect(r!.error!.message).toMatch(/^the host is starved \(load 5\/core >= 4\)/);
    expect(r!.error!.message).toMatch(/--ignore-host-load/);
  });

  it("--ignore-host-load runs anyway; a merely throttled host runs; governance off never refuses", async () => {
    expect(await resourcePreflight({ ignoreHostLoad: true }, { governor: governor({ loadPerCore: 5 }), processTable: NO_PROCESSES })).toBeNull();
    expect(await resourcePreflight({}, { governor: governor({ loadPerCore: 2.5 }), processTable: NO_PROCESSES })).toBeNull();
    expect(await resourcePreflight({}, { governor: governor({ loadPerCore: 50 }, false), processTable: NO_PROCESSES })).toBeNull();
  });

  it("the wrapped action never runs when refused; the refusal goes through the shared path (exit 2)", async () => {
    const out: string[] = [];
    let ran = false;
    const program = new Command().exitOverride().configureOutput({ writeOut: (s) => out.push(s), writeErr: () => undefined });
    trackActionCommand(program);
    const g = governor({ memAvailableBytes: 100 * 1024 ** 2 });
    withResourcePreflight(program.command("go").option("--json").option("--ignore-host-load"), { governor: g, processTable: NO_PROCESSES }).action(() => {
      ran = true;
    });
    await program.parseAsync(["go", "--json"], { from: "user" });
    expect(ran).toBe(false);
    expect(JSON.parse(out.join(""))).toMatchObject({ ok: false, error: { code: "E_HOST_STARVED" } });
    expect(process.exitCode).toBe(2);
    process.exitCode = undefined;
    await program.parseAsync(["go", "--ignore-host-load"], { from: "user" });
    expect(ran).toBe(true);
  });
});

describe("the startup sweep", () => {
  it("clears stale machine slots once per process (and only stale ones)", async () => {
    const slots = new MachineBrowserSlots({ dir, host: "h" });
    const { writeFileSync } = await import("node:fs");
    writeFileSync(join(dir, "slot-0.json"), JSON.stringify({ pid: 2 ** 22 + 7, host: "h", token: "dead", acquiredAt: "x" }));
    writeFileSync(join(dir, "slot-1.json"), JSON.stringify({ pid: process.pid, host: "h", token: "live", acquiredAt: "x" }));
    const g = new ResourceGovernor({ config: { enabled: true, maxBrowsers: 4, memoryCeilingBytes: null }, slots, sampleHost: async () => ({}), measureMemory: () => undefined });
    expect(await resourcePreflight({}, { governor: g, processTable: NO_PROCESSES })).toBeNull();
    expect(slots.list().map((s) => s.index)).toEqual([1]);
  });
});

describe("jevitate doctor", () => {
  it("reports governance, the host, the slots and the jevitate browsers; suggests --cleanup for stale state", async () => {
    const { writeFileSync } = await import("node:fs");
    writeFileSync(join(dir, "slot-0.json"), JSON.stringify({ pid: 2 ** 22 + 9, host: "h", token: "dead", acquiredAt: "x" }));
    const slots = new MachineBrowserSlots({ dir, host: "h" });
    const g = new ResourceGovernor({ config: { enabled: true, maxBrowsers: 3, memoryCeilingBytes: 2 * GiB }, slots, sampleHost: async () => ({ loadPerCore: 2.5, memAvailableBytes: 6 * GiB }), measureMemory: () => undefined });
    const report = await doctorReport({ governor: g, processTable: NO_PROCESSES });
    expect(report).toMatchObject({
      governance: { enabled: true, maxBrowsers: 3, memoryCeilingBytes: 2 * GiB },
      load: { level: "throttled", reasons: ["load 2.50/core > 2"], loadPerCore: 2.5 },
      slots: [{ index: 0, pid: 2 ** 22 + 9, stale: expect.stringMatching(/is not running/) }],
      browsers: [],
    });
    const text = formatDoctor(report);
    expect(text).toMatch(/^resource governance: on · max browsers 3 · memory ceiling 2048 MiB$/m);
    expect(text).toMatch(/^host: throttled \(load 2\.50\/core, 6144 MiB available\) — load 2\.50\/core > 2$/m);
    expect(text).toMatch(/^next: jevitate doctor --cleanup$/m);

    const cleaned = await doctorReport({ governor: g, processTable: NO_PROCESSES, cleanup: true });
    expect(cleaned.cleanup).toEqual({ orphans: [], staleSlotsCleared: 1 });
    expect(cleaned.slots).toEqual([]);
    expect(formatDoctor(cleaned)).toMatch(/cleanup: closed 0 orphaned browser\(s\), cleared 1 stale slot\(s\)/);
  });
});
