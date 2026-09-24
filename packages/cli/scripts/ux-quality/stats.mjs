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
