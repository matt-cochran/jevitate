#!/usr/bin/env node
// metrics.mjs — per-app grade distribution + run-to-run consistency for one or more tags.
// Usage: node metrics.mjs <resultsDir> <tag>[,<tag>...] [--min-confidence 0.75] [--json out.json]
import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { consistency, f2, pct, routeKey, SHOWN } from "./stats.mjs";

const args = process.argv.slice(2);
const [dir, tagsArg] = args;
const opt = (n, d) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : d; };
const cutoff = Number(opt("min-confidence", "0.75"));
const jsonOut = opt("json", undefined);
// --shown-all: the pre-fix report showed every finding (no policy, no working cutoff).
const shownAll = args.includes("--shown-all");
const tags = tagsArg.split(",");
const files = (await readdir(dir)).filter((f) => f.endsWith(".json"));
const rows = [];
for (const tag of tags) {
  const mine = files.filter((f) => f.startsWith(`${tag}--`));
  const apps = [...new Set(mine.map((f) => f.split("--")[1]))].sort();
  for (const app of apps) {
    const runs = [];
    let split = "";
    for (const f of mine.filter((x) => x.split("--")[1] === app).sort()) {
      const r = JSON.parse(await readFile(join(dir, f), "utf8"));
      split = r.split;
      runs.push(r.report.findings.filter((x) => x.tier === "semantic"));
    }
    const all = runs.flat();
    const dist = { actionable: 0, "relevant-minor": 0, generic: 0, wrong: 0 };
    for (const x of all) if (x.quality) dist[x.quality.label]++;
    const n = all.length || 1;
    const shownPolicy = (x) => shownAll || (x.quality && SHOWN.has(x.quality.label));
    const shownBoth = (x) => shownPolicy(x) && x.confidence >= cutoff;
    const c1 = consistency(runs, shownPolicy);
    const c2 = consistency(runs, shownBoth);
    const cr = consistency(runs, shownPolicy, routeKey);
    rows.push({
      tag, app, split, runs: runs.length,
      perRun: all.length / runs.length,
      actionable: dist.actionable / n, relevant: dist["relevant-minor"] / n, generic: dist.generic / n, wrong: dist.wrong / n,
      goodShare: (dist.actionable + dist["relevant-minor"]) / n,
      shownPerRun: all.filter(shownPolicy).length / runs.length,
      shownCutPerRun: all.filter(shownBoth).length / runs.length,
      jaccardRoute: cr.meanJaccard, labelStabilityRoute: cr.labelStability,
      jaccardPolicy: c1.meanJaccard, jaccardPolicyCut: c2.meanJaccard, labelStability: c1.labelStability, keyRecurrence: c1.keyRecurrence,
    });
  }
}
console.log(`| tag | app | split | runs | findings/run | actionable | relevant-minor | generic | wrong | act+rel | shown/run (policy) | shown/run (policy+≥${cutoff}) | Jaccard shown item×route | Jaccard shown item×route×controls | Jaccard (policy+cut) | label stability | key recurrence |`);
console.log("|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|");
for (const r of rows) {
  console.log(`| ${r.tag} | ${r.app} | ${r.split} | ${r.runs} | ${r.perRun.toFixed(1)} | ${pct(r.actionable)} | ${pct(r.relevant)} | ${pct(r.generic)} | ${pct(r.wrong)} | **${pct(r.goodShare)}** | ${r.shownPerRun.toFixed(1)} | ${r.shownCutPerRun.toFixed(1)} | ${f2(r.jaccardRoute)} | ${f2(r.jaccardPolicy)} | ${f2(r.jaccardPolicyCut)} | ${pct(r.labelStability)} | ${pct(r.keyRecurrence)} |`);
}
if (jsonOut) await writeFile(jsonOut, `${JSON.stringify(rows, null, 2)}\n`);
