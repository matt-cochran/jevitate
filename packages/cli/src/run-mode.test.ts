import { afterEach, beforeEach, describe, expect, expectTypeOf, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadEnvironmentsFile } from "./environments.js";
import { loadTargetsFile, resolveTargetConfig, TargetConfigError } from "./target-config.js";
import { resolveTargetTrust, runModeFor, stricterTrust, type RunMode, type TargetTrust } from "./run-mode.js";

/** 0.30.0 contract 4 (docs/design/0.30.0-evidence-and-trust.md §5): run modes and target trust. */

const ORIGIN = "https://app.example.test";
let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "jev-run-mode-"));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const write = (name: string, content: unknown): string => {
  const p = join(root, name);
  writeFileSync(p, JSON.stringify(content));
  return p;
};

describe("runModeFor", () => {
  it("has the signature (trust: TargetTrust) => RunMode and takes no second argument", () => {
    expectTypeOf(runModeFor).toEqualTypeOf<(trust: TargetTrust) => RunMode>();
    expect(runModeFor.length).toBe(1);
    // @ts-expect-error nothing a caller passes can choose the mode
    runModeFor("unknown", "test");
  });

  it.each<[TargetTrust, RunMode]>([
    ["test", "test"],
    ["harness", "test"],
    ["production", "automation"],
    ["unknown", "automation"],
  ])("trust %s runs in %s mode", (trust, mode) => {
    expect(runModeFor(trust)).toBe(mode);
  });
});

describe("resolveTargetTrust", () => {
  it("an origin absent from both files is unknown, which runs in automation mode", () => {
    const envs = loadEnvironmentsFile(write("environments.json", { other: { baseUrl: "https://other.test", trust: "test" } }));
    const targets = loadTargetsFile(write("targets.json", { "https://other.test": { trust: "test" } }));
    const trust = resolveTargetTrust({ targetConfig: targets[ORIGIN], origin: ORIGIN });
    expect(trust).toBe("unknown");
    expect(runModeFor(trust)).toBe("automation");
    expect(resolveTargetTrust({ origin: ORIGIN })).toBe("unknown");
    expect(envs.other?.trust).toBe("test");
  });

  it("environments.json trust:test with targets.json trust:production for one origin is production", () => {
    const envs = loadEnvironmentsFile(write("environments.json", { staging: { baseUrl: ORIGIN, trust: "test" } }));
    const targets = loadTargetsFile(write("targets.json", { [ORIGIN]: { trust: "production" } }));
    const trust = resolveTargetTrust({ environment: envs.staging, targetConfig: resolveTargetConfig(targets, ORIGIN), origin: ORIGIN });
    expect(trust).toBe("production");
    expect(runModeFor(trust)).toBe("automation");
  });

  it("synthetic: true alone is unknown (data, not trust)", () => {
    const envs = loadEnvironmentsFile(write("environments.json", { seeded: { baseUrl: ORIGIN, synthetic: true } }));
    expect(resolveTargetTrust({ environment: envs.seeded, origin: ORIGIN })).toBe("unknown");
  });

  it("production: true is honoured as trust: production", () => {
    const envs = loadEnvironmentsFile(write("environments.json", { prod: { baseUrl: ORIGIN, production: true } }));
    expect(resolveTargetTrust({ environment: envs.prod, origin: ORIGIN })).toBe("production");
    // and it still holds against an operator file that says test
    expect(resolveTargetTrust({ environment: envs.prod, targetConfig: { trust: "test" }, origin: ORIGIN })).toBe("production");
  });

  it("the stricter wins: production > unknown > harness > test", () => {
    const order: TargetTrust[] = ["test", "harness", "unknown", "production"];
    for (const [i, a] of order.entries()) {
      for (const [j, b] of order.entries()) expect(stricterTrust(a, b)).toBe(order[Math.max(i, j)]);
    }
    expect(resolveTargetTrust({ environment: { baseUrl: ORIGIN, trust: "harness" }, targetConfig: { trust: "test" }, origin: ORIGIN })).toBe("harness");
    expect(resolveTargetTrust({ environment: { baseUrl: ORIGIN, trust: "test" }, targetConfig: { trust: "harness" }, origin: ORIGIN })).toBe("harness");
    expect(resolveTargetTrust({ environment: { baseUrl: ORIGIN, trust: "test" }, origin: ORIGIN })).toBe("test");
    expect(resolveTargetTrust({ targetConfig: { trust: "test" }, origin: ORIGIN })).toBe("test");
  });

  it("an environment's test trust covers its own origins only, never a --base-url elsewhere", () => {
    const env = { baseUrl: ORIGIN, origins: { api: "https://api.example.test" }, trust: "test" as const };
    expect(resolveTargetTrust({ environment: env, origin: "https://api.example.test" })).toBe("test");
    expect(resolveTargetTrust({ environment: env, origin: "https://APP.example.test." })).toBe("test");
    expect(resolveTargetTrust({ environment: env, origin: "https://elsewhere.test" })).toBe("unknown");
    // the operator's file still speaks for that other origin
    expect(resolveTargetTrust({ environment: env, targetConfig: { trust: "harness" }, origin: "https://elsewhere.test" })).toBe("harness");
    // a production declaration tightens whatever origin the run goes to
    expect(resolveTargetTrust({ environment: { baseUrl: ORIGIN, trust: "production" }, targetConfig: { trust: "test" }, origin: "https://elsewhere.test" })).toBe("production");
  });
});

