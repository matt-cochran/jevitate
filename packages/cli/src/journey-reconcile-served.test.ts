import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createRequire } from "node:module";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { ProfileManager } from "@jevitate/daemon";
import { FsJourneyStore, type Journey } from "@jevitate/journey";
import { PlaywrightBrowserPort } from "@jevitate/playwright";
import { isApprovedResumeStep } from "./journey-hold.js";
import { runJourneyProgrammatically } from "./journey-api.js";
import { withJourneyRunRecord } from "./journey-run-record.js";
import { registerRunHooks, resetRunHooksForTests } from "./journey-run-hooks.js";
import { createCheckpointKey } from "./journey-verify-checkpoint.js";
import { buildProgram } from "./program.js";

/**
 * #795 served acceptance (real process, real Chromium, real done check). A run is held at step 3 and its process
 * killed with SIGKILL after step 2's write (the Add POST, which places the order). The job's done check, read in a
 * fresh context, reads true, so neither `inbox resume` nor `journey run --retry` repeats the write: the server's
 * request log shows exactly one POST. A plain run's result lists each write as a receipt (method, path shape,
 * status, count, refused), never a value, body or full URL.
 */

/** The user's key home (#787): the test points the home this module graph sees at a temp dir. */
const homeOverride = vi.hoisted(() => ({ dir: undefined as string | undefined }));
vi.mock("node:os", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:os")>();
  const homedir = (): string => homeOverride.dir ?? real.homedir();
  return { ...real, homedir, default: { ...real, homedir } };
});

const MARKER = "MARKER_REF-9034";
const SRC = dirname(fileURLToPath(import.meta.url));
const REPO = join(SRC, "..", "..", "..");
/** vite-node (vitest's own runner) runs the child on this source tree, with the workspace aliases. */
const VITE_NODE = join(dirname(createRequire(createRequire(import.meta.url).resolve("vitest/package.json")).resolve("vite-node/package.json")), "vite-node.mjs");

let server: Server;
let origin: string;
let root: string;
let home: string;
let journeysDir: string;
let holdsDir: string;
let inboxDir: string;
let keyFile: string;
let catalogDir: string;
let logs: string;
const requests: string[] = [];
const app = { cart: 0, orders: 0 };
const posts = (): string[] => requests.filter((r) => r.startsWith("POST "));

function serve(): Promise<Server> {
  const s = createServer((req, res) => {
    const path = (req.url ?? "/").split("?")[0] ?? "/";
    if (path === "/shop" || path.startsWith("/api/")) requests.push(`${req.method ?? "?"} ${path}`);
    if (req.method === "POST" && path === "/api/add") {
      app.cart += 1;
      app.orders += 1;
      res.writeHead(200, { "content-type": "application/json" }).end('{"ok":true}');
      return;
    }
    if (req.method === "POST" && path === "/api/checkout") {
      // Only a cart the first run filled can be checked out: the resume relies on step 2 having run once.
      const ok = app.cart > 0;
      if (ok) app.cart = 0;
      res.writeHead(ok ? 200 : 409, { "content-type": "application/json" }).end(ok ? '{"ok":true}' : '{"ok":false}');
      return;
    }
    if (path === "/orders") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(`<!doctype html><html><body><p data-testid="orders">${app.orders > 0 ? "placed" : "none"}</p></body></html>`);
      return;
    }
    if (path === "/shop") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(`<!doctype html><html><body><h1>Shop</h1>
<button type="button" id="add">Add</button><button type="button" id="checkout">Checkout</button><p id="status"></p>
<script>
document.getElementById("add").addEventListener("click", async () => { const r = await fetch("/api/add", { method: "POST" }); document.getElementById("status").textContent = r.ok ? "Added" : "Not added"; });
document.getElementById("checkout").addEventListener("click", async () => { const r = await fetch("/api/checkout", { method: "POST" }); document.getElementById("status").textContent = r.ok ? "Thanks" : "Empty"; });
</script></body></html>`);
      return;
    }
    res.writeHead(404).end();
  });
  return new Promise((r) => s.listen(0, "127.0.0.1", () => r(s)));
}

function journey(id: string, job?: string): Journey {
  return {
    metadata: { id, name: id, promoted: true, params: ["ref"], ...(job === undefined ? {} : { job }), createdAtIso: "2026-11-08T00:00:00.000Z" },
    recording: {
      version: "1",
      site: origin,
      pages: [
        {
          url: "/shop",
          steps: [
            { step: { kind: "navigate", url: "/shop?ref=${ref}", expect: { kind: "visible", target: { role: "heading", name: "Shop" } } } },
            { step: { kind: "click", target: { role: "button", name: "Add" }, expect: { kind: "visible", target: { text: "Added" } } } },
            { step: { kind: "click", target: { role: "button", name: "Checkout" }, expect: { kind: "visible", target: { text: "Thanks" } } } },
          ],
        },
      ],
    },
  } as unknown as Journey;
}

