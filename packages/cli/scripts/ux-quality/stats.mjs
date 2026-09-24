// stats.mjs — agreement + consistency statistics for the UX quality harness (pure functions).
export const LABELS = ["actionable", "relevant-minor", "generic", "wrong"];
export const SHOWN = new Set(["actionable", "relevant-minor"]);

/** Confusion matrix rows=truth, cols=predicted over LABELS. */
export function confusion(pairs) {
  const m = Object.fromEntries(LABELS.map((t) => [t, Object.fromEntries(LABELS.map((p) => [p, 0]))]));
  for (const { truth, pred } of pairs) m[truth][pred]++;
  return m;
}

/** Cohen's kappa for arbitrary categorical pairs. */
export function kappa(pairs, cats) {
  const n = pairs.length;
  if (n === 0) return NaN;
  const po = pairs.filter((p) => p.truth === p.pred).length / n;
  let pe = 0;
  for (const c of cats) {
    const a = pairs.filter((p) => p.truth === c).length / n;
    const b = pairs.filter((p) => p.pred === c).length / n;
    pe += a * b;
  }
  return pe === 1 ? 1 : (po - pe) / (1 - pe);
}

export function agreement(pairs) {
  const four = { n: pairs.length, accuracy: pairs.filter((p) => p.truth === p.pred).length / Math.max(1, pairs.length), kappa: kappa(pairs, LABELS) };
  const bin = pairs.map((p) => ({ truth: SHOWN.has(p.truth) ? "show" : "hide", pred: SHOWN.has(p.pred) ? "show" : "hide" }));
  const binary = { accuracy: bin.filter((p) => p.truth === p.pred).length / Math.max(1, bin.length), kappa: kappa(bin, ["show", "hide"]) };
  return { four, binary, confusion: confusion(pairs) };
}

/**
 * Precision/recall of a binary "shown" decision (default: `SHOWN.has(label)`, i.e.
 * actionable/relevant-minor vs generic/wrong) against `truth`. `positiveOf` lets a caller reuse
 * this for the raw 4-class labels too (e.g. `(l) => l === "actionable"`).
 */
export function precisionRecall(pairs, positiveOf = (label) => SHOWN.has(label)) {
  let tp = 0, fp = 0, fn = 0, tn = 0;
  for (const { truth, pred } of pairs) {
    const t = positiveOf(truth);
    const p = positiveOf(pred);
    if (t && p) tp++;
    else if (!t && p) fp++;
    else if (t && !p) fn++;
    else tn++;
  }
  const precision = tp + fp > 0 ? tp / (tp + fp) : NaN;
  const recall = tp + fn > 0 ? tp / (tp + fn) : NaN;
  const f1 = Number.isFinite(precision) && Number.isFinite(recall) && precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : NaN;
  return { n: pairs.length, tp, fp, fn, tn, precision, recall, f1 };
}

/**
 * Fleiss' kappa for 3+ raters over a fixed category set (standard formula: Fleiss 1971).
 * `items` is one entry per rated subject, each entry the array of labels assigned to it (one per
 * rater who rated it) — all entries must carry the SAME number of raters `n` (the classic,
 * non-generalized formula; callers filter to subjects every rater in the set actually labeled).
 * Returns NaN for zero items; kappa is defined as 1 (not NaN) when chance agreement Pe is exactly
 * 1 (every rating fell in one category), matching `kappa()`'s convention.
 */
export function fleissKappa(items, cats) {
  const N = items.length;
  if (N === 0) return NaN;
  const n = items[0].length;
  const totalsByCat = Object.fromEntries(cats.map((c) => [c, 0]));
  let sumPi = 0;
  for (const labels of items) {
    const counts = Object.fromEntries(cats.map((c) => [c, 0]));
    for (const l of labels) counts[l] = (counts[l] ?? 0) + 1;
    for (const c of cats) totalsByCat[c] += counts[c];
    const sumSq = cats.reduce((a, c) => a + counts[c] * counts[c], 0);
    sumPi += n > 1 ? (sumSq - n) / (n * (n - 1)) : 1;
  }
  const Pbar = sumPi / N;
  const totalRatings = N * n;
  const Pe = cats.reduce((a, c) => a + (totalsByCat[c] / totalRatings) ** 2, 0);
  return Pe === 1 ? 1 : (Pbar - Pe) / (1 - Pe);
}