describe("targets.json trust", () => {
  it("parses test, harness and production and passes through resolveTargetConfig", () => {
    const targets = loadTargetsFile(write("targets.json", { [ORIGIN]: { trust: "harness" } }));
    expect(targets[ORIGIN]).toEqual({ trust: "harness" });
    expect(resolveTargetConfig(targets, ORIGIN).trust).toBe("harness");
  });

  it("refuses an unknown value, listing the allowed ones", () => {
    for (const bad of ["staging", "unknown", true, 1]) {
      const p = write("targets.json", { [ORIGIN]: { trust: bad } });
      expect(() => loadTargetsFile(p)).toThrow(TargetConfigError);
      expect(() => loadTargetsFile(p)).toThrow(/\.trust must be one of "test", "harness", "production"/);
    }
  });

  it("a file without trust parses as before", () => {
    const targets = loadTargetsFile(write("targets.json", { [ORIGIN]: { secretFields: ["label=Password=env:PW"] } }));
    expect(targets[ORIGIN]).toEqual({ secretFields: ["label=Password=env:PW"] });
    expect(resolveTargetConfig(targets, ORIGIN)).not.toHaveProperty("trust");
  });
});

/**
 * §5.2, the trust table: who may do what. The rows are the contract later deliverables enforce;
 * here they are checked against `runModeFor`: a channel that may promote for one mode may authorise
 * a run on exactly the trusts that map to that mode.
 */
type Actor = "tty" | "pr-review" | "ci" | "non-interactive" | "mcp";
type Cell = "yes" | "no" | "tighten-only" | "n/a" | "test-targets-only";
interface TrustRow {
  readonly actor: Actor;
  readonly setTrust: Cell;
  readonly promoteForTest: Cell;
  readonly promoteForAutomation: Cell;
  readonly loosenPolicyOrPromoteTarget: Cell;
  readonly approveHeldAction: Cell;
  readonly supplySecret: Cell;
}
const TRUST_TABLE: readonly TrustRow[] = [
  { actor: "tty", setTrust: "yes", promoteForTest: "yes", promoteForAutomation: "yes", loosenPolicyOrPromoteTarget: "yes", approveHeldAction: "yes", supplySecret: "yes" },
  { actor: "pr-review", setTrust: "yes", promoteForTest: "yes", promoteForAutomation: "yes", loosenPolicyOrPromoteTarget: "n/a", approveHeldAction: "no", supplySecret: "no" },
  { actor: "ci", setTrust: "no", promoteForTest: "yes", promoteForAutomation: "no", loosenPolicyOrPromoteTarget: "no", approveHeldAction: "no", supplySecret: "test-targets-only" },
  { actor: "non-interactive", setTrust: "no", promoteForTest: "yes", promoteForAutomation: "no", loosenPolicyOrPromoteTarget: "no", approveHeldAction: "no", supplySecret: "test-targets-only" },
  { actor: "mcp", setTrust: "no", promoteForTest: "yes", promoteForAutomation: "no", loosenPolicyOrPromoteTarget: "tighten-only", approveHeldAction: "no", supplySecret: "no" },
];
const TRUSTS: readonly TargetTrust[] = ["test", "harness", "production", "unknown"];

describe("§5.2 trust table", () => {
  it.each(TRUST_TABLE)("$actor: a promotion it makes authorises runs on exactly the trusts of its modes", (row) => {
    const authorised = TRUSTS.filter((t) => (runModeFor(t) === "test" ? row.promoteForTest : row.promoteForAutomation) === "yes");
    expect(authorised).toEqual(row.promoteForAutomation === "yes" ? TRUSTS : ["test", "harness"]);
  });

  it.each(TRUST_TABLE)("$actor: only a person (tty or pr-review) sets trust or promotes for automation mode", (row) => {
    const person = row.actor === "tty" || row.actor === "pr-review";
    expect(row.setTrust === "yes").toBe(person);
    expect(row.promoteForAutomation === "yes").toBe(person);
  });

  it.each(TRUST_TABLE)("$actor: only tty approves a held action; no automated channel supplies a secret outside a test target", (row) => {
    expect(row.approveHeldAction === "yes").toBe(row.actor === "tty");
    expect(row.supplySecret === "yes").toBe(row.actor === "tty");
    if (row.supplySecret === "test-targets-only") expect(TRUSTS.filter((t) => runModeFor(t) === "test")).toEqual(["test", "harness"]);
  });

  it("an undeclared or production target is automation mode, so an mcp-only promotion cannot start a run there", () => {
    const mcp = TRUST_TABLE.find((r) => r.actor === "mcp");
    expect(mcp?.promoteForAutomation).toBe("no");
    expect(runModeFor(resolveTargetTrust({ origin: ORIGIN }))).toBe("automation");
    expect(runModeFor(resolveTargetTrust({ environment: { baseUrl: ORIGIN, production: true }, origin: ORIGIN }))).toBe("automation");
  });
});
