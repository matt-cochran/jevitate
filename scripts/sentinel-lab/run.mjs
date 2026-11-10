#!/usr/bin/env node
// #794 / x-sentinel-measure: drive the shadow write sentinel over the seeded cases through the REAL
// gateway path, and append one JSON line per case.
//
//   node scripts/sentinel-lab/run.mjs --mode scripted [--out scripts/sentinel-lab/results.jsonl]
//   node scripts/sentinel-lab/run.mjs --mode live --max-usd 1 [--provider openrouter|typesafe] [--no-titles]
//
// --no-titles registers the hook without `jobTitle`, as registerRunSurfaceHooks wires it today, so the
// goal Jev sees is "<job id>: <job id>".
//
// The path each case takes is production code from the built packages (run `pnpm -r build` first):
//   runBeforeWriteHooks (journey-run-hooks)            the run's beforeWrite dispatch
//   -> registerSentinelShadowHook's hook (sentinel-hook) controlOf / pathShapeOf / job / threshold
//   -> WriteSentinel.judge (runtime)                    structure-only payload, redaction guard
//   -> RetryingJudgmentPort(JevJudgmentGateway)         ai-core: route, redactModelPayload, credential guard
//   -> JevClientCall                                     scripted (offline) or realJevClientCall (live)
// Only the browser is replaced: the step's locator is a stub whose page() has the case's URL and a
// page body holding PAGE_MARKER, which the hook must never read.
//
// scripted mode: the call is a lexical stand-in that answers from the WIRE payload only (what Jev would
// see), so the plumbing, the payload and the scoring are checked offline. It is a baseline, not Jev.
// live mode: realJevClientCall with the key from the env or ~/.jevitate/credentials.json (read only).
// Each case is one systemOne call (two noul questions). The run stops before a call once the tracked
// cost reaches --max-usd.
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../..");
const dist = (p) => resolve(root, p);

export const PAGE_MARKER = "MARKER_PAGE_TEXT_SENTINEL_LAB";
export const SECRET_MARKER = "MARKER_S_sentinel-lab-secret-794";

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] !== undefined ? process.argv[i + 1] : fallback;
}

/** A lexical stand-in for Jev over the wire payload only (no case truth is visible to it). */
export function lexicalAnswer(state) {
  const text = `${state.controls.join(" ")}`.toLowerCase();
  const destructive = /\b(delete|remove|clear|purge|wipe|erase|reset|revoke|cancel|deactivate|discard|replace|unsubscribe|archive|transfer|merge)\b/.test(text);
  const goal = state.goal.toLowerCase();
  const verbInGoal = destructive && /\b(remove|delete|merge)\b/.test(goal);
  return {
    "write.destructive": { kind: "noul", value: destructive, probability: destructive ? 0.9 : 0.1 },
    "write.outside-intent": { kind: "noul", value: destructive && !verbInGoal, probability: destructive && !verbInGoal ? 0.85 : 0.15 },
  };
}

