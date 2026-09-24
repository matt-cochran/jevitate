import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { startServer } from "@jevitate/example-site";

/**
 * #94 acceptance: a run killed by SIGTERM still writes a partial typed result (`inconclusive`),
 * the same way a `crashed`/`exhausted` stop does — instead of leaving nothing on disk to audit.
 *
 * Spawns a REAL child process (`kill-signal-harness.mjs`, built dist, real Playwright browser,
 * real served fixture) and sends it a real OS signal — this is the only way to exercise the
 * process-level SIGTERM/SIGINT handler installed by `armMissionKillSwitch` (kill-signal.ts); a
 * signal sent to the vitest process itself would kill the test run, not the mission.
 */

const HARNESS = join(dirname(fileURLToPath(import.meta.url)), "kill-signal-harness.mjs");

let site: { url: string; close(): Promise<void> };
beforeAll(async () => {
  site = await startServer();
});
afterAll(async () => {
  await site.close();
});

/** Spawns the harness, waits for it to announce the browser is open, sends `signal`, and returns
 *  the exit info plus the outDir it wrote into. */
async function runAndSignal(signal: "SIGTERM" | "SIGINT", judgeDelayMs = 8000) {
  const outDir = await mkdtemp(join(tmpdir(), "jevitate-kill-signal-"));
  const child = spawn(process.execPath, [HARNESS, `${site.url}/login`, outDir, String(judgeDelayMs)], {
    stdio: ["ignore", "pipe", "pipe"],
  });

  let stderr = "";
  child.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString("utf8");
  });

  const browserOpen = new Promise<void>((resolve, reject) => {
    let buf = "";
    const onData = (chunk: Buffer) => {
      buf += chunk.toString("utf8");
      if (buf.includes("BROWSER_OPEN")) {
        child.stdout.off("data", onData);
        resolve();
      }
    };
    child.stdout.on("data", onData);
    child.once("exit", (code) => reject(new Error(`harness exited (${code}) before opening a browser: ${stderr}`)));
  });
  await browserOpen;

  const exited = new Promise<{ code: number | null; signalReceived: NodeJS.Signals | null }>((resolve) => {
    child.once("exit", (code, signalReceived) => resolve({ code, signalReceived }));
  });
  child.kill(signal);
  const { code } = await exited;
  return { code, stderr, outDir };
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
