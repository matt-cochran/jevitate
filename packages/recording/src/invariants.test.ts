import { describe, expect, it } from "vitest";
import {
  InvariantSpecError,
  UNKNOWN,
  evaluateInvariantExpression,
  invariantActors,
  invariantAuthSecretRefs,
  invariantGate,
  invariantObserver,
  mergeInvariantSpecs,
  parseInvariantExpression,
  parseJsonPath,
  readJsonPath,
  readJsonPathList,
  substituteCaptureRefs,
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

  it("#135: a probe's authFrom is exactly one of localStorage, cookie or secret", () => {
    const spec = (authFrom: unknown) => ({
      observe: { n: { probe: { get: "/v1/imports", authFrom } } },
      invariants: [{ id: "a", require: "n > 0" }],
    });
    expect(validateInvariantSpec(spec({ localStorage: "tok" }), ALLOW).invariants[0]?.id).toBe("a");
    expect(validateInvariantSpec(spec({ cookie: "sid" }), ALLOW).invariants[0]?.id).toBe("a");
    expect(validateInvariantSpec(spec({ secret: "env:APP_TOKEN" }), ALLOW).invariants[0]?.id).toBe("a");
    expect(validateInvariantSpec(spec({ localStorage: "tok", scheme: "" }), ALLOW).invariants[0]?.id).toBe("a");
    expect(refusal(spec({}), ALLOW).join()).toMatch(/exactly one of localStorage, cookie or secret/);
    expect(refusal(spec({ localStorage: "tok", cookie: "sid" }), ALLOW).join()).toMatch(/exactly one of localStorage, cookie or secret/);
    // A `secret` ref must look like `env:VAR` — the same shape --secret-field uses.
    expect(refusal(spec({ secret: "APP_TOKEN" }), ALLOW).join()).toMatch(/a secret ref must be "env:VAR"/);
    expect(refusal(spec({ secret: "file:///etc/passwd" }), ALLOW).join()).toMatch(/a secret ref must be "env:VAR"/);
    // Never a new method/payload surface: authFrom stays additive to a read-only GET/HEAD.
    expect(refusal(spec({ localStorage: "tok", header: "X-Api-Key" }), ALLOW).join()).toMatch(/observe\.n\.probe\.authFrom/);
  });

  it("#135: invariantAuthSecretRefs lists every distinct env: ref a spec's probes declare", () => {
    const spec = validateInvariantSpec(
      {
        observe: {
          a: { probe: { get: "/x", authFrom: { secret: "env:TOK_A" } } },
          b: { probe: { get: "/y", authFrom: { secret: "env:TOK_A" } } },
          c: { probe: { get: "/z", authFrom: { secret: "env:TOK_B" } } },
          d: { dom: { selector: "#d" } },
        },
        invariants: [{ id: "i", require: "a > 0 && b > 0 && c > 0 && d > 0" }],
      },
      ALLOW,
    );
    expect(invariantAuthSecretRefs(spec).sort()).toEqual(["env:TOK_A", "env:TOK_B"]);
    expect(invariantAuthSecretRefs({ invariants: [] })).toEqual([]);
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
    expect(refusal({ invariants: [{ id: "a" }] }).join()).toMatch(/exactly one of require, never, always or deniedAs/);
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

describe("budget declarations (#150)", () => {
  it("accepts a budget-only spec (no invariants required)", () => {
    const spec = validateInvariantSpec(
      {
        observe: { credits: valid.observe.balance, confirmEst: valid.observe.confirmEst },
        invariants: [],
        budget: [{ observe: "credits", maxDelta: -150, guard: { estimate: "confirmEst", factor: 2 }, settle: { withinMs: 60000, pollMs: 5000 } }],
      },
      ALLOW,
    );
    expect(spec.budget).toHaveLength(1);
    expect(spec.invariants).toHaveLength(0);
  });

  it("refuses a spec with neither invariants nor budget", () => {
    expect(refusal({ invariants: [] }).join()).toMatch(/invariants/);
  });

  it("refuses a budget over an undeclared observable, or a guard estimate over an undeclared one", () => {
    expect(
      refusal({ observe: { credits: valid.observe.balance }, invariants: [], budget: [{ observe: "balanse", maxDelta: -10 }] }).join(),
    ).toMatch(/budget\[0\]\.observe: unknown observable "balanse"/);
    expect(
      refusal({
        observe: { credits: valid.observe.balance },
        invariants: [],
        budget: [{ observe: "credits", maxDelta: -10, guard: { estimate: "nope" } }],
      }).join(),
    ).toMatch(/budget\[0\]\.guard\.estimate: unknown observable "nope"/);
  });

  it("refuses a zero maxDelta and a non-GET-shaped budget object", () => {
    expect(
      refusal({ observe: { credits: valid.observe.balance }, invariants: [], budget: [{ observe: "credits", maxDelta: 0 }] }).join(),
    ).toMatch(/maxDelta/);
    expect(
      refusal({ observe: { credits: valid.observe.balance }, invariants: [], budget: [{ observe: "credits", maxDelta: -10, post: "/x" }] }).join(),
    ).toMatch(/Unrecognized key/);
  });

  it("merges budgets across files", () => {
    const a = validateInvariantSpec(
      { observe: { credits: valid.observe.balance }, invariants: [], budget: [{ observe: "credits", maxDelta: -10 }] },
      ALLOW,
    );
    const b = validateInvariantSpec(
      { observe: { credits: valid.observe.balance }, invariants: [{ id: "x", require: "credits >= 0" }] },
      ALLOW,
    );
    expect(mergeInvariantSpecs([a, b]).budget).toHaveLength(1);
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

describe("multi-actor specs (#147): captures, observers, cross-actor checks", () => {
  const OBS = { ...ALLOW, observers: ["intruder"] };
  const denied = {
    actor: "intruder",
    open: "${capture.pieceUrl}",
    expect: {
      documentStatus: [403, 404],
      appResponses: { url: "**/GetWorkspace", status: [404], connectCode: ["not_found", "permission_denied"] },
      orVisible: "/not found|isn't available/i",
    },
  };
  const cross = {
    capture: {
      pieceId: { network: { url: "**/WorkspaceService/CreateWorkspace", json: "$.workspace.id" } },
      pieceUrl: { url: { after: { control: { name: "/Create|Save/i" } }, route: "/w/*" } },
      pieceDom: { dom: { selector: "[data-created]", read: "attr:data-id", after: { op: ["click"] } } },
    },
    observe: {
      intruderList: { probe: { as: "intruder", get: "/v1/workspaces?limit=100", json: "$.items[*].id" } },
      intruderGet: { probe: { as: "intruder", get: "/v1/workspaces/${capture.pieceId}" } },
    },
    invariants: [
      { id: "not-listed-cross-tenant", when: { after: "capture.pieceId" }, require: "!contains(intruderList, pieceId)" },
      { id: "not-readable-cross-tenant", when: { after: "capture.pieceId" }, require: "intruderGet == 404 || intruderGet == 403" },
      { id: "not-openable-cross-tenant", when: { after: "capture.pieceUrl" }, deniedAs: denied },
    ],
  };
  const withDenied = (d: object): unknown => ({ ...cross, invariants: [{ id: "x", when: { after: "capture.pieceUrl" }, deniedAs: d }] });

  it("accepts the issue's design with a registered observer", () => {
    const spec = validateInvariantSpec(cross, OBS);
    expect(spec.capture?.pieceId).toBeDefined();
    expect(invariantActors(spec)).toEqual(["intruder"]);
    expect(spec.invariants.map((i) => invariantGate(i))).toEqual(["pieceId", "pieceId", "pieceUrl"]);
    expect(spec.invariants.map((i) => invariantObserver(spec, i))).toEqual(["intruder", "intruder", "intruder"]);
  });

  it("refuses an actor that is not a registered observer (or any actor with none registered)", () => {
    expect(refusal(cross, ALLOW).join("\n")).toMatch(/actor "intruder" is not registered/);
    expect(refusal(cross, { ...ALLOW, observers: ["b"] }).join("\n")).toMatch(/actor "intruder" is not a registered observer \(have: b\)/);
  });

  it("refuses an observer's observable read around every action, and a deniedAs with no capture gate", () => {
    const p1 = refusal({ ...cross, invariants: [{ id: "x", require: "intruderList == 0" }] }, OBS);
    expect(p1.join("\n")).toMatch(/invariants\[0\]\.when: "intruderList" is read as another actor/);
    const p2 = refusal({ ...cross, invariants: [{ id: "x", deniedAs: denied }] }, OBS);
    expect(p2.join("\n")).toMatch(/deniedAs needs when\.after/);
  });

  it("refuses unknown captures, a gate with other when keys, and a capture that could set an origin", () => {
    const unknownGate = refusal({ ...cross, invariants: [{ id: "x", when: { after: "capture.nope" }, require: "!contains(intruderList, pieceId)" }] }, OBS);
    expect(unknownGate.join("\n")).toMatch(/invariants\[0\]\.when\.after: unknown capture "nope"/);
    const unknownRef = refusal({ ...cross, observe: { ...cross.observe, bad: { probe: { as: "intruder", get: "/v1/${capture.ghost}" } } } }, OBS);
    expect(unknownRef.join("\n")).toMatch(/observe\.bad\.probe: unknown capture "ghost"/);
    const mixed = refusal(
      { ...cross, invariants: [{ id: "x", when: { after: "capture.pieceId", op: ["click"] }, require: "!contains(intruderList, pieceId)" }] },
      OBS,
    );
    expect(mixed.join("\n")).toMatch(/when takes no other key/);
    // Only a url capture (the primary's own, authorized page URL) may start a URL.
    expect(refusal(withDenied({ ...denied, open: "${capture.pieceId}/x" }), OBS).join("\n")).toMatch(/only a url capture may start a URL/);
    expect(refusal(withDenied({ ...denied, open: "http://evil.test/${capture.pieceId}" }), OBS).join("\n")).toMatch(
      /deniedAs\.open: origin http:\/\/evil\.test is not an authorized origin/,
    );
  });

  it("refuses malformed captures and denial expectations; a probe stays GET/HEAD as another actor too", () => {
    const twoKinds = refusal({ ...cross, capture: { ...cross.capture, both: { network: { url: "**", json: "$.id" }, url: { after: { op: ["click"] } } } } }, OBS);
    expect(twoKinds.join("\n")).toMatch(/capture\.both: a capture is exactly one of network, dom or url/);
    const emptyAfter = refusal({ ...cross, capture: { ...cross.capture, pieceUrl: { url: { after: {} } } } }, OBS);
    expect(emptyAfter.join("\n")).toMatch(/after names at least one of control, route or op/);
    expect(refusal(withDenied({ actor: "intruder", open: "/w/1", expect: {} }), OBS).join("\n")).toMatch(/expect names at least one of/);
    expect(
      refusal(withDenied({ actor: "intruder", open: "/w/1", expect: { appResponses: { url: "**", connectCode: ["NotFound"] } } }), OBS).join("\n"),
    ).toMatch(/Connect code is snake_case/);
    expect(refusal({ ...cross, observe: { ...cross.observe, w: { probe: { as: "intruder", post: "/v1/x" } } } }, OBS).join("\n")).toMatch(/Unrecognized key/);
  });

  it("merges captures, refusing one declared differently in two files", () => {
    const a = validateInvariantSpec(cross, OBS);
    const b = validateInvariantSpec({ capture: { pieceId: { network: { url: "**/other", json: "$.id" } } }, invariants: [{ id: "y", never: { pageText: "x" } }] }, OBS);
    expect(() => mergeInvariantSpecs([a, b])).toThrow(/capture\.pieceId: declared differently/);
  });

  it("! and contains(): Kleene-safe, ids compared as text, a list never compared with ==", () => {
    const run = (src: string, vals: Record<string, EvalValue>) =>
      evaluateInvariantExpression(parseInvariantExpression(src), { before: (n) => (n in vals ? (vals[n] as EvalValue) : UNKNOWN), after: (n) => (n in vals ? (vals[n] as EvalValue) : UNKNOWN) });
    expect(run("!contains(l, id)", { l: ["item-1", "item-2"], id: "item-3" })).toBe(true);
    expect(run("!contains(l, id)", { l: ["item-1", 42], id: "42" })).toBe(false);
    expect(run("contains(t, id)", { t: "owner of item-9", id: "item-9" })).toBe(true);
    expect(run("!contains(l, id)", { l: null, id: "x" })).toBe(true);
    expect(run("!contains(l, id)", { id: "x" })).toBe(UNKNOWN);
    expect(run("l == 2", { l: [1, 2] })).toBe(UNKNOWN);
    expect(run("!(a > 1)", { a: 0 })).toBe(true);
    expect(() => parseInvariantExpression("contains(a)")).toThrow();
  });

  it("[*] JSON paths fan out into a list of scalars; read as one value they are its size", () => {
    const body = { items: [{ id: "a" }, { id: 2 }, { nope: 1 }], empty: [] };
    expect(readJsonPathList(body, parseJsonPath("$.items[*].id"))).toEqual(["a", 2]);
    expect(readJsonPathList(body, parseJsonPath("$.empty[*].id"))).toEqual([]);
    expect(readJsonPathList(body, parseJsonPath("$.missing[*].id"))).toBeUndefined();
    expect(readJsonPath(body, parseJsonPath("$.items[*].id"))).toBe(2);
  });

  it("substitutes capture refs: URL-encoded inside a path, raw when the whole template, null when unbound", () => {
    const v: Record<string, string> = { id: "a/b?c", url: "http://app.test/w/1" };
    expect(substituteCaptureRefs("/v1/w/${capture.id}", (n) => v[n])).toBe("/v1/w/a%2Fb%3Fc");
    expect(substituteCaptureRefs("${capture.url}", (n) => v[n])).toBe("http://app.test/w/1");
    expect(substituteCaptureRefs("/v1/${capture.gone}", (n) => v[n])).toBeNull();
  });
});
