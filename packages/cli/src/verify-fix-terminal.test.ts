import { copyFile, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ProfileManager } from "@jevitate/daemon";
import { FakeClock, installClock, resetClock } from "@jevitate/domain";
import { __resetKillSwitchForTests, installMissionKillSwitch, type KillSwitchDeps } from "./kill-signal.js";
import { buildMcpTools } from "./mcp-api.js";
import { scanRuns } from "./report-api.js";
import {
  __resetTerminalResultForTests,
  type TerminalResultDeps,
} from "./terminal-result.js";
import type { CliDeps } from "./cli-shared.js";
import { runVerifyFix, type RunVerifyFixOptions, type VerifyFixReport } from "./verify-fix-api.js";
import { registerVerifyFixCommands } from "./verify-fix-cli.js";

/**
 * #767 — `verify-fix` always ends with a machine-readable result. The report is persisted next to
 * the mission result (opt-in, redacted), the CLI registers with the terminal layer before any
 * browser opens (so a signal or parent death still writes one artifact and one envelope), and a
 * report scan never mistakes a verify-fix artifact for a mission run.
 */

const FINGERPRINT = "a".repeat(16);

/** A mission result whose only finding is a `markup-injection` defect: `verifyFix` returns
 *  `inconclusive` without ever opening a browser, so the writer is exercised without Chromium. */
function markupMission(title = "the failing control"): unknown {
  return {
    missionOutcome: "defects-found",
    exitCode: 1,
    result: {
      target: { seedUrl: "http://x.test/", allowlist: ["http://x.test"] },
      recording: { version: "1", site: "http://x.test", pages: [] },
      defects: [{ fingerprint: FINGERPRINT, kind: "markup-injection", repro: { recordingStepIndex: 0 }, title }],
    },
  };
}

async function writeMission(dir: string, raw: unknown = markupMission()): Promise<string> {
  const path = join(dir, "mission.result.json");
  await writeFile(path, JSON.stringify(raw));
  return path;
}

/** The terminal layer's seams, faked: every write/exit lands in `events`; signals fire on demand. */
function fakeTerminal() {
  const events: string[] = [];
  const stdout: string[] = [];
  const results: Array<{ path: string; result: unknown }> = [];
  const exits: number[] = [];
  const signals: Record<string, () => void> = {};
  const killDeps: KillSwitchDeps = {
    exit: (code) => {
      events.push(`exit ${code}`);
      exits.push(code);
    },
    closeBrowsers: async () => {},
    terminateBrowsers: () => events.push("terminate-browsers"),
    writeResult: (path) => `${path}.result.json`,
    readTranscript: () => ({ steps: 0, transcript: [] }),
    onSignal: (signal, handler) => {
      signals[signal] = handler;
    },
    watchParent: () => {},
    writeStdout: (text) => stdout.push(text),
  };
  const deps: TerminalResultDeps = {
    exit: (code) => {
      events.push(`exit ${code}`);
      exits.push(code);
    },
    terminateBrowsers: () => events.push("terminate-browsers"),
    writeStdout: (text) => {
      events.push("stdout");
      stdout.push(text);
    },
    writeStderr: (text) => {
      events.push("stderr");
    },
    writeResult: (path, _missionOutcome, _exitCode, result) => {
      events.push("artifact");
      results.push({ path, result });
      return path.replace(/\.json$/, ".result.json");
    },
    engine: () => ({ version: "0.0.0-test" }) as ReturnType<TerminalResultDeps["engine"]>,
    onFatalError: () => () => {},
    onProcessExit: () => () => {},
    installKillSwitch: () => installMissionKillSwitch(killDeps),
    sharedProcess: () => false,
  };
  return {
    deps,
    events,
    stdout,
    results,
    exits,
    signal: (name: "SIGTERM") => signals[name]?.(),
    envelopes: () => stdout.map((line) => JSON.parse(line) as { ok: boolean; error: { code: string }; data: Record<string, unknown> }),
  };
}

function deps(dir: string): CliDeps {
  return {
    profiles: new ProfileManager(join(dir, "profiles")),
    explore: { targetsConfigPath: join(dir, "no-targets.json") },
  };
}

let dir: string;
let fakeClock: FakeClock;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "jev-vf-terminal-"));
  fakeClock = new FakeClock();
  installClock(fakeClock);
  __resetKillSwitchForTests();
  __resetTerminalResultForTests();
});

afterEach(async () => {
  __resetTerminalResultForTests();
  __resetKillSwitchForTests();
  resetClock();
  process.exitCode = undefined;
  await rm(dir, { recursive: true, force: true });
});

