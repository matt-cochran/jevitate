import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { MissionResultSchema } from "@jevitate/domain";

/**
 * #220 end to end, through the BUILT CLI in a child process (a real OS signal and real Chromium
 * processes are the only way to exercise this): a page process that dies or freezes mid-run, a
 * browser killed in run 2 of `--repeat 2`, and SIGINT/SIGTERM during a run. Every run must end —
 * bounded, typed (`crashed`/`inconclusive` with a reason, never `intermittent`) — and a signal must
 * exit 130/143 printing the partial summary.
 *
 * The served page holds one request open (`/hold`) in the session under test: that request is the
 * "the run is on the page now" marker the test waits for before killing/freezing processes. Only
 * DESCENDANTS of the spawned CLI are ever signalled (other suites' browsers are never touched).
 */

const here = dirname(fileURLToPath(import.meta.url));
const BIN = join(here, "..", "dist", "bin.js");
const ALIAS = join(here, "..", "..", "jevitate-cli-alias", "bin", "jevitate.js");
/** How long a frozen page may go unanswered before the liveness watchdog closes it (short, for the test). */
const UNRESPONSIVE_MS = 4_000;

let server: Server;
let origin: string;
let sessions = 0;
/** Session number whose page holds `/hold` open → resolver told when it arrives. */
const holdWaiters = new Map<number, () => void>();

