import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { adjudicate, rejudge } from "./adjudicate.js";
import { RunEvidenceSchema, type DoneReading, type Known, type ReplayEvidence, type RunEvidence } from "./evidence.js";
import type { Verdict } from "./verdict.js";

const known = <T>(value: T): Known<T> => ({ known: true, value });
const writes = () => ({ sent: known(1), answered: known(1), aborted: known(0), openAtClose: known(0), shapes: [] });
const reading = (value: boolean | undefined, at: "pre" | "post"): DoneReading => ({
  value: value === undefined ? { known: false, reason: "session-unavailable" } : known(value),
  session: "fresh",
  at,
  durationMs: 500,
});
const replay = (ordinal: number, role: ReplayEvidence["role"], rest: Partial<ReplayEvidence> = {}): ReplayEvidence => ({
  ordinal,
  role,
  outcome: "passed",
  failedSites: [],
  writes: writes(),
  ...rest,
});

function base(trust: RunEvidence["run"]["target"]["trust"] = "test"): RunEvidence {
  return {
    schema: "jevitate.evidence",
    version: 1,
    producedAt: "2026-11-08T12:00:00.000Z",
    producer: { jevitate: "0.30.0" },
    subject: { kind: "journey-run", journey: { id: "add-todo", hash: "sha256:abc" }, job: { id: "keep-a-list", hash: "sha256:def" } },
    run: { mode: "test", channel: "cli", target: { origin: "http://127.0.0.1:4173", trust }, paramsDigest: "hmac:1", secretParamNames: [] },
    steps: [
      { index: 1, kind: "navigate", outcome: "ok", postcondition: "none", writes: known(0) },
      { index: 2, kind: "click", outcome: "ok", postcondition: "held", writes: known(1) },
    ],
    writes: writes(),
    judgments: [{ advisory: true, task: "done.grounded", step: 2, probability: 0.97, threshold: 0.8 }],
    notes: [],
  };
}

const withDone = (before: boolean | undefined, after: boolean | undefined, e: RunEvidence = base()): RunEvidence => ({
  ...e,
  doneCheck: { spec: { version: 1, at: "/todos", check: "textIncludes:${title}" }, before: reading(before, "pre"), after: reading(after, "post") },
});

/** block-write:2 breaks step 2's own postcondition, and (relaxed) the end state; skip:2 breaks the end state. */
function proof(trust: RunEvidence["run"]["target"]["trust"] = "test"): RunEvidence {
  return {
    ...withDone(false, true, base(trust)),
    subject: { kind: "mutation-proof", journey: { id: "add-todo", hash: "sha256:abc" } },
    mutation: {
      plan: {
        mutations: [
          { id: "block-write:2", kind: "block-write", step: 2 },
          { id: "skip:2", kind: "skip", step: 2 },
        ],
        pairs: [
          { site: "step:2", mutation: "block-write:2" },
          { site: "end-state:0", mutation: "block-write:2" },
          { site: "end-state:0", mutation: "skip:2" },
        ],
        sites: [
          { site: "step:2", check: "page textIncludes" },
          { site: "end-state:0", check: "page count" },
        ],
      },
      replays: [
        replay(0, "base"),
        replay(1, "independence"),
        replay(2, "mutated", { mutation: "block-write:2", outcome: "failed", failedSites: [{ where: "step", step: 2, postcondition: true }] }),
        replay(3, "relaxed", { mutation: "block-write:2", outcome: "failed", failedSites: [{ where: "end-state", index: 0 }] }),
        replay(4, "mutated", { mutation: "skip:2", outcome: "failed", failedSites: [{ where: "end-state", index: 0 }] }),
        replay(5, "closing"),
      ],
      restore: "none",
      isolation: known("isolated"),
    },
  };
}

