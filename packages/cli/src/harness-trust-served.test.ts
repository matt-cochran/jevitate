import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { adjudicate, countsForGate, RunEvidenceSchema } from "@jevitate/adjudicator";
import { ProfileManager } from "@jevitate/daemon";
import { FsJourneyStore, JourneyRegistry, type Journey } from "@jevitate/journey";
import { PlaywrightBrowserPort } from "@jevitate/playwright";
import { registerDoneCheckHooks } from "./journey-done-check-hook.js";
import { EVIDENCE_FILE } from "./journey-run-evidence.js";
import { resetRunHooksForTests } from "./journey-run-hooks.js";
import { buildProgram } from "./program.js";
import { useSkippingTime } from "../../explore/src/testkit.js";

useSkippingTime({ per: "all", pageClock: false });

/**
 * #802 served acceptance: on an environment declared `trust: "harness"`, a passing Journey run whose
 * done check reads true is still `unverified` with basis `harness`: a UI harness over a mock backend
 * shows feasibility, never a job verdict (docs/harness.md). A control run on `trust: "test"` is achieved.
 */

let server: Server;
let origin: string;
let root: string;
let journeysDir: string;
let projectDir: string;
let logs: string;
const app = { broken: false, items: [] as string[] };

const esc = (s: string): string => s.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);

function serve(): Promise<Server> {
  const s = createServer((req, res) => {
    const path = (req.url ?? "/").split("?")[0] ?? "/";
    if (req.method === "POST" && path === "/api/items") {
      let body = "";
      req.on("data", (c: Buffer) => (body += c.toString("utf8")));
      req.on("end", () => {
        app.items.push(body);
        res.writeHead(200, { "content-type": "application/json" }).end('{"ok":true}');
      });
      return;
    }
    const html = (b: string) => res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(`<!doctype html><html><body>${b}</body></html>`);
    if (path === "/items") return html(`<ul data-testid="items">${app.items.map((i) => `<li>${esc(i)}</li>`).join("")}</ul>`);
    if (path === "/new")
      return html(`<input data-testid="name" aria-label="Name"><button data-testid="save" type="button">Save</button><p data-testid="status"></p>
<script>
document.querySelector("[data-testid=save]").addEventListener("click", async () => {
  await fetch("/api/items", { method: "POST", body: document.querySelector("[data-testid=name]").value });
  document.querySelector("[data-testid=status]").textContent = "Saved";
});
</script>`);
    res.writeHead(404).end();
  });
  return new Promise((r) => s.listen(0, "127.0.0.1", () => r(s)));
}

function journey(id: string, job: string): Journey {
  return {
    metadata: { id, name: id, promoted: true, params: ["item"], job, createdAtIso: "2026-11-08T00:00:00.000Z" },
    recording: {
      version: "1",
      site: origin,
      pages: [
        {
          url: "/new",
          steps: [
            { step: { kind: "navigate", url: "/new", expect: { kind: "visible", target: { testId: "name" } } } },
            { step: { kind: "fill", target: { testId: "name" }, value: { var: "item" }, expect: { kind: "visible", target: { testId: "name" } } } },
            { step: { kind: "click", target: { testId: "save" }, expect: { kind: "textIncludes", target: { testId: "status" }, text: "Saved" } } },
          ],
        },
      ],
    },
  } as unknown as Journey;
}

const story = { trigger: "When I have a new item", motivation: "I want to save it", outcome: "I can find it later" };

beforeAll(async () => {
  server = await serve();
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  root = mkdtempSync(join(tmpdir(), "jev-harness-trust-served-"));
  journeysDir = join(root, "journeys");
  projectDir = join(root, ".jevitate");
  logs = join(root, "logs");
  mkdirSync(projectDir, { recursive: true });
  writeFileSync(join(projectDir, "project.json"), "{}");
  writeFileSync(
    join(projectDir, "jobs.json"),
    JSON.stringify({ jobs: [{ id: "save-item", ...story, done: { version: 1, at: "/items", check: "textIncludes:testId=items|${item}", distinguishedBy: ["item"] } }] }),
  );
  // The same app, declared twice: as a harness and as a plain test environment (the control).
  writeFileSync(join(root, "environments.json"), JSON.stringify({ harness: { baseUrl: origin, trust: "harness" }, staging: { baseUrl: origin, trust: "test" } }));
  const registry = new JourneyRegistry(new FsJourneyStore(journeysDir));
  await registry.put(journey("save-item", "save-item"));
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((r) => server.close(() => r()));
  rmSync(root, { recursive: true, force: true });
});

