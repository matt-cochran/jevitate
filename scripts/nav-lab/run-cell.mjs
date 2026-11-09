#!/usr/bin/env node
// #807 Run ONE navigation-lab cell: start the case's app, run `jevitate explore --strategy goal`
// against it, read the lab-side done check from the server, stop the server, and append one JSON
// line to <out>/results.jsonl.
//
//   JEVITATE_BIN=packages/cli/dist/bin.js node scripts/nav-lab/run-cell.mjs --case clean --replicate 0 --out <dir>
//
// Same invocation as the accuracy lab's goal cell, and no --success: the done check stays on the lab's
// side, so the verdict under test is judged independently. --real only ever points at the 127.0.0.1
// server started here. JEVITATE_BIN is required: this lab measures a named build, never the global one.
//
// --job page|http (rc-030) adds the job done check arm: the run is `explore --job nav-lab-done` from a
// scratch project whose .jevitate/jobs.json holds one job, done when the lab's own /__lab/state says so,
// read as a page check or as an http check (LAB_JOB_CHECKS). The lab-side done check stays the oracle;
// the line also carries the run's `job` verdict. Without --job the invocation is unchanged.
import { spawn } from "node:child_process";
import { appendFileSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const fixtureDir = resolve(here, "../../test/fixtures/nav-lab");

/** Jev 1.13 and 1.14 are both $0.042 per Mtok of input and free for output (docs.typesafe.ai/models.md, read 2026-11-06). */
const JEV_USD_PER_INPUT_TOKEN = 0.042 / 1e6;

/** A job-arm cell is keyed apart from a judgment-only one, so both may share an out dir. */
export const cellKey = (cell) => `${cell.case}|${cell.replicate}${cell.jobCheck ? `|job=${cell.jobCheck}` : ""}`;

/** The job done check arm: one catalog job, done when the lab's own state says so, read two ways. */
export const LAB_JOB_ID = "nav-lab-done";
export const LAB_JOB_CHECKS = {
  page: { version: 1, at: "/__lab/state", check: 'textIncludes:css=body|"done":true' },
  http: { version: 1, at: "/__lab/state", check: "http:GET /__lab/state|jsonPath=$.done|equals=true" },
};

/** The scratch project an `--job` run starts from (its cwd): `.jevitate/jobs.json` with the lab job. */
export function labJobProject(outDir, jobCheck) {
  const done = LAB_JOB_CHECKS[jobCheck];
  if (!done) throw new Error(`--job must be one of ${Object.keys(LAB_JOB_CHECKS).join(", ")}, got ${JSON.stringify(jobCheck)}`);
  const dir = join(outDir, "job-project", jobCheck);
  mkdirSync(join(dir, ".jevitate"), { recursive: true });
  const job = { id: LAB_JOB_ID, trigger: "the lab goal is stated", motivation: "complete the lab goal", outcome: "the lab-side state shows it is done", done };
  writeFileSync(join(dir, ".jevitate", "jobs.json"), `${JSON.stringify({ jobs: [job] }, null, 2)}\n`);
  return dir;
}

export const loadGroundTruth = () => JSON.parse(readFileSync(join(fixtureDir, "ground-truth.json"), "utf8"));

const startApp = (caseId, seed) => {
  const child = spawn(process.execPath, [join(fixtureDir, "app.mjs"), "--port", "0", "--case", caseId, "--seed", String(seed)], {
    cwd: fixtureDir,
    stdio: ["ignore", "pipe", "inherit"],
  });
  const ready = new Promise((resolveReady, rejectReady) => {
    let buf = "";
    const timer = setTimeout(() => rejectReady(new Error("app.mjs did not announce a port in time")), 10000);
    child.stdout.on("data", (d) => {
      buf += String(d);
      const m = /NAV_LAB_LISTENING (\d+)/.exec(buf);
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

const runJevitate = (port, { goal, entry, artifactDir, timeoutMs, maxActions, projectDir }) =>
  new Promise((resolveRun) => {
    const startedAt = Date.now();
    const child = spawn(
      process.execPath,
      [
        process.env.JEVITATE_BIN, "explore", "--strategy", "goal", "--goal", goal, "--url", `http://127.0.0.1:${port}${entry}`, "--out", artifactDir, "--json", "--max-actions", String(maxActions), "--real",
        ...(projectDir === undefined ? [] : ["--job", LAB_JOB_ID]),
      ],
      { cwd: projectDir ?? fixtureDir, stdio: ["ignore", "pipe", "pipe"] },
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

const artifactOf = (dir, suffix) => {
  try {
    const name = readdirSync(dir).find((f) => f.endsWith(suffix));
    return name ? JSON.parse(readFileSync(join(dir, name), "utf8")) : null;
  } catch {
    return null;
  }
};

/** The run's cost, call by call: a call's own price if it has one, the published Jev price otherwise. */
export function costOf(usageFile) {
  const calls = Array.isArray(usageFile?.calls) ? usageFile.calls : [];
  let usd = 0;
  let unpricedCalls = 0;
  for (const call of calls) {
    if (typeof call.usd === "number") usd += call.usd;
    else if (call.kind === "judgment" && typeof call.inputTokens === "number") usd += call.inputTokens * JEV_USD_PER_INPUT_TOKEN;
    else if (call.ok !== false || typeof call.inputTokens === "number") unpricedCalls += 1;
  }
  return { usd, unpricedCalls, calls: calls.length };
}

const pathOf = (url) => {
  try {
    return new URL(url).pathname;
  } catch {
    return url ?? null;
  }
};

const compactTranscript = (entries) =>
  (Array.isArray(entries) ? entries : []).map((e) => ({
    step: e.step,
    op: e.op,
    target: e.target ?? null,
    actOk: e.actOk ?? null,
    chosenBy: e.chosenBy ?? null,
    origin: e.origin ?? null,
    path: pathOf(e.url),
    reason: typeof e.reason === "string" ? e.reason.slice(0, 400) : null,
    // A value typed into a password field is never carried into the results.
    typed: e.op === "type" || e.op === "send" ? { field: e.target ?? null, length: typeof e.value === "string" ? e.value.length : null, isPassword: /password/i.test(String(e.target)) } : undefined,
  }));

/** Run one cell start-to-finish and append its JSON line to <outDir>/results.jsonl. */
export async function runCell({ caseId, replicate = 0, timeoutMs = 300000, maxActions = 25, outDir, jobCheck }) {
  if (!caseId || !outDir) throw new Error("runCell requires caseId and outDir");
  if (!process.env.JEVITATE_BIN) throw new Error("JEVITATE_BIN must name the built CLI entry under test");
  const gt = loadGroundTruth().cases[caseId];
  if (!gt) throw new Error(`unknown case ${JSON.stringify(caseId)}`);

  const artifactDir = join(outDir, "artifacts", `${caseId}-r${replicate}${jobCheck ? `-job-${jobCheck}` : ""}`);
  mkdirSync(artifactDir, { recursive: true });
  const projectDir = jobCheck ? labJobProject(outDir, jobCheck) : undefined;

  const server = startApp(caseId, replicate);
  let port;
  try {
    port = await server.ready;
  } catch (err) {
    server.child.kill("SIGKILL");
    throw new Error(`cannot start app.mjs: ${err.message}`);
  }

  let run;
  let state = null;
  try {
    run = await runJevitate(port, { goal: gt.goal, entry: gt.entry, artifactDir, timeoutMs, maxActions, projectDir });
    state = await fetch(`http://127.0.0.1:${port}/__lab/state`).then((r) => r.json());
  } finally {
    server.child.kill("SIGTERM");
  }

  const envelope = parseEnvelope(run.stdout);
  const data = envelope && envelope.ok ? envelope.data : null;
  const file = artifactOf(artifactDir, ".result.json")?.result ?? null;
  const r = data ?? file ?? {};
  const transcript = artifactOf(artifactDir, ".transcript.json") ?? r.transcript;
  const usageFile = artifactOf(artifactDir, ".usage.json");
  const cost = costOf(usageFile);
  const defects = Array.isArray(r.defects) ? r.defects : [];
  const error = envelope && envelope.ok === false ? envelope.error : null;

  const line = {
    case: caseId,
    group: gt.group,
    replicate,
    seed: replicate,
    exitCode: run.code,
    signal: run.signal,
    timedOut: run.timedOut,
    missionOutcome: r.missionOutcome ?? null,
    goalOutcome: r.goalOutcome ?? null,
    goalReason: r.goalReason ?? null,
    stop: r.stop ?? null,
    failureKind: r.failure?.kind ?? null,
    failureMessage: typeof r.failure?.message === "string" ? r.failure.message.slice(0, 400) : null,
    reason: typeof r.reason === "string" ? r.reason.slice(0, 3000) : null,
    verifiedBy: r.runOutcome?.verifiedBy ?? null,
    // 0.30.0: the boundary a run stopped at (kind and signal only), and, in the --job arm, its job verdict.
    boundary: r.boundary ? { kind: r.boundary.kind ?? null, signal: r.boundary.signal ?? null } : null,
    ...(jobCheck ? { jobCheck, job: r.job ?? null } : {}),
    defectStatus: r.defectOutcome?.status ?? null,
    defects: defects.map((d) => d?.kind ?? null),
    decisions: r.decisions ?? r.depth?.decisions ?? null,
    actions: r.actions ?? r.depth?.actions ?? null,
    distinctStates: r.depth?.distinctStates ?? null,
    distinctPages: r.depth?.distinctPages ?? null,
    durationMs: run.durationMs,
    finalPath: pathOf(r.finalUrl),
    judgments: usageFile?.usage?.judgments ?? null,
    generations: usageFile?.usage?.generations ?? null,
    inputTokens: usageFile?.usage?.inputTokens ?? null,
    outputTokens: usageFile?.usage?.outputTokens ?? null,
    judgmentInputTokens: (usageFile?.calls ?? []).filter((c) => c.kind === "judgment").map((c) => c.inputTokens ?? null),
    costUsd: cost.usd,
    unpricedCalls: cost.unpricedCalls,
    hostDegraded: r.hostHealth?.degraded ?? null,
    peakLoadPerCore: r.hostHealth?.peakLoadPerCore ?? null,
    done: state?.done ?? null,
    labRequests: state?.requests ?? null,
    facts: state?.facts ?? null,
    transcript: compactTranscript(transcript),
    artifactDir,
    ...(error ? { error } : {}),
    ...(envelope === null ? { stderrTail: run.stderr.slice(-600) } : {}),
  };

  appendFileSync(join(outDir, "results.jsonl"), `${JSON.stringify(line)}\n`);
  return line;
}

const isMain = process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const arg = (name, fallback) => {
    const i = process.argv.indexOf(name);
    return i === -1 ? fallback : process.argv[i + 1];
  };
  const caseId = arg("--case");
  const outDir = arg("--out");
  if (!caseId || !outDir) {
    process.stderr.write("usage: node run-cell.mjs --case <id> --replicate n --out <dir> [--timeout-ms n] [--max-actions n] [--job page|http]\n");
    process.exit(2);
  }
  runCell({ caseId, replicate: Number(arg("--replicate", "0")), timeoutMs: Number(arg("--timeout-ms", "300000")), maxActions: Number(arg("--max-actions", "25")), outDir, ...(arg("--job") ? { jobCheck: arg("--job") } : {}) }).then(
    (line) => process.stdout.write(`${JSON.stringify(line)}\n`),
    (err) => {
      process.stderr.write(`${err && err.message ? err.message : err}\n`);
      process.exit(1);
    },
  );
}
