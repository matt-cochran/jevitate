#!/usr/bin/env node
// Bare `jevitate` alias: re-execs the bundled `@jevitate/cli` binary,
// forwarding argv, stdio, exit code and signals. This is the ONLY logic
// this package carries — the real CLI (and its bundle) lives in
// `@jevitate/cli`, so there is a single source of truth to keep in sync.
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";

// Resolve via the package's main export ("./dist/index.js") rather than its
// package.json, since `@jevitate/cli`'s "exports" map only exposes ".".
const require = createRequire(import.meta.url);
const cliMainPath = require.resolve("@jevitate/cli");
const cliBinPath = join(dirname(cliMainPath), "bin.js");

const child = spawn(process.execPath, [cliBinPath, ...process.argv.slice(2)], {
  stdio: "inherit",
});

// #220: a signal sent to THIS process (e.g. `timeout -s TERM`, or `kill -INT <pid>`) is forwarded
// to the CLI, which writes its partial result and exits 130/143 — this process then mirrors that
// exit. Without this the alias died on the signal and orphaned the still-running CLI, which
// printed nothing.
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(signal, () => {
    if (child.exitCode === null && child.signalCode === null) child.kill(signal);
  });
}

child.on("error", (err) => {
  process.stderr.write(`${String(err)}\n`);
  process.exitCode = 1;
});

child.on("exit", (code, signal) => {
  if (signal) {
    // Our forwarding listeners would swallow the re-raise: drop them so it terminates this process.
    for (const s of ["SIGINT", "SIGTERM", "SIGHUP"]) process.removeAllListeners(s);
    process.kill(process.pid, signal);
  } else {
    process.exitCode = code ?? 0;
  }
});