/** end-state:0 only looks like a cascade (step 3 caught it first); a targeted proof relaxing step:3 reaches it. */
function targetedProof(struck = false): RunEvidence {
  const e = proof();
  return {
    ...e,
    mutation: {
      ...e.mutation!,
      plan: {
        mutations: [{ id: "skip:2", kind: "skip", step: 2 }],
        pairs: [
          { site: "step:3", mutation: "skip:2" },
          { site: "end-state:0", mutation: "skip:2" },
        ],
        sites: [
          { site: "step:3", check: "page textIncludes" },
          { site: "end-state:0", check: "page count" },
        ],
      },
      replays: [
        replay(0, "base"),
        replay(1, "independence"),
        replay(2, "mutated", { mutation: "skip:2", outcome: "failed", failedSites: [{ where: "step", step: 3, postcondition: true }] }),
        replay(3, "targeted", {
          mutation: "skip:2",
          site: "end-state:0",
          relaxedSites: ["step:3"],
          outcome: "failed",
          failedSites: [{ where: "end-state", index: 0 }],
          ...(struck ? { waitsCut: ["end-state:0"] } : {}),
        }),
        replay(4, "control", { mutation: "skip:2", site: "end-state:0", relaxedSites: ["step:3"] }),
        replay(5, "closing"),
      ],
    },
  };
}

/** One step-2 proof with the given plan and mutated replays, around a passing base and closing replay. */
function proofWith(plan: NonNullable<RunEvidence["mutation"]>["plan"], mutated: readonly ReplayEvidence[]): RunEvidence {
  const e = proof();
  return {
    ...e,
    mutation: {
      ...e.mutation!,
      plan,
      replays: [replay(0, "base"), replay(1, "independence"), ...mutated.map((r, i) => ({ ...r, ordinal: i + 2 })), replay(mutated.length + 2, "closing")],
    },
  };
}

/** #811: block-write:2 failed step 2's DOM postcondition AND its own request check, which the applied run evaluated; the relaxed rerun passed. */
function ownRequest(evaluated: boolean): RunEvidence {
  return proofWith(
    {
      mutations: [{ id: "block-write:2", kind: "block-write", step: 2 }],
      pairs: [
        { site: "step:2", mutation: "block-write:2" },
        { site: "step-request:2:0", mutation: "block-write:2" },
      ],
      sites: [
        { site: "step:2", check: "page textIncludes" },
        { site: "step-request:2:0", check: "requestMade POST" },
      ],
    },
    [
      replay(0, "mutated", {
        mutation: "block-write:2",
        outcome: "failed",
        failedSites: [
          { where: "step", step: 2, postcondition: true },
          { where: "step-request", step: 2, checkIndex: 0, ...(evaluated ? { evaluated: true as const } : {}) },
        ],
      }),
      replay(0, "relaxed", { mutation: "block-write:2" }),
    ],
  );
}

/** #811: end-state:1 is a network end state no mutation pairs with; `required` makes that a gap. */
function requiredUnpaired(required: boolean): RunEvidence {
  const e = proof();
  const plan = e.mutation!.plan;
  return { ...e, mutation: { ...e.mutation!, plan: { ...plan, sites: [...plan.sites, { site: "end-state:1", check: "requestMade POST", ...(required ? { required: true as const } : {}) }] } } };
}

/** #811/#813: a final network check broken by block-write:2 while skip:2 left it holding; `skipPaired` false leaves skip:2 off the site. */
function blockAlone(declared: boolean, skipPaired = true): RunEvidence {
  return proofWith(
    {
      mutations: [
        { id: "block-write:2", kind: "block-write", step: 2 },
        { id: "skip:2", kind: "skip", step: 2 },
      ],
      pairs: [
        { site: "end-state:0", mutation: "block-write:2", ...(declared ? { declared: true as const } : {}) },
        ...(skipPaired ? [{ site: "end-state:0", mutation: "skip:2" }] : []),
      ],
      sites: [{ site: "end-state:0", check: "requestMade POST" }],
    },
    [
      replay(0, "mutated", { mutation: "block-write:2", outcome: "failed", failedSites: [{ where: "end-state", index: 0 }] }),
      replay(0, "mutated", { mutation: "skip:2" }),
    ],
  );
}

/** #811: step:2 pairs a data mutation (stale-value:2) and an action one (skip:2); only skip:2 broke it unless `bothBreak`. */
function obligations(bothBreak: boolean): RunEvidence {
  const broke = { outcome: "failed" as const, failedSites: [{ where: "step" as const, step: 2, postcondition: true }] };
  return proofWith(
    {
      mutations: [
        { id: "stale-value:2", kind: "stale-value", step: 2 },
        { id: "skip:2", kind: "skip", step: 2 },
      ],
      pairs: [
        { site: "step:2", mutation: "stale-value:2" },
        { site: "step:2", mutation: "skip:2" },
      ],
      sites: [{ site: "step:2", check: "page valueEquals" }],
    },
    [replay(0, "mutated", { mutation: "stale-value:2", ...(bothBreak ? broke : {}) }), replay(0, "mutated", { mutation: "skip:2", ...broke })],
  );
}

