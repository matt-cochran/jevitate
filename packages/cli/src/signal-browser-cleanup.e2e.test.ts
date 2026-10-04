import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { startServer } from "@jevitate/example-site";

/**
 * #326 acceptance: a signal sent to the CLI's pid ONLY (Node `spawnSync(..., { timeout })`, `kill
 * <pid>`) — or the death of its parent — ends the run with no Chromium left behind. Spawns the BUILT
 * CLI (`dist/bin.js explore --fake-ai`) against a locally served page, waits for its browser (the
 * process whose command line carries `--jevitate-owner=<cli pid>@…`), signals, then watches that
 * browser's whole process group (Playwright launches Chromium as the leader of its own group) drain.
 *
 * Linux only: it reads `/proc` directly, exactly as the orphan sweep does (browser-processes.ts).
 */

const BIN = join(dirname(fileURLToPath(import.meta.url)), "..", "dist", "bin.js");
const linux = process.platform === "linux";

interface Proc {
  readonly pid: number;
  readonly pgid: number;
  readonly cmd: string;
}

/** Every process on the machine: pid, process group, command line (NULs joined by spaces). */
function processes(): Proc[] {
  const out: Proc[] = [];
  for (const name of readdirSync("/proc")) {
    if (!/^\d+$/.test(name)) continue;
    try {
      const stat = readFileSync(`/proc/${name}/stat`, "utf8");
      const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      if (fields[0] === "Z") continue; // a zombie is already dead, only not yet reaped
      const cmd = readFileSync(`/proc/${name}/cmdline`, "utf8").replaceAll("\0", " ");
      out.push({ pid: Number(name), pgid: Number(fields[2]), cmd });
    } catch {
      // exited while listing
    }
  }
  return out;
}

/** The browsers `ownerPid` launched (Chromium rewrites its argv into one space-joined string). */
function ownedBrowsers(ownerPid: number): Proc[] {
  const tag = ` --jevitate-owner=${ownerPid}@`;
  return processes().filter((p) => ` ${p.cmd}`.includes(tag));
}

/** What is left of `ownerPid`'s browsers: anything still tagged, or still in one of their groups. */
function leftovers(ownerPid: number, groups: ReadonlySet<number>): Proc[] {
  const tag = ` --jevitate-owner=${ownerPid}@`;
  return processes().filter((p) => groups.has(p.pgid) || ` ${p.cmd}`.includes(tag));
}

