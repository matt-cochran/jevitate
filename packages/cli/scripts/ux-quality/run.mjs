#!/usr/bin/env node
// run.mjs — replay a captured corpus through the full UX pipeline (Jev judgment → structured
// specifics → code adjudication → dedupe → independent Jev quality grade) N times, saving every
// finding (shown or not) per app per run. Usage:
//   node run.mjs <corpus.json> <outDir> --runs 3 --tag <iteration> [--apps a,b]
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { UxAnalyzer, a11yChecks, buildReport, loadV1Rubric, UX_PROMPTS } from "@jevitate/ux";
import { liveGateways } from "./gateways.mjs";

const args = process.argv.slice(2);
const [corpusPath, outDir] = args;
const opt = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : dflt;
};
const runs = Number(opt("runs", "3"));
const tag = opt("tag", UX_PROMPTS.version);
const onlyApps = opt("apps", "")?.split(",").filter(Boolean) ?? [];
const corpus = JSON.parse(await readFile(corpusPath, "utf8"));
await mkdir(outDir, { recursive: true });
const { judge, gen } = await liveGateways();

const byApp = new Map();
for (const s of corpus.screens) {
  if (onlyApps.length > 0 && !onlyApps.includes(s.app)) continue;
  const list = byApp.get(s.app) ?? [];
  list.push(s);
  byApp.set(s.app, list);
}

function toEvidence(screens) {
  const history = [];
  return screens.map((s) => {
    const ev = {
      screenId: `${s.app}/${s.id}`,
      url: s.url,
      controls: s.controls.map((c) => ({ ...c, descriptor: undefined })),
      visibleText: s.visibleText,
      appContext: { appClass: s.appClass, job: s.job },
      job: s.job,
      history: [...history],
      behavior: { noProgress: false, backtracks: 0, formReentry: 0, dwellMs: 0, errors: 0 },
      a11yFacts: { controls: s.controls.map((c) => ({ controlRef: `control:${c.index}`, accessibleName: c.name.trim() ? c.name : null, focusOrder: c.index, targetSize: null, contrastRatio: null })) },
    };
    history.push({ screenId: ev.screenId, url: ev.url });
    return ev;
  });
}

async function one(app, screens, run) {
  const analyzer = new UxAnalyzer({ judge, gen, a11yChecker: a11yChecks });
  const t0 = Date.now();
  const outcome = await analyzer.analyze({
    screens: toEvidence(screens),
    rubric: loadV1Rubric(),
    appContext: { appClass: screens[0].appClass, job: screens[0].job },
    judgmentBudget: 1000,
  });
  if (outcome.kind === "failed") {
    process.stderr.write(`[${tag}] ${app} run ${run}: FAILED ${outcome.reason}\n`);
    return;
  }
  // Keep everything; metrics apply the policy/cutoff afterwards.
  const report = buildReport(outcome, { minConfidence: 0, quality: { show: ["actionable", "relevant-minor", "generic", "wrong"] } });
  const file = join(outDir, `${tag}--${app}--run${run}.json`);
  await writeFile(file, `${JSON.stringify({ tag, promptsVersion: UX_PROMPTS.version, app, run, split: screens[0].split, ms: Date.now() - t0, report }, null, 2)}\n`);
  process.stderr.write(`[${tag}] ${app} run ${run}: ${report.findings.length} findings, ${report.suppressed.total} suppressed (${Date.now() - t0} ms)\n`);
}

for (let r = 1; r <= runs; r++) {
  await Promise.all([...byApp.entries()].map(([app, screens]) => one(app, screens, r).catch((e) => process.stderr.write(`[${tag}] ${app} run ${r}: ERROR ${e?.message ?? e}\n`))));
}
