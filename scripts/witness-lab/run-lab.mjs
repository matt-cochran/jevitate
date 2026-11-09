#!/usr/bin/env node
// #800 witness lab: run the three-arm comparison (plus a plain replay for the time baseline) on the
// accuracy lab's seeded defects and the deliberately weak Journeys, ONE cell at a time.
//
//   node scripts/witness-lab/run-lab.mjs --work <dir> [--replicates 3] [--arms lint,replay,witness,mutation]
//                                        [--only <journey>|<variant>] [--results scripts/witness-lab/results.jsonl]
//
// Arms (design 0.30.0 §7):
//   lint      `journey lint <id> --json`                               (static; no app)
//   replay    `journey run <id> --no-done-check --json`                (time baseline only; not scored)
//   witness   `journey run <id> --json` with the job's done check      (fresh-session before/after readings)
//   mutation  `journey verify <id> --mutate --json` with a --before reset hook on every replay
// Each cell starts a fresh resettable lab (lab-target.mjs), writes a fresh project under --work, runs
// one CLI process, and appends one JSON line to --results. Cells already recorded are skipped.
// Children get HOME=<work>/home so nothing is written to ~/.jevitate. No model is called by any arm:
// no --real, and none of these commands calls Jev on a passing or failing replay.
import { spawn } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ARMS, CELLS, JOBS, JOURNEY_DEFS, buildJourney } from "./journeys.mjs";
import { startResettableLab } from "./lab-target.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../..");
const DEFAULT_BIN = join(repoRoot, "packages/cli/dist/bin.js");
/** The built bin with the done-check hooks registered (see cli-with-done-check.mjs): the witness arm only. */
const WITNESS_BIN = join(here, "cli-with-done-check.mjs");

/** Lint rules about the Journey's catalog links, not its assertions: never counted as a lint catch. */
export const LINT_CATALOG_RULES = new Set(["job-anchors", "missing-persona"]);

const SENSITIVE = new Set(["sensitive", "proven"]);

export const cellKey = (c) => `${c.arm}|${c.journey}|${c.variant}|${c.replicate}`;

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i === -1 ? fallback : process.argv[i + 1];
}

const parseEnvelope = (stdout) => {
  const lines = stdout.split(/\r?\n/).filter((l) => l.trim() !== "");
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    try {
      const parsed = JSON.parse(lines[i]);
      if (parsed && typeof parsed === "object" && "ok" in parsed) return parsed;
    } catch {
      /* not the envelope line */
    }
  }
  // A pretty-printed envelope spans lines: try the whole stdout from its first "{".
  const at = stdout.indexOf("{");
  if (at !== -1) {
    try {
      return JSON.parse(stdout.slice(at));
    } catch {
      /* no envelope */
    }
  }
  return null;
};

function runCli(args, { cwd, env, timeoutMs }) {
  return new Promise((resolveRun) => {
    // BROWSER-FREE harness timing: wall time of the whole CLI process, as a user would see it.
    const started = process.hrtime.bigint();
    const child = spawn(process.execPath, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += String(d)));
    child.stderr.on("data", (d) => (stderr += String(d)));
    let timedOut = false;
    const killer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, timeoutMs);
    child.on("exit", (code, signal) => {
      clearTimeout(killer);
      const durationMs = Number((process.hrtime.bigint() - started) / 1000000n);
      resolveRun({ code, signal, stdout, stderr, durationMs, timedOut });
    });
  });
}

function writeProject(dir, journeyId, origin) {
  rmSync(dir, { recursive: true, force: true });
  const project = join(dir, ".jevitate");
  const journeys = join(project, "journeys");
  mkdirSync(journeys, { recursive: true });
  writeFileSync(join(project, "project.json"), JSON.stringify({}));
  writeFileSync(join(project, "jobs.json"), JSON.stringify({ jobs: JOBS }, null, 2));
  writeFileSync(join(journeys, `${journeyId}.json`), JSON.stringify(buildJourney(journeyId, origin), null, 2));
  return { project, journeys };
}

/** The arm's reading of one CLI result: what it says, decided by code from the envelope only. */
export function readArm(arm, envelope, exitCode) {
  const data = envelope?.data ?? null;
  if (arm === "lint") {
    const findings = Array.isArray(data?.findings) ? data.findings : [];
    const rules = [...new Set(findings.map((f) => f?.rule).filter(Boolean))].sort();
    // Catalog-link rules (no anchor, no persona) say nothing about whether the checks are strong.
    const strength = findings.filter((f) => !LINT_CATALOG_RULES.has(f?.rule));
    return { flagged: strength.length > 0, lintCodes: rules, lintStrengthCodes: [...new Set(strength.map((f) => f.rule))].sort() };
  }
  if (arm === "replay" || arm === "witness") {
    const outcome = data?.outcome ?? null;
    const job = data?.job ?? null;
    return {
      outcome,
      attainment: job?.attainment ?? null,
      basis: job?.basis ?? null,
      failureKind: data?.failure?.kind ?? null,
      flagged: arm === "witness" ? exitCode !== 0 || (job !== null && job.attainment !== "achieved") : exitCode !== 0,
    };
  }
  // mutation
  const verdict = data?.checks?.verdict ?? data?.verdict ?? data?.report?.verdict ?? null;
  return {
    outcome: data?.outcome ?? null,
    verdict,
    failureKind: data?.failure?.kind ?? null,
    // 0.29.0's word `proven` is 0.30.0's `sensitive` (§6.1); the built CLI still prints `proven`.
    flagged: verdict === null ? exitCode !== 0 : !SENSITIVE.has(verdict),
  };
}

