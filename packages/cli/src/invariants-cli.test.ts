import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProfileManager } from "@jevitate/daemon";
import { FakeGenerationGateway, FakeJudgmentGateway } from "@jevitate/ai-core";
import type { BrowserPort, OpenOptions } from "@jevitate/playwright";
import { buildProgram } from "./program.js";
import { InvariantsFileError, loadInvariantFiles, resolveInvariantAuthTokens } from "./invariants-file.js";
import { parsePersistedMission } from "./verify-fix-api.js";

/**
 * #86 — `--invariants <file>`: parsed, validated and authorized BEFORE any browser opens; a bad file
 * refuses the dispatch with a precise path. The port is a capturing fake that aborts at `open`.
 */

const URL = "http://127.0.0.1:3000/app";
const dir = mkdtempSync(join(tmpdir(), "jev-inv-"));
function file(name: string, content: unknown): string {
  const p = join(dir, name);
  writeFileSync(p, typeof content === "string" ? content : JSON.stringify(content));
  return p;
}

const GOOD = {
  observe: {
    balance: { dom: { selector: "[data-testid=credit-balance]", number: true } },
    imports: { probe: { get: "/v1/imports?limit=1", json: "$.total" } },
  },
  invariants: [{ id: "charge-implies-delivery", require: "delta(balance) < 0 -> delta(imports) >= 1" }],
};

function capture(): { program: ReturnType<typeof buildProgram>; lines: string[]; opens: OpenOptions[] } {
  const opens: OpenOptions[] = [];
  const port: BrowserPort = {
    async open(opts) {
      opens.push(opts);
      throw new Error("open intercepted by test");
    },
  };
  const lines: string[] = [];
  const program = buildProgram({
    profiles: new ProfileManager("/unused-in-these-tests"),
    explore: { judge: new FakeJudgmentGateway({}), gen: new FakeGenerationGateway(), browserPortFactory: () => port },
  });
  program.configureOutput({ writeOut: (s) => lines.push(s) });
  program.exitOverride();
  return { program, lines, opens };
}

const envelope = (lines: string[]): { ok: boolean; error?: { code: string; message: string } } =>
  JSON.parse(lines.join("").trim().split("\n").at(-1) ?? "{}");

describe("loadInvariantFiles (#86)", () => {
  const bounds = { allowlist: ["http://127.0.0.1:3000"], baseUrl: URL };

  it("loads and merges valid files", () => {
    const a = file("a.json", GOOD);
    const b = file("b.json", { invariants: [{ id: "no-raw-errors", never: { pageText: "/\\[internal\\]/" } }] });
    expect(loadInvariantFiles([a, b], bounds)?.invariants.map((i) => i.id)).toEqual(["charge-implies-delivery", "no-raw-errors"]);
    expect(loadInvariantFiles([], bounds)).toBeUndefined();
  });

  it("refuses unreadable JSON, a schema error with its path, an off-origin probe and a repeated id", () => {
    const refuse = (paths: string[]): string => {
      try {
        loadInvariantFiles(paths, bounds);
      } catch (e) {
        expect(e).toBeInstanceOf(InvariantsFileError);
        return (e as Error).message;
      }
      throw new Error("expected a refusal");
    };
    expect(refuse([join(dir, "missing.json")])).toMatch(/cannot read invariants file/);
    expect(refuse([file("bad.json", "{not json")])).toMatch(/cannot read invariants file/);
    expect(refuse([file("typo.json", { ...GOOD, invariants: [{ id: "x", require: "delta(balanse) < 0" }] })])).toMatch(
      /typo\.json: invariants\[0\]\.require: unknown observable "balanse"/,
    );
    expect(refuse([file("post.json", { ...GOOD, observe: { ...GOOD.observe, imports: { probe: { post: "/v1/imports" } } } })])).toMatch(
      /observe\.imports\.probe/,
    );
    expect(
      refuse([file("evil.json", { ...GOOD, observe: { ...GOOD.observe, imports: { probe: { get: "http://evil.test/x" } } } })]),
    ).toMatch(/origin http:\/\/evil\.test is not an authorized origin/);
    const g = file("g.json", GOOD);
    expect(refuse([g, g])).toMatch(/repeats/);
  });
});

