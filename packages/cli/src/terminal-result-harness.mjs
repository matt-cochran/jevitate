#!/usr/bin/env node
// Test harness, like kill-signal-harness.mjs: NOT shipped (not exported, not referenced by any
// production import) and not covered by tsc. `terminal-result.e2e.test.ts` and `epipe.e2e.test.ts`
// spawn it as a REAL process, the only way to exercise real signals, real parent death, a real broken
// pipe and the real artifact write. It runs the BUILT dist, so it needs a build first.
//
// No browser: `terminateOwnBrowsersSync` finds none, and what it does with one is covered elsewhere.
//
// usage: terminal-result-harness.mjs <mode> <outDir> [inactivityMs]
//   hold          report "ready" (with the secret in it) and wait to be ended
//   verdict-0|1   emit a verdict with that exit code, as a command does
//   late-verdict  write a first stdout line, keep working, then emit a verdict with exit 1
//   flood         print many progress lines over several turns, then emit a verdict with exit 1
//   reject        reject up to the entry point, as bin.ts's parseAsync catch sees it
//   throw         throw from a timer: a real uncaught error
//   drain         let the event loop drain with no result
import { join } from "node:path";
import { Command } from "commander";
import { emitCommandResult } from "../dist/cli-shared.js";
import { ok } from "../dist/envelope.js";
import { installMissionKillSwitch } from "../dist/kill-signal.js";
import { installBrokenPipePolicy, registerTerminalResult, reportCommandRejection } from "../dist/terminal-result.js";

// Mirrors bin.ts.
installBrokenPipePolicy();
installMissionKillSwitch();

const [, , mode, outDir, inactivityMs] = process.argv;
const SECRET = process.env.HARNESS_SECRET ?? "harness-secret-value";

const handle = registerTerminalResult({
  command: "harness",
  json: true,
  secrets: [SECRET],
  artifactPath: join(outDir, "harness-1.json"),
  inactivityMs: Number(inactivityMs ?? 20_000),
});

const turn = () => new Promise((resolve) => setImmediate(resolve));

function emitVerdict(exitCode) {
  emitCommandResult(new Command(), ok({ verdict: exitCode === 0 ? "proven" : "still-reproduces" }), { json: true, exitCode });
  handle.complete();
}

// The layer's own timer is unref'd, so something must hold the process open like a running browser would.
const keepAlive = setInterval(() => {}, 1_000);

switch (mode) {
  case "hold":
    handle.progress({ phase: `ready ${SECRET}` });
    break;
  case "verdict-0":
  case "verdict-1":
    clearInterval(keepAlive);
    emitVerdict(Number(mode.at(-1)));
    break;
  case "late-verdict":
    process.stdout.write("a first line the reader may never see\n");
    for (let i = 0; i < 20; i += 1) await turn();
    clearInterval(keepAlive);
    emitVerdict(1);
    break;
  case "flood":
    for (let i = 0; i < 40; i += 1) {
      handle.progress({ replay: i });
      process.stderr.write("a stream write to stderr, like the usage line\n");
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    clearInterval(keepAlive);
    emitVerdict(1);
    break;
  case "reject":
    Promise.reject(new Error(`login failed with ${SECRET}`)).catch((err) => {
      if (!reportCommandRejection(err)) process.stderr.write("not handled by the layer\n");
    });
    break;
  case "throw":
    setTimeout(() => {
      throw new Error(`uncaught with ${SECRET}`);
    }, 1);
    break;
  case "drain":
    clearInterval(keepAlive);
    break;
  default:
    process.stderr.write(`unknown mode ${mode}\n`);
    process.exit(99);
}
