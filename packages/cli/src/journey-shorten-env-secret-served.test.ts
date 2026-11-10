import { createServer, type Server } from "node:http";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ProfileManager } from "@jevitate/daemon";
import { FsJourneyStore, JourneyRegistry, type Journey } from "@jevitate/journey";
import { PlaywrightBrowserPort } from "@jevitate/playwright";
import { registerDoneCheckHooks } from "./journey-done-check-hook.js";
import { resetRunHooksForTests } from "./journey-run-hooks.js";
import { buildProgram } from "./program.js";
import { useSkippingTime } from "../../explore/src/testkit.js";

useSkippingTime({ per: "all", pageClock: false });

/**
 * #801 × #827 served: `journey shorten` runs where every other replay surface can — on a named
 * environment (`--env`), with a secret parameter bound from the process environment
 * (`--secret-field 'param=pw=env:<VAR>'`). The page signs in only when the typed password is the
 * secret's value, so an achieved candidate proves the value was typed; it never reaches the
 * report, the draft, or any file the search left.
 */

const VALUE = "Shorten5ecretVaLue7Qx";
const VAR = "JEV_TEST_SHORTEN_SECRET";

let server: Server;
let origin: string;
let root: string;
let journeysDir: string;
let projectDir: string;
let fixturesFile: string;
let signedIn = false;
let logins = 0;

const page = `<!doctype html><html><body>
<button data-testid=help onclick="document.querySelector('[data-testid=tip]').textContent='Tip shown'">Help</button><p data-testid=tip></p>
<label>Password <input id=pw data-testid=pw type=password></label>
<button onclick="fetch('/api/login',{method:'POST',body:document.getElementById('pw').value}).then(r=>r.json()).then(j=>{document.querySelector('[data-testid=status]').textContent=j.ok?'Signed in':'Rejected'})">Sign in</button>
<p data-testid=status></p></body></html>`;

function signIn(site: string): Journey {
  return {
    metadata: { id: "sign-in", name: "Sign in", promoted: false, params: ["pw"], parameters: [{ name: "pw", secret: true }], createdAtIso: "2026-11-09T00:00:00.000Z" },
    recording: {
      version: "1",
      site,
      pages: [
        {
          url: "/",
          steps: [
            { step: { kind: "navigate", url: "/", expect: { kind: "visible", target: { testId: "pw" } } } },
            { step: { kind: "click", target: { testId: "help" }, expect: { kind: "textIncludes", target: { testId: "tip" }, text: "Tip shown" } } },
            { step: { kind: "fill", target: { label: "Password" }, value: { var: "pw" }, expect: { kind: "visible", target: { testId: "pw" } } } },
            { step: { kind: "click", target: { role: "button", name: "Sign in" }, expect: { kind: "textIncludes", target: { testId: "status" }, text: "Signed in" } } },
          ],
        },
      ],
    },
  } as unknown as Journey;
}

function allFiles(dir: string): string[] {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  return names.flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? allFiles(p) : [p];
  });
}

