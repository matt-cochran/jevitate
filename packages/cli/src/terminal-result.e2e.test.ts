import { spawn } from "node:child_process";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";

/**
 * The terminal layer against the real process: real signals, a really dead parent, a real timer and
 * the real artifact write. `terminal-result-harness.mjs` runs the built dist, so this needs a build
 * (`pnpm -r build`) first. Everything here exists only in real time, so it stays on the real clock.
 */

const HARNESS = join(dirname(fileURLToPath(import.meta.url)), "terminal-result-harness.mjs");
const SECRET = "harness-secret-value";
const ENV = { ...process.env, HARNESS_SECRET: SECRET };
delete ENV["JEVITATE_PARENT_WATCHDOG"];

interface Ended {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly artifact: () => Promise<Record<string, unknown>>;
  readonly envelope: () => { ok: boolean; error: { code: string; message: string }; data: Record<string, unknown> };
}

function collected(outDir: string, stdout: string, stderr: string, code: number | null): Ended {
  return {
    code,
    stdout,
    stderr,
    artifact: async () => JSON.parse(await readFile(join(outDir, "harness-1.result.json"), "utf8")) as Record<string, unknown>,
    envelope: () => JSON.parse(stdout) as ReturnType<Ended["envelope"]>,
  };
}

/** Runs the harness to its end. `whenReady` runs once it has reported "ready" on stderr. */
async function run(mode: string, opts: { inactivityMs?: number; whenReady?: (kill: (signal: NodeJS.Signals) => void) => void } = {}): Promise<Ended> {
  const outDir = await mkdtemp(join(tmpdir(), "jevitate-terminal-"));
  const child = spawn(process.execPath, [HARNESS, mode, outDir, ...(opts.inactivityMs === undefined ? [] : [String(opts.inactivityMs)])], { cwd: outDir, stdio: ["ignore", "pipe", "pipe"], env: { ...ENV, HOME: outDir } });
  let stdout = "";
  let stderr = "";
  let notified = false;
  child.stdout.on("data", (chunk: Buffer) => {
    stdout += chunk.toString("utf8");
  });
  child.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString("utf8");
    if (!notified && stderr.includes("ready")) {
      notified = true;
      opts.whenReady?.((signal) => child.kill(signal));
    }
  });
  const code = await new Promise<number | null>((resolve) => child.once("close", (c) => resolve(c)));
  return collected(outDir, stdout, stderr, code);
}

/**
 * Starts the harness under a bash that stays until the harness is ready and then exits with no signal
 * sent, so the harness really is re-parented. Its stdio stays open on our pipes, so `close` is its end.
 */
async function runWithDyingParent(env: NodeJS.ProcessEnv, inactivityMs: number): Promise<Ended> {
  const outDir = await mkdtemp(join(tmpdir(), "jevitate-terminal-"));
  const parent = spawn("bash", ["-c", '"$@" & read -r _; exit 0', "bash", process.execPath, HARNESS, "hold", outDir, String(inactivityMs)], { cwd: outDir, stdio: ["pipe", "pipe", "pipe"], env: { ...env, HOME: outDir } });
  let stdout = "";
  let stderr = "";
  let notified = false;
  parent.stdout.on("data", (chunk: Buffer) => {
    stdout += chunk.toString("utf8");
  });
  parent.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString("utf8");
    if (!notified && stderr.includes("ready")) {
      notified = true;
      parent.stdin.write("\n");
    }
  });
  await new Promise<void>((resolve) => parent.once("close", () => resolve()));
  return collected(outDir, stdout, stderr, null);
}