/** The child: the gate holds step 3 (unless it is the approved resume), the hold hooks persist it; it then waits to be killed. */
function childScript(): string {
  const imp = (f: string): string => JSON.stringify(join(SRC, f));
  return `
import { configureSharedBrowserPool } from "@jevitate/playwright";
import { registerRunHooks } from ${imp("journey-run-hooks.js")};
import { registerHoldHooks, heldOutcomeOf, isApprovedResumeStep } from ${imp("journey-hold.js")};
import { runJourneyProgrammatically } from ${imp("journey-api.js")};
const a = JSON.parse(process.env.HOLD_CHILD_ARGS);
configureSharedBrowserPool({ signals: { sample: async () => ({ memAvailableBytes: Number.MAX_SAFE_INTEGER, source: "test child" }) }, maxContexts: 1 });
registerRunHooks("test-gate", { beforeWrite: (ctx) => (ctx.step === 3 && !isApprovedResumeStep(ctx) ? { kind: "approval", reason: "a checkout needs a person" } : undefined) });
registerHoldHooks({ holdsDir: a.holdsDir, keyFile: a.keyFile, inboxDir: a.inboxDir });
try {
  await runJourneyProgrammatically({ dir: a.journeysDir, id: "checkout", params: { ref: a.ref } });
  process.stdout.write("NOT-HELD\\n");
} catch (err) {
  const held = heldOutcomeOf(err);
  process.stdout.write(held === undefined ? "ERROR " + JSON.stringify(String(err)) + "\\n" : "HELD " + JSON.stringify(held) + "\\n");
}
setInterval(() => {}, 1 << 30);
`;
}

