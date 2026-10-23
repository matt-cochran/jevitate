#!/usr/bin/env node
// #644 Score a seeded-accuracy-lab run against the ground truth.
//
//   node scripts/accuracy-lab/score.mjs --out /tmp/lab            (reads /tmp/lab/results.jsonl)
//   node scripts/accuracy-lab/score.mjs --results path.jsonl --json
//
// Prints, per variant x strategy, TP/FP/TN/FN/inconclusive; per-strategy precision/recall/
// specificity over conclusive cells; cross-strategy agreement per variant/job (majority verdict);
// and actions/duration mean + min-max per group. --json emits the same as one JSON object.
//
// Verdict rules (the README documents them):
//   * inconclusive: missionOutcome is null/"inconclusive", EXCEPT a usability job-incomplete,
//     which IS a reported problem;
//   * reported problem: missionOutcome "defects-found", or usability job-incomplete, or any
//     finding, or any fingerprint;
//   * a cell is TP/FP/TN/FN by comparing "reported problem" with the ground truth's
//     variants.<variant>.<strategy>.defectExpected; inconclusive cells are excluded from the rates.
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
export const DEFAULT_GROUND_TRUTH = resolve(here, "../../test/fixtures/accuracy-lab/ground-truth.json");

/** Findings that report avoidable effort (#642), never a defect: scored as effort, not as a problem. */
export const EFFORT_FINDINGS = new Set(["signal-repeated-advance"]);

const isEffort = (f) => EFFORT_FINDINGS.has(f.id);

/** Whether a cell reports a problem, by the verdict rules above (effort findings are not problems). */
export function declareProblem(row, strategy = row.strategy) {
  if (row.missionOutcome === "defects-found") return true;
  if (strategy === "usability" && row.failureKind === "job-incomplete") return true;
  return (row.findings ?? []).some((f) => !isEffort(f)) || (row.fingerprints?.length ?? 0) > 0;
}

/** Whether a cell reports avoidable effort (an effort finding). */
export function declareEffort(row) {
  return (row.findings ?? []).some(isEffort);
}

/** Whether a cell is excluded from the rates. A usability job-incomplete is NOT inconclusive. */
export function isInconclusive(row, strategy = row.strategy) {
  if (strategy === "usability" && row.failureKind === "job-incomplete") return false;
  return row.missionOutcome == null || row.missionOutcome === "inconclusive";
}

/** Read a results.jsonl file into rows (tolerating a torn final line). */
export function readResults(path) {
  return readFileSync(path, "utf8")
    .split(/\r?\n/)
    .filter((l) => l.trim() !== "")
    .flatMap((l) => {
      try {
        return [JSON.parse(l)];
      } catch {
        return [];
      }
    });
}

export function loadGroundTruth(path = DEFAULT_GROUND_TRUTH) {
  return JSON.parse(readFileSync(path, "utf8"));
}

const rate = (num, den) => (den === 0 ? null : num / den);
const mean = (xs) => (xs.length === 0 ? null : xs.reduce((a, b) => a + b, 0) / xs.length);
const stats = (xs) => (xs.length === 0 ? { n: 0, mean: null, min: null, max: null } : { n: xs.length, mean: mean(xs), min: Math.min(...xs), max: Math.max(...xs) });

/** Two-strategy majority for one (variant,job): true/false/null (tie or all-inconclusive). */
const majority = (cells) => {
  const conclusive = cells.filter((c) => !isInconclusive(c.row, c.strategy));
  if (conclusive.length === 0) return null;
  const trueCount = conclusive.filter((c) => declareProblem(c.row, c.strategy)).length;
  const falseCount = conclusive.length - trueCount;
  if (trueCount > falseCount) return true;
  if (falseCount > trueCount) return false;
  return null;
};

