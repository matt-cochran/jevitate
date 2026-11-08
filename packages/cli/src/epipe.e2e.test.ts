import { describe, expect, it } from "vitest";
import { exec } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * #213: `jevitate <cmd> | head -1` (or any reader that closes the pipe early) used to crash with
 * an EPIPE stack trace — Node has no default SIGPIPE handling, so the next stdout write after the
 * reader closes throws an uncaught exception. A plain command now exits quietly (0) instead
 * (bin.ts). But a closed reader is never a command's result: `verify-fix | true` once exited 0 on a
 * `still-reproduces` run. Through the BUILT CLI in a real shell pipeline — the only way to reproduce
 * a genuine broken pipe — and, for a registered command (which only the harness can be, so far),
 * through `terminal-result-harness.mjs`, which mirrors bin.ts on the built dist. `| true` closes the
 * reader before node has even started.
 */

const here = dirname(fileURLToPath(import.meta.url));
const BIN = join(here, "..", "dist", "bin.js");
const HARNESS = join(here, "terminal-result-harness.mjs");

function runPiped(cmd: string, pipeline = "| head -1", script = BIN): Promise<{ code: number | null; stderr: string }> {
  // A directory of its own: a `.jevitate` left in the run's shared tmpdir would be every other test's "project".
  const home = mkdtempSync(join(tmpdir(), "jevitate-epipe-"));
  return new Promise((resolve) => {
    // PIPESTATUS[0] is bash-only: the exit code of `node ..` itself, not of `head`'s.
    const shellCmd = `node ${JSON.stringify(script)} ${cmd} ${pipeline}; exit "\${PIPESTATUS[0]}"`;
    exec(shellCmd, { shell: "/bin/bash", cwd: home, timeout: 60_000, env: { ...process.env, HOME: home } }, (err, _stdout, stderr) => {
      const code = err === null ? 0 : typeof (err as NodeJS.ErrnoException & { code?: number }).code === "number" ? (err as unknown as { code: number }).code : 1;
      resolve({ code, stderr });
    });
  });
}

describe("EPIPE from a reader that closes early (#213)", () => {
  it("`jevitate --help | head -1` exits 0 quietly — no EPIPE stack trace on stderr", async () => {
    const { code, stderr } = await runPiped("--help");
    expect(stderr).not.toMatch(/EPIPE/);
    expect(stderr).not.toMatch(/Error: write/);
    expect(code).toBe(0);
  });

  it("`jevitate profile list --help | head -1` exits 0 quietly on a subcommand too", async () => {
    const { code, stderr } = await runPiped("profile list --help");
    expect(stderr).not.toMatch(/EPIPE/);
    expect(code).toBe(0);
  });
});

describe("EPIPE on a plain command, through the real entry point", () => {
  it("`--help | true` exits 0", async () => {
    const { code } = await runPiped("--help", "| true");
    expect(code).toBe(0);
  });

  it("`--help | true` prints no EPIPE trace", async () => {
    const { stderr } = await runPiped("--help", "| true");
    expect(stderr).not.toMatch(/EPIPE/);
  });

  it("a command that set a non-zero exit code keeps it", async () => {
    const { code } = await runPiped("verify-fix --json", "| true");
    expect(code).toBe(64);
  });

  it("a command's non-zero exit code survives stdout and stderr both being gone", async () => {
    const { code } = await runPiped("verify-fix --json", "2>&1 | true");
    expect(code).toBe(64);
  });
});

describe("EPIPE on a registered command", () => {
  const harness = (mode: string, pipeline: string) => runPiped(`${mode} ${JSON.stringify(tmpdir())}`, pipeline, HARNESS);

  it("a still-reproduces verdict with its reader gone keeps exit 1", async () => {
    const { code } = await harness("verdict-1", "| true");
    expect(code).toBe(1);
  });

  it("a proven verdict with its reader gone keeps exit 0", async () => {
    const { code } = await harness("verdict-0", "| true");
    expect(code).toBe(0);
  });

  it("a reader gone before the verdict does not end the run: it reaches its verdict's exit 1", async () => {
    const { code } = await harness("late-verdict", "| true");
    expect(code).toBe(1);
  });

  it("a stderr gone at the start does not end the run: it reaches its verdict's exit 1", async () => {
    const { code } = await harness("flood", "2>&1 >/dev/null | true");
    expect(code).toBe(1);
  });

  it("`2>&1 | head -1` does not end the run: it reaches its verdict's exit 1", async () => {
    const { code } = await harness("flood", "2>&1 | head -1");
    expect(code).toBe(1);
  });

  it("a run whose output all went nowhere still never reports success without a verdict", async () => {
    const { code } = await harness("drain", "2>&1 | true");
    expect(code).toBe(2);
  });
});
