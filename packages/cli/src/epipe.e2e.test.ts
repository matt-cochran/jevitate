import { describe, expect, it } from "vitest";
import { exec } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * #213: `jevitate <cmd> | head -1` (or any reader that closes the pipe early) used to crash with
 * an EPIPE stack trace — Node has no default SIGPIPE handling, so the next stdout write after the
 * reader closes throws an uncaught exception. Every command now exits quietly (0) instead
 * (bin.ts). Through the BUILT CLI in a real shell pipeline — the only way to reproduce a genuine
 * broken pipe.
 */

const here = dirname(fileURLToPath(import.meta.url));
const BIN = join(here, "..", "dist", "bin.js");

function runPiped(cmd: string): Promise<{ code: number | null; stderr: string }> {
  return new Promise((resolve) => {
    // PIPESTATUS[0] is bash-only: the exit code of `node ..` itself, not of `head`'s.
    const shellCmd = `node ${JSON.stringify(BIN)} ${cmd} | head -1; exit "\${PIPESTATUS[0]}"`;
    exec(shellCmd, { shell: "/bin/bash" }, (err, _stdout, stderr) => {
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