async function waitUntil<T>(probe: () => T | undefined, ms: number, what: string): Promise<T> {
  const until = Date.now() + ms;
  for (;;) {
    const v = probe();
    if (v !== undefined) return v;
    if (Date.now() > until) throw new Error(`timed out after ${ms} ms waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

let site: { url: string; close(): Promise<void> };
const cleanup: Array<() => void> = [];
const dirs: string[] = [];

beforeAll(async () => {
  if (linux) site = await startServer();
});
afterAll(async () => {
  if (linux) await site.close();
});
afterEach(async () => {
  // Never leak a browser from a failed assertion: SIGKILL whatever the test recorded.
  for (const fn of cleanup.splice(0)) fn();
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

function exploreArgs(outDir: string): string[] {
  return [BIN, "explore", "--strategy", "goal", "--url", `${site.url}/login`, "--goal", "sign in", "--success", "urlIncludes:/never", "--fake-ai", "--out", outDir, "--json"];
}

/** Waits for `cliPid`'s browser, returns its process groups, and registers a SIGKILL safety net. */
async function browserGroupsOf(cliPid: number, cli?: ChildProcess): Promise<Set<number>> {
  const browsers = await waitUntil(
    () => {
      if (cli !== undefined && (cli.exitCode !== null || cli.signalCode !== null)) throw new Error(`the CLI exited (${cli.exitCode ?? cli.signalCode}) before its browser opened`);
      const b = ownedBrowsers(cliPid);
      return b.length > 0 ? b : undefined;
    },
    30_000,
    "the CLI's browser",
  );
  const groups = new Set(browsers.map((b) => b.pgid));
  cleanup.push(() => {
    for (const p of leftovers(cliPid, groups)) {
      try {
        process.kill(p.pid, "SIGKILL");
      } catch {
        // gone
      }
    }
  });
  return groups;
}

describe.runIf(linux)("[realtime] a signal to the CLI pid only leaves no Chromium behind (#326)", () => {
  for (const [signal, code] of [
    ["SIGTERM", 143],
    ["SIGHUP", 129],
  ] as const) {
    it(
      `${signal}: exits ${code}, writes the partial result, and every process of its browser is gone within a few seconds`,
      async () => {
        const outDir = await mkdtemp(join(tmpdir(), "jevitate-326-"));
        dirs.push(outDir);
        const cli = spawn(process.execPath, exploreArgs(outDir), { stdio: ["ignore", "pipe", "pipe"] });
        cli.stdout.resume();
        cli.stderr.resume();
        const exited = new Promise<number | null>((resolve) => cli.once("exit", (c) => resolve(c)));
        const groups = await browserGroupsOf(cli.pid!, cli);

        process.kill(cli.pid!, signal); // the pid only — never its group
        expect(await exited).toBe(code);

        const left = await waitUntil(() => (leftovers(cli.pid!, groups).length === 0 ? [] : undefined), 5_000, "the browser to be gone").catch(() =>
          leftovers(cli.pid!, groups),
        );
        expect(left.map((p) => `${p.pid} ${p.cmd.slice(0, 120)}`)).toEqual([]);
        // #94's partial result still lands.
        expect((await readdir(outDir)).some((f) => f.endsWith(".result.json"))).toBe(true);
      },
      60_000,
    );
  }

  it(
    "the parent dies (SIGKILLed wrapper): the CLI notices, writes its partial result, and closes its browser",
    async () => {
      const outDir = await mkdtemp(join(tmpdir(), "jevitate-326-parent-"));
      dirs.push(outDir);
      // A wrapper that starts the CLI and reports its pid — then is SIGKILLed, forwarding nothing.
      const wrapper = spawn(
        process.execPath,
        [
          "-e",
          `const c = require("node:child_process").spawn(process.execPath, JSON.parse(process.argv[1]), { stdio: "ignore" }); console.log(c.pid); setInterval(() => {}, 1000);`,
          JSON.stringify(exploreArgs(outDir)),
        ],
        { stdio: ["ignore", "pipe", "inherit"] },
      );
      cleanup.push(() => wrapper.kill("SIGKILL"));
      let out = "";
      wrapper.stdout.on("data", (d: Buffer) => (out += d.toString("utf8")));
      const cliPid = await waitUntil(() => (/^\d+\n/.test(out) ? Number(out.trim()) : undefined), 10_000, "the CLI's pid");
      cleanup.push(() => {
        try {
          process.kill(cliPid, "SIGKILL");
        } catch {
          // gone
        }
      });
      const groups = await browserGroupsOf(cliPid);

      wrapper.kill("SIGKILL");
      // The watchdog polls once a second; the teardown itself is bounded (~1 s grace, then SIGKILL).
      const alive = (): boolean => processes().some((p) => p.pid === cliPid);
      await waitUntil(() => (alive() ? undefined : true), 8_000, "the CLI to exit");
      const left = await waitUntil(() => (leftovers(cliPid, groups).length === 0 ? [] : undefined), 5_000, "the browser to be gone").catch(() =>
        leftovers(cliPid, groups),
      );
      expect(left.map((p) => `${p.pid} ${p.cmd.slice(0, 120)}`)).toEqual([]);
      const results = (await readdir(outDir)).filter((f) => f.endsWith(".result.json"));
      expect(results).toHaveLength(1);
      const parsed = JSON.parse(readFileSync(join(outDir, results[0]!), "utf8"));
      expect(parsed.result.signal).toBe("SIGHUP");
      expect(parsed.exitCode).toBe(129);
    },
    60_000,
  );
});
