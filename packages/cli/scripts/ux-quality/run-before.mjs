#!/usr/bin/env node
// run-before.mjs — replay the corpus through the PRE-fix pipeline (a checkout of jevitate dev
// before this change, path in BEFORE_ROOT) for the before/after comparison. The old analyzer
// has no screen attribution (J-3), so each screen is analyzed on its own to attribute routes.
// Findings are saved in the same result shape (principle, route, controls=[], no observation).
// Usage: BEFORE_ROOT=/path/to/old/jevitate node run-before.mjs <corpus.json> <outDir> --runs 3 --tag before
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { liveGateways } from "./gateways.mjs";

const root = process.env.BEFORE_ROOT;
if (!root) throw new Error("BEFORE_ROOT is required");
const old = await import(join(root, "packages/ux/dist/index.js"));
const args = process.argv.slice(2);
const [corpusPath, outDir] = args;
const opt = (n, d) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : d; };
const runs = Number(opt("runs", "3"));
const tag = opt("tag", "before");
const corpus = JSON.parse(await readFile(corpusPath, "utf8"));
await mkdir(outDir, { recursive: true });
const { judge } = await liveGateways();
const rubric = old.loadV1Rubric();

const byApp = new Map();
for (const s of corpus.screens) byApp.set(s.app, [...(byApp.get(s.app) ?? []), s]);

async function one(app, screens, run) {
  const findings = [];
  const history = [];
  for (const s of screens) {
    const ev = {
      screenId: `${s.app}/${s.id}`, url: s.url, controls: s.controls, visibleText: s.visibleText,
      appContext: { appClass: s.appClass, job: s.job }, job: s.job, history: [...history],
      behavior: { noProgress: false, backtracks: 0, formReentry: 0, dwellMs: 0, errors: 0 },
      a11yFacts: { controls: s.controls.map((c) => ({ controlRef: `control:${c.index}`, accessibleName: c.name.trim() ? c.name : null, focusOrder: c.index, targetSize: null, contrastRatio: null })) },
    };
    history.push({ screenId: ev.screenId, url: ev.url });
    const outcome = await new old.UxAnalyzer({ judge, a11yChecker: old.a11yChecks }).analyze({ screens: [ev], rubric, appContext: ev.appContext, judgmentBudget: 10 });
    if (outcome.kind === "failed") throw new Error(outcome.reason);
    const route = new URL(s.url).pathname;
    for (const f of outcome.findings) {
      if (f.tier !== "semantic") continue;
      findings.push({ ...f, tier: "semantic", route, screenId: ev.screenId, controls: [], quotes: [], principle: rubric.get(f.rubricItemId)?.principle, occurrences: 1 });
    }
  }
  const file = join(outDir, `${tag}--${app}--run${run}.json`);
  await writeFile(file, `${JSON.stringify({ tag, app, run, split: screens[0].split, report: { findings } }, null, 2)}\n`);
  process.stderr.write(`[${tag}] ${app} run ${run}: ${findings.length} findings\n`);
}
for (let r = 1; r <= runs; r++) await Promise.all([...byApp.entries()].map(([a, s]) => one(a, s, r).catch((e) => process.stderr.write(`[${tag}] ${a} run ${r}: ERROR ${e?.message ?? e}\n`))));
