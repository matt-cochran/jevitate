#!/usr/bin/env node
// grader-eval.mjs — validate the quality grader against HUMAN (or model) labels before trusting
// it. See README.md for the corpus/labels directory format.
//   legacy: the dogfood calibration CSV (pre-fix findings: rubric item × route, no observation),
//           graded against the captured screen for that route + the journey's job.
//   hand:   hand-labeled new findings vs the grader label recorded on the same finding in a run
//           result, over a MULTI-APP labels directory, one subdirectory per app:
//             labelsDir/<app>/<rater>.json   — 2+ files ⇒ inter-rater kappa is also reported
//             labelsDir/<app>.json           — legacy flat single-rater file (still supported)
//           Each rater file is `[{key, label, note}]` (issue #97: multiple rater label sets per
//           finding, human or model). Reports, per app: inter-rater agreement (Cohen's kappa for
//           2 raters, Fleiss' kappa for 3+), grader-vs-each-rater agreement, and the grader's
//           "shown" (actionable/relevant-minor) precision/recall against the rater labels — plus
//           the same rolled up across all apps.
// Usage:
//   node grader-eval.mjs legacy <corpus.json> <legacy-labels.json> [--repeat 1]
//   node grader-eval.mjs hand <resultsDir> <tag> <labelsDir>
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { gradeCandidates, loadV1Rubric, redactEvidence } from "@jevitate/ux";
import { agreement, f2, findingKey, interRaterAgreement, LABELS, pct, precisionRecall } from "./stats.mjs";

const [mode, ...rest] = process.argv.slice(2);

function printAgreement(title, pairs) {
  const a = agreement(pairs);
  console.log(`\n### ${title} (n=${a.four.n})`);
  console.log(`4-class accuracy ${pct(a.four.accuracy)}, Cohen's κ ${f2(a.four.kappa)} · show/hide accuracy ${pct(a.binary.accuracy)}, κ ${f2(a.binary.kappa)}`);
  console.log(`\n| human \\ grader | ${LABELS.join(" | ")} |\n|---|${LABELS.map(() => "---").join("|")}|`);
  for (const t of LABELS) console.log(`| ${t} | ${LABELS.map((p) => a.confusion[t][p]).join(" | ")} |`);
  return a;
}

/**
 * PURE per-app evaluation (issue #97): given `raterSets` (`[{name, labels: [{key,label}]}, …]`,
 * one or more raters loaded from `labels/<app>/*.json` or a legacy flat `labels/<app>.json`) and
 * `graded` (`Map<findingKey, gradeLabel>`, the grader's own labels for that app/tag's run
 * results), returns inter-rater agreement (when 2+ raters), grader-vs-each-rater agreement, and
 * the grader's "shown" precision/recall against ALL rater labels pooled. No I/O — exported so the
 * multi-app/multi-rater machinery is unit-testable without live gateways or a results directory.
 */
export function evaluateHandApp(app, raterSets, graded) {
  const interRater = raterSets.length >= 2 ? interRaterAgreement(raterSets) : null;
  const perRater = raterSets.map((rs) => {
    const pairs = rs.labels.filter((l) => graded.has(l.key)).map((l) => ({ truth: l.label, pred: graded.get(l.key), id: l.key }));
    return { name: rs.name, pairs, agreement: agreement(pairs) };
  });
  const pairs = perRater.flatMap((r) => r.pairs);
  return { app, interRater, perRater, pairs, precisionRecall: precisionRecall(pairs) };
}