describe("resolveInvariantAuthTokens (#135)", () => {
  const bounds = { allowlist: ["http://127.0.0.1:3000"], baseUrl: URL };
  const withAuth = {
    observe: {
      ...GOOD.observe,
      secure: { probe: { get: "/v1/secure", authFrom: { secret: "env:JEV_TEST_INV_TOKEN" } } },
    },
    invariants: [...GOOD.invariants, { id: "secure-ok", require: "secure > 0" }],
  };

  it("resolves an env: ref from the given environment — never process.env directly", () => {
    const spec = loadInvariantFiles([file("auth.json", withAuth)], bounds);
    expect(spec).toBeDefined();
    const tokens = resolveInvariantAuthTokens(spec!, { JEV_TEST_INV_TOKEN: "shh-secret-value" });
    expect(tokens).toEqual(new Map([["env:JEV_TEST_INV_TOKEN", "shh-secret-value"]]));
  });

  it("refuses (never crashes) when the referenced variable is unset — the ref is named, never a value", () => {
    const spec = loadInvariantFiles([file("auth2.json", withAuth)], bounds)!;
    expect(() => resolveInvariantAuthTokens(spec, {})).toThrow(InvariantsFileError);
    try {
      resolveInvariantAuthTokens(spec, {});
      throw new Error("expected a refusal");
    } catch (e) {
      expect(e).toBeInstanceOf(InvariantsFileError);
      expect((e as Error).message).toContain("env:JEV_TEST_INV_TOKEN");
      expect((e as Error).message).not.toContain("shh-secret-value");
    }
  });

  it("returns an empty map for a spec with no authFrom.secret refs", () => {
    const spec = loadInvariantFiles([file("noauth.json", GOOD)], bounds)!;
    expect(resolveInvariantAuthTokens(spec, {}).size).toBe(0);
  });
});

describe("explore --invariants (#86)", () => {
  it("a bad file refuses the dispatch before any browser opens, on every strategy", async () => {
    const bad = file("refuse.json", { ...GOOD, observe: { ...GOOD.observe, imports: { probe: { get: "/x", method: "DELETE" } } } });
    for (const argv of [
      ["explore", "--url", URL, "--goal", "g", "--success", "urlIncludes:/x"],
      ["explore", "--strategy", "coverage", "--url", URL],
      ["explore", "--strategy", "adversarial", "--url", URL],
      ["explore", "--url", URL, "--feature", "import"],
    ]) {
      const { program, lines, opens } = capture();
      await program.parseAsync([...argv, "--invariants", bad, "--json"], { from: "user" });
      expect(envelope(lines).error?.code, argv.join(" ")).toBe("E_EXPLORE_INVARIANTS");
      expect(envelope(lines).error?.message).toMatch(/observe\.imports\.probe/);
      expect(opens).toHaveLength(0);
    }
  });

  it("a probe off the --allow origins is refused; the same probe on an --allow origin is accepted", async () => {
    const api = file("api.json", { ...GOOD, observe: { ...GOOD.observe, imports: { probe: { get: "http://127.0.0.1:8088/v1/imports", json: "$.total" } } } });
    const refused = capture();
    await refused.program.parseAsync(["explore", "--strategy", "adversarial", "--url", URL, "--invariants", api, "--json"], { from: "user" });
    expect(envelope(refused.lines).error?.code).toBe("E_EXPLORE_INVARIANTS");
    expect(refused.opens).toHaveLength(0);

    const allowed = capture();
    await allowed.program.parseAsync(
      ["explore", "--strategy", "adversarial", "--url", URL, "--allow", "http://127.0.0.1:3000", "--allow", "http://127.0.0.1:8088", "--invariants", api, "--json"],
      { from: "user" },
    );
    expect(allowed.opens).toHaveLength(1); // validated, then the (intercepted) browser opened
  });

  it("is refused with --strategy usability (UX findings are advisory; invariants are hard defects)", async () => {
    const { program, lines, opens } = capture();
    await program.parseAsync(
      ["explore", "--strategy", "usability", "--url", URL, "--goal", "g", "--app-class", "admin", "--invariants", file("u.json", GOOD), "--json"],
      { from: "user" },
    );
    expect(envelope(lines).error?.code).toBe("E_EXPLORE_ARGS");
    expect(opens).toHaveLength(0);
  });
});

describe("verify-fix finds a declared-invariant defect and its spec in a persisted result (#86)", () => {
  const recording = {
    version: "1.0.0",
    site: "t",
    pages: [{ url: "/app", steps: [{ step: { kind: "navigate", url: "/app", expect: { kind: "urlIncludes", text: "/app" } } }] }],
  };
  const result = (invariantSpec: unknown) => ({
    missionOutcome: "defects-found",
    exitCode: 1,
    result: {
      recording,
      target: { seedUrl: URL, allowlist: ["http://127.0.0.1:3000"] },
      defects: [{ fingerprint: "a".repeat(16), kind: "invariant", invariant: { id: "charge-implies-delivery" }, repro: { recordingStepIndex: 0 } }],
      invariantSpec,
    },
  });

  it("carries the invariant id and the validated spec", () => {
    const m = parsePersistedMission(result(GOOD));
    expect(m.findings[0]?.invariantId).toBe("charge-implies-delivery");
    expect(m.invariantSpec?.invariants[0]?.id).toBe("charge-implies-delivery");
  });

  it("drops a persisted spec that no longer validates (its defect is then inconclusive, never fixed)", () => {
    expect(parsePersistedMission(result({ ...GOOD, extra: 1 })).invariantSpec).toBeUndefined();
  });
});
