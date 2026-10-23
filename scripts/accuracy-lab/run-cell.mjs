#!/usr/bin/env node
// #644 Run ONE seeded-accuracy-lab cell:
//   start the fixture app (--variant) on a free port -> run `jevitate explore`
//   (--strategy, --goal, --url, --json, --max-actions) -> stop the server ->
//   append one JSON line to <out>/results.jsonl.
//
//   node scripts/accuracy-lab/run-cell.mjs --variant j2-stall --job J2 --strategy goal --replicate 0 --out /tmp/lab
//
// --out <dir> is REQUIRED: it receives results.jsonl and artifacts/<variant>-<job>-<strategy>-r<n>/.
// Optional: --timeout-ms <n> (default 200000), --max-actions <n> (default 25).
// JEVITATE_BIN: a built CLI entry (e.g. packages/cli/dist/bin.js) instead of the global `jevitate`.
// `runCell` is exported so run-matrix.mjs can drive cells in-process, one at a time.
//
// Bounds: one cell at a time, one 127.0.0.1 server started here, --real only against it.
import { spawn } from "node:child_process";
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const fixtureDir = resolve(here, "../../test/fixtures/accuracy-lab");

/** The identity of one cell, used by the matrix to skip cells already recorded. */
export const cellKey = (cell) => `${cell.variant}|${cell.job}|${cell.strategy}|${cell.replicate}`;

function argValue(name, fallback) {
  const i = process.argv.indexOf(name);
  return i === -1 ? fallback : process.argv[i + 1];
}

const startApp = (variant) => {
  const child = spawn(process.execPath, [join(fixtureDir, "app.mjs"), "--port", "0", "--variant", variant], {
    cwd: fixtureDir,
    stdio: ["ignore", "pipe", "inherit"],
  });
  const ready = new Promise((resolveReady, rejectReady) => {
    let buf = "";
    const timer = setTimeout(() => rejectReady(new Error("app.mjs did not announce a port in time")), 10000);
    child.stdout.on("data", (d) => {
      buf += String(d);
      const m = /ACME_CRM_LISTENING (\d+)/.exec(buf);
      if (m) {
        clearTimeout(timer);
        resolveReady(Number(m[1]));
      }
    });
    child.on("error", rejectReady);
    child.on("exit", (code) => rejectReady(new Error(`app.mjs exited early (${code})`)));
  });
  return { child, ready };
};

const runJevitate = (port, { strategy, goal, entry, artifactDir, timeoutMs, maxActions }) =>
  new Promise((resolveRun) => {
    const startedAt = Date.now();
    const bin = process.env.JEVITATE_BIN;
    const child = spawn(
      bin ? process.execPath : "jevitate",
      [
        ...(bin ? [bin] : []),
        "explore",
        "--strategy", strategy,
        "--goal", goal,
        "--url", `http://127.0.0.1:${port}${entry}`,
        "--out", artifactDir,
        "--json",
        "--max-actions", String(maxActions),
        "--real",
        ...(strategy === "usability" ? ["--app-class", "internal"] : []),
      ],
      { cwd: fixtureDir, stdio: ["ignore", "pipe", "pipe"] },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += String(d)));
    child.stderr.on("data", (d) => (stderr += String(d)));
    let timedOut = false;
    const killer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 5000);
    }, timeoutMs);
    child.on("exit", (code, signal) => {
      clearTimeout(killer);
      resolveRun({ code, signal, stdout, stderr, durationMs: Date.now() - startedAt, timedOut });
    });
    child.on("error", (err) => {
      clearTimeout(killer);
      resolveRun({ code: null, signal: null, stdout, stderr: stderr + String(err), durationMs: Date.now() - startedAt, timedOut: false });
    });
  });

const parseEnvelope = (stdout) => {
  const lines = stdout.split(/\r?\n/).filter((l) => l.trim() !== "");
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    try {
      const parsed = JSON.parse(lines[i]);
      if (parsed && typeof parsed === "object" && parsed.v === 1) return parsed;
    } catch {
      /* not the envelope line */
    }
  }
  return null;
};

const uniq = (xs) => [...new Set(xs)];

