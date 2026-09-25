import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TargetConfigError, loadTargetsFile, resolveTargetConfig } from "./target-config.js";

let dir: string | undefined;
afterEach(async () => {
  if (dir !== undefined) await rm(dir, { recursive: true, force: true });
});

describe("per-target settle/hang config (~/.jevitate/targets.json)", () => {
  it("is keyed by origin; flags add patterns and override numbers", async () => {
    dir = await mkdtemp(join(tmpdir(), "jev-targets-"));
    const p = join(dir, "targets.json");
    await writeFile(
      p,
      JSON.stringify({
        "http://localhost:3000": { settle: { ignoreRequests: ["/api/poll*"], longPollMs: 4000 }, hangs: { ignoreNoProgress: ["click Refresh*"] } },
      }),
    );
    const file = loadTargetsFile(p);
    expect(resolveTargetConfig(file, "http://localhost:3000", { settleIgnore: ["/hub/*"], longPollMs: 2000 })).toEqual({
      settle: { ignoreRequests: ["/api/poll*", "/hub/*"], longPollMs: 2000 },
      hangs: { ignoreNoProgress: ["click Refresh*"] },
      timing: {},
    });
    expect(resolveTargetConfig(file, "http://other.test", { apiPrefixes: ["/graphql"] })).toEqual({
      settle: {},
      hangs: {},
      timing: { apiPrefixes: ["/graphql"] },
    });
  });

  it("#153: safety.hangReplayWrites is read from the file, the flag also opts in, and a non-boolean fails closed", async () => {
    dir = await mkdtemp(join(tmpdir(), "jev-targets-"));
    const p = join(dir, "targets.json");
    await writeFile(p, JSON.stringify({ "http://a.test": { safety: { hangReplayWrites: true } }, "http://b.test": {} }));
    const file = loadTargetsFile(p);
    expect(resolveTargetConfig(file, "http://a.test").safety?.hangReplayWrites).toBe(true);
    expect(resolveTargetConfig(file, "http://b.test").safety?.hangReplayWrites).toBeUndefined();
    expect(resolveTargetConfig(file, "http://b.test", { hangReplayWrites: true }).safety?.hangReplayWrites).toBe(true);
    await writeFile(p, JSON.stringify({ "http://a.test": { safety: { hangReplayWrites: "yes" } } }));
    expect(() => loadTargetsFile(p)).toThrow(TargetConfigError);
  });

  it("#181: safety.paid is read from the file and --paid patterns are added to it", async () => {
    dir = await mkdtemp(join(tmpdir(), "jev-targets-"));
    const p = join(dir, "targets.json");
    await writeFile(p, JSON.stringify({ "http://a.test": { safety: { paid: ["/^Analyze/"] } } }));
    const file = loadTargetsFile(p);
    expect(resolveTargetConfig(file, "http://a.test", { paid: ["Draft"] }).safety?.paid).toEqual(["/^Analyze/", "Draft"]);
    expect(resolveTargetConfig(file, "http://b.test").safety?.paid).toBeUndefined();
    await writeFile(p, JSON.stringify({ "http://a.test": { safety: { paid: "Analyze" } } }));
    expect(() => loadTargetsFile(p)).toThrow(TargetConfigError);
  });

  it("a missing file is no config; a malformed one fails closed", async () => {
    dir = await mkdtemp(join(tmpdir(), "jev-targets-"));
    expect(loadTargetsFile(join(dir, "none.json"))).toEqual({});
    const bad = join(dir, "bad.json");
    await writeFile(bad, JSON.stringify({ "http://a.test": { settle: { longPollMs: -1 } } }));
    expect(() => loadTargetsFile(bad)).toThrow(TargetConfigError);
    await writeFile(bad, JSON.stringify({ "http://a.test": { settle: { ignoreRequests: "x" } } }));
    expect(() => loadTargetsFile(bad)).toThrow(TargetConfigError);
  });

  it("#142 follow-up: logSources/logDefect/allowLogCmd round-trip — the ONLY place an operator can declare a --log-source outside the CLI flag", async () => {
    dir = await mkdtemp(join(tmpdir(), "jev-targets-"));
    const p = join(dir, "targets.json");
    await writeFile(
      p,
      JSON.stringify({
        "http://localhost:3000": {
          logSources: ["docker:app-1", "cmd:tail -f /var/log/app.log"],
          logDefect: ["error", "/Not Authorized/i"],
          allowLogCmd: true,
        },
      }),
    );
    const file = loadTargetsFile(p);
    const resolved = resolveTargetConfig(file, "http://localhost:3000");
    expect(resolved.logSources).toEqual(["docker:app-1", "cmd:tail -f /var/log/app.log"]);
    expect(resolved.logDefect).toEqual(["error", "/Not Authorized/i"]);
    expect(resolved.allowLogCmd).toBe(true);
    // An origin with no entry gets none of these — never inherited/defaulted from elsewhere.
    expect(resolveTargetConfig(file, "http://other.test").logSources).toBeUndefined();
  });

  it("#142 follow-up: a non-array logSources/logDefect, or a non-boolean allowLogCmd, fails closed", async () => {
    dir = await mkdtemp(join(tmpdir(), "jev-targets-"));
    const bad = join(dir, "bad.json");
    await writeFile(bad, JSON.stringify({ "http://a.test": { logSources: "file:/x" } }));
    expect(() => loadTargetsFile(bad)).toThrow(TargetConfigError);
    await writeFile(bad, JSON.stringify({ "http://a.test": { logDefect: [1] } }));
    expect(() => loadTargetsFile(bad)).toThrow(TargetConfigError);
    await writeFile(bad, JSON.stringify({ "http://a.test": { allowLogCmd: "yes" } }));
    expect(() => loadTargetsFile(bad)).toThrow(TargetConfigError);
  });
});
