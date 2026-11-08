#!/usr/bin/env node
// #801 x-path-search-a/-b: the removal arm (-a), plus the anneal and jev arms (-b). Candidates come from @jevitate/regression's
// minimizeRecording (ddmin over steps, imported from the built package, not copied); each candidate
// is replayed against a fresh accuracy-lab server and decided by the job's done check, read before
// and after in fresh browser contexts. Arms: removal (ddmin, no model), anneal (removal + substituting an
// alternative control from the exploration pool, seeded simulated annealing, no model), jev (Jev ranks the
// single moves by control role and name only; REAL paid calls, capped at --cost-cap USD across all rows).
// Usage:
//   node scripts/path-search-lab/run.mjs --arm removal|anneal|jev --journey J1 --budget 30 [--variant clean] [--out DIR]
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
  return { selftest: a.includes("--selftest"), arm: get("arm"), journey: get("journey"), budget: Number(get("budget", "30")), variant: get("variant", "clean"), out: resolve(get("out", join(HERE, "report"))), seed: Number(get("seed", "801")), costCap: Number(get("cost-cap", "1.00")), recording: get("recording"), done: get("done") };
}

class BudgetExhausted extends Error {}
class CostCapReached extends Error {}

function mulberry32(a) {
  return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

// ---- moves: removal and substituting a recorded alternative (anneal and jev arms) ----------------
const routeAfter = (rs, route) => {
  if (rs.step.kind === "navigate") return new URL(rs.step.url.replace("__BASE__", "http://x"), "http://x").pathname;
  if (rs.step.kind === "click" && rs.step.expect?.kind === "urlIncludes") return rs.step.expect.text;
  return route;
};
const sameControl = (rs, alt) => {
  const t = rs.step.target ?? {};
  return (alt.testId && t.testId === alt.testId) || (rs.step.target?.display?.name ?? t.display?.name ?? rs.step.display?.name) === alt.name || t.name === alt.name;
};
/** All single moves from `cur` (array of RecordedStep): [{kind, at, steps, label, id}] */
function movesFrom(cur, pool, idOf) {
  const out = [];
  let route = "";
  const ids = (list) => list.map((rs) => idOf.get(rs)).join(",");
  cur.forEach((rs, k) => {
    out.push({ kind: "remove", at: k, steps: cur.filter((_, j) => j !== k), label: `remove step ${k + 1} (${stepLabel(rs)})` });
    if (rs.step.kind === "click") {
      for (const alt of pool[route] ?? []) {
        if (sameControl(rs, alt)) continue;
        const aid = `${idOf.get(rs).toString().split("~")[0]}~${alt.role}:${alt.name}`;
        const target = alt.testId ? { testId: alt.testId } : { role: alt.role, name: alt.name };
        const sub = { step: { kind: "click", target: { ...target, display: { role: alt.role, name: alt.name } }, expect: rs.step.expect } };
        idOf.set(sub, aid);
        out.push({ kind: "substitute", at: k, steps: cur.map((x, j) => (j === k ? sub : x)), label: `replace step ${k + 1} (${stepLabel(rs)}) with click ${alt.role} "${alt.name}"` });
      }
    }
    route = routeAfter(rs, route);
  });
  for (const m of out) m.id = ids(m.steps);
  return out;
}
/** A step described by control role and name only: never a typed value, never page text. */
function stepLabel(rs) {
  const s = rs.step, t = s.target ?? {};
  const name = t.display?.name ?? t.name ?? t.testId ?? "";
  switch (s.kind) {
    case "navigate": return `go to page ${new URL(s.url.replace("__BASE__", "http://x"), "http://x").pathname}`;
    case "click": return `click ${t.display?.role ?? t.role ?? "control"} "${name}"`;
    case "fill": return `type into textbox "${name}"`;
    case "select": return `choose an option in dropdown "${name}"`;
    default: return `${s.kind} on "${name}"`;
  }
}

async function main() {
  const o = args();
  if (o.selftest) return selftest();
  if (!["removal", "anneal", "jev"].includes(o.arm)) throw new Error("--arm removal|anneal|jev");
  const { JOURNEYS } = await import("./journeys.mjs");
  let spec = JOURNEYS[o.journey];
  if (o.recording) spec = { recording: JSON.parse(readFileSync(o.recording, "utf8")), done: JSON.parse(readFileSync(o.done, "utf8")) };
  if (!spec) throw new Error(`unknown journey ${o.journey}; one of ${Object.keys(JOURNEYS).join(", ")} or --recording/--done`);
  // The three explorations are of one app: testIds seen in any of them identify the same control in all.
  const pool = o.arm === "removal" ? {} : JSON.parse(readFileSync(join(HERE, "exploration", `${o.journey}.json`), "utf8")).pool;
  if (o.arm !== "removal") {
    const known = new Map();
    for (const f of readdirSync(join(HERE, "exploration"))) for (const l of Object.values(JSON.parse(readFileSync(join(HERE, "exploration", f), "utf8")).pool)) for (const c of l) if (c.testId) known.set(`${c.role}|${c.name}`, c.testId);
    for (const l of Object.values(pool)) for (const c of l) if (!c.testId && known.has(`${c.role}|${c.name}`)) c.testId = known.get(`${c.role}|${c.name}`);
  }

  const { minimizeRecording } = await dist("regression");
  const { RecordingSchema } = await dist("recording");
  const { RecordingInterpreter } = await dist("interpreter");
  const { readDoneCheck, evaluateJobDoneCheck } = await dist("cli", "journey-done-check.js");
  const { PlaywrightDoneCheckPort } = await dist("cli", "journey-done-check-hook.js");
  const { makeRealBrowserActor } = await dist("cli", "cli-shared.js");

  const original = JSON.parse(JSON.stringify(spec.recording));
  if (!RecordingSchema.safeParse(original).success) throw new Error("the Journey is not a valid Recording");
  if (original.pages.length !== 1) throw new Error("harness assumes one page group");
  const flat = original.pages[0].steps;
  const idOf = new Map(flat.map((rs, i) => [rs, i]));
  const outFile = join(o.out, "results.jsonl");
  mkdirSync(o.out, { recursive: true });
  const build = (steps) => ({ ...original, pages: [{ ...original.pages[0], steps }] });

  let replays = 0, n = 0;
  let best = { kept: flat, steps: flat.length };
  const seen = new Map();
  const row = (extra) => appendFileSync(outFile, JSON.stringify({ arm: o.arm, journey: o.journey, variant: o.variant, budget: o.budget, original_steps: flat.length, ...(o.arm === "anneal" ? { seed: o.seed } : {}), ...extra }) + "\n");

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

  /** Decide one candidate (array of RecordedStep). The confirmation guard applies to every arm. */
  async function decideSteps(kept, extra = {}) {
    const id = kept.map((rs) => idOf.get(rs)).join(",");
    const base = { candidate: id, steps: kept.length, ...extra };
    const refusal = refuseCandidate(flat, kept);
    if (refusal) { row({ ...base, verdict: "refused", reason: refusal, replays, n: ++n }); return { verdict: "refused", ok: false }; }
    if (seen.has(id)) { row({ ...base, verdict: seen.get(id), reason: "cached", replays, n: ++n }); return { verdict: seen.get(id), ok: seen.get(id) === "achieved" }; }
    if (replays >= o.budget) throw new BudgetExhausted();
    const t0 = Date.now();
    replays += 1;
    const r = await replay(build(kept));
    seen.set(id, r.verdict);
    const ok = r.verdict === "achieved";
    if (ok && kept.length < best.steps) best = { kept, steps: kept.length };
    row({ ...base, ...r, replays, n: ++n, ms: Date.now() - t0, best_steps: best.steps });
    return { verdict: r.verdict, ok };
  }
  const guardRefuses = (kept) => refuseCandidate(flat, kept);

  const tried = new Set();
  let stopReason = null;
  let jevCost = 0, jevCalls = 0;
  try {
    // The recorded Journey itself first: if it does not achieve the job, nothing shorter can.
    const baseline = await decideSteps(flat);
    if (!baseline.ok) { console.error(`${o.journey}: the recorded path does not achieve the job on ${o.variant}; nothing to search`); }
    else if (o.arm === "removal") {
      await minimizeRecording(original, async (c) => (await decideSteps(c.pages.flatMap((p) => p.steps))).ok);
    } else if (o.arm === "anneal") await anneal();
    else jevCost = await jevArm();
  } catch (e) {
    if (e instanceof BudgetExhausted) stopReason = "budget"; else if (e instanceof CostCapReached) stopReason = "cost-cap"; else throw e;
  }

  async function anneal() {
    const rand = mulberry32(o.seed);
    const T0 = 2, COOL = 0.9, PENALTY = 3;
    const energy = (steps, verdict) => steps.length + (verdict === "achieved" ? 0 : PENALTY);
    let cur = { steps: flat, e: flat.length };
    let proposals = 0;
    while (proposals++ < 5000) {
      const T = T0 * COOL ** Math.max(0, replays - 1);
      let moves = movesFrom(cur.steps, pool, idOf).filter((m) => !seen.has(m.id) && !guardRefuses(m.steps) && !tried.has(m.id));
      if (moves.length === 0) { // exhausted around cur: restart from the best found
        if (cur.steps === best.kept) break;
        cur = { steps: best.kept, e: best.steps };
        continue;
      }
      const m = moves[Math.floor(rand() * moves.length)];
      tried.add(m.id);
      const r = await decideSteps(m.steps, { move: m.kind, temperature: Number(T.toFixed(4)) });
      if (r.verdict === "refused") continue;
      const e = energy(m.steps, r.verdict);
      const accept = e <= cur.e || rand() < Math.exp(-(e - cur.e) / T);
      appendFileSync(outFile, JSON.stringify({ arm: "anneal", journey: o.journey, seed: o.seed, note: "accept", candidate: m.id, from_energy: cur.e, to_energy: e, temperature: Number(T.toFixed(4)), accepted: accept }) + "\n");
      if (accept) cur = { steps: m.steps, e };
    }
  }
  async function jevArm() {
    const { JevJudgmentGateway, RetryingJudgmentPort, UsageTracker, envCredentialStore, realJevClientCall } = await dist("ai-core");
    const { loadLocalCredentials } = await dist("cli", "credentials-file.js");
    const store = envCredentialStore(process.env, loadLocalCredentials()); // reads the key; never printed or stored
    if (!store.detect("OPENROUTER_API_KEY")) throw new Error("no OPENROUTER_API_KEY in env or local credentials; the jev arm cannot run");
    const usage = new UsageTracker();
    const judge = new RetryingJudgmentPort(new JevJudgmentGateway(store, await realJevClientCall(undefined, usage), "openrouter"));
    const spentBefore = () => readFileSync(outFile, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)).filter((r) => r.kind === "jev-call").reduce((s, r) => s + (r.usd ?? 0), 0);
    let cur = flat;
    for (;;) {
      const moves = movesFrom(cur, pool, idOf).filter((m) => !seen.has(m.id) && !guardRefuses(m.steps) && !tried.has(m.id));
      if (moves.length === 0) break;
      if (spentBefore() >= o.costCap) throw new CostCapReached();
      const path = cur.map((rs, i) => `${i + 1}. ${stepLabel(rs)}`).join("; ");
      const questions = {};
      moves.forEach((m, i) => {
        questions[`m${i}`] = {
          kind: "score",
          instructions: `A person wants to "${spec.job}" in a web app. Their current path is: ${path}. Proposed change: ${m.label}. How likely is it that the person can still complete that job by following the changed path, with every step doing what its words say?`,
          criteria: ["the job would not get done", "the job would still get done"],
        };
      });
      const before = usage.calls().length;
      const answers = await judge.systemOne({ state: { goal: spec.job, url: "app", controls: cur.map(stepLabel), history: [] }, questions });
      const calls = usage.calls().slice(before);
      for (const c of calls) { jevCalls += 1; appendFileSync(outFile, JSON.stringify({ kind: "jev-call", arm: "jev", journey: o.journey, seq: jevCalls, questions: moves.length, usd: c.usd ?? null, source: c.source, model: c.model ?? null, inputTokens: c.inputTokens, outputTokens: c.outputTokens, ok: c.ok }) + "\n"); }
      if (calls.some((c) => c.usd === undefined)) throw new Error("a Jev call reported no cost; stopping the arm so the cap stays verifiable");
      const scored = moves.map((m, i) => ({ m, score: answers[`m${i}`]?.value ?? 0.5 })).sort((a, b) => b.score - a.score || a.m.steps.length - b.m.steps.length);
      let accepted = false;
      for (const [rank, { m, score }] of scored.entries()) {
        tried.add(m.id);
        const r = await decideSteps(m.steps, { move: m.kind, rank: rank + 1, jev_score: score });
        if (r.ok) { cur = m.steps; accepted = true; break; } // re-rank from the new path
      }
      if (!accepted) break;
    }
    return spentBefore();
  }

  const summary = { arm: o.arm, journey: o.journey, original_steps: flat.length, shortest_found: best.steps, kept: best.kept.map((rs) => idOf.get(rs)), replays_used: replays, budget: o.budget, stopped: stopReason, ...(o.arm === "jev" ? { jev_calls: jevCalls, jev_cost_usd_total: readFileSync(outFile, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)).filter((r) => r.kind === "jev-call" && r.journey === o.journey).reduce((a, r) => a + (r.usd ?? 0), 0) } : {}) };
  appendFileSync(outFile, JSON.stringify({ kind: "summary", ...summary }) + "\n");
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