beforeAll(async () => {
  server = createServer((req, res) => {
    let body = "";
    req.on("data", (c: Buffer) => (body += c.toString()));
    req.on("end", () => {
      if (req.method === "POST" && req.url === "/api/reset") {
        signedIn = false;
        res.writeHead(200, { "content-type": "application/json" }).end("{}");
      } else if (req.method === "POST" && req.url === "/api/login") {
        logins += 1;
        signedIn = body === VALUE;
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ ok: signedIn }));
      } else if (req.url === "/done") {
        res.writeHead(200, { "content-type": "text/html" }).end(`<!doctype html><html><body>${signedIn ? "<p data-testid=ok>signed in</p>" : "<p>signed out</p>"}</body></html>`);
      } else {
        res.writeHead(200, { "content-type": "text/html" }).end(page);
      }
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  root = mkdtempSync(join(tmpdir(), "jev-801-shorten-env-secret-"));
  journeysDir = join(root, "journeys");
  projectDir = join(root, ".jevitate");
  mkdirSync(projectDir, { recursive: true });
  writeFileSync(join(projectDir, "project.json"), "{}");
  writeFileSync(
    join(projectDir, "jobs.json"),
    JSON.stringify({ jobs: [{ id: "sign-in", trigger: "When I come back", motivation: "I want to sign in", outcome: "I am signed in", done: { version: 1, at: "/done", check: "count:testId=ok|min=1" } }] }),
  );
  writeFileSync(join(root, "environments.json"), JSON.stringify({ local: { baseUrl: origin } }));
  fixturesFile = join(root, "fixtures.json");
  writeFileSync(fixturesFile, JSON.stringify({ setup: [{ name: "reset", method: "POST", url: "/api/reset" }], restore: [{ name: "reset", method: "POST", url: "/api/reset" }] }));
  // Recorded on another origin: only `--env local` places it on the served one.
  await new JourneyRegistry(new FsJourneyStore(journeysDir)).put(signIn("http://127.0.0.1:9"));
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((r) => server.close(() => r()));
  rmSync(root, { recursive: true, force: true });
});

beforeEach(() => {
  vi.stubEnv("JEVITATE_RUN_RECORD", "");
  vi.stubEnv(VAR, VALUE);
  registerDoneCheckHooks();
});

afterEach(() => {
  vi.unstubAllEnvs();
  resetRunHooksForTests();
});

describe("#801 journey shorten --env --secret-field (real Chromium)", () => {
  it("shortens on the named environment with the secret bound from the process environment, the value in no report, draft or file", async () => {
    const out: string[] = [];
    const err: string[] = [];
    const program = buildProgram({
      profiles: new ProfileManager(join(root, "profiles")),
      dbPath: join(root, "db.sqlite"),
      catalogDir: projectDir,
      environmentsFile: join(root, "environments.json"),
      logs: { autoPrune: false, logsRoot: join(root, "logs") },
      explore: { browserPortFactory: () => new PlaywrightBrowserPort(), targetsConfigPath: join(root, "targets.json") },
    });
    program.configureOutput({ writeOut: (s) => out.push(s), writeErr: (s) => err.push(s) });
    program.exitOverride();
    process.exitCode = undefined;
    await program.parseAsync(
      ["journey", "shorten", "sign-in", "--job", "sign-in", "--env", "local", "--secret-field", `param=pw=env:${VAR}`, "--fixtures", fixturesFile, "--journeys-dir", journeysDir, "--json"],
      { from: "user" },
    );
    const code = process.exitCode === undefined ? 0 : Number(process.exitCode);
    process.exitCode = undefined;
    const raw = out.join("");
    const envelope = JSON.parse(raw) as { ok: boolean; data?: Record<string, unknown> };
    expect(envelope.ok, raw).toBe(true);
    expect(code).toBe(0);
    expect(envelope.data).toMatchObject({
      journeyId: "sign-in",
      originalSteps: 4,
      shortestSteps: 3,
      baseline: "achieved",
      draftId: "sign-in-shortest",
      removed: [{ step: 2, kind: "click" }],
    });
    // The candidates ran on the environment's origin and typed the bound value (the page signs in only on it).
    expect(logins).toBeGreaterThan(0);

    const draft = await new FsJourneyStore(journeysDir).get("sign-in-shortest");
    expect(draft?.metadata.promoted).toBe(false);
    expect(draft?.recording.pages.flatMap((p) => p.steps).map((s) => s.step.kind)).toEqual(["navigate", "fill", "click"]);
    expect(JSON.stringify(draft?.recording.pages.flatMap((p) => p.steps)[1]?.step)).toContain('"var":"pw"');

    expect(raw).not.toContain(VALUE);
    expect(err.join("")).not.toContain(VALUE);
    expect(allFiles(root).filter((f) => readFileSync(f).includes(VALUE))).toEqual([]);
  }, 600_000);
});
