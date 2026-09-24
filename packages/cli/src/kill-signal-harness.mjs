#!/usr/bin/env node
// Test harness for #94/#120 — NOT shipped (not exported, not referenced by any production import) and
// not covered by tsc (plain .mjs, outside the TS build). `explore-kill-signal.e2e.test.ts` spawns
// this as a REAL child process — the only way to exercise a genuine OS SIGTERM/SIGINT against the
// process-level handler in kill-signal.ts (sending a real signal to the vitest process itself would
// kill the test run, not the mission).
//
// It drives the exact function the CLI's `explore` command calls (`runExploration`, or
// `runUsabilityMission` for `--strategy usability`, from the BUILT dist — this harness runs as plain
// Node, not through vitest/tsx) against a real Playwright-backed browser and a served fixture. The
// JudgmentPort answers its first `fastCalls` calls at once (so the run takes real, flushed steps),
// then is deliberately slow: every later call takes `judgeDelayMs` (default 8s). The parent waits
// for "BROWSER_OPEN" (fastCalls 0) or "JUDGE_SLOW" (the first slow call began, i.e. every fast step
// has been taken and flushed) on stdout, then has a wide, deterministic window to send a real signal
// well before any further decision could resolve. No timing guess, no race on total mission duration.
//
// Like the CLI's `explore --json`, it asks the kill switch to print the `--json` envelope (#120).
import { runExploration } from "../dist/explore-api.js";
import { runUsabilityMission } from "../dist/ux-api.js";
import { installMissionKillSwitch, setKillSwitchOutput } from "../dist/kill-signal.js";
import { PlaywrightBrowserPort } from "@jevitate/playwright";
import { FakeGenerationGateway, UsageTracker } from "@jevitate/ai-core";

// Mirrors bin.ts: installed before anything else, in particular before any browser can launch and
// register its OWN competing signal handler. See kill-signal.ts's `installMissionKillSwitch` doc.
installMissionKillSwitch();
setKillSwitchOutput("envelope");

const [, , url, outDir, judgeDelayMsRaw, modeRaw, fastCallsRaw, saveStorageStatePath] = process.argv;
if (!url || !outDir) {
  process.stderr.write(
    "usage: kill-signal-harness.mjs <url> <outDir> [judgeDelayMs] [explore|usability] [fastCalls] [saveStorageStatePath]\n",
  );
  process.exit(2);
}
const judgeDelayMs = Number(judgeDelayMsRaw ?? 8000);
const mode = modeRaw ?? "explore";
const fastCalls = Number(fastCallsRaw ?? 0);

/** Wraps the real Playwright port so the parent can tell exactly when the browser is open —
 *  right where the mission itself creates the journal and arms the kill switch next. */
function instrumentedBrowserPortFactory() {
  const inner = new PlaywrightBrowserPort();
  return {
    open: async (opts) => {
      const session = await inner.open(opts);
      process.stdout.write("BROWSER_OPEN\n");
      return session;
    },
  };
}

// Usage so far must survive a kill (#120): every judge call is counted, like the real seam does.
const usage = new UsageTracker();
let calls = 0;

/** Answers every question kind (like the CLI's own `fakeDoneJudge`). The first `fastCalls` calls
 *  pick an action (never `done`) at once; every later call waits `judgeDelayMs` first — long enough
 *  that the parent's SIGTERM/SIGINT always lands while it is pending. */
const judge = {
  async systemOne(args) {
    calls += 1;
    usage.recordJudgment({ inputTokens: 100, outputTokens: 10 });
    const fast = calls <= fastCalls;
    if (!fast) {
      process.stdout.write("JUDGE_SLOW\n");
      await new Promise((resolve) => setTimeout(resolve, judgeDelayMs));
    }
    const out = {};
    for (const [name, q] of Object.entries(args.questions)) {
      if (q.kind === "choice") {
        const value = fast ? (q.options.find((o) => o !== "done") ?? q.options[0]) : q.options.includes("done") ? "done" : q.options[0];
        out[name] = { kind: "choice", value, confidence: 1 };
      } else if (q.kind === "noul") {
        out[name] = { kind: "noul", value: false, probability: 0 };
      } else {
        out[name] = { kind: "score", value: 0 };
      }
    }
    return out;
  },
};

const run =
  mode === "usability"
    ? runUsabilityMission({
        url,
        job: "reach a page this run never actually reaches — it exists only to keep the review alive under test",
        allowlist: [new URL(url).origin],
        appContext: { appClass: "consumer", job: "keep the review alive" },
        judge,
        gen: new FakeGenerationGateway(),
        usage,
        outDir,
        browserPortFactory: instrumentedBrowserPortFactory,
        ...(saveStorageStatePath ? { saveStorageState: saveStorageStatePath } : {}),
      })
    : runExploration({
        url,
        goal: "reach a page this run never actually reaches — it exists only to keep the mission alive under test",
        successAssertion: { kind: "urlIncludes", text: "/this-path-is-never-reached-by-design" },
        allowlist: [new URL(url).origin],
        judge,
        gen: new FakeGenerationGateway(),
        usage,
        outDir,
        browserPortFactory: instrumentedBrowserPortFactory,
        ...(saveStorageStatePath ? { saveStorageState: saveStorageStatePath } : {}),
      });

run
  .then((result) => {
    process.stdout.write(`${JSON.stringify({ ok: true, result })}\n`);
    process.exit(result.exitCode);
  })
  .catch((err) => {
    process.stderr.write(`${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
    process.exit(1);
  });
