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

child.on("error", (err) => {
  process.stderr.write(`${String(err)}\n`);
  process.exitCode = 1;
});

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
  } else {
    process.exitCode = code ?? 0;
  }
});