if (mode === "legacy") {
  const [corpusPath, labelsPath] = rest;
  const ri = rest.indexOf("--repeat");
  const repeat = ri >= 0 ? Number(rest[ri + 1]) : 1;
  const corpus = JSON.parse(await readFile(corpusPath, "utf8"));
  const legacy = JSON.parse(await readFile(labelsPath, "utf8"));
  const rubric = loadV1Rubric();
  const { liveGateways } = await import("./gateways.mjs");
  const { judge } = await liveGateways();
  const byScreen = new Map();
  for (const item of legacy.items) {
    const screen = corpus.screens.find((s) => s.app === legacy.app && s.id === item.screen);
    if (!screen) continue;
    const key = `${item.screen}|${item.job}`;
    const g = byScreen.get(key) ?? { screen, job: legacy.jobs[item.journey], items: [] };
    g.items.push(item);
    byScreen.set(key, g);
  }
  const pairs = [];
  for (let r = 0; r < repeat; r++) {
    for (const { screen, job, items } of byScreen.values()) {
      const ev = redactEvidence(
        {
          screenId: screen.id, url: screen.url, controls: screen.controls, visibleText: screen.visibleText,
          appContext: { appClass: screen.appClass, job }, job, history: [],
          behavior: { noProgress: false, backtracks: 0, formReentry: 0, dwellMs: 0, errors: 0 }, a11yFacts: { controls: [] },
        },
        [],
      );
      const grades = await gradeCandidates(
        judge,
        ev,
        items.map((it, i) => ({ key: String(i), principle: rubric.get(it.rubricItemId)?.principle ?? it.rubricItemId, controls: [], quotes: [] })),
      );
      items.forEach((it, i) => pairs.push({ truth: it.label, pred: grades.get(String(i)).label, id: `${it.rubricItemId}@${it.screen}/${it.journey}` }));
    }
  }
  printAgreement("Grader vs human — legacy calibration labels (tuning app)", pairs);
  const miss = pairs.filter((p) => p.truth !== p.pred).map((p) => `${p.id}: human ${p.truth} / grader ${p.pred}`);
  console.log(`\nDisagreements:\n${miss.map((m) => `- ${m}`).join("\n")}`);
} else if (mode === "hand") {
  const [resultsDir, tag, labelsDir] = rest;
  const files = (await readdir(resultsDir)).filter((f) => f.startsWith(`${tag}--`));
  const entries = await readdir(labelsDir, { withFileTypes: true });
  const allPairs = [];
  const perApp = [];
  for (const entry of entries) {
    let app, raterSets;
    if (entry.isDirectory()) {
      // Multi-app layout: labelsDir/<app>/<rater>.json, one or more raters per app.
      app = entry.name;
      const raterFiles = (await readdir(join(labelsDir, app))).filter((f) => f.endsWith(".json"));
      raterSets = await Promise.all(
        raterFiles.map(async (rf) => ({ name: rf.replace(/\.json$/, ""), labels: JSON.parse(await readFile(join(labelsDir, app, rf), "utf8")) })),
      );
    } else if (entry.name.endsWith(".json")) {
      // Legacy flat layout: labelsDir/<app>.json, a single implicit rater.
      app = entry.name.replace(/\.json$/, "");
      raterSets = [{ name: "rater1", labels: JSON.parse(await readFile(join(labelsDir, entry.name), "utf8")) }];
    } else {
      continue;
    }
    const graded = new Map();
    for (const f of files.filter((x) => x.split("--")[1] === app)) {
      const r = JSON.parse(await readFile(join(resultsDir, f), "utf8"));
      for (const x of r.report.findings) if (x.quality && !graded.has(findingKey(x))) graded.set(findingKey(x), x.quality.label);
    }

    console.log(`\n## ${app}`);
    const evalApp = evaluateHandApp(app, raterSets, graded);
    if (evalApp.interRater) {
      const ia = evalApp.interRater;
      console.log(`\nInter-rater agreement (${ia.method === "fleiss" ? "Fleiss'" : "Cohen's"} kappa, n=${ia.n} common finding(s), raters: ${ia.raters.join(", ")}): κ ${f2(ia.kappa)}`);
      for (const p of ia.pairwise) console.log(`  ${p.a} vs ${p.b} (n=${p.n}): κ ${f2(p.kappa)}`);
    } else {
      console.log(`\nInter-rater agreement: only 1 rater set for ${app} — add labels/${app}/<rater2>.json (human or model) to compute kappa (issue #97).`);
    }

    for (const r of evalApp.perRater) printAgreement(`Grader vs ${r.name} — ${app}`, r.pairs);
    const pr = evalApp.precisionRecall;
    console.log(`\nGrader "shown" (actionable/relevant-minor) precision ${pct(pr.precision)}, recall ${pct(pr.recall)}, F1 ${f2(pr.f1)} (n=${pr.n}, tp=${pr.tp} fp=${pr.fp} fn=${pr.fn} tn=${pr.tn})`);
    perApp.push({ app, pr });
    allPairs.push(...evalApp.pairs);
  }
  printAgreement("Grader vs hand labels — all apps", allPairs);
  console.log(`\nPer-app precision/recall of the grader's "shown" decision:\n| app | n | precision | recall | F1 |\n|---|---|---|---|---|`);
  for (const { app, pr } of perApp) console.log(`| ${app} | ${pr.n} | ${pct(pr.precision)} | ${pct(pr.recall)} | ${f2(pr.f1)} |`);
}
