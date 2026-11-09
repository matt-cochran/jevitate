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
import { registerRunHooks, resetRunHooksForTests } from "./journey-run-hooks.js";
import { createCheckpointKey } from "./journey-verify-checkpoint.js";
import { buildProgram } from "./program.js";
import { advisoryCatalogDir } from "./done-check-policy.testkit.js";

/**
 * #793 served acceptance, with a real process and real Chromium. A child process runs the Journey; the
 * gate (a stand-in for the run-mode gate) holds it at step 3, the Checkout write, and the hold hooks make
 * the hold durable; the child is then killed with SIGKILL. A person approves at a (fake) terminal with
 * `jevitate inbox approve`, and `jevitate inbox resume` in this process continues from the checkpoint:
 * the Journey completes `ok`, and the server's request log shows step 2's write was sent once, by the
 * first run, and the Checkout once, by the resume. The `ref` parameter is a marker that must not reach
 * the hold file or the checkpoint.
 */

/**
 * The key is the user's (#787, `~/.jevitate/verify-checkpoint.key`): no flag or variable names another
 * one, since a key the caller chooses would let anyone sign an approval. The test points the home this
 * module graph sees at a temp dir instead (the browser project runs in worker threads, where a
 * `HOME` stub never reaches `os.homedir()`).
 */
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
const requests: string[] = [];
const app = { cart: 0, orders: 0 };

function serve(): Promise<Server> {
  const s = createServer((req, res) => {
    const path = (req.url ?? "/").split("?")[0] ?? "/";
    if (path === "/shop" || path.startsWith("/api/")) requests.push(`${req.method ?? "?"} ${path}`);
    if (req.method === "POST" && path === "/api/add") {
      app.cart += 1;
      res.writeHead(200, { "content-type": "application/json" }).end('{"ok":true}');
      return;
    }
    if (req.method === "POST" && path === "/api/checkout") {
      // Only a cart the first run filled can be checked out: the resume relies on step 2 having run once.
      const ok = app.cart > 0;
      if (ok) {
        app.orders += 1;
        app.cart = 0;
      }
      res.writeHead(ok ? 200 : 409, { "content-type": "application/json" }).end(ok ? '{"ok":true}' : '{"ok":false}');
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

function journey(): Journey {
  return {
    metadata: { id: "checkout", name: "Checkout", promoted: true, params: ["ref"], createdAtIso: "2026-11-08T00:00:00.000Z" },
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
    // H5: the project the resume reads its done check and doneCheckPolicy from. This test is about the hold, so
    // its project is advisory (an unverified pass exits 0); the job verdict is still read and reported.
    catalogDir: advisoryCatalogDir(root),
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
  root = mkdtempSync(join(tmpdir(), "jev-hold-served-"));
  home = join(root, "home");
  journeysDir = join(root, "journeys");
  holdsDir = join(root, "holds");
  inboxDir = join(root, "inbox");
  keyFile = join(home, ".jevitate", "verify-checkpoint.key");
  mkdirSync(home, { recursive: true });
  createCheckpointKey(keyFile);
  await new FsJourneyStore(journeysDir).put(journey());
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((r) => server.close(() => r()));
  rmSync(root, { recursive: true, force: true });
});

afterEach(() => {
  homeOverride.dir = undefined;
  resetRunHooksForTests();
});

describe("[realtime] #793 a run held at step 3, its process killed, approved at a terminal and resumed (real Chromium)", () => {
  it("completes the Journey ok without re-running steps 1-2, by the server's request log; no MARKER_ in the hold or the checkpoint", async () => {
    const reported = await runChildAndKill();
    expect(reported.startsWith("HELD "), reported).toBe(true);
    const held = JSON.parse(reported.slice("HELD ".length)) as { outcome: string; holdId: string; step: number; code: string };
    expect(held).toMatchObject({ outcome: "held", code: "E_RUN_HELD", step: 3 });
    const id = held.holdId;
    // The first run sent step 1's page load and step 2's write, and stopped before the Checkout.
    expect(requests).toEqual(["GET /shop", "POST /api/add"]);

    // Acceptance 4: the files the run left are value-free.
    const files = readdirSync(holdsDir).sort();
    expect(files).toEqual([`${id}.checkpoint.json`, `${id}.json`]);
    for (const f of files) expect(readFileSync(join(holdsDir, f), "utf8").match(/MARKER_/g) ?? []).toHaveLength(0);

    // `inbox approve`/`resume` read the user's key from the home: the temp one the child was given.
    homeOverride.dir = home;

    // Resuming before a person answered is refused, and nothing runs.
    const early = await cli(["inbox", "resume", id, "--holds-dir", holdsDir, "--param", `ref=${MARKER}`]);
    expect(early.body.error?.code).toBe("E_HOLD_NOT_APPROVED");
    expect(early.code).toBe(64);
    expect(requests).toHaveLength(2);

    const approved = await cli(["inbox", "approve", id, "--holds-dir", holdsDir], {
      stdinIsTTY: () => true,
      stdoutIsTTY: () => true,
      prompt: async () => id,
      env: {},
      user: () => "person",
    });
    expect(approved.body, JSON.stringify(approved.body)).toMatchObject({ ok: true, data: { id, decision: "approved", channel: "tty" } });
    expect(approved.code).toBe(0);
    for (const f of readdirSync(holdsDir)) expect(readFileSync(join(holdsDir, f), "utf8")).not.toContain("MARKER_");

    // The run-mode gate lives in this process too; it lets through only the approved resume step.
    registerRunHooks("test-gate", { beforeWrite: (ctx) => (ctx.step === 3 && !isApprovedResumeStep(ctx) ? { kind: "approval", reason: "a checkout needs a person" } : undefined) });
    const resumed = await cli(["inbox", "resume", id, "--holds-dir", holdsDir, "--param", `ref=${MARKER}`]);
    // H5: the resumed run reads its job's done check, as `journey run` does: none is declared, so the job reads
    // unverified/no-check (0 under this advisory project; 2 under the default require, done-check-surfaces.test.ts).
    expect(resumed.body, JSON.stringify(resumed.body)).toMatchObject({ ok: true, data: { id, outcome: "ok", fromStep: 3, job: { attainment: "unverified", basis: "no-check" } } });
    expect(resumed.code).toBe(0);
    expect(JSON.stringify(resumed.body)).not.toContain("MARKER_");

    // The resume reopened the page the run was held on, then sent the Checkout: step 2's write was never sent again.
    expect(requests).toEqual(["GET /shop", "POST /api/add", "GET /shop", "POST /api/checkout"]);
    expect(requests.filter((r) => r === "POST /api/add")).toHaveLength(1);
    expect(app.orders).toBe(1);
    // One approval, one action: the hold was consumed as the approved action acted.
    expect(existsSync(join(holdsDir, `${id}.json`))).toBe(false);
    const again = await cli(["inbox", "resume", id, "--holds-dir", holdsDir, "--param", `ref=${MARKER}`]);
    expect(again.body.error?.code).toBe("E_HOLD_NOT_FOUND");
  }, 180_000);
});
