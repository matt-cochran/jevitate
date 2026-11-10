#!/usr/bin/env node
// #802 mock-harness lab driver. Records one real run of `jz-triager-files-issue` on the synthetic
// gRPC-Web stack (real-server.mjs) through a recording proxy, redacts it into MockServer expectations
// (mock-data/expectations.json), scans them (scan.log), then runs the Journey N times on a MockServer
// container declared `trust: "harness"` and N times on the real stack declared `trust: "test"`, with
// a drift probe, a drift arm (the real API changes, the mock does not) and a mutation-proof arm.
//
// Usage: node scripts/mock-harness-lab/run-lab.mjs [--repeats 5] [--work <dir>] [--skip-proof]
// Needs: a built worktree (packages/cli/dist), docker with mockserver/mockserver:5.15.0 and
// zricethezav/gitleaks:v8.21.2. Ports 28190 (real), 28191 (MockServer), 28192 (recording proxy).
// Writes only under --work (default ~/gt/mock-harness-lab-work) and this directory's mock-data/,
// scan.log and results.json. HOME is moved into --work, so nothing touches ~/.jevitate.
import { spawn, spawnSync } from "node:child_process";
import { cpSync, existsSync, symlinkSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { clock } from "../../packages/domain/dist/index.js";
import { diffFields, redactExchange, responseView, scan, secretRules, startRecordingProxy, toExpectations } from "./mockdata.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "../..");
const args = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = args.indexOf(name);
  return i < 0 ? dflt : args[i + 1];
};
const REPEATS = Number(opt("--repeats", "5"));
const WORK = resolve(opt("--work", join(homedir(), "gt", "mock-harness-lab-work")));
const SKIP_PROOF = args.includes("--skip-proof");
const REAL = 28190;
const MOCK = 28191;
const PROXY = 28192;
const ORIGIN = (p) => `http://127.0.0.1:${p}`;
const JOURNEY = "jz-triager-files-issue";
const MOCK_IMAGE = "mockserver/mockserver:5.15.0";
const GITLEAKS_IMAGE = "zricethezav/gitleaks:v8.21.2";
const CONTAINER = "mhlab-mockserver";

const log = (...a) => process.stdout.write(a.join(" ") + "\n");
const children = [];

async function waitFor(fn, what, ms = 60_000) {
  const start = clock.monotonicMs();
  for (;;) {
    try {
      if (await fn()) return;
    } catch {
      // not up yet
    }
    if (clock.monotonicMs() - start > ms) throw new Error(`timed out waiting for ${what}`);
    await clock.sleep(250);
  }
}

async function loadGate() {
  await waitFor(async () => Number(readFileSync("/proc/loadavg", "utf8").split(" ")[0]) <= 16, "load <= 16", 30 * 60_000);
  return Number(readFileSync("/proc/loadavg", "utf8").split(" ")[0]);
}

function startReal(extra = []) {
  const child = spawn(process.execPath, [join(here, "real-server.mjs"), "--port", String(REAL), "--secrets-out", join(WORK, "secrets.json"), ...extra], { stdio: ["ignore", "pipe", "inherit"] });
  children.push(child);
  return waitFor(async () => (await fetch(`${ORIGIN(REAL)}/proto.js`)).ok, "real server").then(() => child);
}

async function stopReal(child) {
  child.kill("SIGTERM");
  await new Promise((r) => child.once("exit", r));
}

async function resetReal() {
  const t = clock.monotonicMs();
  const r = await fetch(`${ORIGIN(REAL)}/__lab/reset`, { method: "POST" });
  if (r.status !== 204) throw new Error("reset failed");
  return (clock.monotonicMs() - t) / 1000;
}

function docker(argv, opts = {}) {
  const r = spawnSync("docker", argv, { encoding: "utf8", ...opts });
  return { code: r.status, out: (r.stdout ?? "") + (r.stderr ?? "") };
}

async function startMock() {
  docker(["rm", "-f", CONTAINER]);
  const r = docker(["run", "-d", "--rm", "--name", CONTAINER, "-p", `127.0.0.1:${MOCK}:1080`, "-e", "MOCKSERVER_LOG_LEVEL=WARN", MOCK_IMAGE]);
  if (r.code !== 0) throw new Error(`mockserver: ${r.out}`);
  await waitFor(async () => (await fetch(`${ORIGIN(MOCK)}/mockserver/status`, { method: "PUT" })).ok, "mockserver");
}

