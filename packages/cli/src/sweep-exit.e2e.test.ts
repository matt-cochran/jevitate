import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * #511 end to end, through the BUILT CLI in a child process (whether the process exits on its own is
 * only observable from outside it): a 1-target sweep whose `cmd:` log source never ends, and whose
 * command leaves a helper in its OWN session holding the source's stdout/stderr pipes — what an
 * `ssh` with ControlPersist does (its daemonized master inherits the pipes and escapes the process
 * group jevitate kills). The sweep writes its result and summary; the process must then exit.
 */

const here = dirname(fileURLToPath(import.meta.url));
const BIN = join(here, "..", "dist", "bin.js");

let server: Server;
let origin: string;
let dir: string;

beforeAll(async () => {
  server = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/html" }).end(`<!doctype html><html><body><h1>Welcome</h1><button type="button">Go</button></body></html>`);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

/** The escaped helper's pid (written by the log command): always killed, so nothing outlives the test. */
afterEach(async () => {
  const pid = Number(await readFile(join(dir, "helper.pid"), "utf8").catch(() => ""));
  if (Number.isInteger(pid) && pid > 0) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // already gone
    }
  }
  await rm(dir, { recursive: true, force: true });
});

describe.runIf(process.platform === "linux")("[realtime] sweep exits after writing its result, whatever its log source left behind (#511)", () => {
  it(
    "a 1-target sweep with a never-ending cmd: log source whose helper escaped the process group exits on its own",
    async () => {
      dir = await mkdtemp(join(tmpdir(), "jev-511-"));
      const targets = join(dir, "targets.json");
      await writeFile(targets, JSON.stringify([{ id: "home", url: `${origin}/`, goal: "read the heading" }]));
      const pidFile = join(dir, "helper.pid");
      const logCmd = `cmd:setsid sleep 300 & echo $! > '${pidFile}'; while true; do echo tick; sleep 1; done`;
      const child = spawn(
        process.execPath,
        [BIN, "sweep", "--targets", targets, "--concurrency", "1", "--out", join(dir, "out"), "--fake-ai", "--allow-log-cmd", "--log-source", logCmd],
        { stdio: ["ignore", "pipe", "pipe"] },
      );
      let stdout = "";
      child.stdout.on("data", (d: Buffer) => (stdout += d.toString("utf8")));
      const exited = new Promise<boolean>((resolve) => child.once("exit", () => resolve(true)));
      const bound = new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 60_000).unref());
      const exitedOnItsOwn = await Promise.race([exited, bound]);
      if (!exitedOnItsOwn) child.kill("SIGKILL");
      expect(exitedOnItsOwn, `still running 60s on; stdout: ${stdout.slice(-600)}`).toBe(true);
    },
    90_000,
  );
});
