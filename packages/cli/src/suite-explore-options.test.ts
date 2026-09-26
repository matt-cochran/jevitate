import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { UsageTracker } from "@jevitate/ai-core";
import { ProfileManager } from "@jevitate/daemon";
import { buildProgram } from "./program.js";
import { runCheck, type CheckGateways, type CheckRunners } from "./check-api.js";
import { SUITE_FIELDS, SuiteError, parseSuite } from "./check-suite.js";
import {
  ALL_KINDS,
  SUITE_DEDICATED_EXPLORE_OPTIONS,
  SUITE_EXCLUDED_EXPLORE_OPTIONS,
  SUITE_EXPLORE_OPTIONS,
  type ExploreItemKind,
  type SuiteExploreOptionName,
} from "./suite-explore-options.js";

/**
 * #195: a `check --suite` item takes `explore`'s option set. These tests hold the suite to the REAL
 * `explore` command: every explore option is accepted by a suite item (or excluded with a reason),
 * every accepted one is validated path-precisely and reaches the runner it applies to, and a suite
 * can never carry a literal secret.
 */

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "jevitate-suite-opts-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const URL0 = "https://shop.example/app";

function exploreCommand() {
  const program = buildProgram({ profiles: new ProfileManager("/unused") });
  const cmd = program.commands.find((c) => c.name() === "explore");
  if (cmd === undefined) throw new Error("no explore command");
  return cmd;
}

const LIST_SHAPES = new Set(["strings", "named-paths", "env-refs", "env-bindings"]);

describe("the suite item option set is explore's (#195)", () => {
  it("every explore option is accepted by a suite item, dedicated, or excluded with a reason — and only one of those", () => {
    const attrs = exploreCommand().options.map((o) => o.attributeName());
    const generic = Object.keys(SUITE_EXPLORE_OPTIONS);
    const dedicated = Object.keys(SUITE_DEDICATED_EXPLORE_OPTIONS);
    const excluded = Object.keys(SUITE_EXCLUDED_EXPLORE_OPTIONS);
    const undecided = attrs.filter((a) => !generic.includes(a) && !dedicated.includes(a) && !excluded.includes(a));
    expect(undecided, "explore options a suite item neither accepts nor excludes (decide them in suite-explore-options.ts)").toEqual([]);
    for (const a of attrs) expect([generic, dedicated, excluded].filter((l) => l.includes(a)).length, a).toBe(1);
    // Nothing stale: every table entry is a real explore option.
    expect([...generic, ...dedicated, ...excluded].filter((a) => !attrs.includes(a))).toEqual([]);
    for (const reason of Object.values(SUITE_EXCLUDED_EXPLORE_OPTIONS)) expect(reason.length).toBeGreaterThan(20);
  });

  it("each generic option's shape matches its explore flag (a repeatable flag is a list, a switch a boolean)", () => {
    for (const o of exploreCommand().options) {
      const a = o.attributeName();
      if (!(a in SUITE_EXPLORE_OPTIONS)) continue;
      const shape = SUITE_EXPLORE_OPTIONS[a as SuiteExploreOptionName].shape;
      if (o.isBoolean() || o.negate) expect(shape, a).toBe("boolean");
      else if (Array.isArray(o.defaultValue)) expect(LIST_SHAPES.has(shape), `${a}: ${shape}`).toBe(true);
      else expect(shape === "boolean" || LIST_SHAPES.has(shape), `${a}: ${shape}`).toBe(false);
    }
  });

  it("each dedicated option is a field of the suite levels it is declared at", () => {
    for (const [attr, d] of Object.entries(SUITE_DEDICATED_EXPLORE_OPTIONS)) {
      for (const at of d.at) expect(SUITE_FIELDS[at] as readonly string[], `${attr} -> ${at}.${d.key}`).toContain(d.key);
    }
  });
});

// ── per-option samples: what to set, with which companions, on which kind of item ─────────────

interface Sample {
  readonly kind: ExploreItemKind;
  readonly set: unknown;
  /** Companion options the option only means something with (present in the baseline too). */
  readonly with?: Record<string, unknown>;
}

function files(): { state: string; state2: string; upload: string; personas: string; log: string } {
  const state = join(dir, "alice.json");
  const state2 = join(dir, "bob.json");
  writeFileSync(state, JSON.stringify({ cookies: [], origins: [] }));
  writeFileSync(state2, JSON.stringify({ cookies: [], origins: [] }));
  const upload = join(dir, "upload.csv");
  writeFileSync(upload, "a,b\n");
  const personas = join(dir, "personas.json");
  writeFileSync(personas, JSON.stringify({ admin: "alice.json", viewer: "bob.json" }));
  const log = join(dir, "app.log");
  writeFileSync(log, "");
  return { state, state2, upload, personas, log };
}

