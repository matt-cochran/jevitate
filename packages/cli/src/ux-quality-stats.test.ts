// Unit tests for the ux-quality harness's pure statistics functions (issue #97): Cohen's kappa
// and Fleiss' kappa (with known/hand-computed textbook-style values), precision/recall of the
// grader's "shown" decision, the named multi-rater wrapper, and the pure per-app evaluator that
// `grader-eval.mjs hand` drives over a multi-app/multi-rater `labels/` directory. No live
// gateways: everything here is arithmetic over fixture data.
import { describe, expect, it } from "vitest";

const stats = await import(new URL("../scripts/ux-quality/stats.mjs", import.meta.url).href);
const { evaluateHandApp } = await import(new URL("../scripts/ux-quality/grader-eval.mjs", import.meta.url).href);
const { kappa, fleissKappa, precisionRecall, interRaterAgreement, agreement, LABELS, SHOWN } = stats;

describe("kappa (Cohen's, 2 raters)", () => {
  // Textbook-style 2x2 example: rater A vs rater B over 50 subjects, "yes"/"no".
  //   A\B    yes  no
  //   yes     20   5   (25)
  //   no      10  15   (25)
  //          (30) (20)  50
  // po = (20+15)/50 = 0.70
  // pe = (25/50)(30/50) + (25/50)(20/50) = 0.30 + 0.20 = 0.50
  // kappa = (0.70-0.50)/(1-0.50) = 0.40
  it("matches a hand-computed 2x2 confusion matrix", () => {
    const pairs = [
      ...Array(20).fill({ truth: "yes", pred: "yes" }),
      ...Array(5).fill({ truth: "yes", pred: "no" }),
      ...Array(10).fill({ truth: "no", pred: "yes" }),
      ...Array(15).fill({ truth: "no", pred: "no" }),
    ];
    expect(kappa(pairs, ["yes", "no"])).toBeCloseTo(0.4, 10);
  });

  it("is 1 for perfect agreement", () => {
    const pairs = ["a", "b", "a", "c"].map((l) => ({ truth: l, pred: l }));
    expect(kappa(pairs, ["a", "b", "c"])).toBe(1);
  });

  it("is defined as 1 (not NaN) when chance agreement Pe is exactly 1", () => {
    const pairs = Array(5).fill({ truth: "only", pred: "only" });
    expect(kappa(pairs, ["only"])).toBe(1);
  });

  it("is NaN for zero pairs", () => {
    expect(kappa([], LABELS)).toBeNaN();
  });
});

describe("fleissKappa (3+ raters)", () => {
  // Hand-computed example: 4 subjects, 3 raters, 2 categories {a,b}.
  //   item1: a,a,a -> counts a=3 b=0 -> sumSq=9 -> (9-3)/(3*2)=1
  //   item2: a,a,b -> counts a=2 b=1 -> sumSq=5 -> (5-3)/6=1/3
  //   item3: b,b,b -> counts a=0 b=3 -> sumSq=9 -> (9-3)/6=1
  //   item4: a,b,b -> counts a=1 b=2 -> sumSq=5 -> (5-3)/6=1/3
  // Pbar = (1 + 1/3 + 1 + 1/3) / 4 = (8/3)/4 = 2/3
  // total ratings = 12; total a = 3+2+0+1 = 6 -> p_a=0.5, p_b=0.5 -> Pe = 0.25+0.25 = 0.5
  // kappa = (2/3 - 0.5) / (1 - 0.5) = (1/6) / (1/2) = 1/3
  it("matches a hand-computed 4-item/3-rater/2-category example (kappa = 1/3)", () => {
    const items = [
      ["a", "a", "a"],
      ["a", "a", "b"],
      ["b", "b", "b"],
      ["a", "b", "b"],
    ];
    expect(fleissKappa(items, ["a", "b"])).toBeCloseTo(1 / 3, 10);
  });

  it("is 1 for unanimous-but-varied perfect agreement", () => {
    // item1: a,a,a ; item2: b,b,b -> Pbar=1; p_a=0.5,p_b=0.5 -> Pe=0.5 -> kappa=1
    const items = [
      ["a", "a", "a"],
      ["b", "b", "b"],
    ];
    expect(fleissKappa(items, ["a", "b"])).toBe(1);
  });

  it("is NaN for zero items", () => {
    expect(fleissKappa([], ["a", "b"])).toBeNaN();
  });
});