export async function runOne({ arm, journey, variant, truth, replicate, work, bin, witnessBin = WITNESS_BIN, timeoutMs }) {
  const lab = await startResettableLab(variant);
  const cellDir = join(work, "cells", `${arm}-${journey}-${variant}-r${replicate}`);
  const home = join(work, "home");
  mkdirSync(home, { recursive: true });
  const { project, journeys } = writeProject(cellDir, journey, lab.origin);
  const params = Object.entries(JOURNEY_DEFS[journey].params).flatMap(([k, v]) => ["--param", `${k}=${v}`]);
  const common = ["--project", project, "--journeys-dir", journeys, "--json"];
  const reset = `${JSON.stringify(process.execPath)} ${JSON.stringify(join(here, "reset.mjs"))} ${lab.controlPort}`;
  const args =
    arm === "lint"
      ? [bin, "journey", "lint", journey, ...common]
      : arm === "replay"
        ? [bin, "journey", "run", journey, ...common, ...params, "--no-done-check"]
        : arm === "witness"
          ? [witnessBin, "journey", "run", journey, ...common, ...params]
          : [bin, "journey", "verify", journey, ...common, ...params, "--mutate", "--before", reset, "--allow-shell-hooks"];
  const env = {
    ...process.env,
    HOME: home,
    PLAYWRIGHT_BROWSERS_PATH: process.env.PLAYWRIGHT_BROWSERS_PATH ?? join(homedir(), ".cache", "ms-playwright"),
    JEVITATE_RUN_RECORD: "",
  };
  let run;
  try {
    run = await runCli(args, { cwd: cellDir, env, timeoutMs });
  } finally {
    await lab.close();
  }
  const envelope = parseEnvelope(run.stdout);
  const reading = readArm(arm, envelope, run.code);
  const line = {
    arm,
    journey,
    variant,
    truth,
    replicate,
    exitCode: run.code,
    timedOut: run.timedOut,
    durationMs: run.durationMs,
    resets: lab.resets(),
    ...reading,
    ok: envelope?.ok ?? null,
    error: envelope && envelope.ok === false ? (envelope.error?.code ?? envelope.error?.message ?? "error") : null,
    usd: 0,
  };
  writeFileSync(join(cellDir, "stdout.json"), run.stdout);
  writeFileSync(join(cellDir, "stderr.txt"), run.stderr);
  return line;
}

function recorded(resultsPath) {
  const done = new Set();
  if (!existsSync(resultsPath)) return done;
  for (const raw of readFileSync(resultsPath, "utf8").split(/\r?\n/)) {
    if (raw.trim() === "") continue;
    try {
      done.add(cellKey(JSON.parse(raw)));
    } catch {
      /* torn line */
    }
  }
  return done;
}

async function main() {
  const work = arg("--work");
  if (!work) {
    process.stderr.write("usage: node run-lab.mjs --work <dir> [--replicates 3] [--arms lint,replay,witness,mutation] [--only <id>]\n");
    process.exit(2);
  }
  const replicates = Number(arg("--replicates", "3"));
  const arms = arg("--arms", ARMS.join(",")).split(",");
  const only = arg("--only");
  const resultsPath = resolve(arg("--results", join(here, "results.jsonl")));
  const bin = resolve(process.env.JEVITATE_BIN ?? DEFAULT_BIN);
  const timeoutMs = Number(arg("--timeout-ms", "300000"));
  const done = recorded(resultsPath);
  for (const arm of arms) {
    for (const cell of CELLS) {
      if (only && cell.journey !== only && cell.variant !== only) continue;
      // Lint never opens the app: one reading per Journey, attributed to each of its cells by score.mjs.
      if (arm === "lint" && cell !== CELLS.find((c) => c.journey === cell.journey)) continue;
      for (let replicate = 0; replicate < (arm === "lint" ? 1 : replicates); replicate += 1) {
        const c = { ...cell, arm, replicate };
        if (done.has(cellKey(c))) continue;
        const line = await runOne({ ...c, work: resolve(work), bin, timeoutMs });
        appendFileSync(resultsPath, `${JSON.stringify(line)}\n`);
        process.stdout.write(`${cellKey(c)} exit=${line.exitCode} flagged=${line.flagged} ${line.durationMs}ms\n`);
      }
    }
  }
  process.stdout.write("LAB_DONE\n");
}

const isMain = process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) main();
