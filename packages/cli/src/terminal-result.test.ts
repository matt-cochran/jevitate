import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FakeClock, installClock, resetClock } from "@jevitate/domain";
import { __resetKillSwitchForTests, armMissionKillSwitch, installMissionKillSwitch, setKillSummary, setKillSwitchOutput, type KillSwitchDeps } from "./kill-signal.js";
import { __resetTerminalResultForTests, registerTerminalResult, type TerminalResultDeps, type TerminalResultRegistration } from "./terminal-result.js";

const SECRET = "hunter2-very-secret-value";

/** One process, faked: every write and exit lands in `events`, in order, and listeners fire on demand. */
function fakeProcess() {
  const events: string[] = [];
  const stdout: string[] = [];
  const stderr: string[] = [];
  const results: Array<{ path: string; missionOutcome: string; exitCode: number; result: unknown }> = [];
  const signals: Record<string, () => void> = {};
  let fatal: ((err: unknown) => void) | undefined;
  let processExit: (() => void) | undefined;
  const killDeps: KillSwitchDeps = {
    exit: (code) => events.push(`exit ${code}`),
    closeBrowsers: async () => {},
    terminateBrowsers: () => events.push("terminate-browsers"),
    writeResult: (path) => `${path}.result.json`,
    readTranscript: () => ({ steps: 0, transcript: [] }),
    onSignal: (signal, handler) => {
      signals[signal] = handler;
    },
    writeStdout: (text) => {
      events.push("stdout");
      stdout.push(text);
    },
  };
  const deps: TerminalResultDeps = {
    exit: (code) => events.push(`exit ${code}`),
    terminateBrowsers: () => events.push("terminate-browsers"),
    writeStdout: (text) => {
      events.push("stdout");
      stdout.push(text);
    },
    writeStderr: (text) => {
      events.push("stderr");
      stderr.push(text);
    },
    writeResult: (path, missionOutcome, exitCode, result) => {
      events.push("artifact");
      results.push({ path, missionOutcome, exitCode, result });
      return path.replace(/\.json$/, ".result.json");
    },
    engine: () => ({ version: "0.0.0-test" }) as ReturnType<TerminalResultDeps["engine"]>,
    onFatalError: (listener) => {
      fatal = listener;
      return () => {
        fatal = undefined;
      };
    },
    onProcessExit: (listener) => {
      processExit = listener;
      return () => {
        processExit = undefined;
      };
    },
    installKillSwitch: () => installMissionKillSwitch(killDeps),
  };
  const register = (over: Partial<TerminalResultRegistration> = {}) =>
    registerTerminalResult({ command: "journey verify", json: true, secrets: [SECRET], watchdogMs: 1_000, ...over }, deps);
  return {
    events,
    stdout,
    stderr,
    results,
    killDeps,
    register,
    signal: (name: "SIGTERM" | "SIGINT" | "SIGHUP") => signals[name]?.(),
    throwFatal: (err: unknown) => fatal?.(err),
    endProcess: () => processExit?.(),
    envelopes: () => stdout.map((line) => JSON.parse(line) as { ok: boolean; error: { code: string; message: string }; data: Record<string, unknown> }),
  };
}

let fakeClock: FakeClock;

beforeEach(() => {
  fakeClock = new FakeClock();
  installClock(fakeClock);
  __resetKillSwitchForTests();
  __resetTerminalResultForTests();
});

afterEach(() => {
  __resetTerminalResultForTests();
  __resetKillSwitchForTests();
  resetClock();
  process.exitCode = undefined;
});

describe("a signal", () => {
  it("emits the envelope before the exit", () => {
    const p = fakeProcess();
    p.register();
    p.signal("SIGTERM");
    expect(p.events).toEqual(["stdout", "terminate-browsers", "exit 143"]);
  });

  it("writes the artifact before the envelope", () => {
    const p = fakeProcess();
    p.register({ artifactPath: "/out/verify-fix-1.json" });
    p.signal("SIGTERM");
    expect(p.events.slice(0, 2)).toEqual(["artifact", "stdout"]);
  });

  it("reports a failure, never a success", () => {
    const p = fakeProcess();
    p.register();
    p.signal("SIGINT");
    expect(p.envelopes()[0]).toMatchObject({ ok: false, error: { code: "E_TERMINAL_SIGNAL" } });
  });

  it("carries its signal and documented exit code in the diagnostic", () => {
    const p = fakeProcess();
    p.register();
    p.signal("SIGHUP");
    expect(p.envelopes()[0]?.data).toMatchObject({ trigger: "signal", signal: "SIGHUP", exitCode: 129 });
  });

  it("prints only the registered command's envelope when a mission is also armed", () => {
    const p = fakeProcess();
    p.register();
    setKillSwitchOutput("envelope");
    armMissionKillSwitch({ recordingPath: "/out/explore-a.json" }, p.killDeps);
    p.signal("SIGTERM");
    expect(p.envelopes().map((e) => e.error?.code)).toEqual(["E_TERMINAL_SIGNAL"]);
  });

  it("prints only the registered command's envelope when a kill summary is also installed", () => {
    const p = fakeProcess();
    p.register();
    setKillSummary(() => "summary text\n");
    p.signal("SIGTERM");
    expect(p.stdout).toHaveLength(1);
  });

  it("without --json prints the refusal line on stderr and nothing on stdout", () => {
    const p = fakeProcess();
    p.register({ json: false });
    p.signal("SIGTERM");
    expect({ stdout: p.stdout, stderr: p.stderr[0] }).toEqual({
      stdout: [],
      stderr: "error E_TERMINAL_SIGNAL: journey verify: interrupted by SIGTERM before any progress was reported\n",
    });
  });
});

