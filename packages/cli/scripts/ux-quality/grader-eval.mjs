#!/usr/bin/env node
// grader-eval.mjs — validate the quality grader against HUMAN labels before trusting it.
//   legacy: the dogfood calibration CSV (pre-fix findings: rubric item × route, no observation),
//           graded against the captured screen for that route + the journey's job.
//   hand:   hand-labeled new findings (labels/<app>.json: [{key,label,note}]) vs the grader
//           label recorded on the same finding in a run result.
// Usage:
//   node grader-eval.mjs legacy <corpus.json> <legacy-labels.json> [--repeat 1]
//   node grader-eval.mjs hand <resultsDir> <tag> <labelsDir>
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { gradeCandidates, loadV1Rubric, redactEvidence } from "@jevitate/ux";
import { agreement, f2, findingKey, LABELS, pct } from "./stats.mjs";

const [mode, ...rest] = process.argv.slice(2);

function printAgreement(title, pairs) {
  const a = agreement(pairs);
  console.log(`\n### ${title} (n=${a.four.n})`);
  console.log(`4-class accuracy ${pct(a.four.accuracy)}, Cohen's κ ${f2(a.four.kappa)} · show/hide accuracy ${pct(a.binary.accuracy)}, κ ${f2(a.binary.kappa)}`);
  console.log(`\n| human \\ grader | ${LABELS.join(" | ")} |\n|---|${LABELS.map(() => "---").join("|")}|`);
  for (const t of LABELS) console.log(`| ${t} | ${LABELS.map((p) => a.confusion[t][p]).join(" | ")} |`);
  return a;
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
  const labelFiles = (await readdir(labelsDir)).filter((f) => f.endsWith(".json"));
  const all = [];
  for (const lf of labelFiles) {
    const app = lf.replace(/\.json$/, "");
    const labels = JSON.parse(await readFile(join(labelsDir, lf), "utf8"));
    const graded = new Map();
    for (const f of files.filter((x) => x.split("--")[1] === app)) {
      const r = JSON.parse(await readFile(join(resultsDir, f), "utf8"));
      for (const x of r.report.findings) if (x.quality && !graded.has(findingKey(x))) graded.set(findingKey(x), x.quality.label);
    }
    const pairs = labels.filter((l) => graded.has(l.key)).map((l) => ({ truth: l.label, pred: graded.get(l.key), id: l.key }));
    all.push(...pairs);
    printAgreement(`Grader vs hand labels — ${app}`, pairs);
  }
  printAgreement("Grader vs hand labels — all apps", all);
}