/** Score every cell into a report object. Pure; the CLI/format functions render it. */
export function scoreRows(rows, groundTruth) {
  const variants = {};
  const strategies = {};
  for (const row of rows) {
    const { variant, strategy } = row;
    const gt = groundTruth.variants[variant]?.[strategy];
    if (!gt) continue;
    const bucket = (variants[variant] ??= {})[strategy] ??= { tp: 0, fp: 0, tn: 0, fn: 0, inconclusive: 0, effortExpected: gt.effortElevated === true, effortReported: 0 };
    if (declareEffort(row)) bucket.effortReported += 1;
    const all = (strategies[strategy] ??= { tp: 0, fp: 0, tn: 0, fn: 0, inconclusive: 0 });
    if (isInconclusive(row, strategy)) {
      bucket.inconclusive += 1;
      all.inconclusive += 1;
      continue;
    }
    const reported = declareProblem(row, strategy);
    if (gt.defectExpected && reported) bucket.tp += 1;
    else if (gt.defectExpected && !reported) bucket.fn += 1;
    else if (!gt.defectExpected && reported) bucket.fp += 1;
    else bucket.tn += 1;
    all.tp += gt.defectExpected && reported ? 1 : 0;
    all.fn += gt.defectExpected && !reported ? 1 : 0;
    all.fp += !gt.defectExpected && reported ? 1 : 0;
    all.tn += !gt.defectExpected && !reported ? 1 : 0;
  }
  for (const strategy of Object.keys(strategies)) {
    const s = strategies[strategy];
    s.precision = rate(s.tp, s.tp + s.fp);
    s.recall = rate(s.tp, s.tp + s.fn);
    s.specificity = rate(s.tn, s.tn + s.fp);
  }

  const agreement = [];
  const groupsMap = new Map();
  for (const key of new Set(rows.map((r) => `${r.variant}|${r.job}`))) {
    const [variant, job] = key.split("|");
    const cells = rows.filter((r) => r.variant === variant && r.job === job);
    const goal = majority(cells.filter((c) => c.strategy === "goal").map((r) => ({ row: r, strategy: "goal" })));
    const usability = majority(cells.filter((c) => c.strategy === "usability").map((r) => ({ row: r, strategy: "usability" })));
    agreement.push({
      variant,
      job,
      goal,
      usability,
      conclusiveGoal: cells.filter((r) => r.strategy === "goal" && !isInconclusive(r, "goal")).length,
      conclusiveUsability: cells.filter((r) => r.strategy === "usability" && !isInconclusive(r, "usability")).length,
      agree: goal !== null && goal === usability,
    });
  }
  for (const row of rows) {
    const key = `${row.variant}|${row.strategy}`;
    const group = groupsMap.get(key) ?? { variant: row.variant, strategy: row.strategy, actions: [], durationMs: [] };
    if (typeof row.actions === "number") group.actions.push(row.actions);
    if (typeof row.durationMs === "number") group.durationMs.push(row.durationMs);
    groupsMap.set(key, group);
  }
  const groups = [...groupsMap.values()].map((g) => ({
    variant: g.variant,
    strategy: g.strategy,
    actions: stats(g.actions),
    durationMs: stats(g.durationMs),
  }));

  return { cells: rows.length, variants, strategies, agreement, groups };
}

const pct = (x) => (x === null ? "n/a" : (x * 100).toFixed(1) + "%");

export function formatReport(report) {
  const lines = [`accuracy-lab: ${report.cells} cells`];
  lines.push("\nper variant x strategy (tp/fp/tn/fn/inconclusive)");
  for (const variant of Object.keys(report.variants)) {
    for (const strategy of Object.keys(report.variants[variant])) {
      const c = report.variants[variant][strategy];
      lines.push(`  ${variant.padEnd(11)} ${strategy.padEnd(9)} tp=${c.tp} fp=${c.fp} tn=${c.tn} fn=${c.fn} inconclusive=${c.inconclusive}`);
    }
  }
  lines.push("\neffort findings per variant x strategy (#642; expected where the ground truth says effortElevated)");
  for (const variant of Object.keys(report.variants)) {
    for (const strategy of Object.keys(report.variants[variant])) {
      const c = report.variants[variant][strategy];
      if (c.effortExpected || c.effortReported > 0) lines.push(`  ${variant.padEnd(11)} ${strategy.padEnd(9)} reported=${c.effortReported} expected=${c.effortExpected}`);
    }
  }
  lines.push("\nper-strategy rates over conclusive cells");
  for (const strategy of Object.keys(report.strategies)) {
    const s = report.strategies[strategy];
    lines.push(`  ${strategy.padEnd(9)} precision=${pct(s.precision)} recall=${pct(s.recall)} specificity=${pct(s.specificity)}`);
  }
  lines.push("\ncross-strategy agreement per variant/job (majority verdict)");
  for (const a of report.agreement) {
    lines.push(`  ${a.variant.padEnd(11)} ${a.job}  goal=${a.goal} usability=${a.usability} agree=${a.agree}`);
  }
  lines.push("\nactions / duration per variant x strategy (n, mean, min-max)");
  for (const g of report.groups) {
    const a = g.actions;
    const d = g.durationMs;
    lines.push(`  ${g.variant.padEnd(11)} ${g.strategy.padEnd(9)} actions n=${a.n} mean=${a.mean === null ? "n/a" : a.mean.toFixed(1)} [${a.min}-${a.max}]  duration n=${d.n} mean=${d.mean === null ? "n/a" : Math.round(d.mean)}ms [${d.min}-${d.max}]ms`);
  }
  return lines.join("\n");
}

function main() {
  const arg = (name, fallback) => {
    const i = process.argv.indexOf(name);
    return i === -1 ? fallback : process.argv[i + 1];
  };
  const out = arg("--out");
  const resultsPath = arg("--results", out ? join(out, "results.jsonl") : undefined);
  if (!resultsPath) {
    process.stderr.write("usage: node score.mjs --out <dir> | --results <results.jsonl> [--ground-truth <file>] [--json]\n");
    process.exit(2);
  }
  const groundTruth = loadGroundTruth(arg("--ground-truth", DEFAULT_GROUND_TRUTH));
  const report = scoreRows(readResults(resultsPath), groundTruth);
  process.stdout.write(process.argv.includes("--json") ? `${JSON.stringify(report, null, 2)}\n` : `${formatReport(report)}\n`);
}

const isMain = process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) main();