describe("the watchdog", () => {
  it("emits a diagnostic naming the replay, mutation and step reached", async () => {
    const p = fakeProcess();
    const handle = p.register({ watchdogMs: 1_000 });
    handle.progress({ replay: 2, mutation: "drop-save", step: 3 });
    await fakeClock.advanceBy(1_000);
    expect(p.envelopes()[0]?.error).toEqual({
      code: "E_TERMINAL_WATCHDOG",
      message: "journey verify: no result within the 1000ms watchdog limit at replay 2, mutation drop-save, step 3",
    });
  });

  it("exits inconclusive after ending the process's browsers", async () => {
    const p = fakeProcess();
    p.register({ watchdogMs: 1_000 });
    await fakeClock.advanceBy(1_000);
    expect(p.events).toEqual(["stdout", "terminate-browsers", "exit 2"]);
  });

  it("does not fire before its limit", async () => {
    const p = fakeProcess();
    p.register({ watchdogMs: 1_000 });
    await fakeClock.advanceBy(999);
    expect(p.events).toEqual([]);
  });

  it("does not fire after the command completed", async () => {
    const p = fakeProcess();
    p.register({ watchdogMs: 1_000 }).complete();
    await fakeClock.advanceBy(1_000);
    expect(p.events).toEqual([]);
  });

  it.each([0, -1, Number.NaN, 1.5, Number.POSITIVE_INFINITY, 2_147_483_648])("refuses a limit of %s", (watchdogMs) => {
    const p = fakeProcess();
    expect(() => p.register({ watchdogMs })).toThrow(RangeError);
  });
});

describe("exactly once", () => {
  it("a second trigger of another kind writes nothing more", async () => {
    const p = fakeProcess();
    p.register({ artifactPath: "/out/a.json", watchdogMs: 1_000 });
    p.signal("SIGTERM");
    const after = [...p.events];
    p.throwFatal(new Error("late"));
    await fakeClock.advanceBy(1_000);
    p.endProcess();
    expect(p.events).toEqual(after);
  });

  it("a second fail writes nothing more", () => {
    const p = fakeProcess();
    const handle = p.register();
    handle.fail(new Error("first"));
    const after = [...p.events];
    handle.fail(new Error("second"));
    expect(p.events).toEqual(after);
  });

  it("a second signal force-exits and writes nothing more", () => {
    const p = fakeProcess();
    p.register();
    p.signal("SIGTERM");
    p.signal("SIGTERM");
    expect(p.stdout).toHaveLength(1);
  });

  it("a fail after complete writes nothing", () => {
    const p = fakeProcess();
    const handle = p.register();
    handle.complete();
    handle.fail(new Error("late"));
    expect(p.events).toEqual([]);
  });

  it("a nested command's signal prints one envelope, for the newest command", () => {
    const p = fakeProcess();
    p.register({ command: "outer" });
    p.register({ command: "inner" });
    p.signal("SIGTERM");
    expect(p.envelopes().map((e) => e.data["command"])).toEqual(["inner"]);
  });
});

describe("an internal error", () => {
  it("exits crashed with the documented code", () => {
    const p = fakeProcess();
    p.register().fail(new Error("boom"));
    expect(p.events).toEqual(["stdout", "terminate-browsers", "exit 2"]);
  });

  it("marks the artifact crashed", () => {
    const p = fakeProcess();
    p.register({ artifactPath: "/out/a.json" }).fail(new Error("boom"));
    expect(p.results[0]).toMatchObject({ missionOutcome: "crashed", exitCode: 2 });
  });

  it("an uncaught error reports like a thrown one", () => {
    const p = fakeProcess();
    p.register();
    p.throwFatal(new Error("uncaught"));
    expect(p.envelopes()[0]?.error.code).toBe("E_TERMINAL_INTERNAL");
  });

  it("an artifact that cannot be written still leaves the envelope, naming why", () => {
    const p = fakeProcess();
    const failing = registerTerminalResult(
      { command: "c", json: true, secrets: [], watchdogMs: 1_000, artifactPath: "/out/a.json" },
      {
        exit: () => {},
        terminateBrowsers: () => {},
        writeStdout: (text) => p.stdout.push(text),
        writeStderr: () => {},
        writeResult: () => {
          throw new Error("EROFS: read-only");
        },
        engine: () => ({ version: "t" }) as ReturnType<TerminalResultDeps["engine"]>,
        onFatalError: () => () => {},
        onProcessExit: () => () => {},
        installKillSwitch: () => {},
      },
    );
    failing.fail(new Error("boom"));
    expect(p.envelopes()[0]?.data["artifactError"]).toBe("EROFS: read-only");
  });
});