async function main() {
  const mode = arg("mode", "scripted");
  const out = resolve(arg("out", resolve(here, mode === "live" ? "results.jsonl" : "results-scripted.jsonl")));
  const maxUsd = Number(arg("max-usd", "1"));
  const provider = arg("provider", undefined);
  const { cases } = JSON.parse(readFileSync(resolve(here, "cases.json"), "utf8"));

  const ai = await import(dist("packages/ai-core/dist/index.js"));
  const hooks = await import(dist("packages/cli/dist/journey-run-hooks.js"));
  const { registerSentinelShadowHook, SENTINEL_WOULD_HOLD_THRESHOLD } = await import(dist("packages/cli/dist/sentinel-hook.js"));

  const usage = new ai.UsageTracker();
  const wire = []; // what reached the JevClientCall seam, after the gateway's own redaction
  let call;
  let store;
  if (mode === "live") {
    const { loadLocalCredentials } = await import(dist("packages/cli/dist/credentials-file.js"));
    store = ai.envCredentialStore(process.env, loadLocalCredentials());
    const real = await ai.realJevClientCall(undefined, usage);
    call = async (args) => {
      const spent = usage.snapshot().totalUsd ?? 0;
      if (spent >= maxUsd) throw new Error(`sentinel-lab budget reached: $${spent}`);
      wire.push(JSON.stringify({ state: args.state, questions: args.questions }));
      return real(args);
    };
  } else {
    // A dummy key so the real route + credential guard run; it never leaves the process.
    store = ai.envCredentialStore({ TYPESAFE_API_KEY: "sentinel-lab-dummy-key-not-real" }, {});
    call = async (args) => {
      wire.push(JSON.stringify({ state: args.state, questions: args.questions }));
      usage.recordJudgment(ai.FAKE_CALL_USAGE);
      return lexicalAnswer(args.state);
    };
  }
  const gateway = new ai.RetryingJudgmentPort(new ai.JevJudgmentGateway(store, call, provider));

  // A declared secret is live for the whole run: the redaction guard must keep it off the wire.
  const scope = ai.openModelSecretScope();
  scope.add([SECRET_MARKER]);

  hooks.resetRunHooksForTests();
  const titles = new Map(cases.map((c) => [c.job.id, c.job.title]));
  const noTitles = process.argv.includes("--no-titles");
  const shadow = registerSentinelShadowHook(noTitles ? { gateway } : { gateway, jobTitle: (id) => titles.get(id) });

  const rows = [];
  const startedSeq = () => usage.calls().length;
  for (const c of cases) {
    const judgments = [];
    const notes = [];
    const evidence = { noteJudgments: (js) => judgments.push(...js), note: (n) => notes.push(n) };
    const page = { url: () => `http://127.0.0.1:4999${c.pageUrl}`, content: async () => `<h1>${PAGE_MARKER}</h1>` };
    const journey = {
      metadata: { id: `lab-${c.id}`, job: c.job.id, params: [], parameters: [] },
      recording: { version: "1", site: "http://127.0.0.1:4999", pages: [{ url: c.pageUrl, steps: [{ step: { kind: "click", target: { role: c.control.role, name: c.control.name } } }] }] },
    };
    const before = startedSeq();
    const wireBefore = wire.length;
    await hooks.runBeforeWriteHooks({
      journey,
      params: { note: SECRET_MARKER },
      channel: "cli",
      mode: "automation",
      evidence,
      step: 1,
      kind: "click",
      locator: { page: () => page },
    });
    const calls = usage.calls().slice(before);
    const p = (task) => judgments.find((j) => j.task === task)?.probability ?? null;
    rows.push({
      case: c.id,
      surface: c.surface,
      clean: c.clean,
      job: c.job.id,
      control: c.control,
      truth: c.truth,
      destructiveP: p("write.destructive"),
      outsideIntentP: p("write.outside-intent"),
      threshold: judgments[0]?.threshold ?? SENTINEL_WOULD_HOLD_THRESHOLD,
      wouldHaveHeld: judgments.some((j) => j.probability >= (j.threshold ?? SENTINEL_WOULD_HOLD_THRESHOLD)),
      notes,
      mode,
      provider: provider ?? "default",
      titles: !noTitles,
      model: calls.at(-1)?.model ?? null,
      usd: calls.reduce((s, k) => s + (k.usd ?? 0), 0),
      wire: wire[wireBefore] ?? null,
    });
  }
  scope.release();
  hooks.resetRunHooksForTests();

  const leaks = wire.filter((w) => w.includes(PAGE_MARKER) || w.includes(SECRET_MARKER)).length;
  writeFileSync(out, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
  const u = usage.snapshot();
  console.log(JSON.stringify({ out, mode, cases: rows.length, judged: shadow.result.judged, wouldHaveHeld: shadow.result.wouldHaveHeld, wireCalls: wire.length, markerLeaks: leaks, usage: u }));
  if (leaks > 0) process.exitCode = 2;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