async function loadMock(expectations) {
  const t = clock.monotonicMs();
  await fetch(`${ORIGIN(MOCK)}/mockserver/reset`, { method: "PUT" });
  const r = await fetch(`${ORIGIN(MOCK)}/mockserver/expectation`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(expectations) });
  if (r.status !== 201) throw new Error(`mockserver expectation load: ${r.status} ${await r.text()}`);
  return (clock.monotonicMs() - t) / 1000;
}

function cliEnv() {
  return {
    PATH: process.env.PATH,
    HOME: join(WORK, "home"),
    PLAYWRIGHT_BROWSERS_PATH: process.env.PLAYWRIGHT_BROWSERS_PATH ?? join(homedir(), ".cache", "ms-playwright"),
    TMPDIR: join(WORK, "tmp"),
    JEVITATE_RUN_RECORD: "",
    NO_COLOR: "1",
  };
}

// Async on purpose: the recording proxy runs in this process, so a sync spawn would starve it.
async function jev(argv, launcher = join(here, "jev.mjs")) {
  const start = clock.monotonicMs();
  const child = spawn(process.execPath, [launcher, ...argv], { cwd: join(WORK, "project"), env: cliEnv(), stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (c) => (stdout += c));
  child.stderr.on("data", (c) => (stderr += c));
  const status = await new Promise((r) => child.once("close", (code) => r(code)));
  const seconds = (clock.monotonicMs() - start) / 1000;
  let data = null;
  try {
    data = JSON.parse(stdout).data ?? null;
  } catch {
    // not JSON (a crash); kept in raw
  }
  return { exit: status, seconds, data, raw: data === null ? (stdout + stderr).slice(-4000) : undefined };
}

function latestEvidence() {
  const logs = join(WORK, "project", ".jevitate", "logs");
  if (!existsSync(logs)) return null;
  const dirs = readdirSync(logs).flatMap((d) =>
    statSync(join(logs, d)).isDirectory()
      ? readdirSync(join(logs, d))
          .filter((f) => f.startsWith("journey-evidence-"))
          .map((f) => join(logs, d, f))
      : [],
  );
  dirs.sort((a, b) => statSync(a).mtimeMs - statSync(b).mtimeMs);
  const last = dirs.at(-1);
  if (!last) return null;
  const file = join(last, "evidence.json");
  return existsSync(file) ? { dir: last, ev: JSON.parse(readFileSync(file, "utf8")) } : null;
}

async function runJourney(env, label, launcher) {
  const load1 = await loadGate();
  const r = await jev(["journey", "run", JOURNEY, "--project", join(WORK, "project"), "--env", env, "--json"], launcher);
  const e = latestEvidence();
  const row = {
    label,
    env,
    exit: r.exit,
    seconds: Number(r.seconds.toFixed(2)),
    load1Before: load1,
    outcome: r.data?.outcome ?? null,
    job: r.data?.job ?? null,
    failedAt: r.data?.failedAtIndex ?? r.data?.failure?.stepIndex ?? null,
    reason: r.data?.reason ?? r.data?.failure?.message ?? null,
    evidence: e
      ? { mode: e.ev.run?.mode, trust: e.ev.run?.target?.trust, doneBefore: e.ev.doneCheck?.before?.value ?? null, doneAfter: e.ev.doneCheck?.after?.value ?? null }
      : null,
    raw: r.raw,
  };
  log(`${label}: exit ${row.exit} ${row.seconds}s outcome=${row.outcome} job=${JSON.stringify(row.job)} done=${JSON.stringify(row.evidence?.doneAfter)}`);
  return row;
}

async function verifyJourney(env, label, before) {
  const load1 = await loadGate();
  const r = await jev(["journey", "verify", JOURNEY, "--project", join(WORK, "project"), "--env", env, "--mutate", "--before", before, "--allow-shell-hooks", "--json"]);
  const d = r.data ?? {};
  const row = {
    label,
    env,
    exit: r.exit,
    seconds: Number(r.seconds.toFixed(2)),
    load1Before: load1,
    verdict: d.verdict ?? d.summary?.verdict ?? null,
    countsForGate: d.countsForGate ?? d.checks?.countsForGate ?? null,
    reason: d.reason ?? d.summary?.reason ?? null,
    mutations: (d.mutations ?? []).map((m) => ({ id: m.id, verdict: m.verdict, reason: m.reason })),
    assertions: (d.assertions ?? []).map((a) => ({ site: a.site, verdict: a.verdict })),
    raw: r.data === null ? r.raw : undefined,
  };
  log(`${label}: exit ${row.exit} ${row.seconds}s verdict=${row.verdict} countsForGate=${row.countsForGate}`);
  return row;
}

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length === 0 ? null : s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};