describe("redaction", () => {
  const thrown = (): Error => {
    const err = new Error(`login failed with ${SECRET}`);
    err.stack = `Error: login failed with ${SECRET}\n    at x (/app/${SECRET}.ts:1:1)`;
    return err;
  };

  it("a secret in a thrown error does not reach the envelope", () => {
    const p = fakeProcess();
    p.register().fail(thrown());
    expect(p.stdout.join("")).not.toContain(SECRET);
  });

  it("a secret in a thrown error does not reach the artifact", () => {
    const p = fakeProcess();
    p.register({ artifactPath: "/out/a.json" }).fail(thrown());
    expect(JSON.stringify(p.results)).not.toContain(SECRET);
  });

  it("a secret in a thrown error's cause does not reach the envelope", () => {
    const p = fakeProcess();
    p.register().fail(new Error("wrapped", { cause: thrown() }));
    expect(p.stdout.join("")).not.toContain(SECRET);
  });

  it("a secret in a thrown non-error does not reach the envelope", () => {
    const p = fakeProcess();
    p.register().fail({ token: SECRET });
    expect(p.stdout.join("")).not.toContain(SECRET);
  });

  it("a URL-encoded secret does not reach the envelope", () => {
    const p = fakeProcess();
    const secret = "pass word/with&chars-long";
    p.register({ secrets: [secret] }).fail(new Error(`GET /x?p=${encodeURIComponent(secret)}`));
    expect(p.stdout.join("")).not.toContain(encodeURIComponent(secret));
  });

  it("a secret in reported progress does not reach the envelope", () => {
    const p = fakeProcess();
    const handle = p.register();
    handle.progress({ step: `type ${SECRET}`, detail: { [SECRET]: SECRET } });
    handle.fail(new Error("boom"));
    expect(p.stdout.join("")).not.toContain(SECRET);
  });

  it("a secret added during the run does not reach the envelope", () => {
    const p = fakeProcess();
    const handle = p.register({ secrets: [] });
    handle.addSecrets(["late-learned-auth-token"]);
    handle.fail(new Error("sent late-learned-auth-token"));
    expect(p.stdout.join("")).not.toContain("late-learned-auth-token");
  });

  it("a secret containing a shorter secret leaves no part of itself readable", () => {
    const p = fakeProcess();
    p.register({ secrets: ["short-secret", "short-secret-and-its-tail"] }).fail(new Error("saw short-secret-and-its-tail"));
    expect(p.stdout.join("")).not.toContain("and-its-tail");
  });

  it("a credential nobody registered does not reach the envelope", () => {
    const p = fakeProcess();
    const token = "ghp_abcdefghijklmnopqrstuvwxyz0123456789";
    p.register({ secrets: [] }).fail(new Error(`push refused for ${token}`));
    expect(p.stdout.join("")).not.toContain(token);
  });

  it("progress that cannot be serialized leaves a withheld diagnostic, not silence", () => {
    const p = fakeProcess();
    const handle = p.register();
    const cyclic: Record<string, unknown> = { value: SECRET };
    cyclic["self"] = cyclic;
    handle.progress({ detail: cyclic });
    handle.fail(new Error("boom"));
    expect(p.envelopes()[0]?.data).toMatchObject({ trigger: "internal-error", diagnosticWithheld: true });
  });
});

describe("a process that ends unsettled", () => {
  it("reports inconclusive instead of ending silently", () => {
    const p = fakeProcess();
    p.register();
    p.endProcess();
    expect(p.envelopes()[0]?.error.code).toBe("E_TERMINAL_UNSETTLED");
  });

  it("does not exit again from inside the exit", () => {
    const p = fakeProcess();
    p.register();
    p.endProcess();
    expect(p.events).toEqual(["stdout", "terminate-browsers"]);
  });
});

describe("a command that registered nothing", () => {
  it("a signal prints the mission's own envelope as before", () => {
    const p = fakeProcess();
    installMissionKillSwitch(p.killDeps);
    setKillSwitchOutput("envelope");
    armMissionKillSwitch({ recordingPath: "/out/explore-a.json" }, p.killDeps);
    p.signal("SIGTERM");
    expect(p.envelopes()[0]).toMatchObject({ ok: true, data: { outcome: "inconclusive", signal: "SIGTERM" } });
  });

  it("a signal with no mission prints nothing and exits as before", () => {
    const p = fakeProcess();
    installMissionKillSwitch(p.killDeps);
    p.signal("SIGTERM");
    expect(p.events).toEqual(["terminate-browsers", "exit 143"]);
  });

  it("a completed command's later signal behaves as if it never registered", () => {
    const p = fakeProcess();
    p.register().complete();
    p.signal("SIGTERM");
    expect(p.events).toEqual(["terminate-browsers", "exit 143"]);
  });
});