beforeAll(async () => {
  server = createServer((req, res) => {
    const sid = /(?:^|;\s*)sid=(\d+)/.exec(req.headers.cookie ?? "")?.[1];
    const headers: Record<string, string> = { "content-type": "text/html" };
    let n = sid === undefined ? NaN : Number(sid);
    if (sid === undefined) {
      n = ++sessions;
      headers["set-cookie"] = `sid=${n}; Path=/`;
    }
    const path = (req.url ?? "/").split("?")[0];
    if (path === "/hold") {
      holdWaiters.get(n)?.();
      return; // never answered: the run stays on this page
    }
    const hold = holdWaiters.has(n) ? `<script>fetch("/hold")</script>` : "";
    res.writeHead(200, headers).end(`<!doctype html><html><body><h1>Welcome</h1><button type="button">Go</button>${hold}</body></html>`);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

/** Every live descendant of `pid` (Linux `ps`). */
function descendants(pid: number): Array<{ pid: number; args: string }> {
  const rows = execFileSync("ps", ["-eo", "pid=,ppid=,args="], { encoding: "utf8" })
    .trim()
    .split("\n")
    .map((l) => /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(l))
    .filter((m): m is RegExpExecArray => m !== null)
    .map((m) => ({ pid: Number(m[1]), ppid: Number(m[2]), args: m[3]! }));
  const out: Array<{ pid: number; args: string }> = [];
  const queue = [pid];
  while (queue.length > 0) {
    const p = queue.shift()!;
    for (const r of rows) {
      if (r.ppid === p) {
        out.push(r);
        queue.push(r.pid);
      }
    }
  }
  return out;
}

const renderers = (pid: number): number[] => descendants(pid).filter((p) => p.args.includes("--type=renderer")).map((p) => p.pid);
const browserMain = (pid: number): number[] =>
  descendants(pid)
    .filter((p) => /chrom/i.test(p.args) && !p.args.includes("--type="))
    .map((p) => p.pid);

/** Processes this file SIGSTOPped: always SIGKILLed afterwards, so nothing frozen outlives a test. */
const frozen: number[] = [];
const children: ChildProcess[] = [];
afterEach(() => {
  for (const pid of frozen.splice(0)) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // already gone
    }
  }
  for (const c of children.splice(0)) if (c.exitCode === null && c.signalCode === null) c.kill("SIGKILL");
});

function signalAll(pids: readonly number[], signal: NodeJS.Signals): void {
  for (const pid of pids) {
    try {
      process.kill(pid, signal);
      if (signal === "SIGSTOP") frozen.push(pid);
    } catch {
      // raced with its own exit
    }
  }
}

interface Spawned {
  readonly child: ChildProcess;
  readonly out: string;
  stdout(): string;
  stderr(): string;
  /** Resolves with the exit, or rejects if the process is still running after `withinMs` (then it is killed). */
  exited(withinMs: number): Promise<{ code: number | null; signal: NodeJS.Signals | null; afterMs: number }>;
}

async function spawnExplore(extra: string[], opts: { viaAlias?: boolean } = {}): Promise<Spawned> {
  const out = await mkdtemp(join(tmpdir(), "jev-liveness-"));
  const args = ["explore", "--url", `${origin}/`, "--goal", "read the heading", "--fake-ai", "--max-actions", "4", "--out", out, ...extra];
  const child = spawn(process.execPath, [opts.viaAlias === true ? ALIAS : BIN, ...args], {
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, JEVITATE_PAGE_UNRESPONSIVE_MS: String(UNRESPONSIVE_MS) },
  });
  children.push(child);
  let stdout = "";
  let stderr = "";
  child.stdout!.on("data", (d: Buffer) => (stdout += d.toString("utf8")));
  child.stderr!.on("data", (d: Buffer) => (stderr += d.toString("utf8")));
  const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
  return {
    child,
    out,
    stdout: () => stdout,
    stderr: () => stderr,
    exited: async (withinMs) => {
      const t0 = Date.now();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const late = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          child.kill("SIGKILL");
          reject(new Error(`the run was still going ${withinMs}ms later (hung). stdout: ${stdout.slice(-800)} stderr: ${stderr.slice(-800)}`));
        }, withinMs);
      });
      try {
        const r = await Promise.race([exit, late]);
        return { ...r, afterMs: Date.now() - t0 };
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

/** Holds `/hold` open for the `n`-th browser session from now; resolves once that page asked for it. */
function onPageOfSession(offset: number): Promise<void> {
  const n = sessions + offset;
  return new Promise<void>((resolve) => {
    holdWaiters.set(n, () => {
      holdWaiters.delete(n);
      resolve();
    });
  });
}

const settleMs = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe.skipIf(process.platform !== "linux")("#220 — a lost page/browser ends the run, bounded and typed; signals stop it cleanly", () => {
  it(
    // #296: the watchdog closing a frozen renderer is the APP's page not answering, not an engine
    // failure — `inconclusive` (exit 2, the same code) with the stalled liveness reason, never crashed.
    "a page process that FREEZES mid-run (alive, never answering) ends the run inconclusive with the liveness reason — no hang, no crash",
    async () => {
      const onPage = onPageOfSession(1);
      const run = await spawnExplore([]);
      try {
        await onPage;
        await settleMs(500);
        signalAll(renderers(run.child.pid!), "SIGSTOP");
        const { code, afterMs } = await run.exited(60_000);
        expect(code).toBe(2);
        expect(afterMs).toBeLessThan(60_000);
        expect(run.stdout()).toMatch(/^INCONCLUSIVE:/m);
        expect(run.stdout()).toMatch(/stalled: the page process stopped responding/);
      } finally {
        await rm(run.out, { recursive: true, force: true });
      }
    },
    120_000,
  );

  it(
    "a page process KILLED mid-run ends the run crashed promptly (page-crash)",
    async () => {
      const onPage = onPageOfSession(1);
      const run = await spawnExplore([]);
      try {
        await onPage;
        await settleMs(500);
        signalAll(renderers(run.child.pid!), "SIGKILL");
        const { code } = await run.exited(60_000);
        expect(code).toBe(2);
        expect(run.stdout()).toMatch(/^CRASHED:/m);
        expect(run.stdout()).toMatch(/page-crash/);
      } finally {
        await rm(run.out, { recursive: true, force: true });
      }
    },
    120_000,
  );

  it(
    "--repeat 2 with run 2's browser killed finishes with a typed result: inconclusive with the reason, never intermittent",
    async () => {
      const onRun2 = onPageOfSession(2);
      const run = await spawnExplore(["--repeat", "2", "--json"]);
      try {
        await onRun2;
        await settleMs(500);
        signalAll(browserMain(run.child.pid!), "SIGKILL");
        const { code } = await run.exited(90_000);
        const env = JSON.parse(run.stdout().trim().split("\n").at(-1)!) as { ok: boolean; data: Record<string, unknown> };
        expect(env.ok).toBe(true);
        expect(env.data).toMatchObject({ kind: "multi-run", complete: true, outcome: "inconclusive", exitCode: 2 });
        expect(String(env.data.reason)).toMatch(/run 2 crashed/);
        expect(code).toBe(2);
      } finally {
        await rm(run.out, { recursive: true, force: true });
      }
    },
    180_000,
  );

  it(
    "SIGINT during --repeat: exits 130, prints the multi-run's partial summary, and leaves a typed partial on disk",
    async () => {
      const onRun2 = onPageOfSession(2);
      const run = await spawnExplore(["--repeat", "2"]);
      try {
        await onRun2;
        await settleMs(500);
        run.child.kill("SIGINT");
        const { code } = await run.exited(30_000);
        expect(code).toBe(130);
        // The command's own (human) output rule — the multi-run summary, not run 2's JSON envelope.
        expect(run.stdout()).toMatch(/^INCONCLUSIVE: goal ×2/m);
        expect(run.stdout()).toMatch(/interrupted by SIGINT during run 2; 1 of 2 run\(s\) finished/);
        expect(run.stdout()).not.toMatch(/^\{"v":1/m);
        const aggregate = JSON.parse(await readFile(join(run.out, "multi-run.result.json"), "utf8")) as Record<string, unknown>;
        expect(aggregate).toMatchObject({ complete: false, outcome: "inconclusive", exitCode: 130, interrupted: { signal: "SIGINT" } });
        const cells = aggregate.cells as Array<{ runs: Array<{ outcome: string }> }>;
        expect(cells[0]!.runs.map((r) => r.outcome)).toHaveLength(2);
        expect(cells[0]!.runs[1]!.outcome).toBe("inconclusive");
        // Run 2's own partial result is a unified result (strategy, canonical missionOutcome).
        const run2 = join(run.out, "run-2");
        const resultFile = (await readdir(run2)).find((f) => f.endsWith(".result.json"));
        expect(resultFile).toBeDefined();
        const persisted = JSON.parse(await readFile(join(run2, resultFile!), "utf8")) as { result: unknown };
        expect(MissionResultSchema.parse(persisted.result)).toMatchObject({ strategy: "goal", missionOutcome: "inconclusive", exitCode: 130 });
      } finally {
        await rm(run.out, { recursive: true, force: true });
      }
    },
    120_000,
  );

  it(
    "SIGTERM sent to the bare `jevitate` alias reaches the CLI: exits 143 with the partial result printed",
    async () => {
      const onPage = onPageOfSession(1);
      const run = await spawnExplore(["--json"], { viaAlias: true });
      try {
        await onPage;
        await settleMs(500);
        run.child.kill("SIGTERM");
        const { code, signal } = await run.exited(30_000);
        expect({ code, signal }).toEqual({ code: 143, signal: null });
        const env = JSON.parse(run.stdout().trim().split("\n").at(-1)!) as { ok: boolean; data: Record<string, unknown> };
        expect(env.data).toMatchObject({ missionOutcome: "inconclusive", strategy: "goal", signal: "SIGTERM", exitCode: 143 });
        expect(MissionResultSchema.safeParse(env.data).success).toBe(true);
      } finally {
        await rm(run.out, { recursive: true, force: true });
      }
    },
    120_000,
  );
});