describe("precisionRecall", () => {
  it("matches hand-computed tp/fp/fn/tn for the show/hide split", () => {
    // truth "actionable" (show) x4, "generic" (hide) x4; grader gets 3/4 show right, 1 false positive.
    const pairs = [
      { truth: "actionable", pred: "actionable" }, // tp
      { truth: "actionable", pred: "actionable" }, // tp
      { truth: "actionable", pred: "generic" }, // fn
      { truth: "relevant-minor", pred: "relevant-minor" }, // tp
      { truth: "generic", pred: "generic" }, // tn
      { truth: "generic", pred: "actionable" }, // fp
      { truth: "wrong", pred: "wrong" }, // tn
    ];
    const pr = precisionRecall(pairs);
    expect(pr).toMatchObject({ n: 7, tp: 3, fp: 1, fn: 1, tn: 2 });
    expect(pr.precision).toBeCloseTo(3 / 4, 10);
    expect(pr.recall).toBeCloseTo(3 / 4, 10);
    expect(pr.f1).toBeCloseTo(3 / 4, 10);
  });

  it("precision is NaN with zero positive predictions, recall NaN with zero positive truths", () => {
    expect(precisionRecall([{ truth: "generic", pred: "generic" }]).precision).toBeNaN();
    expect(precisionRecall([{ truth: "generic", pred: "generic" }]).recall).toBeNaN();
  });

  it("accepts a custom positive-class predicate (raw 4-class, not just show/hide)", () => {
    const pairs = [
      { truth: "actionable", pred: "actionable" },
      { truth: "actionable", pred: "relevant-minor" },
      { truth: "generic", pred: "actionable" },
    ];
    const pr = precisionRecall(pairs, (l) => l === "actionable");
    expect(pr).toMatchObject({ tp: 1, fp: 1, fn: 1 });
  });
});

describe("interRaterAgreement", () => {
  it("2 raters uses Cohen's kappa and matches kappa() directly", () => {
    const raterSets = [
      { name: "human1", labels: [{ key: "k1", label: "actionable" }, { key: "k2", label: "generic" }, { key: "k3", label: "wrong" }] },
      { name: "human2", labels: [{ key: "k1", label: "actionable" }, { key: "k2", label: "actionable" }, { key: "k3", label: "wrong" }] },
    ];
    const ia = interRaterAgreement(raterSets, LABELS);
    expect(ia.method).toBe("cohen");
    expect(ia.n).toBe(3);
    const direct = kappa(
      [
        { truth: "actionable", pred: "actionable" },
        { truth: "generic", pred: "actionable" },
        { truth: "wrong", pred: "wrong" },
      ],
      LABELS,
    );
    expect(ia.kappa).toBeCloseTo(direct, 10);
    expect(ia.pairwise).toHaveLength(1);
    expect(ia.pairwise[0]).toMatchObject({ a: "human1", b: "human2", n: 3 });
  });

  it("3+ raters uses Fleiss' kappa and matches fleissKappa() directly", () => {
    const raterSets = [
      { name: "r1", labels: [{ key: "k1", label: "a" }, { key: "k2", label: "a" }, { key: "k3", label: "b" }, { key: "k4", label: "a" }] },
      { name: "r2", labels: [{ key: "k1", label: "a" }, { key: "k2", label: "a" }, { key: "k3", label: "b" }, { key: "k4", label: "b" }] },
      { name: "r3", labels: [{ key: "k1", label: "a" }, { key: "k2", label: "b" }, { key: "k3", label: "b" }, { key: "k4", label: "b" }] },
    ];
    const ia = interRaterAgreement(raterSets, ["a", "b"]);
    expect(ia.method).toBe("fleiss");
    expect(ia.n).toBe(4);
    expect(ia.kappa).toBeCloseTo(fleissKappa([["a", "a", "a"], ["a", "a", "b"], ["b", "b", "b"], ["a", "b", "b"]], ["a", "b"]), 10);
    expect(ia.pairwise).toHaveLength(3); // r1-r2, r1-r3, r2-r3
  });

  it("only counts keys EVERY rater in the set labeled (fair, fixed-n comparison)", () => {
    const raterSets = [
      { name: "r1", labels: [{ key: "k1", label: "a" }, { key: "onlyR1", label: "a" }] },
      { name: "r2", labels: [{ key: "k1", label: "a" }] },
    ];
    const ia = interRaterAgreement(raterSets, ["a", "b"]);
    expect(ia.n).toBe(1);
  });

  it("a single rater set has no inter-rater agreement to compute (n raters < 2)", () => {
    const raterSets = [{ name: "solo", labels: [{ key: "k1", label: "a" }] }];
    const ia = interRaterAgreement(raterSets, ["a", "b"]);
    expect(ia.kappa).toBeNaN();
    expect(ia.pairwise).toEqual([]);
  });
});