/** Run one cell start-to-finish and append its JSON line to <outDir>/results.jsonl. */
export async function runCell({ variant, job: jobId, strategy = "goal", replicate = 0, timeoutMs = 200000, maxActions = 25, outDir }) {
  if (!variant || !jobId || !outDir) throw new Error("runCell requires variant, job and outDir");
  if (!["goal", "usability"].includes(strategy)) throw new Error(`strategy must be goal or usability, got ${JSON.stringify(strategy)}`);

  const groundTruth = JSON.parse(readFileSync(join(fixtureDir, "ground-truth.json"), "utf8"));
  const job = groundTruth.jobs[jobId];
  if (!job) throw new Error(`unknown job ${JSON.stringify(jobId)} (one of ${Object.keys(groundTruth.jobs).join(", ")})`);

  const artifactDir = join(outDir, "artifacts", `${variant}-${jobId}-${strategy}-r${replicate}`);
  mkdirSync(artifactDir, { recursive: true });

  const server = startApp(variant);
  let port;
  try {
    port = await server.ready;
  } catch (err) {
    server.child.kill("SIGKILL");
    throw new Error(`cannot start app.mjs: ${err.message}`);
  }

  let run;
  try {
    run = await runJevitate(port, { strategy, goal: job.goal, entry: job.entry, artifactDir, timeoutMs, maxActions });
  } finally {
    server.child.kill("SIGTERM");
  }

  const envelope = parseEnvelope(run.stdout);
  const data = envelope && envelope.ok ? envelope.data : null;
  const defects = Array.isArray(data?.defects) ? data.defects : [];
  const hangs = Array.isArray(data?.hangs) ? data.hangs : [];
  const reportFindings = Array.isArray(data?.report?.findings) ? data.report.findings : [];

  const fingerprints = uniq([...defects.map((d) => d?.fingerprint), ...hangs.map((h) => h?.fingerprint)].filter(Boolean));
  const findings = [
    ...defects.map((d) => ({
      id: d?.fingerprint ?? null,
      kind: d?.kind ?? null,
      severity: d?.severity ?? d?.kind ?? null,
      step: d?.repro?.recordingStepIndex ?? null,
    })),
    ...reportFindings.map((f) => ({
      id: f?.rubricItemId ?? null,
      kind: "ux",
      severity: f?.severity ?? null,
      step: f?.screenIds?.[0] ?? null,
      impact: f?.impact ?? null,
    })),
  ];

  const error = envelope && envelope.ok === false ? envelope.error : null;
  const line = {
    variant,
    job: jobId,
    strategy,
    replicate,
    exitCode: run.code,
    timedOut: run.timedOut,
    missionOutcome: data?.missionOutcome ?? null,
    goalOutcome: data?.goalOutcome ?? null,
    failureKind: data?.failure?.kind ?? null,
    fingerprints,
    findings,
    actions: data?.actions ?? data?.depth?.actions ?? null,
    durationMs: run.durationMs,
    usd: data?.usage?.totalUsd ?? null,
    artifactDir,
    ...(error ? { error } : {}),
  };

  appendFileSync(join(outDir, "results.jsonl"), `${JSON.stringify(line)}\n`);
  return line;
}

function main() {
  const variant = argValue("--variant");
  const jobId = argValue("--job");
  const strategy = argValue("--strategy", "goal");
  const replicate = Number(argValue("--replicate", "0"));
  const timeoutMs = Number(argValue("--timeout-ms", "200000"));
  const maxActions = Number(argValue("--max-actions", "25"));
  const outDir = argValue("--out");
  if (!variant || !jobId || !outDir) {
    process.stderr.write("usage: node run-cell.mjs --variant <v> --job <J1|J2|J3> --strategy <goal|usability> --replicate n --out <dir>\n");
    process.exit(2);
  }
  if (!["goal", "usability"].includes(strategy)) {
    process.stderr.write(`--strategy must be goal or usability, got ${JSON.stringify(strategy)}\n`);
    process.exit(2);
  }
  runCell({ variant, job: jobId, strategy, replicate, timeoutMs, maxActions, outDir }).then(
    (line) => process.stdout.write(`${JSON.stringify(line)}\n`),
    (err) => {
      process.stderr.write(`${err && err.message ? err.message : err}\n`);
      process.exit(1);
    },
  );
}

const isMain = process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) main();
