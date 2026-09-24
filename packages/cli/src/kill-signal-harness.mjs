#!/usr/bin/env node
// Test harness for #94 — NOT shipped (not exported, not referenced by any production import) and
// not covered by tsc (plain .mjs, outside the TS build). `explore-kill-signal.e2e.test.ts` spawns
// this as a REAL child process — the only way to exercise a genuine OS SIGTERM/SIGINT against the
// process-level handler in kill-signal.ts (sending a real signal to the vitest process itself would
// kill the test run, not the mission).
//
// It drives the exact function the CLI's `explore` command calls (`runExploration`, from the
// BUILT dist — this harness runs as plain Node, not through vitest/tsx) against a real
// Playwright-backed browser and a served fixture. The JudgmentPort is deliberately slow: every
// call takes `judgeDelayMs` (default 8s), so once the parent test sees "BROWSER_OPEN" on stdout —
// emitted right after the real browser session opens, just before MissionJournal/the kill switch
// arm — it has a wide, deterministic window to send a real signal well before any decision could
// resolve. No timing guess, no race on total mission duration.
import { runExploration } from "../dist/explore-api.js";
import { installMissionKillSwitch } from "../dist/kill-signal.js";
import { PlaywrightBrowserPort } from "@jevitate/playwright";
import { FakeGenerationGateway } from "@jevitate/ai-core";

// Mirrors bin.ts: installed before anything else, in particular before any browser can launch and
// register its OWN competing signal handler. See kill-signal.ts's `installMissionKillSwitch` doc.
installMissionKillSwitch();

const [, , url, outDir, judgeDelayMsRaw] = process.argv;
if (!url || !outDir) {
  process.stderr.write("usage: kill-signal-harness.mjs <url> <outDir> [judgeDelayMs]\n");
  process.exit(2);
}
const judgeDelayMs = Number(judgeDelayMsRaw ?? 8000);

/** Wraps the real Playwright port so the parent can tell exactly when the browser is open —
 *  right where `runExploration` itself creates the journal and arms the kill switch next. */
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

/** Answers every question kind (like the CLI's own `fakeDoneJudge`), after a fixed, injectable
 *  delay — long enough that the parent's SIGTERM/SIGINT always lands while this call is pending. */
const slowJudge = {
  async systemOne(args) {
    await new Promise((resolve) => setTimeout(resolve, judgeDelayMs));
    const out = {};
    for (const [name, q] of Object.entries(args.questions)) {
      if (q.kind === "choice") {
        const value = q.options.includes("done") ? "done" : q.options[0];
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

runExploration({
  url,
  goal: "reach a page this run never actually reaches — it exists only to keep the mission alive under test",
  successAssertion: { kind: "urlIncludes", text: "/this-path-is-never-reached-by-design" },
  allowlist: [new URL(url).origin],
  judge: slowJudge,
  gen: new FakeGenerationGateway(),
  outDir,
  browserPortFactory: instrumentedBrowserPortFactory,
})
  .then((result) => {
    process.stdout.write(`${JSON.stringify({ ok: true, result })}\n`);
    process.exit(result.exitCode);
  })
  .catch((err) => {
    process.stderr.write(`${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
    process.exit(1);
  });