describe("evaluateHandApp (grader-eval.mjs's pure per-app evaluator)", () => {
  // Fixture: a tiny 2-rater, 2-app-worth-of-findings corpus, all in one app for this unit.
  const graded = new Map([
    ["k1", "actionable"],
    ["k2", "generic"],
    ["k3", "wrong"],
    ["k4", "relevant-minor"],
  ]);
  const raterSets = [
    { name: "human-a", labels: [{ key: "k1", label: "actionable" }, { key: "k2", label: "generic" }, { key: "k3", label: "wrong" }] },
    { name: "human-b", labels: [{ key: "k1", label: "actionable" }, { key: "k2", label: "actionable" }, { key: "k4", label: "relevant-minor" }] },
  ];

  it("computes inter-rater agreement over the raters' common keys", () => {
    const r = evaluateHandApp("fixture-app", raterSets, graded);
    expect(r.interRater).not.toBeNull();
    expect(r.interRater.n).toBe(2); // k1, k2 are the only keys both raters labeled
  });

  it("computes grader-vs-each-rater agreement over keys the grader graded", () => {
    const r = evaluateHandApp("fixture-app", raterSets, graded);
    expect(r.perRater).toHaveLength(2);
    const humanA = r.perRater.find((x) => x.name === "human-a");
    expect(humanA.pairs).toHaveLength(3); // k1,k2,k3 all in `graded`
    const humanB = r.perRater.find((x) => x.name === "human-b");
    expect(humanB.pairs).toHaveLength(3); // k1,k2,k4 all labeled by human-b AND graded
  });

  it("pools every rater's pairs into one precision/recall of the grader's show/hide decision", () => {
    const r = evaluateHandApp("fixture-app", raterSets, graded);
    expect(r.pairs.length).toBe(r.perRater.reduce((n, x) => n + x.pairs.length, 0));
    expect(Number.isFinite(r.precisionRecall.precision) || Number.isNaN(r.precisionRecall.precision)).toBe(true);
  });

  it("reports no inter-rater agreement (null) for a single rater set", () => {
    const r = evaluateHandApp("solo-app", [raterSets[0]], graded);
    expect(r.interRater).toBeNull();
  });
});

describe("agreement (existing 4-class + binary show/hide wrapper, sanity)", () => {
  it("SHOWN is exactly actionable + relevant-minor", () => {
    expect([...SHOWN].sort()).toEqual(["actionable", "relevant-minor"]);
  });

  it("binary kappa reduces the 4-class confusion to show/hide before computing kappa", () => {
    const pairs = [
      { truth: "actionable", pred: "relevant-minor" }, // both "show" -> binary agree
      { truth: "generic", pred: "wrong" }, // both "hide" -> binary agree
    ];
    const a = agreement(pairs);
    expect(a.four.accuracy).toBe(0); // no 4-class pair matches exactly
    expect(a.binary.accuracy).toBe(1); // but both are "show"/"hide"-consistent
  });
});