describe("runVerifyFix result artifact (#767)", () => {
  it("writes exactly one result artifact on an inconclusive return", async () => {
    const resultPath = await writeMission(dir);
    await runVerifyFix({ resultPath, fingerprint: FINGERPRINT, resultArtifact: true, resultStamp: "STAMP" });
    expect((await readdir(dir)).filter((f) => f.startsWith("verify-fix-") && f.endsWith(".result.json"))).toEqual(["verify-fix-STAMP.result.json"]);
  });

  it("returns the written artifact path on the report", async () => {
    const resultPath = await writeMission(dir);
    const report = await runVerifyFix({ resultPath, fingerprint: FINGERPRINT, resultArtifact: true, resultStamp: "STAMP" });
    expect(report.resultPath).toBe(join(dir, "verify-fix-STAMP.result.json"));
  });

  it("writes no artifact when the caller does not opt in", async () => {
    const resultPath = await writeMission(dir);
    await runVerifyFix({ resultPath, fingerprint: FINGERPRINT });
    expect((await readdir(dir)).filter((f) => f.startsWith("verify-fix-"))).toEqual([]);
  });

  it("redacts a registered secret from the written report", async () => {
    const resultPath = await writeMission(dir, markupMission("title with hunter2-secret"));
    await runVerifyFix({ resultPath, fingerprint: FINGERPRINT, resultArtifact: true, resultStamp: "STAMP", secrets: ["hunter2-secret"] });
    expect(await readFile(join(dir, "verify-fix-STAMP.result.json"), "utf8")).not.toContain("hunter2-secret");
  });
});