/** Runs the child until it reports, then SIGKILLs it; resolves with what it reported. */
function runChildAndKill(): Promise<string> {
  const script = join(root, "hold-child.ts");
  writeFileSync(script, childScript());
  const child: ChildProcess = spawn(process.execPath, [VITE_NODE, "--root", REPO, "--config", join(REPO, "vitest.config.ts"), script], {
    env: { ...process.env, HOME: home, HOLD_CHILD_ARGS: JSON.stringify({ journeysDir, holdsDir, inboxDir, keyFile, ref: MARKER }) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "";
  let err = "";
  child.stderr?.on("data", (c: Buffer) => (err += c.toString("utf8")));
  return new Promise((resolve, reject) => {
    child.on("exit", (code, signal) => {
      const line = out.split("\n").find((l) => l.startsWith("HELD ") || l.startsWith("ERROR ") || l === "NOT-HELD");
      if (signal === "SIGKILL" && line !== undefined) resolve(line);
      else reject(new Error(`the child ended (${String(code)}/${String(signal)}) before it was killed: ${out} ${err.slice(-2000)}`));
    });
    child.stdout?.on("data", (c: Buffer) => {
      out += c.toString("utf8");
      if (/^(HELD |ERROR |NOT-HELD)/m.test(out)) child.kill("SIGKILL");
    });
  });
}

interface Cli {
  readonly body: { ok: boolean; data?: Record<string, unknown>; error?: { code: string; message: string } };
  readonly code: number;
}

async function cli(args: string[], approval?: Parameters<typeof buildProgram>[0]["approval"]): Promise<Cli> {
  const out: string[] = [];
  const err: string[] = [];
  const program = buildProgram({
    profiles: new ProfileManager("/unused"),
    inboxDir,
    journeysDir,
    catalogDir,
    dbPath: join(root, "db.sqlite"),
    explore: { browserPortFactory: () => new PlaywrightBrowserPort(), targetsConfigPath: join(root, "targets.json") },
    ...(approval === undefined ? {} : { approval }),
  });
  program.configureOutput({ writeOut: (s) => out.push(s), writeErr: (s) => err.push(s) });
  program.exitOverride();
  process.exitCode = undefined;
  await program.parseAsync([...args, "--json"], { from: "user" });
  const code = process.exitCode === undefined ? 0 : Number(process.exitCode);
  process.exitCode = undefined;
  return { body: JSON.parse(out.join("")) as Cli["body"], code };
}

beforeAll(async () => {
  server = await serve();
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  root = mkdtempSync(join(tmpdir(), "jev-reconcile-served-"));
  home = join(root, "home");
  journeysDir = join(root, "journeys");
  holdsDir = join(root, "holds");
  inboxDir = join(root, "inbox");
  catalogDir = join(root, ".jevitate");
  logs = join(root, "logs");
  keyFile = join(home, ".jevitate", "verify-checkpoint.key");
  mkdirSync(home, { recursive: true });
  mkdirSync(catalogDir, { recursive: true });
  createCheckpointKey(keyFile);
  writeFileSync(
    join(catalogDir, "jobs.json"),
    JSON.stringify({ jobs: [{ id: "place-order", trigger: "When I want it", motivation: "I want to buy", outcome: "I can see my order", done: { version: 1, at: "/orders", check: "textIncludes:testId=orders|placed" } }] }),
  );
  const store = new FsJourneyStore(journeysDir);
  await store.put(journey("checkout", "place-order"));
  await store.put(journey("plain"));
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((r) => server.close(() => r()));
  rmSync(root, { recursive: true, force: true });
});

afterEach(() => {
  vi.unstubAllEnvs();
  homeOverride.dir = undefined;
  resetRunHooksForTests();
});

describe("[realtime] #795 reconcile before a resume or retry (real Chromium)", () => {
  it("a run killed after its write is neither resumed nor retried while the done check reads true: one POST in the server's log", async () => {
    const reported = await runChildAndKill();
    expect(reported.startsWith("HELD "), reported).toBe(true);
    const held = JSON.parse(reported.slice("HELD ".length)) as { holdId: string; step: number };
    expect(held.step).toBe(3);
    expect(posts()).toEqual(["POST /api/add"]);
    expect(app.orders).toBe(1);

    homeOverride.dir = home;
    const approved = await cli(["inbox", "approve", held.holdId, "--holds-dir", holdsDir], {
      stdinIsTTY: () => true,
      stdoutIsTTY: () => true,
      prompt: async () => held.holdId,
      env: {},
      user: () => "person",
    });
    expect(approved.code).toBe(0);
    registerRunHooks("test-gate", { beforeWrite: (ctx) => (ctx.step === 3 && !isApprovedResumeStep(ctx) ? { kind: "approval", reason: "a checkout needs a person" } : undefined) });

    const resumed = await cli(["inbox", "resume", held.holdId, "--holds-dir", holdsDir, "--param", `ref=${MARKER}`]);
    expect(resumed.body.error?.code).toBe("E_RECONCILE_ALREADY_DONE");
    expect(resumed.code).toBe(2);
    expect(posts()).toEqual(["POST /api/add"]);
    // The hold stays: nothing ran, nothing was consumed.
    expect(existsSync(join(holdsDir, `${held.holdId}.json`))).toBe(true);

    const retried = await cli(["journey", "run", "checkout", "--retry", "--param", `ref=${MARKER}`]);
    expect(retried.body.error?.code).toBe("E_RECONCILE_ALREADY_DONE");
    expect(retried.code).toBe(2);
    expect(JSON.stringify([resumed.body, retried.body])).not.toContain("MARKER_");

    // Acceptance 1: exactly one POST after the kill, the resume and the retry.
    expect(posts()).toEqual(["POST /api/add"]);
  }, 180_000);

  it("a run's result lists each write as a receipt: method, path shape, status, count, refused; never a value, body or full URL", async () => {
    requests.length = 0;
    vi.stubEnv("JEVITATE_RUN_RECORD", "");
    const params = { ref: MARKER };
    const result = await withJourneyRunRecord({ channel: "cli", id: "plain", params, logsRoot: logs, evidenceKeyFile: keyFile }, (runRecorder) =>
      runJourneyProgrammatically({ dir: journeysDir, id: "plain", params, runRecorder, browserPortFactory: () => new PlaywrightBrowserPort() }),
    );
    expect(result.outcome).toBe("ok");
    expect(posts()).toEqual(["POST /api/add", "POST /api/checkout"]);
    expect(result.writes).toHaveLength(2);
    const receipt = result.writes![0]!;
    expect(receipt).toMatchObject({ method: "POST", path: "/:id/:id", status: "2xx", count: 1 });
    for (const k of Object.keys(receipt)) expect(["method", "path", "status", "count", "refused", "origin"]).toContain(k);
    for (const k of ["value", "body", "url"]) expect(receipt).not.toHaveProperty(k);
    expect(JSON.stringify(result.writes)).not.toContain(MARKER);
    expect(JSON.stringify(result.writes)).not.toContain("127.0.0.1");
  }, 180_000);
});