/**
 * Inter-rater agreement over 2+ named rater label sets (issue #97: "multiple rater label sets per
 * finding"). `raterSets` is `[{ name, labels: [{key,label}] }, ...]`. Agreement is computed only
 * over keys EVERY rater in the set labeled (a fair, fixed-n comparison) — 2 raters use Cohen's
 * kappa (`kappa()`), 3+ use `fleissKappa`. Also returns every pairwise Cohen's kappa, useful when
 * one "rater" is actually the grader and the others are human/model raters.
 */
export function interRaterAgreement(raterSets, cats = LABELS) {
  const maps = raterSets.map((r) => new Map(r.labels.map((l) => [l.key, l.label])));
  const common = raterSets.length === 0 ? [] : [...maps[0].keys()].filter((k) => maps.every((m) => m.has(k)));
  const items = common.map((k) => maps.map((m) => m.get(k)));
  const pairwise = [];
  for (let i = 0; i < raterSets.length; i++) {
    for (let j = i + 1; j < raterSets.length; j++) {
      const pairs = common.map((k) => ({ truth: maps[i].get(k), pred: maps[j].get(k) }));
      pairwise.push({ a: raterSets[i].name, b: raterSets[j].name, n: pairs.length, kappa: kappa(pairs, cats) });
    }
  }
  const overall = raterSets.length < 2 ? NaN : raterSets.length === 2 ? kappa(items.map(([a, b]) => ({ truth: a, pred: b })), cats) : fleissKappa(items, cats);
  return { n: common.length, raters: raterSets.map((r) => r.name), method: raterSets.length <= 2 ? "cohen" : "fleiss", kappa: overall, pairwise };
}

export function findingKey(f) {
  return `${f.rubricItemId}|${f.route}|${[...f.controls].sort().join("+") || [...f.quotes].map((q) => q.toLowerCase()).sort().join("+")}`;
}

export function jaccard(a, b) {
  const A = new Set(a);
  const B = new Set(b);
  const inter = [...A].filter((x) => B.has(x)).length;
  const uni = new Set([...A, ...B]).size;
  return uni === 0 ? 1 : inter / uni;
}

/** Mean pairwise Jaccard of shown finding keys across runs + label stability for repeated keys. */
export const routeKey = (f) => `${f.rubricItemId}|${f.route}`;

export function consistency(runs /* array of findings[] (all findings, with quality) */, isShown, keyOf = findingKey) {
  const shownSets = runs.map((fs) => fs.filter(isShown).map(keyOf));
  const pairs = [];
  for (let i = 0; i < shownSets.length; i++) for (let j = i + 1; j < shownSets.length; j++) pairs.push(jaccard(shownSets[i], shownSets[j]));
  const meanJaccard = pairs.length ? pairs.reduce((a, b) => a + b, 0) / pairs.length : NaN;
  const labelsByKey = new Map();
  for (const fs of runs) for (const f of fs) {
    const k = keyOf(f);
    const l = labelsByKey.get(k) ?? [];
    l.push(f.quality?.label ?? "ungraded");
    labelsByKey.set(k, l);
  }
  const repeated = [...labelsByKey.values()].filter((l) => l.length >= 2);
  const stable = repeated.filter((l) => l.every((x) => x === l[0])).length;
  const allKeys = new Set(runs.flatMap((fs) => fs.map(keyOf)));
  const inAll = [...allKeys].filter((k) => (labelsByKey.get(k)?.length ?? 0) >= runs.length).length;
  return { meanJaccard, labelStability: repeated.length ? stable / repeated.length : NaN, repeatedKeys: repeated.length, keyRecurrence: allKeys.size ? inAll / allKeys.size : NaN };
}

export const pct = (x) => (Number.isFinite(x) ? `${Math.round(x * 100)}%` : "n/a");
export const f2 = (x) => (Number.isFinite(x) ? x.toFixed(2) : "n/a");
