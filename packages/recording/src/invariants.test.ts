import { describe, expect, it } from "vitest";
import {
  InvariantSpecError,
  UNKNOWN,
  evaluateInvariantExpression,
  mergeInvariantSpecs,
  parseInvariantExpression,
  parseJsonPath,
  readJsonPath,
  validateInvariantSpec,
  type EvalValue,
} from "./invariants.js";

const ALLOW = { allowlist: ["http://app.test"], baseUrl: "http://app.test/start" };

const valid = {
  observe: {
    balance: { dom: { selector: "[data-testid=credit-balance]", number: true } },
    imports: { probe: { get: "/v1/imports?limit=1", json: "$.total" } },
    confirmEst: { dom: { selector: "[data-testid=confirm-estimate]", number: true, optional: true } },
    lastCharge: { network: { url: "**/v1/billing/credit-activity*", json: "$.entries[0].credits", optional: true } },
  },
  invariants: [
    { id: "charge-implies-delivery", require: "delta(balance) < 0 -> delta(imports) >= 1", settle: { withinMs: 60000, pollMs: 5000 } },
    { id: "open-is-free", when: { control: { name: "/Open as editable workspace/i" } }, require: "delta(balance) == 0" },
    { id: "estimate-honest", when: { control: { name: "/Confirm|Run/i" } }, require: "confirmEst == null || delta(balance) >= -1.5 * before(confirmEst)" },
    { id: "no-raw-rpc-errors", never: { pageText: "/\\[(deadline_exceeded|unavailable|internal)\\]/" } },
    { id: "banner-visible", always: { kind: "visible", target: { testId: "app-shell" } } },
  ],
};

function refusal(raw: unknown, opts = ALLOW): string[] {
  try {
    validateInvariantSpec(raw, opts);
  } catch (e) {
    if (e instanceof InvariantSpecError) return [...e.problems];
    throw e;
  }
  throw new Error("expected a refusal");
}

describe("invariant spec schema (#86)", () => {
  it("accepts the issue's example spec", () => {
    expect(validateInvariantSpec(valid, ALLOW).invariants).toHaveLength(5);
  });

  it("refuses unknown keys at every level, naming the path", () => {
    expect(refusal({ ...valid, extra: 1 }).join()).toMatch(/\(root\)|extra/);
    expect(refusal({ ...valid, invariants: [{ ...valid.invariants[1], script: "x()" }] }).join()).toMatch(/invariants\[0\]/);
    expect(
      refusal({ observe: { balance: { dom: { selector: "#b", eval: "1" } } }, invariants: [{ id: "a", require: "balance > 0" }] }).join(),
    ).toMatch(/observe\.balance\.dom/);
  });

  it("refuses a non-GET probe: post/put/delete/method/headers/body are unknown keys", () => {
    for (const probe of [
      { post: "/v1/imports" },
      { put: "/v1/imports" },
      { delete: "/v1/imports" },
      { get: "/v1/imports", method: "POST" },
      { get: "/v1/imports", headers: { authorization: "x" } },
      { get: "/v1/imports", body: "{}" },
    ]) {
      const problems = refusal({ observe: { n: { probe } }, invariants: [{ id: "a", require: "n > 0" }] });
      expect(problems.join(), JSON.stringify(probe)).toMatch(/observe\.n\.probe/);
    }
    // A probe is exactly one of get / head.
    expect(refusal({ observe: { n: { probe: { json: "$.a" } } }, invariants: [{ id: "a", require: "n > 0" }] }).join()).toMatch(
      /exactly one of get or head/,
    );
  });

  it("refuses a probe whose origin is not authorized, or that carries credentials", () => {
    const spec = (get: string) => ({ observe: { n: { probe: { get } } }, invariants: [{ id: "a", require: "n == 200" }] });
    expect(refusal(spec("http://evil.test/steal")).join()).toMatch(/observe\.n\.probe: origin http:\/\/evil\.test is not an authorized origin/);
    expect(refusal(spec("http://user:pw@app.test/x")).join()).toMatch(/credentials/);
    expect(refusal(spec("file:///etc/passwd")).join()).toMatch(/not an http/);
    // With no allowlist to check against, a probe is refused rather than trusted.
    expect(refusal(spec("/ok"), {} as typeof ALLOW).join()).toMatch(/authorized origins/);
    expect(validateInvariantSpec(spec("/ok"), ALLOW).invariants[0]?.id).toBe("a");
  });

  it("refuses an expression over an undeclared observable, or outside the grammar — never evaluated", () => {
    expect(refusal({ observe: { balance: valid.observe.balance }, invariants: [{ id: "a", require: "delta(balanse) == 0" }] })).toEqual([
      'invariants[0].require: unknown observable "balanse"',
    ]);
    for (const bad of ["process.exit(1)", "balance = 1", "balance > ", "`x`", "delta(1)", "balance[0] > 1"]) {
      expect(refusal({ observe: { balance: valid.observe.balance }, invariants: [{ id: "a", require: bad }] }).join(), bad).toMatch(
        /invariants\[0\]\.require/,
      );
    }
  });

  it("refuses a missing required field with its path, and malformed kinds", () => {
    expect(refusal({ observe: { balance: { dom: { number: true } } }, invariants: [{ id: "a", require: "balance > 0" }] }).join()).toMatch(
      /observe\.balance\.dom\.selector: exactly one of selector or target/,
    );
    expect(refusal({ invariants: [{ id: "a" }] }).join()).toMatch(/exactly one of require, never or always/);
    expect(refusal({ invariants: [] }).join()).toMatch(/invariants/);
    expect(refusal({ invariants: [{ id: "a", never: { pageText: "/(/" } }] }).join()).toMatch(/invalid regex/);
    expect(refusal({ invariants: [{ id: "../x", never: { pageText: "boom" } }] }).join()).toMatch(/invariants\[0\]\.id/);
    expect(
      refusal({ invariants: [{ id: "a", never: { pageText: "x" } }, { id: "a", never: { pageText: "y" } }] }).join(),
    ).toMatch(/duplicate invariant id/);
    expect(refusal({ observe: { delta: valid.observe.balance }, invariants: [{ id: "a", never: { pageText: "x" } }] }).join()).toMatch(
      /invalid observable name/,
    );
  });

  it("merges files, refusing a redefined observable or a repeated id", () => {
    const a = validateInvariantSpec({ observe: { b: valid.observe.balance }, invariants: [{ id: "a", require: "b > 0" }] }, ALLOW);
    const b = validateInvariantSpec({ observe: { b: valid.observe.balance }, invariants: [{ id: "b", require: "b >= 0" }] }, ALLOW);
    expect(mergeInvariantSpecs([a, b]).invariants.map((i) => i.id)).toEqual(["a", "b"]);
    expect(() => mergeInvariantSpecs([a, a])).toThrow(/repeats/);
    const c = validateInvariantSpec({ observe: { b: { dom: { selector: "#other" } } }, invariants: [{ id: "c", require: "b > 0" }] }, ALLOW);
    expect(() => mergeInvariantSpecs([a, c])).toThrow(/declared differently/);
  });
});

