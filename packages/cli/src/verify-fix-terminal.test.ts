import { existsSync } from "node:fs";
import { copyFile, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
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
import { runVerifyFix, verifyFixArtifactPath, type RunVerifyFixOptions, type VerifyFixReport } from "./verify-fix-api.js";
import { registerVerifyFixCommands } from "./verify-fix-cli.js";

/**
 * #767 — `verify-fix` always ends with a machine-readable result. The report is persisted beside a
 * mission result, or in the logs for a committed input (opt-in, redacted), the CLI registers with the terminal layer before any
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

describe("where a verify-fix run writes", () => {
  const entry = (root: string): string => join(root, ".jevitate", "regressions", "ledger", `${FINGERPRINT}.json`);

  async function ledgerProject(): Promise<string> {
    await mkdir(dirname(entry(dir)), { recursive: true });
    await writeFile(entry(dir), JSON.stringify(markupMission()));
    return join(dir, ".jevitate", "regressions");
  }

  function cli(): { program: Command; terminal: ReturnType<typeof fakeTerminal> } {
    const terminal = fakeTerminal();
    const program = new Command();
    program.exitOverride();
    program.configureOutput({ writeOut: (s) => void terminal.stdout.push(s), writeErr: () => {} });
    registerVerifyFixCommands(program, deps(dir), { terminalDeps: terminal.deps });
    return { program, terminal };
  }

  it("leaves the ledger directory untouched on a ledger-based run", async () => {
    const regressions = await ledgerProject();
    await cli().program.parseAsync(["node", "jevitate", "verify-fix", FINGERPRINT, "--regressions-dir", regressions, "--json"]);
    expect(await readdir(dirname(entry(dir)))).toEqual([`${FINGERPRINT}.json`]);
  });

  it("names a file that exists under the project's logs on a ledger-based run", async () => {
    const regressions = await ledgerProject();
    const { program, terminal } = cli();
    await program.parseAsync(["node", "jevitate", "verify-fix", FINGERPRINT, "--regressions-dir", regressions, "--json"]);
    const named = String(terminal.envelopes()[0]?.data["resultPath"]);
    expect(named.startsWith(join(dir, ".jevitate", "logs")) && existsSync(named)).toBe(true);
  });

  it("sends a signal's artifact to the same logs on a ledger-based run", async () => {
    const regressions = await ledgerProject();
    const terminal = fakeTerminal();
    const program = new Command();
    program.exitOverride();
    program.configureOutput({ writeOut: (s) => void terminal.stdout.push(s), writeErr: () => {} });
    registerVerifyFixCommands(program, deps(dir), { terminalDeps: terminal.deps, runVerifyFix: (() => new Promise<VerifyFixReport>(() => {})) as typeof runVerifyFix });
    void program.parseAsync(["node", "jevitate", "verify-fix", FINGERPRINT, "--regressions-dir", regressions, "--json"]);
    await new Promise((resolve) => setImmediate(resolve));
    terminal.signal("SIGTERM");
    expect(terminal.results[0]?.path.startsWith(join(dir, ".jevitate", "logs"))).toBe(true);
  });

  it("gives the CLI and the report writer one path", async () => {
    const regressions = await ledgerProject();
    let stamp = "";
    const terminal = fakeTerminal();
    const program = new Command();
    program.exitOverride();
    program.configureOutput({ writeOut: (s) => void terminal.stdout.push(s), writeErr: () => {} });
    registerVerifyFixCommands(program, deps(dir), {
      terminalDeps: terminal.deps,
      runVerifyFix: ((opts: RunVerifyFixOptions) => {
        stamp = opts.resultStamp ?? "";
        return new Promise<VerifyFixReport>(() => {});
      }) as typeof runVerifyFix,
    });
    void program.parseAsync(["node", "jevitate", "verify-fix", FINGERPRINT, "--regressions-dir", regressions, "--json"]);
    await new Promise((resolve) => setImmediate(resolve));
    terminal.signal("SIGTERM");
    expect(terminal.results[0]?.path).toBe(verifyFixArtifactPath(entry(dir), stamp));
  });

  it("keeps a run over a mission result beside that result", () => {
    expect(verifyFixArtifactPath(join(dir, "out", "mission.result.json"), "STAMP")).toBe(join(dir, "out", "verify-fix-STAMP.json"));
  });

  it("keeps a run over a mission result in the logs beside that result", () => {
    const input = join(dir, ".jevitate", "logs", "2026-01-01", "explore.result.json");
    expect(verifyFixArtifactPath(input, "STAMP")).toBe(join(dirname(input), "verify-fix-STAMP.json"));
  });

  it("files a run under its stamp's date", async () => {
    await ledgerProject();
    expect(verifyFixArtifactPath(entry(dir), "2026-01-02T03-04-05-678Z")).toBe(join(dir, ".jevitate", "logs", "2026-01-02", "verify-fix-2026-01-02T03-04-05-678Z.json"));
  });

  it("moves a run out of a ledger under a custom regressions directory", () => {
    const layout = { cwd: () => join(dir, "repo"), homedir: () => join(dir, "home") };
    const path = verifyFixArtifactPath(join(dir, "custom", "ledger", `${FINGERPRINT}.json`), "STAMP", layout);
    expect(path.startsWith(join(dir, "home", ".jevitate", "logs"))).toBe(true);
  });

  it("moves a run out of an explicit --result inside the regressions directory", async () => {
    await ledgerProject();
    const path = verifyFixArtifactPath(join(dir, ".jevitate", "regressions", "mission.result.json"), "STAMP");
    expect(path.startsWith(join(dir, ".jevitate", "logs"))).toBe(true);
  });
});

describe("the one redacted verify-fix report", () => {
  const TOKEN_ENV = "JEV_TEST_VF_AUTH_TOKEN";
  const AUTH_TOKEN = "tok-short-77";

  afterEach(() => {
    delete process.env[TOKEN_ENV];
  });

  /** A mission whose invariant authenticates from the environment, and whose finding's title quotes the token. */
  function authMission(): unknown {
    const mission = markupMission(`title with ${AUTH_TOKEN}`) as { result: Record<string, unknown> };
    mission.result["invariantSpec"] = {
      observe: { secure: { probe: { get: "/v1/secure", authFrom: { secret: `env:${TOKEN_ENV}` } } } },
      invariants: [{ id: "secure-ok", require: "secure > 0" }],
    };
    return mission;
  }

  function cli(): { program: Command; terminal: ReturnType<typeof fakeTerminal> } {
    const terminal = fakeTerminal();
    const program = new Command();
    program.exitOverride();
    program.configureOutput({ writeOut: (s) => void terminal.stdout.push(s), writeErr: () => {} });
    registerVerifyFixCommands(program, deps(dir), { terminalDeps: terminal.deps });
    return { program, terminal };
  }

  async function runJson(title: string, ...flags: string[]): Promise<ReturnType<typeof fakeTerminal>> {
    const mission = await writeMission(dir, markupMission(title));
    const { program, terminal } = cli();
    await program.parseAsync(["node", "jevitate", "verify-fix", "--result", mission, "--fingerprint", FINGERPRINT, "--json", ...flags]);
    return terminal;
  }

  it("masks --secret on the --json stdout", async () => {
    const terminal = await runJson("title with hunter2-secret", "--secret", "hunter2-secret");
    expect(terminal.stdout.join("")).not.toContain("hunter2-secret");
  });

  it("masks a --param value on the --json stdout", async () => {
    const terminal = await runJson("title with hunter2-secret", "--param", "pw=hunter2-secret");
    expect(terminal.stdout.join("")).not.toContain("hunter2-secret");
  });

  it("masks a URL token on the --json stdout", async () => {
    const terminal = await runJson("failed at http://x.test/reset?token=shortTok1");
    expect(terminal.stdout.join("")).not.toContain("shortTok1");
  });

  it("masks --secret in the human summary", async () => {
    const mission = await writeMission(dir, markupMission("title with hunter2-secret"));
    const { program, terminal } = cli();
    await program.parseAsync(["node", "jevitate", "verify-fix", "--result", mission, "--fingerprint", FINGERPRINT, "--secret", "hunter2-secret"]);
    expect(terminal.stdout.join("")).not.toContain("hunter2-secret");
  });

  it("masks a URL token in the artifact", async () => {
    const resultPath = await writeMission(dir, markupMission("failed at http://x.test/reset?token=shortTok1"));
    await runVerifyFix({ resultPath, fingerprint: FINGERPRINT, resultArtifact: true, resultStamp: "STAMP" });
    expect(await readFile(join(dir, "verify-fix-STAMP.result.json"), "utf8")).not.toContain("shortTok1");
  });

  it("masks an invariant's auth token in the artifact", async () => {
    process.env[TOKEN_ENV] = AUTH_TOKEN;
    const resultPath = await writeMission(dir, authMission());
    await runVerifyFix({ resultPath, fingerprint: FINGERPRINT, resultArtifact: true, resultStamp: "STAMP" });
    expect(await readFile(join(dir, "verify-fix-STAMP.result.json"), "utf8")).not.toContain(AUTH_TOKEN);
  });

  it("masks an invariant's auth token in the returned report", async () => {
    process.env[TOKEN_ENV] = AUTH_TOKEN;
    const report = await runVerifyFix({ resultPath: await writeMission(dir, authMission()), fingerprint: FINGERPRINT });
    expect(JSON.stringify(report)).not.toContain(AUTH_TOKEN);
  });

  it("hands an invariant's auth token to the caller as it resolves", async () => {
    process.env[TOKEN_ENV] = AUTH_TOKEN;
    const learned: string[] = [];
    await runVerifyFix({ resultPath: await writeMission(dir, authMission()), fingerprint: FINGERPRINT, onSecrets: (values) => learned.push(...values) });
    expect(learned).toEqual([AUTH_TOKEN]);
  });

  it("masks a token learned during the run from a later internal error", async () => {
    const terminal = fakeTerminal();
    const program = new Command();
    program.exitOverride();
    program.configureOutput({ writeOut: (s) => void terminal.stdout.push(s), writeErr: () => {} });
    registerVerifyFixCommands(program, deps(dir), {
      terminalDeps: terminal.deps,
      runVerifyFix: ((opts: RunVerifyFixOptions) => {
        opts.onSecrets?.([AUTH_TOKEN]);
        return Promise.reject(new Error(`login failed with ${AUTH_TOKEN}`));
      }) as typeof runVerifyFix,
    });
    await program.parseAsync(["node", "jevitate", "verify-fix", "--result", await writeMission(dir), "--fingerprint", FINGERPRINT, "--json"]);
    expect(terminal.stdout.join("")).not.toContain(AUTH_TOKEN);
  });

  it("masks a URL token in a thrown input error", async () => {
    await expect(runVerifyFix({ resultPath: join(dir, "missing?token=shortTok1.json"), fingerprint: FINGERPRINT })).rejects.toThrow(/token=«redacted»/);
  });

  it("keeps the verdict when a --param value equals it", async () => {
    const terminal = await runJson("the failing control", "--param", "mode=inconclusive");
    expect(terminal.envelopes()[0]?.data["verdict"]).toBe("inconclusive");
  });

  it("keeps the exit code when a --param value equals the verdict", async () => {
    await runJson("the failing control", "--param", "mode=inconclusive");
    expect(process.exitCode).toBe(2);
  });

  it("keeps the fingerprint when a --param value equals it", async () => {
    const terminal = await runJson("the failing control", "--param", `id=${FINGERPRINT}`);
    expect(terminal.envelopes()[0]?.data["fingerprint"]).toBe(FINGERPRINT);
  });

  it("keeps the path it names when a --param value is a folder in it", async () => {
    await mkdir(join(dir, "run"));
    const mission = await writeMission(join(dir, "run"));
    const { program, terminal } = cli();
    await program.parseAsync(["node", "jevitate", "verify-fix", "--result", mission, "--fingerprint", FINGERPRINT, "--json", "--param", "dir=run"]);
    expect(existsSync(String(terminal.envelopes()[0]?.data["resultPath"]))).toBe(true);
  });

  it("keeps a title with no secret readable", async () => {
    const terminal = await runJson("the failing control", "--secret", "hunter2-secret");
    expect(terminal.envelopes()[0]?.data["title"]).toBe("the failing control");
  });

  it("gives the report and the artifact the same text", async () => {
    const resultPath = await writeMission(dir, markupMission("failed with hunter2-secret at http://x.test/?token=shortTok1"));
    const report = await runVerifyFix({ resultPath, fingerprint: FINGERPRINT, resultArtifact: true, resultStamp: "STAMP", secrets: ["hunter2-secret"] });
    const file = JSON.parse(await readFile(join(dir, "verify-fix-STAMP.result.json"), "utf8")) as { result: { title: string } };
    expect(file.result.title).toBe(report.title);
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

  async function mcpCall(title: string, read: (key: string) => string | undefined = () => undefined): Promise<string> {
    const id = "adversarial-2026-01-01T00-00-00-000Z";
    await writeFile(join(dir, `${id}.result.json`), JSON.stringify(markupMission(title)));
    const tool = buildMcpTools({
      journeysDir: join(dir, "journeys"),
      recordingsDir: dir,
      targetsConfigPath: join(dir, "no-targets.json"),
      credentialStore: { read } as never,
    }).find((t) => t.name === "verify_fix");
    const result = await tool?.handler({ id, fingerprint: FINGERPRINT });
    return result?.content[0]?.text ?? "";
  }

  it("masks a URL token in its return value", async () => {
    expect(await mcpCall("failed at http://x.test/reset?token=shortTok1")).not.toContain("shortTok1");
  });

  it("masks an operator credential in its return value", async () => {
    const text = await mcpCall("failed with or-key-value-1", (key) => (key === "OPENROUTER_API_KEY" ? "or-key-value-1" : undefined));
    expect(text).not.toContain("or-key-value-1");
  });

  it("masks an operator credential in the artifact it writes", async () => {
    const text = await mcpCall("failed with or-key-value-1", (key) => (key === "OPENROUTER_API_KEY" ? "or-key-value-1" : undefined));
    expect(await readFile(JSON.parse(text).resultPath as string, "utf8")).not.toContain("or-key-value-1");
  });

  it("keeps its verdict", async () => {
    expect(JSON.parse(await mcpCall("the failing control")).verdict).toBe("inconclusive");
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