/** Replays the recorded request sequence against the fresh mock and the fresh real stack, field by field. */
async function driftProbe(raw, expectations, label) {
  await loadMock(expectations);
  await resetReal();
  const first = await fetch(`${ORIGIN(REAL)}/triage`);
  const cookie = (first.headers.get("set-cookie") ?? "").split(";")[0];
  const csrf = /name="csrf-token" content="([^"]+)"/.exec(await first.text())?.[1] ?? "";
  const rows = [];
  for (const x of raw) {
    const init = (auth) => ({ method: x.method, headers: { "content-type": "application/grpc-web+proto", ...(auth ? { cookie, "x-csrf-token": csrf } : {}) }, ...(x.method === "GET" ? {} : { body: Buffer.from(x.requestBody, "base64") }) });
    const [m, r] = await Promise.all([fetch(`${ORIGIN(MOCK)}${x.path}`, init(false)), fetch(`${ORIGIN(REAL)}${x.path}`, init(true))]);
    const mb = Buffer.from(await m.arrayBuffer());
    const rb = Buffer.from(await r.arrayBuffer());
    let fields;
    if (x.path.startsWith("/journeeze.")) fields = diffFields(responseView(x.path, m.status, mb.toString("base64")), responseView(x.path, r.status, rb.toString("base64")));
    else {
      const norm = (b) => b.toString("utf8").replace(/(<meta name="csrf-token" content=")[^"]*(")/, "$1CSRF$2");
      fields = norm(mb) === norm(rb) && m.status === r.status ? [] : ["body"];
    }
    const kind = (f) => (/reporterEmail$/.test(f) ? "redacted" : /updatedAt$/.test(f) ? "volatile" : "semantic");
    rows.push({ request: `${x.method} ${x.path}`, differing: fields.map((f) => ({ field: f, kind: kind(f) })) });
  }
  const semantic = rows.filter((r) => r.differing.some((d) => d.kind === "semantic"));
  log(`drift probe ${label}: ${rows.length} requests, ${semantic.length} with semantic differences`);
  return { label, requests: rows.length, semantic: semantic.length, rows };
}

function gitleaks(dir, label) {
  const r = docker(["run", "--rm", "-v", `${dir}:/scan:ro`, GITLEAKS_IMAGE, "detect", "--no-git", "--no-banner", "--source", "/scan", "--redact", "--exit-code", "0", "--report-format", "json", "--report-path", "/dev/stdout"]);
  let n = null;
  try {
    const start = r.out.indexOf("[");
    n = JSON.parse(r.out.slice(start, r.out.lastIndexOf("]") + 1)).length;
  } catch {
    n = null;
  }
  let rules = null;
  try {
    const start = r.out.indexOf("[");
    rules = [...new Set(JSON.parse(r.out.slice(start, r.out.lastIndexOf("]") + 1)).map((f) => f.RuleID))];
  } catch {
    rules = null;
  }
  return { label, findings: n, rules, tail: r.out.split("\n").filter((l) => /leaks|scan|WRN|ERR/i.test(l)).slice(-3) };
}

async function main() {
  rmSync(WORK, { recursive: true, force: true });
  for (const d of ["home/.cache", "tmp"]) mkdirSync(join(WORK, d), { recursive: true });
  // jevitate looks for Playwright's pinned Chromium under $HOME/.cache; reuse the real cache read-only.
  symlinkSync(join(homedir(), ".cache", "ms-playwright"), join(WORK, "home", ".cache", "ms-playwright"));
  cpSync(join(here, "project"), join(WORK, "project"), { recursive: true });
  writeFileSync(
    join(WORK, "project", ".jevitate", "environments.json"),
    JSON.stringify(
      {
        harness: { baseUrl: ORIGIN(MOCK), trust: "harness" },
        staging: { baseUrl: ORIGIN(REAL), trust: "test" },
        record: { baseUrl: ORIGIN(PROXY), trust: "test" },
      },
      null,
      2,
    ),
  );
  const results = { startedAt: clock.nowIso(), repeats: REPEATS, ports: { REAL, MOCK, PROXY }, images: [MOCK_IMAGE, GITLEAKS_IMAGE], engine: (await jev(["--version"])).raw?.trim() ?? null };

  // 1. Record one real run through the proxy.
  let real = await startReal();
  await resetReal();
  const rawFile = join(WORK, "raw-recording.jsonl");
  const proxy = await startRecordingProxy({ port: PROXY, upstream: ORIGIN(REAL), logFile: rawFile });
  results.recording = await runJourney("record", "record (real, via proxy)");
  // The wiring gap: the shipped bin.js on the same real stack, to show it returns no `job` at all.
  await resetReal();
  results.plainBin = await runJourney("staging", "real via shipped bin.js", join(repo, "packages/cli/dist/bin.js"));
  await resetReal();
  await new Promise((r) => proxy.close(r));
  const raw = readFileSync(rawFile, "utf8").trim().split("\n").map((l) => JSON.parse(l));

  // 2. Redact into MockServer expectations; scan.
  const emails = new Map();
  const expectations = toExpectations(raw.map((x) => redactExchange(x, emails)));
  mkdirSync(join(here, "mock-data"), { recursive: true });
  writeFileSync(join(here, "mock-data", "expectations.json"), JSON.stringify(expectations, null, 2) + "\n");
  const secrets = JSON.parse(readFileSync(join(WORK, "secrets.json"), "utf8"));
  const known = [secrets.csrf, ...secrets.sessions, ...emails.keys()];
  const rules = secretRules(known);
  const rawFindings = scan(raw, rules);
  const mockFindings = scan(expectations, rules);
  // gitleaks over the committed file and over a decoded text dump of it (gitleaks cannot see into base64 protobuf).
  const decodedDir = join(WORK, "decoded");
  mkdirSync(join(decodedDir, "mock"), { recursive: true });
  mkdirSync(join(decodedDir, "raw"), { recursive: true });
  const { scanTexts } = await import("./mockdata.mjs");
  writeFileSync(join(decodedDir, "mock", "decoded.txt"), expectations.flatMap((e) => scanTexts(e).map((t) => `${t.where}: ${t.text}`)).join("\n"));
  writeFileSync(join(decodedDir, "raw", "decoded.txt"), raw.flatMap((e) => scanTexts(e).map((t) => `${t.where}: ${t.text}`)).join("\n"));
  mkdirSync(join(WORK, "rawonly"), { recursive: true });
  cpSync(rawFile, join(WORK, "rawonly", "raw-recording.jsonl"));
  const gl = [
    gitleaks(join(here, "mock-data"), "mock-data/ (committed)"),
    gitleaks(join(decodedDir, "mock"), "mock-data decoded"),
    gitleaks(join(WORK, "rawonly"), "raw recording as stored (positive control)"),
    gitleaks(join(decodedDir, "raw"), "raw recording decoded (positive control)"),
  ];
  const scanLog = [
    `# #802 mock-harness lab secret scan (${clock.nowIso()})`,
    `scanner: scripts/mock-harness-lab/mockdata.mjs scan() — ${rules.length} rules: ${rules.filter((r) => !r.literal).map((r) => r.id).join(", ")}, plus ${known.length} exact values issued during the recorded run (${secrets.sessions.length} session cookies, 1 CSRF token, ${emails.size} reporter e-mails); reads paths, headers, raw bodies and decoded protobuf fields`,
    `positive control: raw recording (${raw.length} exchanges, never committed): ${rawFindings.reduce((a, f) => a + f.count, 0)} matches`,
    ...summarize(rawFindings).map((l) => `  ${l}`),
    `recorded mock data: scripts/mock-harness-lab/mock-data/expectations.json (${expectations.length} expectations): ${mockFindings.reduce((a, f) => a + f.count, 0)} matches`,
    ...summarize(mockFindings).map((l) => `  ${l}`),
    `gitleaks ${GITLEAKS_IMAGE}:`,
    ...gl.map((g) => `  ${g.label}: ${g.findings === null ? "unparsed" : `${g.findings} findings${g.rules?.length ? ` (${g.rules.join(", ")})` : ""}`}`),
    "",
  ].join("\n");
  writeFileSync(join(here, "scan.log"), scanLog);
  log(scanLog);
  results.scan = { rawMatches: rawFindings.reduce((a, f) => a + f.count, 0), mockMatches: mockFindings.reduce((a, f) => a + f.count, 0), gitleaks: gl, expectations: expectations.length, exchanges: raw.length };

  // 3. Harness and real arms, interleaved (H, R, H, R, ...) so load drift hits both alike.
  await startMock();
  results.harness = [];
  results.real = [];
  results.resetSeconds = { harness: [], real: [] };
  for (let i = 1; i <= REPEATS; i++) {
    results.resetSeconds.harness.push(await loadMock(expectations));
    results.harness.push(await runJourney("harness", `harness ${i}`));
    results.resetSeconds.real.push(await resetReal());
    results.real.push(await runJourney("staging", `real ${i}`));
  }
  results.driftProbe = await driftProbe(raw, expectations, "unchanged API");

  // 4. Mutation proof (the write proof), one per arm, reset before every replay.
  if (!SKIP_PROOF) {
    const mockReset = `curl -sf -X PUT ${ORIGIN(MOCK)}/mockserver/reset >/dev/null && curl -sf -X PUT -H 'content-type: application/json' --data-binary @${join(here, "mock-data", "expectations.json")} ${ORIGIN(MOCK)}/mockserver/expectation >/dev/null`;
    const realReset = `curl -sf -X POST ${ORIGIN(REAL)}/__lab/reset`;
    await loadMock(expectations);
    results.proofHarness = await verifyJourney("harness", "proof harness", mockReset);
    await resetReal();
    results.proofReal = await verifyJourney("staging", "proof real", realReset);
  }

  // 5. Drift arm: the real API changes (FileIssue requires `severity`); the mock is not re-recorded.
  await stopReal(real);
  real = await startReal(["--drift"]);
  results.driftHarness = [];
  results.driftReal = [];
  for (let i = 1; i <= REPEATS; i++) {
    await loadMock(expectations);
    results.driftHarness.push(await runJourney("harness", `drift harness ${i}`));
    await resetReal();
    results.driftReal.push(await runJourney("staging", `drift real ${i}`));
  }
  results.driftProbeChanged = await driftProbe(raw, expectations, "changed API (--drift)");
  await stopReal(real);
  docker(["rm", "-f", CONTAINER]);

  const pass = (r) => r.exit === 0 && r.outcome === "ok";
  const ff = (h, r) => h.filter((x, i) => pass(x) && !pass(r[i])).length;
  results.summary = {
    falseFeasible: `${ff(results.harness, results.real)}/${REPEATS}`,
    driftFalseFeasible: `${ff(results.driftHarness, results.driftReal)}/${REPEATS}`,
    medianHarnessS: median(results.harness.map((r) => r.seconds)),
    medianRealS: median(results.real.map((r) => r.seconds)),
    medianMockResetS: median(results.resetSeconds.harness),
    medianRealResetS: median(results.resetSeconds.real),
  };
  results.summary.ratio = Number((results.summary.medianHarnessS / results.summary.medianRealS).toFixed(3));
  results.finishedAt = clock.nowIso();
  for (const arm of ["recording"]) delete results[arm].raw;
  writeFileSync(join(here, "results.json"), JSON.stringify(results, null, 2) + "\n");
  log(JSON.stringify(results.summary, null, 2));
}

function summarize(findings) {
  const by = new Map();
  for (const f of findings) by.set(`${f.rule} in ${f.where}`, (by.get(`${f.rule} in ${f.where}`) ?? 0) + f.count);
  return [...by].map(([k, n]) => `${n} x ${k}`);
}

main().catch((err) => {
  process.stderr.write(`${err.stack ?? err}\n`);
  for (const c of children) c.kill("SIGTERM");
  docker(["rm", "-f", CONTAINER]);
  process.exitCode = 1;
});