beforeEach(() => {
  vi.stubEnv("JEVITATE_RUN_RECORD", "");
  rmSync(logs, { recursive: true, force: true });
  app.items = [];
  registerDoneCheckHooks();
});

afterEach(() => {
  vi.unstubAllEnvs();
  resetRunHooksForTests();
});

interface Run {
  readonly data: { outcome?: string; job?: { attainment: string; basis: string } };
  readonly code: number;
  readonly text: string;
}

async function run(env: string): Promise<Run> {
  const out: string[] = [];
  const err: string[] = [];
  const program = buildProgram({
    profiles: new ProfileManager("/unused"),
    dbPath: join(root, "db.sqlite"),
    catalogDir: projectDir,
    environmentsFile: join(root, "environments.json"),
    logs: { autoPrune: false, logsRoot: logs },
    explore: { browserPortFactory: () => new PlaywrightBrowserPort(), targetsConfigPath: join(root, "targets.json") },
  });
  program.configureOutput({ writeOut: (s) => out.push(s), writeErr: (s) => err.push(s) });
  program.exitOverride();
  process.exitCode = undefined;
  await program.parseAsync(["journey", "run", "save-item", "--journeys-dir", journeysDir, "--env", env, "--param", "item=harness-item-1", "--json"], { from: "user" });
  const code = process.exitCode === undefined ? 0 : Number(process.exitCode);
  process.exitCode = undefined;
  const envelope = JSON.parse(out.join("")) as { data?: Run["data"] };
  return { data: envelope.data ?? {}, code, text: [out.join(""), ...err].join("") };
}

function evidence() {
  const files = existsSync(logs)
    ? readdirSync(logs).flatMap((d) =>
        readdirSync(join(logs, d))
          .filter((f) => f.startsWith("journey-evidence-") && statSync(join(logs, d, f)).isDirectory())
          .map((f) => join(logs, d, f, EVIDENCE_FILE)),
      )
    : [];
  expect(files).toHaveLength(1);
  return RunEvidenceSchema.parse(JSON.parse(readFileSync(files[0]!, "utf8")));
}

describe("#802 a harness target never yields a job verdict (real Chromium)", () => {
  it("control: the same passing run on trust 'test' is achieved, exit 0", async () => {
    const r = await run("staging");
    expect(r.data.job, r.text).toEqual({ attainment: "achieved", basis: "done-check" });
    expect(r.code).toBe(0);
    expect(evidence().run.target.trust).toBe("test");
  }, 120_000);

  it("trust 'harness': the done check reads true, yet the job is unverified with basis harness", async () => {
    const r = await run("harness");
    expect(r.data.outcome, r.text).toBe("ok");
    expect(r.data.job).toEqual({ attainment: "unverified", basis: "harness" });
    const ev = evidence();
    expect(ev.run.mode).toBe("test");
    expect(ev.run.target.trust).toBe("harness");
    // The done check really read true in a fresh session: only the trust forced the verdict.
    expect(ev.doneCheck?.after).toMatchObject({ session: "fresh", value: { known: true, value: true } });
    expect(adjudicate(ev).job).toEqual({ attainment: "unverified", basis: "harness" });
    // Code (rules-v1 countsForGate, design 5.1): a harness is test mode, so a mutation proof counts for the gate.
    expect(countsForGate("harness")).toBe(true);
    // Owner decision (2026-11-08): a harness pass exits 0 while still reading unverified/harness;
    // only a real-stack unverified pass exits 2 under the default doneCheckPolicy `require`.
    expect(r.code).toBe(0);
  }, 120_000);
});
