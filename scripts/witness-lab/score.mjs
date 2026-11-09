#!/usr/bin/env node
// #800 witness lab: score results.jsonl into the per-arm table and the prediction's three clauses.
//
//   node scripts/witness-lab/score.mjs [--results scripts/witness-lab/results.jsonl] [--json]
//
// Per arm: caught/total over `defect` cells, false alarms/total over `clean` cells, flagged/total
// over `weak-clean` cells (reported apart: a correct finding about the Journey, not the app), median
// wall seconds, and n. Lint runs once per Journey (it never opens the app), so its one reading is
// attributed to every replicate of every cell of that Journey; its n is the number of Journeys.
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { CELLS } from "./journeys.mjs";

const here = dirname(fileURLToPath(import.meta.url));

export function readResults(path) {
  return readFileSync(path, "utf8")
    .split(/\r?\n/)
    .filter((l) => l.trim() !== "")
    .map((l) => JSON.parse(l));
}

const median = (xs) => {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? s[m] : (s[m - 1] + s[m]) / 2;
};

/** Expand lint's one-per-Journey reading onto every (cell, replicate) the other arms ran. */
function expandLint(rows) {
  const lint = new Map(rows.filter((r) => r.arm === "lint").map((r) => [r.journey, r]));
  const replicates = Math.max(1, ...rows.filter((r) => r.arm !== "lint").map((r) => r.replicate + 1));
  const out = [];
  for (const cell of CELLS) {
    const reading = lint.get(cell.journey);
    if (!reading) continue;
    for (let replicate = 0; replicate < replicates; replicate += 1) out.push({ ...reading, variant: cell.variant, truth: cell.truth, replicate });
  }
  return out;
}

function tally(rows, flag = (r) => r.flagged) {
  const by = (truth) => rows.filter((r) => r.truth === truth);
  const count = (xs) => ({ hit: xs.filter(flag).length, total: xs.length });
  return { caught: count(by("defect")), falseAlarms: count(by("clean")), weakFlagged: count(by("weak-clean")) };
}

/** Score rows: { arms: { <arm>: { caught, falseAlarms, weakFlagged, medianS, n, ... } }, prediction, outcome, cells }. */
export function scoreRows(rows) {
  const arms = {};
  const lintRows = rows.filter((r) => r.arm === "lint");
  if (lintRows.length > 0) {
    arms.lint = { ...tally(expandLint(rows)), medianS: median(lintRows.map((r) => r.durationMs / 1000)), n: lintRows.length, cellsAttributed: expandLint(rows).length };
  }
  for (const arm of ["replay", "witness", "mutation"]) {
    const rs = rows.filter((r) => r.arm === arm);
    if (rs.length === 0) continue;
    arms[arm] = {
      ...tally(rs),
      medianS: median(rs.map((r) => r.durationMs / 1000)),
      medianCleanS: median(rs.filter((r) => r.truth === "clean").map((r) => r.durationMs / 1000)),
      totalS: rs.reduce((a, r) => a + r.durationMs / 1000, 0),
      n: rs.length,
      timedOut: rs.filter((r) => r.timedOut).length,
      usd: rs.reduce((a, r) => a + (r.usd ?? 0), 0),
    };
  }
  const witness = rows.filter((r) => r.arm === "witness");
  if (witness.length > 0) {
    // The design's literal rule (§7): caught = job.attainment not-achieved or unverified; no `job` (a run that ended before it) is not counted.
    arms["witness (attainment only)"] = { ...tally(witness, (r) => r.attainment === "not-achieved" || r.attainment === "unverified"), medianS: arms.witness.medianS, n: witness.length };
  }

  let prediction = null;
  let outcome = null;
  if (arms.witness && arms.mutation) {
    const w = arms.witness;
    const m = arms.mutation;
    const rate = (x) => (x.total === 0 ? 0 : x.hit / x.total);
    const catches = rate(w.caught) >= rate(m.caught);
    const alarms = rate(w.falseAlarms) <= rate(m.falseAlarms);
    const timeVsProof = w.totalS / m.totalS;
    const time = timeVsProof <= 0.1;
    const overheadVsReplay = arms.replay ? w.medianCleanS / arms.replay.medianCleanS - 1 : null;
    prediction = { catches, alarms, time, timeVsProof, medianCleanVsProof: w.medianCleanS / m.medianCleanS, overheadVsReplay };
    outcome = !catches ? "Witness catches fewer" : !alarms ? "More false alarms" : !time ? "Time over 10%" : "Holds";
  }

  const cells = CELLS.map((c) => {
    const pick = (arm) => {
      const rs = arm === "lint" ? expandLint(rows).filter((r) => r.journey === c.journey && r.variant === c.variant) : rows.filter((r) => r.arm === arm && r.journey === c.journey && r.variant === c.variant);
      return { flagged: rs.filter((r) => r.flagged).length, n: rs.length, detail: [...new Set(rs.map((r) => detailOf(arm, r)))].join(" / ") };
    };
    return { ...c, lint: pick("lint"), witness: pick("witness"), mutation: pick("mutation") };
  });
  return { arms, prediction, outcome, cells };
}