describe("verify-fix CLI terminal result (#767)", () => {
  function runCli(seams: { runVerifyFix?: typeof runVerifyFix; terminalDeps?: TerminalResultDeps }): {
    program: Command;
    terminal: ReturnType<typeof fakeTerminal>;
  } {
    const terminal = fakeTerminal();
    const program = new Command();
    program.exitOverride();
    // The command's own envelope goes to the same stream the terminal layer writes to, as in bin.ts.
    program.configureOutput({ writeOut: (s) => void terminal.stdout.push(s), writeErr: () => {} });
    registerVerifyFixCommands(program, deps(dir), { ...seams, terminalDeps: seams.terminalDeps ?? terminal.deps });
    return { program, terminal };
  }

  it("prints the report's result path in the envelope when the replay finishes", async () => {
    const mission = await writeMission(dir);
    let seenStamp: string | undefined;
    const { program, terminal } = runCli({
      runVerifyFix: (async (opts: RunVerifyFixOptions) => {
        seenStamp = opts.resultStamp;
        return {
          verdict: "still-reproduces",
          fingerprint: opts.fingerprint,
          observedFingerprints: [],
          replay: { outcome: "completed" },
          reason: "the defect reproduced",
          exitCode: 1,
          resultPath: join(dirname(opts.resultPath), `verify-fix-${opts.resultStamp}.result.json`),
        } as VerifyFixReport;
      }) as typeof runVerifyFix,
    });
    await program.parseAsync(["node", "jevitate", "verify-fix", "--result", mission, "--fingerprint", FINGERPRINT, "--json"]);
    expect(terminal.envelopes()[0]?.data["resultPath"]).toBe(join(dir, `verify-fix-${seenStamp}.result.json`));
  });

  it("prints the inconclusive report's result path in the envelope", async () => {
    const mission = await writeMission(dir);
    const { program, terminal } = runCli({
      runVerifyFix: (async (opts: RunVerifyFixOptions) =>
        ({
          verdict: "inconclusive",
          fingerprint: opts.fingerprint,
          observedFingerprints: [],
          replay: { outcome: "failed" },
          reason: "could not replay",
          exitCode: 2,
          resultPath: join(dirname(opts.resultPath), `verify-fix-${opts.resultStamp}.result.json`),
        }) as VerifyFixReport) as typeof runVerifyFix,
    });
    await program.parseAsync(["node", "jevitate", "verify-fix", "--result", mission, "--fingerprint", FINGERPRINT, "--json"]);
    expect(terminal.envelopes()[0]?.data["resultPath"]).toMatch(/verify-fix-.*\.result\.json$/);
  });

  it("writes exactly one result artifact when the replay throws an internal error", async () => {
    const mission = await writeMission(dir);
    const { program, terminal } = runCli({
      runVerifyFix: (async () => {
        throw new Error("boom");
      }) as typeof runVerifyFix,
    });
    await program.parseAsync(["node", "jevitate", "verify-fix", "--result", mission, "--fingerprint", FINGERPRINT, "--json"]);
    expect(terminal.results).toHaveLength(1);
  });

  it("prints one E_TERMINAL_INTERNAL envelope when the replay throws an internal error", async () => {
    const mission = await writeMission(dir);
    const { program, terminal } = runCli({
      runVerifyFix: (async () => {
        throw new Error("boom");
      }) as typeof runVerifyFix,
    });
    await program.parseAsync(["node", "jevitate", "verify-fix", "--result", mission, "--fingerprint", FINGERPRINT, "--json"]);
    expect(terminal.envelopes()[0]?.error.code).toBe("E_TERMINAL_INTERNAL");
  });

  it("exits non-zero when the replay throws an internal error", async () => {
    const mission = await writeMission(dir);
    const { program, terminal } = runCli({
      runVerifyFix: (async () => {
        throw new Error("boom");
      }) as typeof runVerifyFix,
    });
    await program.parseAsync(["node", "jevitate", "verify-fix", "--result", mission, "--fingerprint", FINGERPRINT, "--json"]);
    expect(terminal.exits).toEqual([2]);
  });

  it("keeps a secret in a thrown error out of the artifact", async () => {
    const mission = await writeMission(dir);
    const { program, terminal } = runCli({
      runVerifyFix: (async () => {
        throw new Error("login failed with hunter2-secret");
      }) as typeof runVerifyFix,
    });
    await program.parseAsync(["node", "jevitate", "verify-fix", "--result", mission, "--fingerprint", FINGERPRINT, "--json", "--secret", "hunter2-secret"]);
    expect(JSON.stringify(terminal.results[0]?.result)).not.toContain("hunter2-secret");
  });

  it("keeps a secret --param value in a thrown error out of the artifact", async () => {
    const mission = await writeMission(dir);
    const { program, terminal } = runCli({
      runVerifyFix: (async () => {
        throw new Error("login failed with hunter2-secret");
      }) as typeof runVerifyFix,
    });
    await program.parseAsync(["node", "jevitate", "verify-fix", "--result", mission, "--fingerprint", FINGERPRINT, "--json", "--param", "token=hunter2-secret"]);
    expect(JSON.stringify(terminal.results[0]?.result)).not.toContain("hunter2-secret");
  });

  it("keeps a secret in a thrown error out of stdout", async () => {
    const mission = await writeMission(dir);
    const { program, terminal } = runCli({
      runVerifyFix: (async () => {
        throw new Error("login failed with hunter2-secret");
      }) as typeof runVerifyFix,
    });
    await program.parseAsync(["node", "jevitate", "verify-fix", "--result", mission, "--fingerprint", FINGERPRINT, "--json", "--secret", "hunter2-secret"]);
    expect(terminal.stdout.join("")).not.toContain("hunter2-secret");
  });

  it("prints one E_TERMINAL_SIGNAL envelope when SIGTERM ends the run", async () => {
    const mission = await writeMission(dir);
    const { program, terminal } = runCli({
      runVerifyFix: (() => new Promise<VerifyFixReport>(() => {})) as typeof runVerifyFix,
    });
    void program.parseAsync(["node", "jevitate", "verify-fix", "--result", mission, "--fingerprint", FINGERPRINT, "--json"]);
    await new Promise((resolve) => setImmediate(resolve));
    terminal.signal("SIGTERM");
    expect(terminal.envelopes()[0]?.error.code).toBe("E_TERMINAL_SIGNAL");
  });

  it("exits 143 when SIGTERM ends the run", async () => {
    const mission = await writeMission(dir);
    const { program, terminal } = runCli({
      runVerifyFix: (() => new Promise<VerifyFixReport>(() => {})) as typeof runVerifyFix,
    });
    void program.parseAsync(["node", "jevitate", "verify-fix", "--result", mission, "--fingerprint", FINGERPRINT, "--json"]);
    await new Promise((resolve) => setImmediate(resolve));
    terminal.signal("SIGTERM");
    expect(terminal.exits).toEqual([143]);
  });
});

describe("the MCP verify_fix tool (#767)", () => {
  it("returns the written artifact path for a default-impl replay", async () => {
    const id = "adversarial-2026-01-01T00-00-00-000Z";
    await copyFile(await writeMission(dir), join(dir, `${id}.result.json`));
    const tool = buildMcpTools({ journeysDir: join(dir, "journeys"), recordingsDir: dir, targetsConfigPath: join(dir, "no-targets.json") }).find(
      (t) => t.name === "verify_fix",
    );
    const result = await tool?.handler({ id, fingerprint: FINGERPRINT });
    expect(JSON.parse(result?.content[0]?.text ?? "").resultPath).toMatch(/verify-fix-.*\.result\.json$/);
  });
});

describe("report scan of a verify-fix artifact (#767)", () => {
  it("does not count a verify-fix artifact as a mission run", async () => {
    await writeFile(
      join(dir, "verify-fix-STAMP.result.json"),
      JSON.stringify({ missionOutcome: "still-reproduces", exitCode: 1, result: { mode: "verify-fix", fingerprint: FINGERPRINT, target: { seedUrl: "http://x.test/" }, defects: [] } }),
    );
    expect(scanRuns([dir])).toEqual([]);
  });
});
