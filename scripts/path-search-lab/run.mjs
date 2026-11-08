#!/usr/bin/env node
// #801 x-path-search-a: the removal-only arm. Candidates come from @jevitate/regression's
// minimizeRecording (ddmin over steps, imported from the built package, not copied); each candidate
// is replayed against a fresh accuracy-lab server and decided by the job's done check, read before
// and after in fresh browser contexts. No model calls. Usage:
//   node scripts/path-search-lab/run.mjs --arm removal --journey J1 --budget 30 [--variant clean] [--out DIR]
//   node scripts/path-search-lab/run.mjs --selftest
import { spawn } from "node:child_process";
import { appendFileSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { homedir, loadavg } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "../..");
process.env.TMPDIR ??= join(homedir(), "gt");
mkdirSync(process.env.TMPDIR, { recursive: true });

const dist = (pkg, file = "index.js") => import(pathToFileURL(join(ROOT, "packages", pkg, "dist", file)).href);
const CONFIRMATION = /confirm|agree|accept/i;

// ---- the guard: only paths a person could take -------------------------------------------------
export function controlName(rs) {
  const t = rs.step.target;
  if (!t) return "";
  return [t.display?.name, t.name, t.label, t.text, t.testId].filter(Boolean).join(" ");
}
export const isConfirmation = (rs) => rs.step.kind === "click" && CONFIRMATION.test(controlName(rs));

/** `original`/`kept`: flat arrays of RecordedStep (kept is a subsequence). Returns a refusal reason or null. */
export function refuseCandidate(original, kept) {
  const keptSet = new Set(kept);
  const removedConfirm = original.map((rs, i) => [rs, i]).filter(([rs]) => isConfirmation(rs) && !keptSet.has(rs)).map(([, i]) => i);
  if (removedConfirm.length === 0) return null;
  const first = Math.min(...removedConfirm);
  const deepLinks = original.some((rs, j) => j > first && keptSet.has(rs) && rs.step.kind === "navigate");
  return deepLinks ? "deep-link-past-confirmation" : "skipped-confirmation";
}

// ---- the lab app: one server per candidate, started and stopped by PID -------------------------
async function startApp(variant) {
  const child = spawn(process.execPath, [join(ROOT, "test/fixtures/accuracy-lab/app.mjs"), "--port", "0", "--variant", variant], { stdio: ["ignore", "pipe", "inherit"] });
  const port = await new Promise((res, rej) => {
    let buf = "";
    child.once("exit", (c) => rej(new Error(`app exited ${c}`)));
    child.stdout.on("data", (d) => {
      buf += d;
      const m = /ACME_CRM_LISTENING (\d+)/.exec(buf);
      if (m) res(Number(m[1]));
    });
  });
  if (port === 3001 || port === 4173) { process.kill(child.pid); throw new Error(`app got reserved port ${port}`); }
  const stop = () => new Promise((res) => { if (child.exitCode !== null) return res(); child.once("exit", res); process.kill(child.pid, "SIGTERM"); });
  return { url: `http://127.0.0.1:${port}`, pid: child.pid, stop };
}

async function waitForLoad() {
  while (loadavg()[0] >= 20) await new Promise((r) => setTimeout(r, 5000));
}

// ---- args ---------------------------------------------------------------------------------------
function args() {
  const a = process.argv.slice(2);
  const get = (n, d) => { const i = a.indexOf(`--${n}`); return i === -1 ? d : a[i + 1]; };
  return { selftest: a.includes("--selftest"), arm: get("arm"), journey: get("journey"), budget: Number(get("budget", "30")), variant: get("variant", "clean"), out: resolve(get("out", HERE)), recording: get("recording"), done: get("done") };
}

class BudgetExhausted extends Error {}