describe("[realtime] a real signal", () => {
  it.each([
    ["SIGTERM", 143],
    ["SIGINT", 130],
    ["SIGHUP", 129],
  ] as const)("%s exits %i", async (signal, expected) => {
    const ended = await run("hold", { whenReady: (kill) => kill(signal) });
    expect(ended.code).toBe(expected);
  });

  describe("SIGTERM", () => {
    let ended: Ended;
    beforeAll(async () => {
      ended = await run("hold", { whenReady: (kill) => kill("SIGTERM") });
    });

    it("leaves exactly one envelope on stdout", () => {
      expect(ended.envelope().error.code).toBe("E_TERMINAL_SIGNAL");
    });

    it("writes the real artifact", async () => {
      expect(await ended.artifact()).toMatchObject({ missionOutcome: "inconclusive", exitCode: 143, result: { stop: "terminated", diagnostic: { trigger: "signal", signal: "SIGTERM" } } });
    });

    it("names the artifact in the envelope", async () => {
      expect(ended.envelope().data["resultPath"]).toMatch(/harness-1\.result\.json$/);
    });

    it("keeps the secret out of the artifact", async () => {
      expect(JSON.stringify(await ended.artifact())).not.toContain(SECRET);
    });

    it("keeps the secret out of stdout", () => {
      expect(ended.stdout).not.toContain(SECRET);
    });

    it("keeps the secret out of the progress line", () => {
      expect(ended.stderr).not.toContain(SECRET);
    });
  });
});

describe("[realtime] a parent that goes away", () => {
  let ended: Ended;
  beforeAll(async () => {
    ended = await runWithDyingParent(ENV, 20_000);
  }, 30_000);

  it("reports it under its own code", () => {
    expect(ended.envelope().error.code).toBe("E_TERMINAL_PARENT_GONE");
  });

  it("names the switch that keeps a detached run going", () => {
    expect(ended.envelope().error.message).toContain("JEVITATE_PARENT_WATCHDOG=off");
  });

  it("writes the artifact with the documented exit code", async () => {
    expect(await ended.artifact()).toMatchObject({ exitCode: 129, result: { stop: "terminated", diagnostic: { trigger: "parent-gone" } } });
  });

  it("claims no signal", () => {
    expect(ended.envelope().data).not.toHaveProperty("signal");
  });

  it("with the parent watchdog off, the run goes on to its own ending", async () => {
    const off = await runWithDyingParent({ ...ENV, JEVITATE_PARENT_WATCHDOG: "off" }, 2_500);
    expect(off.envelope().error.code).toBe("E_TERMINAL_WATCHDOG");
  }, 30_000);
});

describe("[realtime] a run with no progress", () => {
  let ended: Ended;
  beforeAll(async () => {
    ended = await run("hold", { inactivityMs: 300 });
  });

  it("exits inconclusive", () => {
    expect(ended.code).toBe(2);
  });

  it("reports the inactivity limit", () => {
    expect(ended.envelope().error.code).toBe("E_TERMINAL_WATCHDOG");
  });

  it("writes the real artifact", async () => {
    expect(await ended.artifact()).toMatchObject({ missionOutcome: "inconclusive", exitCode: 2, result: { stop: "watchdog", diagnostic: { inactivityMs: 300 } } });
  });
});

describe("[realtime] an error nobody handled", () => {
  it("a rejection reaching the entry point exits 2", async () => {
    expect((await run("reject")).code).toBe(2);
  });

  it("a rejection reaching the entry point reports through the layer", async () => {
    expect((await run("reject")).envelope().error.code).toBe("E_TERMINAL_INTERNAL");
  });

  it("a rejection reaching the entry point is redacted", async () => {
    expect((await run("reject")).stdout).not.toContain(SECRET);
  });

  it("an uncaught error exits 2", async () => {
    expect((await run("throw")).code).toBe(2);
  });

  it("an uncaught error writes a crashed artifact", async () => {
    expect((await (await run("throw")).artifact())["missionOutcome"]).toBe("crashed");
  });
});

describe("[realtime] an event loop that drains with no result", () => {
  let ended: Ended;
  beforeAll(async () => {
    ended = await run("drain");
  });

  it("exits inconclusive instead of 0", () => {
    expect(ended.code).toBe(2);
  });

  it("reports it", () => {
    expect(ended.envelope().error.code).toBe("E_TERMINAL_UNSETTLED");
  });
});
