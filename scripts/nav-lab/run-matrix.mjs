#!/usr/bin/env node
// #807 Run the navigation-lab matrix: every case x --replicates, at most --concurrency cells at once.
//
//   JEVITATE_BIN=packages/cli/dist/bin.js node scripts/nav-lab/run-matrix.mjs --out <dir> [--replicates 3]
//       [--concurrency 2] [--quiet-lock <file>] [--max-load 20] [--max-usd 10] [--cases a,b]
//       [--guards clean:J1,clean:J2,j3-deadend:J3]
//
// --guards adds the accuracy lab's goal-strategy cells, run by its own unchanged runCell (results in
// <out>/accuracy/), each with one line in <out>/guards.jsonl that also holds decisions and cost.
//
// Cells already in <out>/results.jsonl are skipped, so a rerun finishes an interrupted matrix.
// Shared-machine rules, checked before each cell starts:
//  - while --quiet-lock exists no cell starts, and running cells finish;
//  - no cell starts while the 1-minute load average is at or above --max-load;
//  - the matrix ends with exit 3 once the recorded model cost passes --max-usd.
import { existsSync, readFileSync, readdirSync, appendFileSync, mkdirSync } from "node:fs";
import { loadavg } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runCell as runAccuracyCell } from "../accuracy-lab/run-cell.mjs";
import { cellKey, costOf, loadGroundTruth, runCell } from "./run-cell.mjs";

/** Every cell of the matrix, replicate by replicate, so an early stop still covers each case. */
export function buildCells(replicates, caseIds = Object.keys(loadGroundTruth().cases)) {
  const cells = [];
  for (let replicate = 0; replicate < replicates; replicate += 1) {
    for (const id of caseIds) cells.push({ case: id, replicate });
  }
  return cells;
}

const recorded = (outDir) => {
  const path = join(outDir, "results.jsonl");
  const rows = [];
  if (!existsSync(path)) return rows;
  for (const raw of readFileSync(path, "utf8").split(/\r?\n/)) {
    if (raw.trim() === "") continue;
    try {
      rows.push(JSON.parse(raw));
    } catch {
      /* torn final line from an interrupted run */
    }
  }
  return rows;
};

const artifactOf = (dir, suffix) => {
  const name = readdirSync(dir).find((f) => f.endsWith(suffix));
  return name ? JSON.parse(readFileSync(join(dir, name), "utf8")) : null;
};

/** One accuracy-lab cell, plus what its line leaves out, read back from the run's own files. */
async function runGuard(cell, outDir, maxActions) {
  const line = await runAccuracyCell({ variant: cell.variant, job: cell.job, strategy: "goal", replicate: cell.replicate, outDir: join(outDir, "accuracy"), maxActions, timeoutMs: 300000 });
  const result = artifactOf(line.artifactDir, ".result.json")?.result ?? {};
  const row = {
    case: cell.case,
    variant: cell.variant,
    job: cell.job,
    replicate: cell.replicate,
    exitCode: line.exitCode,
    missionOutcome: line.missionOutcome,
    goalOutcome: line.goalOutcome,
    goalReason: result.goalReason ?? null,
    failureKind: line.failureKind,
    stop: result.stop ?? null,
    decisions: result.decisions ?? null,
    actions: line.actions,
    fingerprints: line.fingerprints,
    findings: line.findings,
    hostDegraded: result.hostHealth?.degraded ?? null,
    durationMs: line.durationMs,
    costUsd: costOf(artifactOf(line.artifactDir, ".usage.json")).usd,
  };
  appendFileSync(join(outDir, "guards.jsonl"), `${JSON.stringify(row)}\n`);
  return row;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const POLL_MS = 15000;

async function main() {
  const arg = (name, fallback) => {
    const i = process.argv.indexOf(name);
    return i === -1 ? fallback : process.argv[i + 1];
  };
  const outDir = arg("--out");
  if (!outDir) {
    process.stderr.write("usage: node run-matrix.mjs --out <dir> [--replicates 3] [--concurrency 2] [--quiet-lock f] [--max-load 20] [--max-usd 10] [--cases a,b]\n");
    process.exit(2);
  }
  mkdirSync(outDir, { recursive: true });
  const replicates = Number(arg("--replicates", "3"));
  const concurrency = Math.min(Number(arg("--concurrency", "2")), 2);
  const quietLock = arg("--quiet-lock");
  const maxLoad = Number(arg("--max-load", "20"));
  const maxUsd = Number(arg("--max-usd", "10"));
  const only = arg("--cases");
  const logPath = join(outDir, "matrix.log");
  const log = (msg) => {
    const line = `${new Date().toISOString()} ${msg}\n`;
    appendFileSync(logPath, line);
    process.stdout.write(line);
  };

  const guardRows = existsSync(join(outDir, "guards.jsonl")) ? readFileSync(join(outDir, "guards.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
  const rows = [...recorded(outDir), ...guardRows];
  const done = new Set(rows.map(cellKey));
  let spent = rows.reduce((sum, r) => sum + (r.costUsd ?? 0), 0);
  const guards = (arg("--guards") ?? "").split(",").filter(Boolean).map((g) => g.split(":"));
  const guardCells = guards.flatMap(([variant, job]) => Array.from({ length: replicates }, (_, replicate) => ({ case: `accuracy:${variant}:${job}`, variant, job, replicate })));
  const noCases = only === "none";
  const queue = [...(noCases ? [] : buildCells(replicates, only ? only.split(",") : undefined)), ...guardCells].filter((c) => !done.has(cellKey(c)));
  log(`start: ${queue.length} cells to run, ${done.size} recorded, $${spent.toFixed(4)} spent`);

  let overBudget = false;
  const mayStart = async () => {
    for (;;) {
      if (overBudget) return false;
      if (quietLock && existsSync(quietLock)) {
        log("quiet-machine lock present: starting nothing");
      } else if (loadavg()[0] >= maxLoad) {
        log(`load ${loadavg()[0].toFixed(1)} at or above ${maxLoad}: waiting`);
      } else {
        return true;
      }
      await sleep(POLL_MS);
    }
  };

  const worker = async () => {
    for (;;) {
      if (!(await mayStart())) return;
      const cell = queue.shift();
      if (!cell) return;
      log(`run  ${cellKey(cell)}`);
      try {
        const line = cell.variant ? await runGuard(cell, outDir, 25) : await runCell({ caseId: cell.case, replicate: cell.replicate, outDir });
        spent += line.costUsd ?? 0;
        log(`done ${cellKey(cell)} goal=${line.goalOutcome} reason=${line.goalReason} exit=${line.exitCode} labDone=${line.done} decisions=${line.decisions} ${Math.round(line.durationMs / 1000)}s total=$${spent.toFixed(4)}`);
        if (spent > maxUsd) overBudget = true;
      } catch (err) {
        log(`cell failed ${cellKey(cell)}: ${err && err.message ? err.message : err}`);
      }
    }
  };
  await Promise.all(Array.from({ length: concurrency }, worker));
  log(overBudget ? `MATRIX_STOPPED_OVER_BUDGET $${spent.toFixed(4)}` : `MATRIX_DONE $${spent.toFixed(4)}`);
  process.exit(overBudget ? 3 : 0);
}

const isMain = process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) main();