function samples(f: ReturnType<typeof files>): Record<SuiteExploreOptionName, Sample> {
  const logs = { logSource: [`file:${f.log}`] };
  return {
    show: { kind: "usability", set: "actionable" },
    minConfidence: { kind: "usability", set: 0.5 },
    scope: { kind: "coverage", set: "app" },
    secret: { kind: "goal", set: ["env:SUITE_SECRET"] },
    totp: { kind: "goal", set: ["label=Code=env:SUITE_TOTP"] },
    fixture: { kind: "goal", set: "upload.csv" },
    actor: { kind: "goal", set: ["alice=alice.json", "bob=bob.json"] },
    saveStorageState: { kind: "feature", set: "saved.json" },
    persona: { kind: "feature", set: ["admin=alice.json"] },
    personas: { kind: "feature", set: "personas.json" },
    stallTimeout: { kind: "feature", set: 5 },
    replyWaitMs: { kind: "goal", set: 1000 },
    replyCeilingMs: { kind: "goal", set: 2000 },
    replyMaxChars: { kind: "goal", set: 100 },
    jobWaitMs: { kind: "goal", set: 3000 },
    deny: { kind: "feature", set: ["/^Archive/i"] },
    paid: { kind: "feature", set: ["/^Analyze/"] },
    allowDestructive: { kind: "feature", set: true },
    allowWrites: { kind: "goal", set: true },
    allowWrite: { kind: "goal", set: ["/api/drafts/**"] },
    readRpc: { kind: "goal", set: ["Estimate*"] },
    hangReplayWrites: { kind: "goal", set: true },
    settleIgnore: { kind: "coverage", set: ["*/poll*"] },
    longPollMs: { kind: "coverage", set: 9000 },
    apiPrefix: { kind: "coverage", set: ["/api/"] },
    ignoreNoProgress: { kind: "coverage", set: ["/busy/*"] },
    hangReplays: { kind: "adversarial", set: 0 },
    minControlCoverage: { kind: "adversarial", set: 0.5 },
    requireFormSubmit: { kind: "adversarial", set: false },
    logSource: { kind: "feature", set: [`file:${f.log}`] },
    allowLogCmd: { kind: "feature", set: true, with: logs },
    logDefect: { kind: "feature", set: ["error"] },
    logQuietOk: { kind: "feature", set: [`file:${f.log}`], with: logs },
    logIgnore: { kind: "feature", set: ["/noise/"], with: logs },
    serverLogDrainMs: { kind: "feature", set: 100, with: logs },
    checkOverflow: { kind: "coverage", set: true },
    ignoreOverflow: { kind: "coverage", set: [".carousel"] },
    before: { kind: "goal", set: "true", with: { allowShellHooks: true } },
    after: { kind: "goal", set: "true", with: { allowShellHooks: true } },
    allowShellHooks: { kind: "goal", set: true, with: { before: "true" } },
    // a hook outliving the timeout fails the setup: the runner is never reached
    hookTimeoutMs: { kind: "goal", set: 50, with: { before: "sleep 1", allowShellHooks: true } },
  };
}

const ENV = { SUITE_SECRET: "s3cr3t-value", SUITE_TOTP: "JBSWY3DPEHPK3PXP" };

function item(kind: ExploreItemKind, opts: Record<string, unknown>): { goals?: unknown[]; missions?: unknown[] } {
  if (kind === "goal") return { goals: [{ name: "g", goal: "do it", success: ["urlIncludes:/done"], ...opts }] };
  const extra = kind === "feature" ? { feature: "f" } : kind === "usability" ? { goal: "job", appClass: "consumer" } : {};
  return { missions: [{ name: "m", strategy: kind, ...extra, ...opts }] };
}

function suiteOf(target: Record<string, unknown>) {
  return parseSuite({ version: 1, name: "opts", targets: [{ name: "shop", url: URL0, ...target }] }, join(dir, "suite.json"));
}

/** Every runner records its options and throws (the item errors; only what reached it matters). */
function recordingRunners(calls: unknown[]): Partial<CheckRunners> {
  const rec = (kind: string) =>
    (async (o: unknown) => {
      calls.push({ kind, o });
      throw new Error("recorded");
    }) as never;
  return { goal: rec("goal"), coverage: rec("coverage"), adversarial: rec("adversarial"), feature: rec("feature"), usability: rec("usability") };
}