const fixtures: Record<string, RunEvidence> = {
  achieved: withDone(false, true),
  notAchieved: withDone(false, false),
  alreadyTrue: withDone(true, false),
  beforeUnknown: withDone(undefined, true),
  afterUnknown: withDone(false, undefined),
  noCheck: base(),
  harness: withDone(false, true, base("harness")),
  boundary: { ...withDone(false, false), boundary: { kind: "wall", step: 2, signal: "http-401" } },
  proof: proof(),
  proofUnknownTrust: proof("unknown"),
  targeted: targetedProof(),
  targetedStruck: targetedProof(true),
  ownRequestEvaluated: ownRequest(true),
  ownRequestUnevaluated: ownRequest(false),
  requiredUnpaired: requiredUnpaired(true),
  blockAlone: blockAlone(false),
  blockAloneDeclared: blockAlone(true),
  blockAloneSkipUnpaired: blockAlone(true, false),
  obligationsOneSided: obligations(false),
  obligationsBoth: obligations(true),
};

describe("fixtures", () => {
  it("are all valid RunEvidence", () => {
    for (const [name, e] of Object.entries(fixtures)) expect(RunEvidenceSchema.safeParse(e).success, name).toBe(true);
  });
});

describe("§3.1 done-check table", () => {
  it("before false, after true: achieved by done-check", () => {
    expect(adjudicate(fixtures.achieved!).job).toEqual({ attainment: "achieved", basis: "done-check" });
  });
  it("before false, after false: not-achieved by done-check", () => {
    expect(adjudicate(fixtures.notAchieved!).job).toEqual({ attainment: "not-achieved", basis: "done-check" });
  });
  it("before true, after any: unverified, already-true", () => {
    expect(adjudicate(fixtures.alreadyTrue!).job).toEqual({ attainment: "unverified", basis: "already-true" });
    expect(adjudicate(withDone(true, true)).job).toEqual({ attainment: "unverified", basis: "already-true" });
  });
  it("either reading unknown: unverified, reading-unknown", () => {
    expect(adjudicate(fixtures.beforeUnknown!).job).toEqual({ attainment: "unverified", basis: "reading-unknown" });
    expect(adjudicate(fixtures.afterUnknown!).job).toEqual({ attainment: "unverified", basis: "reading-unknown" });
  });
  it("no doneCheck section: unverified, no-check", () => {
    expect(adjudicate(fixtures.noCheck!).job).toEqual({ attainment: "unverified", basis: "no-check" });
  });
});

describe("trust, boundary and harness", () => {
  it("a harness target forces unverified with basis harness", () => {
    expect(adjudicate(fixtures.harness!).job).toEqual({ attainment: "unverified", basis: "harness" });
  });
  it("a boundary is inconclusive", () => {
    expect(adjudicate(fixtures.boundary!).boundary).toEqual({ outcome: "inconclusive", kind: "wall", step: 2, signal: "http-401" });
  });
  it("a proof counts for the gate on a test target, not on an unknown one", () => {
    expect(adjudicate(fixtures.proof!).checks?.countsForGate).toBe(true);
    expect(adjudicate(fixtures.proofUnknownTrust!).checks?.countsForGate).toBe(false);
    expect(adjudicate(fixtures.proofUnknownTrust!).checks?.verdict).toBe("sensitive");
  });
});

