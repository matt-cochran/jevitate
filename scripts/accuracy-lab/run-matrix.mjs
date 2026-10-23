#!/usr/bin/env node
// #644 Run the full seeded-accuracy-lab matrix ONE cell at a time as a Node script (no bash):
//   clean x J1..J3 + each seeded variant on its affected job, x goal/usability, x --replicates N.
//
//   node scripts/accuracy-lab/run-matrix.mjs --out /tmp/lab [--replicates 3]
//
// Cells already present in <out>/results.jsonl are skipped, so a rerun finishes an interrupted
// matrix. --out <dir> is REQUIRED (results.jsonl + artifacts/); --timeout-ms/--max-actions are
// forwarded to runCell. JEVITATE_BIN is read by runCell via the environment.
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { cellKey, runCell } from "./run-cell.mjs";

/** clean drives every job; each seeded variant drives its affected job. */
export const JOBS_BY_VARIANT = {
  clean: ["J1", "J2", "J3"],
  "j1-5xx": ["J1"],
  "j2-stall": ["J2"],
  "j3-effort": ["J3"],
  "j3-deadend": ["J3"],
};
export const STRATEGIES = ["goal", "usability"];

/** Every cell the matrix should hold: variant x affected job x strategy x replicate. */
export function buildCells(replicates) {
  const cells = [];
  for (const [variant, jobs] of Object.entries(JOBS_BY_VARIANT)) {
    for (const job of jobs) {
      for (const strategy of STRATEGIES) {
        for (let replicate = 0; replicate < replicates; replicate += 1) {
          cells.push({ variant, job, strategy, replicate });
        }
      }
    }
  }
  return cells;
}

/** Cell keys already recorded in <outDir>/results.jsonl (a torn final line is simply re-run). */
export function recordedCells(outDir) {
  const resultsPath = join(outDir, "results.jsonl");
  const done = new Set();
  if (!existsSync(resultsPath)) return done;
  for (const raw of readFileSync(resultsPath, "utf8").split(/\r?\n/)) {
    if (raw.trim() === "") continue;
    try {
      done.add(cellKey(JSON.parse(raw)));
    } catch {
      /* torn final line from an interrupted run */
    }
  }
  return done;
}

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i === -1 ? fallback : process.argv[i + 1];
}

async function main() {
  const outDir = arg("--out");
  if (!outDir) {
    process.stderr.write("usage: node run-matrix.mjs --out <dir> [--replicates 3] [--timeout-ms n] [--max-actions n]\n");
    process.exit(2);
  }
  const replicates = Number(arg("--replicates", "3"));
  const timeoutMs = arg("--timeout-ms");
  const maxActions = arg("--max-actions");
  const done = recordedCells(outDir);

  for (const cell of buildCells(replicates)) {
    const key = cellKey(cell);
    if (done.has(key)) {
      process.stdout.write(`skip ${key} (already in results.jsonl)\n`);
      continue;
    }
    process.stdout.write(`run  ${key}\n`);
    try {
      await runCell({
        ...cell,
        outDir,
        ...(timeoutMs ? { timeoutMs: Number(timeoutMs) } : {}),
        ...(maxActions ? { maxActions: Number(maxActions) } : {}),
      });
    } catch (err) {
      process.stdout.write(`  cell failed: ${err && err.message ? err.message : err}\n`);
    }
  }
  process.stdout.write("MATRIX_DONE\n");
}

const isMain = process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) main();
