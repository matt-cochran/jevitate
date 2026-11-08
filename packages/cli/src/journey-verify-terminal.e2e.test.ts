import { spawn } from "node:child_process";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FsJourneyStore, type Journey } from "@jevitate/journey";
import { OWNER_MARKER_SWITCH, PlaywrightBrowserPort, closeSharedBrowserPool, type BrowserSession } from "@jevitate/playwright";
import { useSkippingTime } from "../../explore/src/testkit.js";
import { verifyJourneyMutations } from "./journey-verify.js";

/**
 * What `journey verify --mutate` owes its caller when it is ended from outside (#764), through the
 * BUILT CLI on a served page: this needs `pnpm -r build` first. And the proof's own bound against a
 * real browser session (#766).
 */

const BIN = join(dirname(fileURLToPath(import.meta.url)), "..", "dist", "bin.js");
const ID = "save-text";
const PAGE = `<!doctype html><html><head><title>Editor</title></head><body><main><h1>Editor</h1><label for="t">Text</label> <input id="t"><button type="button" id="save" onclick="fetch('/api/save',{method:'POST'})">Save</button></main></body></html>`;

function journeyOn(site: string): Journey {
  return {
    metadata: { id: ID, name: "Save text", promoted: false, params: [], createdAtIso: "2026-10-07T00:00:00.000Z" },
    recording: {
      version: "1",
      site,
      pages: [
        {
          url: "/editor",
          steps: [
            { step: { kind: "navigate", url: "/editor", expect: { kind: "visible", target: { role: "heading", name: "Editor" } } } },
            { step: { kind: "fill", target: { label: "Text" }, value: { redacted: false, value: "hello" }, expect: { kind: "valueEquals", target: { label: "Text" }, value: "hello" } } },
            {
              step: { kind: "click", target: { role: "button", name: "Save" }, expect: { kind: "visible", target: { role: "button", name: "Save" } } },
              delta: { verdict: "relevant-change", why: "saved", changes: ["status"], requests: ["POST /api/save → 200"], overheadMs: 1 },
            },
          ],
        },
      ],
    },
  };
}

/** Live processes whose argv holds `pid`'s owner marker. Reads /proc: no `pgrep` can match itself here. */
async function markedBrowsers(pid: number): Promise<number[]> {
  const marker = `${OWNER_MARKER_SWITCH}=${pid}@`;
  const found: number[] = [];
  for (const entry of await readdir("/proc")) {
    if (!/^\d+$/.test(entry)) continue;
    const argv = await readFile(`/proc/${entry}/cmdline`, "utf8").catch(() => "");
    if (argv.includes(marker)) found.push(Number(entry));
  }
  return found;
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

const pause = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Polls until `ready` holds or `withinMs` passes. */
async function until(ready: () => Promise<boolean> | boolean, withinMs: number): Promise<void> {
  const deadline = performance.now() + withinMs;
  while (performance.now() < deadline && !(await ready())) await pause(50);
}

describe("[realtime] SIGTERM to the CLI once its browser child exists", () => {
  let dir: string;
  let server: Server;
  let pagesAsked = 0;
  let sentinel = 0;
  let cliGroup = 0;
  let sentinelGroup = 0;
  let exitCode: number | null = null;
  let stdout = "";
  let left: number[] = [];
  let sentinelAliveAfter = false;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "jevitate-verify-e2e-"));
    server = createServer((req, res) => {
      if (req.method === "GET") {
        pagesAsked += 1;
        // Replay 1 passes; replay 2's page never answers, so the proof is certainly still running at the signal.
        if (pagesAsked > 1) return;
      }
      res.writeHead(200, { "content-type": req.method === "GET" ? "text/html; charset=utf-8" : "application/json" }).end(req.method === "GET" ? PAGE : "{}");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const site = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const journeysDir = join(dir, "journeys");
    await new FsJourneyStore(journeysDir).put(journeyOn(site));

    const sentinelFile = join(dir, "sentinel.pid");
    // bash starts the sentinel and then BECOMES the CLI, so the two share the CLI's process group.
    const env: NodeJS.ProcessEnv = { ...process.env, HOME: dir, PLAYWRIGHT_BROWSERS_PATH: process.env["PLAYWRIGHT_BROWSERS_PATH"] ?? join(homedir(), ".cache", "ms-playwright") };
    delete env["JEVITATE_PARENT_WATCHDOG"];
    const child = spawn(
      "bash",
      ["-c", 'sleep 600 >/dev/null 2>&1 </dev/null & echo $! > "$0"; exec "$@"', sentinelFile, process.execPath, BIN, "journey", "verify", ID, "--mutate", "--json", "--journeys-dir", journeysDir],
      { cwd: dir, env, detached: true, stdio: ["ignore", "pipe", "pipe"] },
    );
    const cli = child.pid as number;
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.resume();
    const closed = new Promise<number | null>((resolve) => child.once("close", (code) => resolve(code)));

    await until(async () => pagesAsked > 1 && (await markedBrowsers(cli)).length > 0, 60_000);
    sentinel = Number(await readFile(sentinelFile, "utf8"));
    const stat = async (pid: number): Promise<number> => Number((await readFile(`/proc/${pid}/stat`, "utf8")).split(") ")[1]!.split(" ")[2]);
    cliGroup = await stat(cli);
    sentinelGroup = await stat(sentinel);
    child.kill("SIGTERM");
    exitCode = await closed;
    await until(async () => (await markedBrowsers(cli)).length === 0, 10_000);
    left = await markedBrowsers(cli);
    sentinelAliveAfter = isAlive(sentinel);
  }, 120_000);

  afterAll(async () => {
    if (sentinel > 0 && isAlive(sentinel)) process.kill(sentinel, "SIGKILL");
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(dir, { recursive: true, force: true });
  });

  it("prints one parseable envelope on stdout", () => {
    expect(stdout.trim().split("\n").map((line) => (JSON.parse(line) as { error: { code: string } }).error.code)).toEqual(["E_TERMINAL_SIGNAL"]);
  });

  it("exits 143", () => {
    expect(exitCode).toBe(143);
  });

  it("leaves no browser with its owner marker", () => {
    expect(left).toEqual([]);
  });

  it("leaves a sentinel in the CLI's process group alive", () => {
    expect({ sharedGroup: sentinelGroup === cliGroup, sentinelAliveAfter }).toEqual({ sharedGroup: true, sentinelAliveAfter: true });
  });
});

describe("a stalled replay holding a real browser session", () => {
  // Large jumps: the limit is many minutes of idle clock, with nothing in the page to land between them.
  useSkippingTime({ maxSkipMs: 60_000, pageClock: false });

  afterAll(async () => {
    await closeSharedBrowserPool();
  });

  it("has its session closed when the proof's bound ends it", async () => {
    const dir = await mkdtemp(join(tmpdir(), "jevitate-verify-e2e-"));
    await new FsJourneyStore(dir).put(journeyOn("http://127.0.0.1:9"));
    let session: BrowserSession | undefined;
    const stuck = async (opts: { browserPortFactory?: () => { open(o: object): Promise<BrowserSession> } }): Promise<never> => {
      session = await opts.browserPortFactory!().open({ headless: true, allowedOrigins: [], baseUrl: "http://127.0.0.1:9" });
      return new Promise<never>(() => undefined);
    };
    await verifyJourneyMutations({ dir, id: ID, params: {}, browserPortFactory: () => new PlaywrightBrowserPort() }, stuck as never).catch(() => undefined);
    await rm(dir, { recursive: true, force: true });
    expect(session?.page.isClosed()).toBe(true);
  });
});
