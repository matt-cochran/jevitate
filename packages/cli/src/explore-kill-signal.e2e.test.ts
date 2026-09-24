import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { startServer } from "@jevitate/example-site";
import { currentEngineInfo } from "./engine.js";

/**
 * #94 acceptance: a run killed by SIGTERM still writes a partial typed result (`inconclusive`),
 * the same way a `crashed`/`exhausted` stop does — instead of leaving nothing on disk to audit.
 * #120: that result describes the run — its real step count and transcript, the transcript file
 * that actually exists (a usability run keys it off its report), `engine`, the usage spent so far —
 * and a `--json` envelope is printed to stdout before the process exits.
 *
 * Spawns a REAL child process (`kill-signal-harness.mjs`, built dist, real Playwright browser,
 * real served fixture) and sends it a real OS signal — this is the only way to exercise the
 * process-level SIGTERM/SIGINT handler installed by `armMissionKillSwitch` (kill-signal.ts); a
 * signal sent to the vitest process itself would kill the test run, not the mission.
 */

const HARNESS = join(dirname(fileURLToPath(import.meta.url)), "kill-signal-harness.mjs");

/** The identity the BUILT harness reports: this build's version and commit. Its `builtAt` is the
 *  dist's own (a concurrent `build` may regenerate the source-side stamp), so only its shape is fixed. */
function builtEngine() {
  const { version, commit } = currentEngineInfo();
  return { version, commit, builtAt: expect.any(String) };
}

let site: { url: string; close(): Promise<void> };
beforeAll(async () => {
  site = await startServer();
});
afterAll(async () => {
  await site.close();
});

/** Spawns the harness, waits until it is ready to be killed — the browser is open (no fast steps)
 *  or the first slow judge call began (every fast step taken and flushed) — sends `signal`, and
 *  returns the exit info, everything it printed, and the outDir it wrote into. */
async function runAndSignal(
  signal: "SIGTERM" | "SIGINT",
  opts: { judgeDelayMs?: number; mode?: "explore" | "usability"; fastCalls?: number } = {},
) {
  const { judgeDelayMs = 8000, mode = "explore", fastCalls = 0 } = opts;
  const outDir = await mkdtemp(join(tmpdir(), "jevitate-kill-signal-"));
  const child = spawn(
    process.execPath,
    [HARNESS, `${site.url}/login`, outDir, String(judgeDelayMs), mode, String(fastCalls)],
    { stdio: ["ignore", "pipe", "pipe"] },
  );

  let stderr = "";
  child.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString("utf8");
  });
  let stdout = "";
  child.stdout.on("data", (chunk: Buffer) => {
    stdout += chunk.toString("utf8");
  });

  const marker = fastCalls > 0 ? "JUDGE_SLOW" : "BROWSER_OPEN";
  const ready = new Promise<void>((resolve, reject) => {
    const onData = () => {
      if (stdout.includes(marker)) {
        child.stdout.off("data", onData);
        resolve();
      }
    };
    child.stdout.on("data", onData);
    child.once("exit", (code) => reject(new Error(`harness exited (${code}) before ${marker}: ${stderr}`)));
  });
  await ready;

  const exited = new Promise<{ code: number | null; signalReceived: NodeJS.Signals | null }>((resolve) => {
    child.once("exit", (code, signalReceived) => resolve({ code, signalReceived }));
  });
  child.kill(signal);
  const { code } = await exited;
  // The `--json` envelope the kill switch printed (#120): the one stdout line that parses as one.
  const envelope = stdout
    .split("\n")
    .filter((l) => l.startsWith("{"))
    .map((l) => JSON.parse(l) as Record<string, unknown>)
    .find((o) => o.v === 1);
  return { code, stderr, stdout, envelope, outDir };
}