describe("mutation proof (ported rules)", () => {
  it("reads sensitive, with sensitive assertions and the new verdict word", () => {
    const checks = adjudicate(fixtures.proof!).checks!;
    expect(checks.verdict).toBe("sensitive");
    expect(checks.assertions).toEqual([
      { site: "step:2", verdict: "sensitive", provedBy: "block-write:2" },
      { site: "end-state:0", verdict: "sensitive", provedBy: "block-write:2" },
    ]);
  });
  it("reads insensitive when a paired assertion passes under its mutation", () => {
    const e = proof();
    const replays = e.mutation!.replays.map((r) => (r.mutation === "skip:2" ? { ...r, outcome: "passed" as const, failedSites: [] } : r));
    const relaxedGone = replays.filter((r) => r.role !== "relaxed");
    const checks = adjudicate({ ...e, mutation: { ...e.mutation!, replays: relaxedGone } }).checks!;
    expect(checks.assertions.find((a) => a.site === "end-state:0")?.verdict).toBe("insensitive");
    expect(checks.verdict).toBe("insensitive");
  });
  it("judges a sound targeted proof sensitive with its relaxed sites", () => {
    const checks = adjudicate(fixtures.targeted!).checks!;
    expect(checks.verdict).toBe("sensitive");
    expect(checks.assertions[1]).toEqual({ site: "end-state:0", verdict: "sensitive", provedBy: "skip:2", relaxedSites: ["step:3"] });
  });
  it("treats a struck targeted proof as refused: cascade, inconclusive", () => {
    const checks = adjudicate(fixtures.targetedStruck!).checks!;
    expect(checks.assertions[1]?.verdict).toBe("cascade");
    expect(checks.verdict).toBe("inconclusive");
  });
  it("is inconclusive when the base replay failed, a restore failed, or state crossed", () => {
    const e = proof();
    const m = e.mutation!;
    expect(adjudicate({ ...e, mutation: { ...m, replays: m.replays.map((r) => (r.role === "base" ? { ...r, outcome: "failed" as const } : r)) } }).checks?.verdict).toBe("inconclusive");
    expect(adjudicate({ ...e, mutation: { ...m, restore: "failed" } }).checks?.verdict).toBe("inconclusive");
    expect(adjudicate({ ...e, mutation: { ...m, isolation: known("state-crossed") } }).checks?.verdict).toBe("inconclusive");
    expect(adjudicate({ ...e, mutation: { ...m, replays: m.replays.map((r) => (r.role === "closing" ? { ...r, outcome: "failed" as const } : r)) } }).checks?.verdict).toBe("inconclusive");
  });
  it("keeps not-applied distinct from error, and reads a stalled replay as errored", () => {
    const e = proof();
    const m = e.mutation!;
    const as = (outcome: ReplayEvidence["outcome"]) => adjudicate({ ...e, mutation: { ...m, replays: m.replays.map((r) => (r.mutation === "skip:2" ? { ...r, outcome, failedSites: [] } : r)) } }).checks!;
    expect(as("not-applied").verdict).toBe("sensitive"); // block-write:2 still shows end-state:0 sensitive
    expect(as("stalled").verdict).toBe("inconclusive");
    expect(as("stalled").reason).toMatch(/1 of 2 mutated replays errored/);
  });
  it("#811: keeps an evaluated own-request failure sensitive when the DOM postcondition failed too", () => {
    const checks = adjudicate(fixtures.ownRequestEvaluated!).checks!;
    expect(checks.assertions).toEqual([
      { site: "step:2", verdict: "sensitive", provedBy: "block-write:2" },
      { site: "step-request:2:0", verdict: "sensitive", provedBy: "block-write:2" },
    ]);
    expect(checks.verdict).toBe("sensitive");
    // Not evaluated in the applied run: judged on the relaxed rerun, which passed.
    const plain = adjudicate(fixtures.ownRequestUnevaluated!).checks!;
    expect(plain.assertions[1]).toEqual({ site: "step-request:2:0", verdict: "insensitive" });
    expect(plain.verdict).toBe("insensitive");
  });
  it("#811: a required end state with no causal pair leaves the proof inconclusive", () => {
    const checks = adjudicate(fixtures.requiredUnpaired!).checks!;
    expect(checks.assertions[2]).toEqual({ site: "end-state:1", verdict: "unpaired" });
    expect(checks.verdict).toBe("inconclusive");
    expect(checks.reason).toBe("a network or persistence assertion has no established causal mutation pair");
    expect(adjudicate(requiredUnpaired(false)).checks?.verdict).toBe("sensitive");
  });
  it("#811: a network check only an undeclared block broke, while the skip held, is insensitive", () => {
    const checks = adjudicate(fixtures.blockAlone!).checks!;
    expect(checks.assertions).toEqual([{ site: "end-state:0", verdict: "insensitive" }]);
    expect(checks.verdict).toBe("insensitive");
  });
  it("#813: the paired skip's pass contradicts a declared block's ownership too; an unpaired skip does not", () => {
    const declared = adjudicate(fixtures.blockAloneDeclared!).checks!;
    expect(declared.assertions).toEqual([{ site: "end-state:0", verdict: "insensitive" }]);
    expect(declared.verdict).toBe("insensitive");
    // With no skip paired with the check, nothing contradicts the block: its failure is sensitive.
    const unpaired = adjudicate(fixtures.blockAloneSkipUnpaired!).checks!;
    expect(unpaired.assertions).toEqual([{ site: "end-state:0", verdict: "sensitive", provedBy: "block-write:2" }]);
    expect(unpaired.verdict).toBe("sensitive");
  });
  it("#811: data and action mutations are separate obligations that must both be sensitive", () => {
    const checks = adjudicate(fixtures.obligationsOneSided!).checks!;
    expect(checks.assertions).toEqual([{ site: "step:2", verdict: "insensitive" }]);
    expect(checks.verdict).toBe("insensitive");
    const both = adjudicate(fixtures.obligationsBoth!).checks!;
    expect(both.assertions).toEqual([{ site: "step:2", verdict: "sensitive", provedBy: "stale-value:2" }]);
    expect(both.verdict).toBe("sensitive");
  });
  it("leaves checks out when there is no mutation proof", () => {
    expect(adjudicate(fixtures.achieved!).checks).toBeUndefined();
  });
});

