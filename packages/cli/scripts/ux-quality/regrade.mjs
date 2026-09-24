#!/usr/bin/env node
// regrade.mjs — re-grade saved run results with the CURRENT (validated) grader, so every
// iteration is measured by the same grader. Legacy results (no observation) are graded on the
// principle vs the screen. Usage: node regrade.mjs <corpus.json> <resultsDir> <fromTag> <toTag>
import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { gradeCandidates, loadV1Rubric, redactEvidence, UX_PROMPTS } from "@jevitate/ux";
import { liveGateways } from "./gateways.mjs";

const [corpusPath, dir, fromTag, toTag] = process.argv.slice(2);
const corpus = JSON.parse(await readFile(corpusPath, "utf8"));
const { judge } = await liveGateways();
const rubric = loadV1Rubric();
const screens = new Map(corpus.screens.map((s) => [`${s.app}/${s.id}`, s]));

function evidenceFor(s) {
  return redactEvidence(
    {
      screenId: `${s.app}/${s.id}`, url: s.url, controls: s.controls, visibleText: s.visibleText,
      appContext: { appClass: s.appClass, job: s.job }, job: s.job, history: [],
      behavior: { noProgress: false, backtracks: 0, formReentry: 0, dwellMs: 0, errors: 0 }, a11yFacts: { controls: [] },
    },
    [],
  );
}

const files = (await readdir(dir)).filter((f) => f.startsWith(`${fromTag}--`));
await Promise.all(
  files.map(async (f) => {
    const r = JSON.parse(await readFile(join(dir, f), "utf8"));
    const byScreen = new Map();
    r.report.findings.forEach((x, i) => {
      if (x.tier !== "semantic") return;
      const list = byScreen.get(x.screenId) ?? [];
      list.push(i);
      byScreen.set(x.screenId, list);
    });
    for (const [screenId, idxs] of byScreen) {
      const s = screens.get(screenId);
      if (!s) continue;
      const grades = await gradeCandidates(
        judge,
        evidenceFor(s),
        idxs.map((i) => {
          const x = r.report.findings[i];
          return { key: String(i), principle: rubric.get(x.rubricItemId)?.principle ?? x.rubricItemId, observation: x.observation, userImpact: x.userImpact, recommendation: x.observation ? x.recommendation : undefined, controls: x.controls ?? [], quotes: x.quotes ?? [] };
        }),
      );
      for (const i of idxs) r.report.findings[i] = { ...r.report.findings[i], quality: grades.get(String(i)) };
    }
    r.tag = toTag;
    r.graderVersion = UX_PROMPTS.version;
    await writeFile(join(dir, f.replace(`${fromTag}--`, `${toTag}--`)), `${JSON.stringify(r, null, 2)}\n`);
  }),
);
process.stderr.write(`regraded ${files.length} file(s) ${fromTag} → ${toTag} with ${UX_PROMPTS.version}\n`);