function detailOf(arm, r) {
  if (arm === "lint") return (r.lintStrengthCodes ?? []).join(",") || "-";
  if (arm === "witness") return `${r.outcome ?? "?"}:${r.attainment ?? "no-job"}${r.basis ? `/${r.basis}` : ""}`;
  return `${r.verdict ?? r.error ?? "?"}`;
}

const pct = (x) => (x.total === 0 ? "n/a" : `${x.hit}/${x.total}`);
const s1 = (x) => (x === null || x === undefined ? "n/a" : x.toFixed(1));

export function renderTable(report) {
  const lines = ["| arm | caught/total (defect cells) | false alarms/clean cells | weak Journey flagged on clean app | median s | n |", "|---|---|---|---|---|---|"];
  for (const [arm, a] of Object.entries(report.arms)) {
    lines.push(`| ${arm} | ${pct(a.caught)} | ${pct(a.falseAlarms)} | ${pct(a.weakFlagged)} | ${s1(a.medianS)} | ${a.n} |`);
  }
  return lines.join("\n");
}

export function renderCells(report) {
  const lines = ["| Journey | variant | truth | lint | witness | mutation proof |", "|---|---|---|---|---|---|"];
  for (const c of report.cells) {
    const f = (x) => `${x.flagged}/${x.n} (${x.detail})`;
    lines.push(`| ${c.journey} | ${c.variant} | ${c.truth} | ${f(c.lint)} | ${f(c.witness)} | ${f(c.mutation)} |`);
  }
  return lines.join("\n");
}

export function renderPrediction(report) {
  const p = report.prediction;
  if (!p) return "Prediction: not evaluable (witness or mutation arm missing).";
  const yn = (b) => (b ? "yes" : "no");
  return [
    `- Prediction held: ${yn(p.catches)} — witness catches at least as many as mutation proof`,
    `- Prediction held: ${yn(p.alarms)} — witness raises no more false alarms`,
    `- Prediction held: ${yn(p.time)} — witness takes at most 10% of mutation proof's time (total wall time ratio ${(p.timeVsProof * 100).toFixed(1)}%; clean-cell median ratio ${(p.medianCleanVsProof * 100).toFixed(1)}%)`,
    `- Witness overhead over a plain replay (clean-cell medians): ${p.overheadVsReplay === null ? "n/a" : `${(p.overheadVsReplay * 100).toFixed(0)}%`}`,
    `- §7 outcome: **${report.outcome}**`,
  ].join("\n");
}

function main() {
  const i = process.argv.indexOf("--results");
  const path = resolve(i === -1 ? join(here, "results.jsonl") : process.argv[i + 1]);
  const report = scoreRows(readResults(path));
  if (process.argv.includes("--json")) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return;
  }
  process.stdout.write(`${renderTable(report)}\n\n${renderPrediction(report)}\n\n${renderCells(report)}\n`);
}

const isMain = process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) main();