function serialize(v: unknown): string {
  return JSON.stringify(v, (_k, x: unknown) => {
    if (x instanceof Map) return [...x.entries()];
    if (typeof x === "function") return "fn";
    if (x instanceof RegExp) return String(x);
    if (x !== null && typeof x === "object" && !Array.isArray(x) && Object.getPrototypeOf(x) !== Object.prototype) {
      // class instances (fixtures, matchers): their own enumerable state
      return { ...(x as Record<string, unknown>), __class: (x as object).constructor.name };
    }
    return x;
  });
}

async function runnerCalls(target: Record<string, unknown>): Promise<string> {
  const calls: unknown[] = [];
  const gw: CheckGateways = { judge: {} as CheckGateways["judge"], gen: {} as CheckGateways["gen"], usage: new UsageTracker() };
  let refused: string | undefined;
  try {
    await runCheck({
      suite: suiteOf(target),
      outDir: join(dir, "out"),
      journeysDir: dir,
      runners: recordingRunners(calls),
      gateways: async () => gw,
      aiMode: "fake",
      env: ENV,
    });
  } catch (e) {
    refused = String(e); // a preflight refusal (e.g. hooks without allowShellHooks) is what the options did
  }
  return serialize({ calls, refused });
}

describe("every generic option is validated and applied (#195)", () => {
  it("is accepted on an item it applies to and as a target default, and refused, naming the path, on an item it does not", () => {
    const f = files();
    for (const [key, s] of Object.entries(samples(f))) {
      const opts = { ...s.with, [key]: s.set };
      expect(() => suiteOf(item(s.kind, opts)), key).not.toThrow();
      expect(() => suiteOf({ ...opts, ...item(s.kind, {}) }), key).not.toThrow();
      const applies: readonly ExploreItemKind[] = SUITE_EXPLORE_OPTIONS[key as SuiteExploreOptionName].appliesTo;
      const other = ALL_KINDS.find((k) => !applies.includes(k));
      if (other === undefined) continue;
      const at = other === "goal" ? "goals[0]" : "missions[0]";
      expect(() => suiteOf(item(other, { [key]: s.set })), `${key} on ${other}`).toThrow(
        new RegExp(`\\$\\.targets\\[0\\]\\.${at.replace(/[[\]]/g, "\\$&")}\\.${key}: does not apply to a`),
      );
    }
  });

  it("has a sample here for every generic option (add one when adding an option)", () => {
    expect(Object.keys(samples(files())).sort()).toEqual(Object.keys(SUITE_EXPLORE_OPTIONS).sort());
  });

  it("reaches the runner: set on the item — and as a target default — it changes what the runner is called with", async () => {
    const f = files();
    for (const [key, s] of Object.entries(samples(f))) {
      const baseline = await runnerCalls(item(s.kind, { ...s.with }));
      const onItem = await runnerCalls(item(s.kind, { ...s.with, [key]: s.set }));
      expect(onItem, `${key} on the item did not reach the ${s.kind} runner`).not.toBe(baseline);
      const asDefault = await runnerCalls({ [key]: s.set, ...item(s.kind, { ...s.with }) });
      expect(asDefault, `${key} as a target default`).toBe(onItem);
    }
  }, 120_000);

  it("an item's value replaces the target's default", async () => {
    const calls: Array<{ kind: string; o: { target?: { safety?: { deny?: string[] } } } }> = [];
    await runCheck({
      suite: suiteOf({ deny: ["/^Archive/"], missions: [{ name: "a", strategy: "feature", feature: "a" }, { name: "b", strategy: "feature", feature: "b", deny: ["/^Delete/"] }] }),
      outDir: join(dir, "out"),
      journeysDir: dir,
      runners: recordingRunners(calls),
    });
    expect(calls.map((c) => (c.o as { safety?: { deny?: string[] } }).safety?.deny)).toEqual([["/^Archive/"], ["/^Delete/"]]);
  });
});