describe("purity", () => {
  it("advisory judgments never change a verdict", () => {
    for (const [name, e] of Object.entries(fixtures)) {
      expect(adjudicate({ ...e, judgments: [] }), name).toEqual(adjudicate(e));
      expect(adjudicate(structuredClone(e)), name).toEqual(adjudicate(e));
    }
  });

  it("rejudge v1 -> v1 moves nothing", () => {
    for (const e of Object.values(fixtures)) expect(rejudge(e, "v1", "v1").moved).toEqual([]);
  });

  /** Every path to an object `{known: true, value}` in a record. */
  function knownPaths(value: unknown, path: (string | number)[] = []): (string | number)[][] {
    if (Array.isArray(value)) return value.flatMap((v, i) => knownPaths(v, [...path, i]));
    if (value === null || typeof value !== "object") return [];
    const here = (value as { known?: unknown }).known === true ? [path] : [];
    return [...here, ...Object.entries(value).flatMap(([k, v]) => knownPaths(v, [...path, k]))];
  }

  function flipped(e: RunEvidence, path: (string | number)[]): RunEvidence {
    const copy = structuredClone(e) as unknown as Record<string | number, unknown>;
    const parent = path.slice(0, -1).reduce<Record<string | number, unknown>>((node, key) => node[key] as Record<string | number, unknown>, copy);
    parent[path.at(-1)!] = { known: false, reason: "not-gathered" };
    return copy as unknown as RunEvidence;
  }

  const named = Object.entries(fixtures);
  const jobOk = (before: Verdict, after: Verdict): boolean => after.job.attainment === before.job.attainment || after.job.attainment === "unverified";
  const checksOk = (before: Verdict, after: Verdict): boolean => after.checks?.verdict === before.checks?.verdict || after.checks?.verdict === "inconclusive";

  it("flipping any known fact to unknown moves only towards unverified / inconclusive", () => {
    expect(named.every(([, e]) => knownPaths(e).length > 0)).toBe(true);
    fc.assert(
      fc.property(fc.integer({ min: 0, max: named.length - 1 }), fc.nat(), (f, k) => {
        const e = named[f]![1];
        const paths = knownPaths(e);
        const path = paths[k % paths.length]!;
        const next = flipped(e, path);
        expect(RunEvidenceSchema.safeParse(next).success).toBe(true);
        const before = adjudicate(e);
        const after = adjudicate(next);
        expect(jobOk(before, after), `${named[f]![0]} /${path.join("/")} job`).toBe(true);
        expect(checksOk(before, after), `${named[f]![0]} /${path.join("/")} checks`).toBe(true);
      }),
      { numRuns: 500 },
    );
  });

  it("the flip property holds exhaustively over every fixture's known facts", () => {
    for (const [name, e] of named) {
      for (const path of knownPaths(e)) {
        const before = adjudicate(e);
        const after = adjudicate(flipped(e, path));
        expect(jobOk(before, after) && checksOk(before, after), `${name} /${path.join("/")}`).toBe(true);
      }
    }
  });
});