describe("invariant expressions: parsed, three-valued, never eval'ed", () => {
  const env = (before: Record<string, EvalValue>, after: Record<string, EvalValue>) => ({
    before: (n: string) => (n in before ? (before[n] as EvalValue) : UNKNOWN),
    after: (n: string) => (n in after ? (after[n] as EvalValue) : UNKNOWN),
  });
  const run = (src: string, before: Record<string, EvalValue>, after: Record<string, EvalValue>) =>
    evaluateInvariantExpression(parseInvariantExpression(src), env(before, after));

  it("before/after/delta, implication and arithmetic", () => {
    const expr = "delta(balance) < 0 -> delta(imports) >= 1";
    expect(run(expr, { balance: 100, imports: 3 }, { balance: 60, imports: 3 })).toBe(false);
    expect(run(expr, { balance: 100, imports: 3 }, { balance: 60, imports: 4 })).toBe(true);
    expect(run(expr, { balance: 100, imports: 3 }, { balance: 100, imports: 3 })).toBe(true);
    expect(run("delta(b) >= -1.5 * before(e)", { b: 100, e: 40 }, { b: 20, e: 40 })).toBe(false);
    expect(run("b == before(b) + 1", { b: 1 }, { b: 2 })).toBe(true);
    expect(run("-b < 0", { b: 1 }, { b: 1 })).toBe(true);
  });

  it("an unreadable observable is unknown — neither a pass nor a violation — unless logic decides", () => {
    expect(run("delta(b) == 0", { b: 1 }, {})).toBe(UNKNOWN);
    expect(run("delta(b) < 0 -> x > 0", { b: 1 }, { b: 1 })).toBe(true); // false antecedent decides
    expect(run("x > 0 || b == 1", {}, { b: 1 })).toBe(true);
    expect(run("x > 0 && b == 2", {}, { b: 1 })).toBe(false);
    expect(run("x > 0 && b == 1", {}, { b: 1 })).toBe(UNKNOWN);
  });

  it("null comparisons: == null decides, an ordering against null is unknown", () => {
    expect(run("e == null || e > 5", {}, { e: null })).toBe(true);
    expect(run("e > 5", {}, { e: null })).toBe(UNKNOWN);
    expect(run("delta(e) == null", { e: null }, { e: 3 })).toBe(true);
  });

  it("-> is right-associative and binds loosest", () => {
    expect(parseInvariantExpression("a -> b -> c")).toEqual(parseInvariantExpression("a -> (b -> c)"));
    expect(parseInvariantExpression("a || b -> c")).toEqual(parseInvariantExpression("(a || b) -> c"));
  });
});

describe("JSON path subset", () => {
  it("reads scalars (and an array's length), nothing else", () => {
    const body = { entries: [{ credits: -80 }], total: 3, list: [1, 2], nested: { a: { "b-c": "x" } } };
    expect(readJsonPath(body, parseJsonPath("$.entries[0].credits"))).toBe(-80);
    expect(readJsonPath(body, parseJsonPath("$.total"))).toBe(3);
    expect(readJsonPath(body, parseJsonPath("$.list"))).toBe(2);
    expect(readJsonPath(body, parseJsonPath('$.nested.a["b-c"]'))).toBe("x");
    expect(readJsonPath(body, parseJsonPath("$.nested"))).toBeUndefined();
    expect(readJsonPath(body, parseJsonPath("$.missing[0]"))).toBeUndefined();
    expect(readJsonPath(body, parseJsonPath("$.constructor"))).toBeUndefined();
    expect(() => parseJsonPath("$..credits")).toThrow();
    expect(() => parseJsonPath("$[?(@.x)]")).toThrow();
    expect(() => parseJsonPath("entries")).toThrow();
  });
});
