import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FakeClock, installClock, resetClock } from "@jevitate/domain";
import { __resetKillSwitchForTests, armMissionKillSwitch, installMissionKillSwitch, setKillSummary, setKillSwitchOutput, type KillSwitchDeps } from "./kill-signal.js";
import { EventEmitter } from "node:events";
import { runAsMcpInvocation } from "./approval-provenance.js";
import { __resetTerminalResultForTests, installBrokenPipePolicy, registerTerminalResult, reportCommandRejection, type TerminalResultDeps, type TerminalResultRegistration } from "./terminal-result.js";

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
  let parentGone: (() => void) | undefined;
  let stderrBroken = false;
  let shared = false;
  const killDeps: KillSwitchDeps = {
    exit: (code) => events.push(`exit ${code}`),
    closeBrowsers: async () => {},
    terminateBrowsers: () => events.push("terminate-browsers"),
    writeResult: (path) => `${path}.result.json`,
    readTranscript: () => ({ steps: 0, transcript: [] }),
    onSignal: (signal, handler) => {
      signals[signal] = handler;
    },
    watchParent: (onGone) => {
      parentGone = onGone;
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
      if (stderrBroken) {
        events.push("stderr-refused");
        throw Object.assign(new Error("write EPIPE"), { code: "EPIPE" });
      }
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
    sharedProcess: () => shared,
  };
  const register = (over: Partial<TerminalResultRegistration> = {}) =>
    registerTerminalResult({ command: "journey verify", json: true, secrets: [SECRET], inactivityMs: 1_000, ...over }, deps);
  return {
    events,
    stdout,
    stderr,
    results,
    killDeps,
    register,
    signal: (name: "SIGTERM" | "SIGINT" | "SIGHUP") => signals[name]?.(),
    loseParent: () => parentGone?.(),
    breakStderr: () => {
      stderrBroken = true;
    },
    shareProcess: () => {
      shared = true;
    },
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

describe("the inactivity limit", () => {
  it("emits a diagnostic naming the replay, mutation and step reached", async () => {
    const p = fakeProcess();
    const handle = p.register({ inactivityMs: 1_000 });
    handle.progress({ replay: 2, mutation: "drop-save", step: 3 });
    await fakeClock.advanceBy(1_000);
    expect(p.envelopes()[0]?.error).toEqual({
      code: "E_TERMINAL_WATCHDOG",
      message: "journey verify: no progress for the 1000ms inactivity limit at replay 2, mutation drop-save, step 3",
    });
  });

  it("exits inconclusive after ending the process's browsers", async () => {
    const p = fakeProcess();
    p.register({ inactivityMs: 1_000 });
    await fakeClock.advanceBy(1_000);
    expect(p.events).toEqual(["stdout", "terminate-browsers", "exit 2"]);
  });

  it("carries its limit in the diagnostic", async () => {
    const p = fakeProcess();
    p.register({ inactivityMs: 1_000 });
    await fakeClock.advanceBy(1_000);
    expect(p.envelopes()[0]?.data).toMatchObject({ trigger: "watchdog", inactivityMs: 1_000 });
  });

  it("does not end a run far longer than the limit while progress keeps coming", async () => {
    const p = fakeProcess();
    const handle = p.register({ inactivityMs: 1_000 });
    for (let replay = 0; replay < 50; replay += 1) {
      await fakeClock.advanceBy(999);
      handle.progress({ replay });
    }
    expect(p.events).not.toContain("exit 2");
  });

  it("fires one limit after the last progress", async () => {
    const p = fakeProcess();
    const handle = p.register({ inactivityMs: 1_000 });
    await fakeClock.advanceBy(900);
    handle.progress({ replay: 1 });
    await fakeClock.advanceBy(1_000);
    expect(p.envelopes()[0]?.error.code).toBe("E_TERMINAL_WATCHDOG");
  });

  it("does not fire earlier for the limit already running when progress arrived", async () => {
    const p = fakeProcess();
    const handle = p.register({ inactivityMs: 1_000 });
    await fakeClock.advanceBy(900);
    handle.progress({ replay: 1 });
    await fakeClock.advanceBy(999);
    expect(p.stdout).toEqual([]);
  });

  it("is not restarted by progress after the command completed", async () => {
    const p = fakeProcess();
    const handle = p.register({ inactivityMs: 1_000 });
    handle.complete();
    handle.progress({ replay: 1 });
    await fakeClock.advanceBy(1_000);
    expect(p.stdout).toEqual([]);
  });

  it("an inner command's progress keeps the command around it from firing", async () => {
    const p = fakeProcess();
    p.register({ command: "outer", inactivityMs: 1_000 });
    const inner = p.register({ command: "inner", inactivityMs: 1_000 });
    await fakeClock.advanceBy(900);
    inner.progress({ replay: 1 });
    await fakeClock.advanceBy(900);
    expect(p.stdout).toEqual([]);
  });

  it("does not fire before its limit", async () => {
    const p = fakeProcess();
    p.register({ inactivityMs: 1_000 });
    await fakeClock.advanceBy(999);
    expect(p.events).toEqual([]);
  });

  it("does not fire after the command completed", async () => {
    const p = fakeProcess();
    p.register({ inactivityMs: 1_000 }).complete();
    await fakeClock.advanceBy(1_000);
    expect(p.events).toEqual([]);
  });

  it.each([0, -1, Number.NaN, 1.5, Number.POSITIVE_INFINITY, 2_147_483_648])("refuses a limit of %s", (inactivityMs) => {
    const p = fakeProcess();
    expect(() => p.register({ inactivityMs })).toThrow(RangeError);
  });
});

describe("a progress line", () => {
  it("goes to stderr, naming the command and where it is", async () => {
    const p = fakeProcess();
    const handle = p.register();
    await fakeClock.advanceBy(500);
    handle.progress({ phase: "proof", replay: 2, mutation: "drop-save", step: 3 });
    expect(p.stderr).toEqual(["progress journey verify: proof, replay 2, mutation drop-save, step 3 (1s)\n"]);
  });

  it("is printed once per call", () => {
    const p = fakeProcess();
    const handle = p.register();
    handle.progress({ replay: 1 });
    handle.progress({ replay: 2 });
    expect(p.stderr).toHaveLength(2);
  });

  it("leaves stdout alone", () => {
    const p = fakeProcess();
    p.register().progress({ replay: 1 });
    expect(p.stdout).toEqual([]);
  });

  it("merges into what was reported before", () => {
    const p = fakeProcess();
    const handle = p.register();
    handle.progress({ replay: 1, mutation: "drop-save" });
    handle.progress({ step: 4 });
    expect(p.stderr[1]).toContain("replay 1, mutation drop-save, step 4");
  });

  it("drops a field cleared with undefined", () => {
    const p = fakeProcess();
    const handle = p.register();
    handle.progress({ replay: 1, mutation: "drop-save" });
    handle.progress({ mutation: undefined });
    expect(p.stderr[1]).not.toContain("mutation");
  });

  it("masks a registered secret", () => {
    const p = fakeProcess();
    p.register().progress({ step: `type ${SECRET}` });
    expect(p.stderr.join("")).not.toContain(SECRET);
  });

  it("masks a URL-encoded secret", () => {
    const p = fakeProcess();
    const secret = "pass word/with&chars-long";
    p.register({ secrets: [secret] }).progress({ step: `GET /x?p=${encodeURIComponent(secret)}` });
    expect(p.stderr.join("")).not.toContain(encodeURIComponent(secret));
  });

  it("masks a secret added during the run", () => {
    const p = fakeProcess();
    const handle = p.register({ secrets: [] });
    handle.addSecrets(["late-learned-auth-token"]);
    handle.progress({ step: "sent late-learned-auth-token" });
    expect(p.stderr.join("")).not.toContain("late-learned-auth-token");
  });

  it("masks a credential nobody registered", () => {
    const p = fakeProcess();
    const token = "ghp_abcdefghijklmnopqrstuvwxyz0123456789";
    p.register({ secrets: [] }).progress({ step: `push ${token}` });
    expect(p.stderr.join("")).not.toContain(token);
  });

  it("masks a secret in the command's name", () => {
    const p = fakeProcess();
    p.register({ command: `verify ${SECRET}` }).progress({ replay: 1 });
    expect(p.stderr.join("")).not.toContain(SECRET);
  });

  it("masks a secret that has a line break in it", () => {
    const p = fakeProcess();
    const secret = "first-line-of-secret\nsecond-line-of-secret";
    p.register({ secrets: [secret] }).progress({ step: `type ${secret}` });
    expect(p.stderr.join("")).not.toContain("second-line-of-secret");
  });

  it("stays one line whatever a label holds", () => {
    const p = fakeProcess();
    p.register().progress({ step: "a\nforged line\r\u001b[2Kb" });
    expect(p.stderr[0]?.trimEnd()).not.toMatch(/[\r\n\u001b]/);
  });

  it("stays short whatever a label holds", () => {
    const p = fakeProcess();
    p.register().progress({ step: "x".repeat(10_000) });
    expect(p.stderr[0]?.length).toBeLessThanOrEqual(201);
  });

  it("leaves out the free-form detail", () => {
    const p = fakeProcess();
    p.register().progress({ replay: 1, detail: { note: "only-for-the-diagnostic" } });
    expect(p.stderr.join("")).not.toContain("only-for-the-diagnostic");
  });

  it("is not printed after the command completed", () => {
    const p = fakeProcess();
    const handle = p.register();
    handle.complete();
    handle.progress({ replay: 1 });
    expect(p.stderr).toEqual([]);
  });
});

describe("a stderr that refuses a progress line", () => {
  it("does not throw into the run", () => {
    const p = fakeProcess();
    const handle = p.register();
    p.breakStderr();
    expect(() => handle.progress({ replay: 1 })).not.toThrow();
  });

  it("is not tried again", () => {
    const p = fakeProcess();
    const handle = p.register();
    p.breakStderr();
    handle.progress({ replay: 1 });
    handle.progress({ replay: 2 });
    expect(p.events.filter((e) => e === "stderr-refused")).toHaveLength(1);
  });

  it("does not end the run", () => {
    const p = fakeProcess();
    const handle = p.register();
    p.breakStderr();
    handle.progress({ replay: 1 });
    expect(p.events).toEqual(["stderr-refused"]);
  });

  it("still restarts the inactivity limit", async () => {
    const p = fakeProcess();
    const handle = p.register({ inactivityMs: 1_000 });
    p.breakStderr();
    await fakeClock.advanceBy(900);
    handle.progress({ replay: 1 });
    await fakeClock.advanceBy(900);
    expect(p.stdout).toEqual([]);
  });

  it("still lets a later trigger report on stdout", async () => {
    const p = fakeProcess();
    const handle = p.register({ inactivityMs: 1_000 });
    p.breakStderr();
    handle.progress({ replay: 1 });
    await fakeClock.advanceBy(1_000);
    expect(p.envelopes()[0]?.error.code).toBe("E_TERMINAL_WATCHDOG");
  });
});

describe("the parent going away", () => {
  it("exits 129 after ending the process's browsers", () => {
    const p = fakeProcess();
    p.register();
    p.loseParent();
    expect(p.events).toEqual(["stdout", "terminate-browsers", "exit 129"]);
  });

  it("has its own code, apart from a real signal", () => {
    const p = fakeProcess();
    p.register();
    p.loseParent();
    expect(p.envelopes()[0]?.error.code).toBe("E_TERMINAL_PARENT_GONE");
  });

  it("says so, and names the switch that keeps a detached run going", () => {
    const p = fakeProcess();
    p.register();
    p.loseParent();
    expect(p.envelopes()[0]?.error.message).toBe(
      "journey verify: the parent process went away, no signal was sent (set JEVITATE_PARENT_WATCHDOG=off to keep a detached run going) before any progress was reported",
    );
  });

  it("claims no signal in the diagnostic", () => {
    const p = fakeProcess();
    p.register();
    p.loseParent();
    expect(p.envelopes()[0]?.data).not.toHaveProperty("signal");
  });

  it("marks the artifact inconclusive and terminated", () => {
    const p = fakeProcess();
    p.register({ artifactPath: "/out/a.json" });
    p.loseParent();
    expect(p.results[0]).toMatchObject({ missionOutcome: "inconclusive", exitCode: 129, result: { stop: "terminated" } });
  });
});

describe("exactly once", () => {
  it("a second trigger of another kind writes nothing more", async () => {
    const p = fakeProcess();
    p.register({ artifactPath: "/out/a.json", inactivityMs: 1_000 });
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
      { command: "c", json: true, secrets: [], inactivityMs: 1_000, artifactPath: "/out/a.json" },
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
        sharedProcess: () => false,
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

describe("a broken output pipe", () => {
  const EPIPE = Object.assign(new Error("write EPIPE"), { code: "EPIPE" });

  function pipes() {
    const stdout = new EventEmitter();
    const stderr = new EventEmitter();
    let exits = 0;
    installBrokenPipePolicy({ stdout, stderr }, () => {
      exits += 1;
    });
    return { stdout, stderr, exits: () => exits };
  }

  it("on stderr does not end a plain command", () => {
    const pipe = pipes();
    pipe.stderr.emit("error", EPIPE);
    expect(pipe.exits()).toBe(0);
  });

  it("on stderr does not end a running registered command", () => {
    const p = fakeProcess();
    p.register();
    const pipe = pipes();
    pipe.stderr.emit("error", EPIPE);
    expect(pipe.exits()).toBe(0);
  });

  it("on stdout ends a plain command", () => {
    const pipe = pipes();
    pipe.stdout.emit("error", EPIPE);
    expect(pipe.exits()).toBe(1);
  });

  it("on stdout does not end a running registered command", () => {
    const p = fakeProcess();
    p.register();
    const pipe = pipes();
    pipe.stdout.emit("error", EPIPE);
    expect(pipe.exits()).toBe(0);
  });

  it("on stdout ends a registered command that completed", () => {
    const p = fakeProcess();
    p.register().complete();
    const pipe = pipes();
    pipe.stdout.emit("error", EPIPE);
    expect(pipe.exits()).toBe(1);
  });

  it("on stdout does not end the command around one that completed", () => {
    const p = fakeProcess();
    p.register({ command: "outer" });
    p.register({ command: "inner" }).complete();
    const pipe = pipes();
    pipe.stdout.emit("error", EPIPE);
    expect(pipe.exits()).toBe(0);
  });

  it.each(["stdout", "stderr"] as const)("any other error on %s is still thrown", (name) => {
    const pipe = pipes();
    expect(() => pipe[name].emit("error", Object.assign(new Error("boom"), { code: "EIO" }))).toThrow("boom");
  });
});

describe("a rejection reaching the entry point", () => {
  it("is left to the caller when nothing was registered", () => {
    expect(reportCommandRejection(new Error("plain"), () => {})).toBe(false);
  });

  it("ends a running command through the layer", () => {
    const p = fakeProcess();
    p.register();
    reportCommandRejection(new Error("boom"));
    expect(p.envelopes()[0]?.error.code).toBe("E_TERMINAL_INTERNAL");
  });

  it("is redacted for a running command", () => {
    const p = fakeProcess();
    p.register();
    reportCommandRejection(new Error(`failed with ${SECRET}`));
    expect(p.stdout.join("")).not.toContain(SECRET);
  });

  it("is redacted for a command that already completed", () => {
    const p = fakeProcess();
    p.register().complete();
    const printed: string[] = [];
    reportCommandRejection(new Error(`cleanup failed with ${SECRET}`), (text) => printed.push(text));
    expect(printed).toEqual(["Error: cleanup failed with «redacted»\n"]);
  });

  it("prints no second envelope for a command that already completed", () => {
    const p = fakeProcess();
    p.register().complete();
    reportCommandRejection(new Error("cleanup failed"), () => {});
    expect(p.stdout).toEqual([]);
  });

  it("exits inconclusive for a command that already completed", () => {
    const p = fakeProcess();
    p.register().complete();
    reportCommandRejection(new Error("cleanup failed"), () => {});
    expect(process.exitCode).toBe(2);
  });
});

describe("inside an MCP tool call", () => {
  it("prints no progress", () => {
    const p = fakeProcess();
    p.shareProcess();
    p.register().progress({ replay: 1 });
    expect(p.events).toEqual([]);
  });

  it("the inactivity limit does not end the shared server", async () => {
    const p = fakeProcess();
    p.shareProcess();
    p.register({ inactivityMs: 1_000 });
    await fakeClock.advanceBy(1_000);
    expect(p.events).toEqual([]);
  });

  it("a signal leaves the protocol channel alone", () => {
    const p = fakeProcess();
    installMissionKillSwitch(p.killDeps);
    p.shareProcess();
    p.register();
    p.signal("SIGTERM");
    expect(p.stdout).toEqual([]);
  });

  it("fail throws to the runner instead of exiting", () => {
    const p = fakeProcess();
    p.shareProcess();
    expect(() => p.register().fail(new Error("boom"))).toThrow("boom");
  });

  it("fail's error is redacted", () => {
    const p = fakeProcess();
    p.shareProcess();
    let message = "";
    try {
      p.register().fail(new Error(`boom ${SECRET}`));
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).not.toContain(SECRET);
  });

  it("still refuses an unusable limit", () => {
    const p = fakeProcess();
    p.shareProcess();
    expect(() => p.register({ inactivityMs: 0 })).toThrow(RangeError);
  });

  it("the real seam recognises the runner's scope", async () => {
    const failure = await runAsMcpInvocation(async () => {
      const handle = registerTerminalResult({ command: "c", json: true, secrets: [], inactivityMs: 1_000 });
      return () => handle.fail(new Error("from the shared process"));
    });
    await expect(runAsMcpInvocation(async () => failure())).rejects.toThrow("from the shared process");
  });
});
