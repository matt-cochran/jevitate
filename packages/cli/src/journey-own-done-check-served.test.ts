import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { RunEvidenceSchema } from "@jevitate/adjudicator";
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
 * 0.30.0 design §3.1 served acceptance: a Journey with no linked job carries its own done check in
 * `metadata.done`, and `journey run` (in process, real Chromium) reads it in a fresh context before step 1
 * and after the end state, exactly as a linked job's. A Journey that links a job reads the job's check,
 * never its own (the lint refuses the pair).
 */

const MARKER = "MARKER_ITEM-5512";

let server: Server;
let origin: string;
let root: string;
let journeysDir: string;
let projectDir: string;
let logs: string;
/** What the app stores; `broken` answers Save with 200 and stores nothing. */
const app = { broken: true, items: [] as string[] };

const esc = (s: string): string => s.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);

function serve(): Promise<Server> {
  const s = createServer((req, res) => {
    const path = (req.url ?? "/").split("?")[0] ?? "/";
    if (req.method === "POST" && path === "/api/items") {
      let body = "";
      req.on("data", (c: Buffer) => (body += c.toString("utf8")));
      req.on("end", () => {
        if (!app.broken) app.items.push(body);
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

const OWN_DONE = { version: 1, at: "/items", check: "textIncludes:testId=items|${item}", distinguishedBy: ["item"] } as const;

function journey(id: string, links: { job?: string; done?: typeof OWN_DONE }): Journey {
  return {
    metadata: { id, name: id, promoted: true, params: ["item"], ...links, createdAtIso: "2026-11-09T00:00:00.000Z" },
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

function writeProject(policy?: "require" | "advisory"): void {
  writeFileSync(join(projectDir, "project.json"), JSON.stringify(policy === undefined ? {} : { doneCheckPolicy: policy }));
}

beforeAll(async () => {
  server = await serve();
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  root = mkdtempSync(join(tmpdir(), "jev-own-done-check-served-"));
  journeysDir = join(root, "journeys");
  projectDir = join(root, ".jevitate");
  logs = join(root, "logs");
  mkdirSync(projectDir, { recursive: true });
  writeFileSync(
    join(projectDir, "jobs.json"),
    JSON.stringify({
      jobs: [
        { id: "no-check", ...story },
      ],
    }),
  );
  const registry = new JourneyRegistry(new FsJourneyStore(journeysDir));
  await registry.put(journey("save-own", { done: OWN_DONE }));
  await registry.put(journey("save-both", { job: "no-check", done: OWN_DONE }));
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((r) => server.close(() => r()));
  rmSync(root, { recursive: true, force: true });
});

beforeEach(() => {
  vi.stubEnv("JEVITATE_RUN_RECORD", "");
  rmSync(logs, { recursive: true, force: true });
  app.broken = true;
  app.items = [];
  writeProject();
  registerDoneCheckHooks();
});

afterEach(() => {
  vi.unstubAllEnvs();
  resetRunHooksForTests();
});

interface Run {
  readonly data: { outcome?: string; job?: { attainment: string; basis: string }; failure?: { kind: string } };
  readonly code: number;
  /** Everything the run wrote (stdout and stderr), less the replay's own `output` (see `noMarker`). */
  readonly text: string;
}

async function run(id: string, ...flags: string[]): Promise<Run> {
  const out: string[] = [];
  const err: string[] = [];
  const program = buildProgram({
    profiles: new ProfileManager("/unused"),
    dbPath: join(root, "db.sqlite"),
    catalogDir: projectDir,
    logs: { autoPrune: false, logsRoot: logs },
    explore: { browserPortFactory: () => new PlaywrightBrowserPort(), targetsConfigPath: join(root, "targets.json") },
  });
  program.configureOutput({ writeOut: (s) => out.push(s), writeErr: (s) => err.push(s) });
  program.exitOverride();
  process.exitCode = undefined;
  await program.parseAsync(["journey", "run", id, "--journeys-dir", journeysDir, "--param", `item=${MARKER}`, "--json", ...flags], { from: "user" });
  const code = process.exitCode === undefined ? 0 : Number(process.exitCode);
  process.exitCode = undefined;
  const envelope = JSON.parse(out.join("")) as { data?: Run["data"] & { output?: unknown } };
  // The replay's `output` echoes the bound variables, as every `journey run` has since before 0.30.0:
  // not this deliverable's to change, so it is set aside; everything else must be value-free.
  const { output: _output, ...data } = envelope.data ?? {};
  return { data, code, text: [JSON.stringify({ ...envelope, data }), ...err].join("") };
}

function evidenceFiles(): string[] {
  if (!existsSync(logs)) return [];
  return readdirSync(logs).flatMap((date) =>
    readdirSync(join(logs, date))
      .filter((f) => f.startsWith("journey-evidence-") && statSync(join(logs, date, f)).isDirectory())
      .map((f) => join(logs, date, f, EVIDENCE_FILE)),
  );
}

describe("design §3.1: a Journey's own done check (metadata.done), read by journey run (real Chromium)", () => {
  it("no linked job: its own check decides; a Save that stores nothing is not-achieved, exit 1, with the spec in the evidence", async () => {
    const r = await run("save-own");
    expect(r.data.outcome, r.text).toBe("ok");
    expect(r.data.job).toEqual({ attainment: "not-achieved", basis: "done-check" });
    expect(r.data.failure).toMatchObject({ kind: "done-check-failed" });
    expect(r.code).toBe(1);
    const evidence = RunEvidenceSchema.parse(JSON.parse(readFileSync(evidenceFiles()[0]!, "utf8")));
    expect(evidence.doneCheck?.spec).toEqual(OWN_DONE);
    expect(r.text).not.toContain(MARKER);
  }, 120_000);

  it("no linked job: on an app that stores the item, achieved, exit 0", async () => {
    app.broken = false;
    const r = await run("save-own");
    expect(r.data.job, r.text).toEqual({ attainment: "achieved", basis: "done-check" });
    expect(r.code).toBe(0);
  }, 120_000);

  it("a linked job wins: the job has no check, so the run reads no-check and its own metadata.done is never read", async () => {
    app.broken = false;
    const r = await run("save-both");
    expect(r.data.job, r.text).toEqual({ attainment: "unverified", basis: "no-check" });
    const evidence = RunEvidenceSchema.parse(JSON.parse(readFileSync(evidenceFiles()[0]!, "utf8")));
    expect(evidence.doneCheck).toBeUndefined();
  }, 120_000);
});