async function main() {
  const o = args();
  if (o.selftest) return selftest();
  if (o.arm !== "removal") throw new Error("only --arm removal is implemented in x-path-search-a");
  const { JOURNEYS } = await import("./journeys.mjs");
  let spec = JOURNEYS[o.journey];
  if (o.recording) spec = { recording: JSON.parse(readFileSync(o.recording, "utf8")), done: JSON.parse(readFileSync(o.done, "utf8")) };
  if (!spec) throw new Error(`unknown journey ${o.journey}; one of ${Object.keys(JOURNEYS).join(", ")} or --recording/--done`);

  const { minimizeRecording } = await dist("regression");
  const { RecordingSchema } = await dist("recording");
  const { RecordingInterpreter } = await dist("interpreter");
  const { readDoneCheck, evaluateJobDoneCheck } = await dist("cli", "journey-done-check.js");
  const { PlaywrightDoneCheckPort } = await dist("cli", "journey-done-check-hook.js");
  const { makeRealBrowserActor } = await dist("cli", "cli-shared.js");

  const original = JSON.parse(JSON.stringify(spec.recording));
  if (!RecordingSchema.safeParse(original).success) throw new Error("the Journey is not a valid Recording");
  const flat = original.pages.flatMap((p) => p.steps);
  const index = new Map(flat.map((rs, i) => [rs, i]));
  const outFile = join(o.out, "results.jsonl");
  mkdirSync(o.out, { recursive: true });

  let replays = 0, n = 0;
  let best = { kept: flat, steps: flat.length };
  const seen = new Map();
  const row = (extra) => appendFileSync(outFile, JSON.stringify({ arm: "removal", journey: o.journey, variant: o.variant, budget: o.budget, original_steps: flat.length, ...extra }) + "\n");

  async function replay(candidate) {
    await waitForLoad();
    const app = await startApp(o.variant); // a fresh server is the reset: state is in memory
    let close;
    try {
      const sub = (v) => ({ ...JSON.parse(JSON.stringify(v).replaceAll("__BASE__", app.url)), site: app.url });
      const rec = sub(candidate);
      const port = new PlaywrightDoneCheckPort({ origin: app.url });
      const read = (at) => readDoneCheck({ spec: spec.done, origin: app.url, auth: {}, params: {}, extracts: {}, browserPort: port, at });
      const before = await read("pre");
      const made = await makeRealBrowserActor(rec.site, undefined, undefined, undefined, undefined, [app.url]);
      close = made.close;
      const result = await new RecordingInterpreter({ targetTimeoutMs: 4000 }).run(made.actor, rec);
      await close().catch(() => {}); close = undefined;
      if (result.outcome !== "completed") return { verdict: "replay-failed", reason: `${result.outcome}@${result.at ?? "-"}` };
      const after = await read("post");
      const job = evaluateJobDoneCheck(before, after);
      return { verdict: job.attainment === "achieved" ? "achieved" : job.attainment, reason: job.basis };
    } finally {
      if (close) await close().catch(() => {});
      await app.stop();
    }
  }

  async function decide(candidate) {
    const kept = candidate.pages.flatMap((p) => p.steps);
    const id = kept.map((rs) => index.get(rs)).join(",");
    const base = { candidate: id, steps: kept.length };
    const refusal = refuseCandidate(flat, kept);
    if (refusal) { row({ ...base, verdict: "refused", reason: refusal, replays, n: ++n }); return false; }
    if (seen.has(id)) { row({ ...base, verdict: seen.get(id), reason: "cached", replays, n: ++n }); return seen.get(id) === "achieved"; }
    if (replays >= o.budget) throw new BudgetExhausted();
    const t0 = Date.now();
    replays += 1;
    const r = await replay(candidate);
    seen.set(id, r.verdict);
    row({ ...base, ...r, replays, n: ++n, ms: Date.now() - t0 });
    const ok = r.verdict === "achieved";
    if (ok && kept.length < best.steps) best = { kept, steps: kept.length };
    return ok;
  }

  let exhausted = false;
  try {
    // The recorded Journey itself first: if it does not achieve the job, nothing shorter can.
    const baseline = await decide(original);
    if (baseline) await minimizeRecording(original, decide);
    else console.error(`${o.journey}: the recorded path does not achieve the job on ${o.variant}; nothing to search`);
  } catch (e) {
    if (e instanceof BudgetExhausted) exhausted = true; else throw e;
  }
  const summary = { journey: o.journey, original_steps: flat.length, shortest_found: best.steps, kept: best.kept.map((rs) => index.get(rs)), replays_used: replays, budget: o.budget, budget_exhausted: exhausted };
  console.log(JSON.stringify(summary));
}

function selftest() {
  const mk = (kind, name) => ({ step: { kind, ...(name ? { target: { testId: name } } : {}) } });
  const orig = [mk("navigate"), mk("click", "go-import"), mk("click", "import-confirm"), mk("navigate")];
  const check = (kept, want) => { const got = refuseCandidate(orig, kept); if (got !== want) throw new Error(`kept ${kept.map((k) => orig.indexOf(k))}: wanted ${want}, got ${got}`); };
  check(orig, null);
  check([orig[0], orig[1], orig[3]], "deep-link-past-confirmation"); // confirm dropped, deep link kept
  check([orig[0], orig[1]], "skipped-confirmation");
  check([orig[0], orig[2], orig[3]], null); // a non-confirmation control may go
  console.log("selftest ok");
}

main().catch((e) => { console.error(e); process.exit(1); });