describe("explore — SIGTERM/SIGINT mid-run still writes a partial result (#94)", () => {
  it(
    "SIGTERM: writes <recording>.result.json with missionOutcome inconclusive and exits 143",
    async () => {
      const { code, outDir } = await runAndSignal("SIGTERM");
      expect(code).toBe(143);

      const files = await readdir(outDir);
      const resultFile = files.find((f) => f.endsWith(".result.json"));
      expect(resultFile).toBeDefined();
      const parsed = JSON.parse(await readFile(join(outDir, resultFile!), "utf8"));
      expect(parsed.missionOutcome).toBe("inconclusive");
      expect(parsed.exitCode).toBe(143);
      expect(parsed.result.outcome).toBe("inconclusive");
      expect(parsed.result.stop).toBe("terminated");
      expect(parsed.result.signal).toBe("SIGTERM");
      expect(parsed.result.reason).toMatch(/^interrupted by SIGTERM after \d+ steps?$/);
      expect(Array.isArray(parsed.result.transcript)).toBe(true);

      await rm(outDir, { recursive: true, force: true });
    },
    60_000,
  );

  it(
    "SIGINT: writes an inconclusive result too and exits 130",
    async () => {
      const { code, outDir } = await runAndSignal("SIGINT");
      expect(code).toBe(130);

      const files = await readdir(outDir);
      const resultFile = files.find((f) => f.endsWith(".result.json"));
      expect(resultFile).toBeDefined();
      const parsed = JSON.parse(await readFile(join(outDir, resultFile!), "utf8"));
      expect(parsed.missionOutcome).toBe("inconclusive");
      expect(parsed.exitCode).toBe(130);
      expect(parsed.result.signal).toBe("SIGINT");

      await rm(outDir, { recursive: true, force: true });
    },
    60_000,
  );
});

describe("a killed run's result describes the run it killed (#120, #112)", () => {
  it(
    "goal: the real step count and transcript, engine, usage so far — and the --json envelope on stdout",
    async () => {
      const { code, outDir, envelope } = await runAndSignal("SIGTERM", { fastCalls: 2 });
      expect(code).toBe(143);

      const files = await readdir(outDir);
      const resultFile = files.find((f) => f.endsWith(".result.json"))!;
      const { result } = JSON.parse(await readFile(join(outDir, resultFile), "utf8"));
      expect(result.steps).toBe(2);
      expect(result.reason).toBe("interrupted by SIGTERM after 2 steps");
      expect(result.transcript).toHaveLength(2);
      // The flushed transcript file is the one the result names, and holds the same steps.
      expect(existsSync(result.transcriptPath)).toBe(true);
      expect(JSON.parse(await readFile(result.transcriptPath, "utf8"))).toHaveLength(2);
      expect(result.engine).toEqual(builtEngine());
      // 3 judge calls: 2 answered, the 3rd still pending when the signal landed — all counted.
      expect(result.usage).toMatchObject({ judgments: 3, inputTokens: 300, outputTokens: 30 });

      expect(envelope).toMatchObject({ v: 1, ok: true, data: { outcome: "inconclusive", steps: 2, engine: result.engine } });

      await rm(outDir, { recursive: true, force: true });
    },
    90_000,
  );

  it(
    "usability: names the transcript that exists (keyed off the report, not the Recording) and counts its steps",
    async () => {
      const { code, outDir, envelope } = await runAndSignal("SIGTERM", { mode: "usability", fastCalls: 2 });
      expect(code).toBe(143);

      const files = await readdir(outDir);
      const resultFile = files.find((f) => f.endsWith(".result.json"))!;
      expect(resultFile).toMatch(/^usability-.+\.recording\.result\.json$/);
      const { result } = JSON.parse(await readFile(join(outDir, resultFile), "utf8"));
      expect(result.transcriptPath).toMatch(/usability-[^/]+Z\.transcript\.json$/);
      expect(result.transcriptPath).not.toMatch(/\.recording\.transcript\.json$/);
      expect(existsSync(result.transcriptPath)).toBe(true);
      expect(result.steps).toBe(2);
      expect(result.transcript).toHaveLength(2);
      expect(result.engine).toEqual(builtEngine());
      expect(result.usage).toMatchObject({ judgments: 3 });
      expect(result.partialReport).toMatchObject({ screensObserved: expect.any(Number) });
      expect(envelope).toMatchObject({ v: 1, ok: true, data: { steps: 2, transcriptPath: result.transcriptPath } });

      await rm(outDir, { recursive: true, force: true });
    },
    90_000,
  );
});
