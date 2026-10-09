import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  SweepSpecError,
  aggregateSweep,
  loadSweepTargets,
  runSweep,
  sweepTargetOptions,
  targetArgv,
  type SweepPlan,
  type SweepResult,
  type SweepRunArgs,
  type SweepTarget,
} from "./sweep-api.js";
import type { RunEnvelope } from "./multi-run.js";

/**
 * #425 `jevitate sweep`: the targets file (validated up front, every problem listed), the argv each
 * target runs with, and the orchestration over a FAKE run-once — bounded concurrency, --resume,
 * --stop-on-env-failure, defects deduped by fingerprint across targets, environment causes grouped.
 */

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "jevitate-sweep-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function file(name: string, content: string): string {
  const p = join(dir, name);
  writeFileSync(p, content);
  return p;
}

const roots = (): string[] => [dir];

describe("loadSweepTargets", () => {
  it("reads JSON: routes against baseUrl, defaults, personas (named after the file or given), tags and typed options", () => {
    file("admin.json", "{}");
    file("sales.json", "{}");
    const p = file(
      "targets.json",
      JSON.stringify({
        baseUrl: "http://app.test",
        defaults: { strategy: "adversarial", tags: { release: "0.8.0" }, options: { maxDecisions: 2 } },
        targets: [
          { id: "billing", route: "/billing", persona: "admin.json", tags: { feature: "billing" }, options: { maxActions: 5, deny: ["Delete"], allowDestructive: false } },
          { id: "search", url: "http://app.test/search?q=x", persona: "sales=sales.json", strategy: "goal", goal: "find a product" },
          { id: "feature-run", route: "/settings", strategy: "goal", options: { feature: "save settings" }, persona: { name: "ops", storageState: "admin.json" } },
        ],
      }),
    );
    const t = loadSweepTargets(p, { roots: roots() });
    expect(t.map((x) => [x.id, x.url, x.strategy, x.persona?.name])).toEqual([
      ["billing", "http://app.test/billing", "adversarial", "admin"],
      ["search", "http://app.test/search?q=x", "goal", "sales"],
      ["feature-run", "http://app.test/settings", "goal", "ops"],
    ]);
    expect(t[0]!.persona!.storageState).toBe(join(dir, "admin.json"));
    expect(t[0]!.tags).toEqual({ release: "0.8.0", feature: "billing" });
    expect(t[0]!.optionArgv).toEqual(["--max-actions=5", "--max-decisions=2", "--deny=Delete"]);
    // --base-url wins over the file's baseUrl.
    expect(loadSweepTargets(p, { roots: roots(), baseUrl: "https://staging.test" })[0]!.url).toBe("https://staging.test/billing");
  });

  it("reads TSV: a header row, '#' comments, tags as k=v;k=v, option columns typed by their explore argument", () => {
    file("admin.json", "{}");
    const p = file(
      "targets.tsv",
      [
        "id\troute\tpersona\tstrategy\tgoal\ttags\tmaxActions\tdeny\tallowDestructive\tviewport",
        "# a comment",
        "home\t/\t\tadversarial\t\tfeature=home;owner=web\t3\t[\"Delete\",\"Pay\"]\ttrue\t800x600",
        "",
        "account\t/account\tadmin.json\tgoal\tchange the email\t\t\tLogout\t\t",
      ].join("\n"),
    );
    const t = loadSweepTargets(p, { roots: roots(), env: { JEVITATE_BASE_URL: "http://127.0.0.1:9" } });
    expect(t).toHaveLength(2);
    expect(t[0]).toMatchObject({ id: "home", url: "http://127.0.0.1:9/", tags: { feature: "home", owner: "web" } });
    expect(t[0]!.optionArgv).toEqual(["--max-actions=3", "--allow-destructive", "--deny=Delete", "--deny=Pay", "--viewport=800x600"]);
    expect(t[1]).toMatchObject({ id: "account", goal: "change the email", persona: { name: "admin" } });
    expect(t[1]!.optionArgv).toEqual(["--deny=Logout"]);
  });

  it("lists EVERY problem in one refusal (exit-64 code), nothing half-loaded", () => {
    mkdirSync(join(dir, "elsewhere"));
    const outside = mkdtempSync(join(tmpdir(), "jevitate-sweep-outside-"));
    try {
      writeFileSync(join(outside, "s.json"), "{}");
      const p = file(
        "bad.json",
        JSON.stringify([
          { id: "a", route: "/x" }, // no base URL; goal strategy without a goal
          { id: "a", url: "ftp://x", strategy: "nope" },
          { id: "../evil", url: "http://x.test/" },
          { id: "b", url: "http://x.test/", strategy: "adversarial", options: { logSource: ["cmd:rm -rf /"], storageState: "x.json", maxActions: "many" } },
          { id: "c", url: "http://x.test/", strategy: "adversarial", tags: { target: "other" }, persona: join(outside, "s.json") },
          { id: "d", url: "http://x.test/", strategy: "adversarial", persona: "missing.json", extra: 1 },
        ]),
      );
      let err: unknown;
      try {
        loadSweepTargets(p, { roots: roots(), env: {} });
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(SweepSpecError);
      const msg = (err as SweepSpecError).message;
      expect((err as SweepSpecError).code).toBe("E_SWEEP_SPEC");
      for (const fragment of [
        "route /x needs a base URL",
        "strategy goal needs a goal",
        "id a is used twice",
        "must be an absolute http(s) URL",
        'strategy "nope"',
        "id must be 1-64",
        "not-allowed explore option(s) logSource, storageState",
        "tag 'target' is reserved",
        "resolves outside the paths",
        "persona storage state not found",
        'unknown key "extra"',
      ]) {
        expect(msg, fragment).toContain(fragment);
      }
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("#428/#424/#427: allowControl, minActions, minDistinctStates and authCheck are per-target options, validated before any run", () => {
    const ok = file(
      "ok.json",
      JSON.stringify([
        { id: "g", url: "http://x.test/", goal: "list the main features", options: { allowControl: ["^Generate key$"], minActions: 4, minDistinctStates: 3, authCheck: "urlExcludes:/login" } },
      ]),
    );
    expect(loadSweepTargets(ok, { roots: roots() })[0]!.optionArgv).toEqual(
      expect.arrayContaining(["--allow-control=^Generate key$", "--min-actions=4", "--min-distinct-states=3", "--auth-check=urlExcludes:/login"]),
    );
    const bad = file(
      "bad-shaping.json",
      JSON.stringify([
        { id: "a", url: "http://x.test/", strategy: "adversarial", options: { allowControl: [".*"], minActions: 3 } },
        { id: "b", url: "http://x.test/", goal: "g", options: { allowControl: ["("], authCheck: "sometimes", deny: ["/[/"] } },
        { id: "c", url: "http://x.test/", strategy: "goal", options: { feature: "f", minDistinctStates: 2 } },
        { id: "d", url: "http://x.test/", goal: "g", options: { jevProvider: "typesafe" } },
      ]),
    );
    let msg = "";
    try {
      loadSweepTargets(bad, { roots: roots() });
    } catch (e) {
      msg = (e as Error).message;
    }
    for (const fragment of [
      "matches every control name",
      "minActions is supported only with strategy goal",
      'allowControl "("',
      "authCheck must be off, auto",
      "minDistinctStates is supported only with strategy goal (a goal or find-out run), not a feature run",
      "not-allowed explore option(s) jevProvider",
    ]) {
      expect(msg, fragment).toContain(fragment);
    }
    expect(msg).toMatch(/deny/);
  });

  it("a target may set only the value-typed run_exploration options (no paths, log commands, secrets, hooks)", () => {
    const allowed = Object.keys(sweepTargetOptions());
    expect(allowed).toEqual(expect.arrayContaining(["maxActions", "maxDecisions", "deny", "allowDestructive", "feature", "route", "viewport", "device"]));
    expect(allowed).toEqual(expect.arrayContaining(["allowControl", "minActions", "minDistinctStates", "authCheck"]));
    for (const forbidden of ["url", "goal", "strategy", "storageState", "persona", "invariants", "fixtures", "logSource", "secret", "out", "repeat", "tags", "real", "jevProvider"]) {
      expect(allowed, forbidden).not.toContain(forbidden);
    }
  });
});

// ── orchestration over a fake run-once ──────────────────────────────────────────────────────

function target(id: string, extra: Partial<SweepTarget> = {}): SweepTarget {
  return { id, url: `http://app.test/${id}`, strategy: "adversarial", tags: {}, options: {}, optionArgv: [], ...extra };
}

function plan(targets: SweepTarget[], extra: Partial<SweepPlan> = {}): SweepPlan {
  return { targetsPath: join(dir, "targets.json"), targets, concurrency: 1, resume: false, outDir: join(dir, "out"), tags: {}, runArgs: [], ...extra };
}

const result = (data: Record<string, unknown>): RunEnvelope => ({ ok: true, data: { missionOutcome: "clean", exitCode: 0, ...data } });
const defect = (fp: string, extra: Record<string, unknown> = {}) => ({ fingerprint: fp, kind: "http-5xx", title: `HTTP 500 ${fp}`, route: "/x", ...extra });
const tick = (): Promise<void> => new Promise((r) => setImmediate(r));

describe("runSweep", () => {
  it("runs every target with its own argv and tags, bounded by --concurrency, and writes ONE aggregate", async () => {
    let inFlight = 0;
    let peak = 0;
    const seen: SweepRunArgs[] = [];
    const targets = ["a", "b", "c", "d", "e"].map((id) => target(id, { tags: { feature: id } }));
    const r = await runSweep({
      plan: plan(targets, { concurrency: 2, tags: { release: "0.8.0" }, runArgs: ["--fake-ai"] }),
      nowIso: () => "2026-10-08T00:00:00.000Z",
      runOnce: async (args) => {
        seen.push(args);
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await tick();
        await tick();
        inFlight -= 1;
        return result({ depth: { distinctStates: 3, actions: 4, formsSubmitted: 1 }, resultPath: join(args.runDir, "x.result.json") });
      },
    });
    expect(peak).toBe(2);
    expect(seen.map((s) => s.target.id).sort()).toEqual(["a", "b", "c", "d", "e"]);
    const argv = seen.find((s) => s.target.id === "c")!.argv;
    expect(argv.slice(0, 5)).toEqual(["explore", "--url", "http://app.test/c", "--strategy", "adversarial"]);
    expect(argv).toEqual(expect.arrayContaining(["--tag", "release=0.8.0", "--tag", "feature=c", "--tag", "target=c", "--fake-ai", "--out", join(dir, "out", "c"), "--json"]));
    expect(r).toMatchObject({ kind: "sweep", complete: true, missionOutcome: "clean", exitCode: 0, summary: { targets: 5, ran: 5, errors: 0, skipped: 0, pending: 0 } });
    expect(r.targets[0]).toMatchObject({ id: "a", status: "ran", depth: { distinctStates: 3 }, tags: { release: "0.8.0", feature: "a", target: "a" } });
    const onDisk = JSON.parse(readFileSync(join(dir, "out", "sweep.result.json"), "utf8")) as SweepResult;
    expect(onDisk.summary).toEqual(r.summary);
    for (const id of ["a", "e"]) expect(existsSync(join(dir, "out", id, "run.envelope.json"))).toBe(true);
  });

  it("dedupes defects by fingerprint ACROSS targets (one finding, N sightings) and groups environment causes", async () => {
    const byId: Record<string, RunEnvelope> = {
      a: result({ missionOutcome: "defects-found", exitCode: 1, defects: [defect("f1"), defect("f2", { kind: "server-log", level: "error", source: "file:/var/log/app.log", message: "TypeError x", count: 3 })] }),
      b: result({ missionOutcome: "defects-found", exitCode: 1, defects: [defect("f1", { route: "/y" })], environmentFaults: { causes: [{ ruleId: "load", source: "host", message: "load 3/core", count: 2 }] } }),
      c: result({ missionOutcome: "defects-found", exitCode: 1, defects: [defect("f2", { kind: "server-log", count: 1 })], hangs: [{ fingerprint: "h1", kind: "hang" }], environmentDegraded: [{ kind: "environment-degraded", finding: "hang", cause: "load 3/core", detail: "x", advisory: true }] }),
      d: result({ environmentFaults: { causes: [{ ruleId: "load", source: "host", message: "load 3/core", count: 1 }] } }),
    };
    const r = await runSweep({ plan: plan(["a", "b", "c", "d"].map((id) => target(id))), runOnce: async ({ target: t }) => byId[t.id]! });
    expect(r.missionOutcome).toBe("defects-found");
    const f1 = r.defects.find((d) => d.fingerprint === "f1")!;
    expect(f1).toMatchObject({ kind: "http-5xx", sightingCount: 2, targets: ["a", "b"] });
    expect(f1.sightings.map((s) => s.route)).toEqual(["/x", "/y"]);
    expect(r.defects.find((d) => d.fingerprint === "f2")).toMatchObject({ kind: "server-log", level: "error", source: "file:/var/log/app.log", message: "TypeError x", sightingCount: 2, targets: ["a", "c"] });
    expect(r.defects.find((d) => d.fingerprint === "h1")).toMatchObject({ kind: "hang", targets: ["c"] });
    expect(r.summary.defects).toBe(3);
    expect(r.environment.causes).toContainEqual({ ruleId: "load", source: "host", message: "load 3/core", count: 3, targets: ["b", "d"] });
    expect(r.environment.causes).toContainEqual({ ruleId: "hang", message: "load 3/core", count: 1, targets: ["c"] });
  });

  it("--resume skips targets whose run finished (read back into the aggregate) and re-runs errors and the rest", async () => {
    const out = join(dir, "out");
    const first = await runSweep({
      plan: plan([target("a"), target("b"), target("c")], { outDir: out }),
      runOnce: async ({ target: t }) =>
        t.id === "b" ? { ok: false, error: { code: "E_EXPLORE_RUN", message: "browser failed to start" } } : result({ defects: t.id === "a" ? [defect("f1")] : [], missionOutcome: t.id === "a" ? "defects-found" : "clean" }),
    });
    expect(first.targets.map((t) => t.status)).toEqual(["ran", "error", "ran"]);
    expect(first.targets[1]).toMatchObject({ missionOutcome: "inconclusive", environmentFailure: { kind: "setup" } });
    const reran: string[] = [];
    const second = await runSweep({
      plan: plan([target("a"), target("b"), target("c"), target("d")], { outDir: out, resume: true }),
      runOnce: async ({ target: t }) => {
        reran.push(t.id);
        return result({});
      },
    });
    expect(reran).toEqual(["b", "d"]);
    expect(second.targets.map((t) => t.status)).toEqual(["resumed", "ran", "resumed", "ran"]);
    expect(second.summary).toMatchObject({ ran: 2, resumed: 2 });
    // The resumed run's defects still count in the aggregate.
    expect(second.defects.map((d) => d.fingerprint)).toEqual(["f1"]);
    expect(second.missionOutcome).toBe("defects-found");
  });

  it("--stop-on-env-failure K: the first K runs all failing for environment reasons stop the sweep; the rest are skipped", async () => {
    const started: string[] = [];
    const r = await runSweep({
      plan: plan(["a", "b", "c", "d", "e"].map((id) => target(id, { persona: { name: "admin", storageState: "/s.json" } })), { stopOnEnvFailure: 2 }),
      runOnce: async ({ target: t }) => {
        started.push(t.id);
        return t.id === "a"
          ? result({ missionOutcome: "inconclusive", exitCode: 2, failure: { kind: "auth-expired", message: "persona admin: session expired" } })
          : result({ missionOutcome: "inconclusive", exitCode: 2, failure: { kind: "target-unreachable", message: "ECONNREFUSED" } });
      },
    });
    expect(started).toEqual(["a", "b"]);
    expect(r.aborted).toMatchObject({ afterRuns: 2 });
    expect(r.aborted!.reason).toMatch(/first 2 run\(s\) all failed for environment\/setup reasons \(auth-expired, target-unreachable\)/);
    expect(r).toMatchObject({ complete: false, missionOutcome: "inconclusive", exitCode: 2, summary: { ran: 2, skipped: 3, environmentFailures: 2 } });
    expect(r.targets.slice(2).map((t) => [t.status, t.failure?.kind])).toEqual([
      ["skipped", "sweep-stopped"],
      ["skipped", "sweep-stopped"],
      ["skipped", "sweep-stopped"],
    ]);
    expect(r.environment.failures.map((f) => [f.kind, f.targets])).toEqual([
      ["auth-expired", ["a"]],
      ["target-unreachable", ["b"]],
    ]);
  });

  it("counts goal runs that executed zero actions as notStarted in the summary", async () => {
    const r = await runSweep({
      plan: plan(["a", "b"].map((id) => target(id, { strategy: "goal" }))),
      runOnce: async ({ target: t }) =>
        t.id === "a"
          ? result({ strategy: "goal", missionOutcome: "inconclusive", exitCode: 2, goalOutcome: "not-started", goalReason: "no-controls" })
          : result({ strategy: "goal", goalOutcome: "succeeded" }),
    });
    expect(r.summary.notStarted).toBe(1);
  });

  it("does not stop when one of the first K runs reached the app", async () => {
    const r = await runSweep({
      plan: plan(["a", "b", "c"].map((id) => target(id)), { stopOnEnvFailure: 2 }),
      runOnce: async ({ target: t }) => (t.id === "a" ? result({ missionOutcome: "crashed", exitCode: 2, failure: { kind: "exception", message: "boom" } }) : result({})),
    });
    expect(r.aborted).toBeUndefined();
    expect(r.summary.ran).toBe(3);
    expect(r.targets[0]!.environmentFailure).toMatchObject({ kind: "crashed" });
  });

  it("#427: an auth-expired run is an environment failure; #424/#428: depth and safetyOverrides reach the target row", async () => {
    const r = await runSweep({
      plan: plan([target("a", { persona: { name: "admin", storageState: "/s.json" } }), target("b")]),
      runOnce: async ({ target: t }) =>
        t.id === "a"
          ? result({ missionOutcome: "inconclusive", exitCode: 2, failure: { kind: "auth-expired", message: "persona admin: signed out (login page)" } })
          : result({ depth: { distinctStates: 6, actions: 9, formsSubmitted: 2 }, safetyOverrides: [{ step: 3, control: 'button "Generate key"', rule: "paid-heuristic", regex: "^Generate key$" }] }),
    });
    expect(r.targets[0]).toMatchObject({ environmentFailure: { kind: "auth-expired", message: "auth-expired: persona admin: signed out (login page)" }, missionOutcome: "inconclusive" });
    expect(r.environment.failures).toEqual([{ kind: "auth-expired", message: "auth-expired: persona admin: signed out (login page)", count: 1, targets: ["a"] }]);
    expect(r.targets[1]).toMatchObject({ depth: { distinctStates: 6, actions: 9, formsSubmitted: 2 }, safetyOverrides: [{ regex: "^Generate key$" }] });
  });

  it("an in-progress aggregate is incomplete and inconclusive, its unfinished targets pending", () => {
    const p = plan([target("a"), target("b")]);
    const partial = aggregateSweep({ plan: p, rows: [undefined, undefined], finished: [], startedAt: "t", complete: false });
    expect(partial).toMatchObject({ complete: false, missionOutcome: "inconclusive", reason: "incomplete: 0 of 2 target(s) finished", summary: { pending: 2, skipped: 0 } });
    expect(partial.targets.map((t) => t.status)).toEqual(["pending", "pending"]);
  });

  it("targetArgv: the sweep's operator flags come before the target's options; the target's tag of the same key wins", () => {
    const argv = targetArgv({ tags: { owner: "qa", feature: "x" }, runArgs: ["--deny", "Delete"] }, target("t", { goal: "g", tags: { feature: "y" }, optionArgv: ["--max-actions=3"] }), "/out/t");
    expect(argv).toEqual([
      "explore", "--url", "http://app.test/t", "--strategy", "adversarial", "--goal", "g",
      "--tag", "owner=qa", "--tag", "feature=y", "--tag", "target=t",
      "--deny", "Delete", "--max-actions=3", "--out", "/out/t", "--json",
    ]);
  });
});