describe("per-item sessions (#195)", () => {
  it("an item runs with its own storageState, none with null, else the target's; a persona item runs once per persona", async () => {
    const f = files();
    const calls: Array<{ kind: string; o: { storageState?: string } }> = [];
    const r = await runCheck({
      suite: suiteOf({
        storageState: "alice.json",
        missions: [
          { name: "default", strategy: "feature", feature: "a" },
          { name: "own", strategy: "feature", feature: "a", storageState: "bob.json" },
          { name: "fresh", strategy: "feature", feature: "a", storageState: null },
          { name: "matrix", strategy: "feature", feature: "a", persona: ["admin=alice.json", "viewer=bob.json"] },
        ],
      }),
      outDir: join(dir, "out"),
      journeysDir: dir,
      runners: recordingRunners(calls),
    });
    expect(calls.map((c) => c.o.storageState)).toEqual([f.state, f.state2, undefined, f.state, f.state2]);
    expect(r.items.map((i) => i.name)).toEqual(["default", "own", "fresh", "matrix@admin", "matrix@viewer"]);
  });

  it("refuses a missing item storage state before anything runs", async () => {
    await expect(
      runCheck({ suite: suiteOf({ missions: [{ name: "m", strategy: "feature", feature: "a", storageState: "nope.json" }] }), outDir: join(dir, "out"), journeysDir: dir, runners: recordingRunners([]) }),
    ).rejects.toThrow(/target shop: mission m: storage state not found: .*nope\.json/);
  });
});

describe("a suite never carries a literal secret (#195)", () => {
  const refuse = (target: Record<string, unknown>): string => {
    try {
      suiteOf(target);
    } catch (e) {
      expect(e).toBeInstanceOf(SuiteError);
      return (e as Error).message;
    }
    throw new Error("accepted");
  };

  it("secret takes env:<VAR> references only; totp and secretFields env bindings only — and the literal is never echoed", () => {
    for (const [target, at] of [
      [item("goal", { secret: ["hunter2"] }), "goals[0].secret[0]"],
      [{ secret: ["hunter2"] }, "secret[0]"],
      [item("goal", { totp: ["label=Code=hunter2"] }), "goals[0].totp[0]"],
      [item("goal", { secretFields: ["label=Password=hunter2"] }), "goals[0].secretFields[0]"],
      [{ secretFields: ["label=Password=hunter2"] }, "secretFields[0]"],
    ] as const) {
      const msg = refuse(target);
      expect(msg).toContain(`$.targets[0].${at}: `);
      expect(msg).toContain("never carries a literal secret");
      expect(msg).not.toContain("hunter2");
    }
  });

  it("resolves env references at preflight; an unset variable is refused naming it, never a value", async () => {
    const calls: Array<{ kind: string; o: { secrets?: string[] } }> = [];
    const gw: CheckGateways = { judge: {} as CheckGateways["judge"], gen: {} as CheckGateways["gen"], usage: new UsageTracker() };
    const base = { outDir: join(dir, "out"), journeysDir: dir, runners: recordingRunners(calls), gateways: async () => gw, aiMode: "fake" as const };
    await runCheck({ ...base, suite: suiteOf(item("goal", { secret: ["env:SUITE_SECRET"] })), env: ENV });
    expect(calls[0]?.o.secrets).toEqual(["s3cr3t-value"]);
    await expect(runCheck({ ...base, suite: suiteOf(item("goal", { secret: ["env:SUITE_SECRET"] })), env: {} })).rejects.toThrow(
      "target shop: goal g: secret env:SUITE_SECRET: environment variable SUITE_SECRET is not set",
    );
  });
});

describe("suite validation stays path-precise (#195)", () => {
  it("names the path of a bad option value, and suggests the camelCase name for a flag spelling", () => {
    expect(() => suiteOf(item("feature", { stallTimeout: -1 }))).toThrow("$.targets[0].missions[0].stallTimeout: must be a positive number");
    expect(() => suiteOf(item("feature", { deny: ["/(/"] }))).toThrow(/\$\.targets\[0\]\.missions\[0\]\.deny: deny "\/\(\/": /);
    expect(() => suiteOf(item("coverage", { scope: "page" }))).toThrow('$.targets[0].missions[0].scope: must be "app"');
    expect(() => suiteOf({ "api-prefix": ["/api/"] })).toThrow('$.targets[0].api-prefix: unknown field; did you mean "apiPrefix"?');
    expect(() => suiteOf(item("goal", { replyMaxChars: 5 }))).toThrow("$.targets[0].goals[0].replyMaxChars: must be an integer in 20..2000");
    expect(() => suiteOf(item("feature", { persona: ["admin"] }))).toThrow("$.targets[0].missions[0].persona[0]: must be '<name>=<storageState path>'");
    expect(() => suiteOf(item("goal", { actor: ["a=x.json"], storageState: "y.json" }))).toThrow("$.targets[0].goals[0].storageState: cannot be combined with actor/persona/personas");
  });
});
