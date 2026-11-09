import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ProfileManager } from "@jevitate/daemon";
import { ALLOWED_TOOLS } from "@jevitate/mcp-facade";
import { FsJourneyStore, type Journey } from "@jevitate/journey";
import { PlaywrightBrowserPort } from "@jevitate/playwright";
import type { CliDeps } from "./cli-shared.js";
import { registerHoldHooks } from "./journey-hold.js";
import { journeyReviewHash } from "./journey-review.js";
import { createCheckpointKey } from "./journey-verify-checkpoint.js";
import { buildMcpTools, type McpTool } from "./mcp-api.js";
import { makeInProcessCliRunner } from "./mcp-cli-runner.js";
import { buildProgram } from "./program.js";
import { useSkippingTime } from "../../explore/src/testkit.js";

/**
 * #819 and #827, served (real MCP tools, the in-process CLI, real Chromium): a secret parameter has a
 * route off the command line on every replay surface, and over MCP never through the call's arguments.
 *
 *  - #819: a token in a navigate URL is bound by name (`--secret-field 'param=<name>=env:VAR'`, or the same
 *    spec in targets.json `secretFields`); it goes only to its binding's origin; over MCP with no binding the
 *    run is refused naming that route (a person can't type a URL at a hold); the `--param` warning names a
 *    route that works for it.
 *  - #827: `journey verify`, `journey demo`, `load run` take `--secret-field` (and targets.json with
 *    `--base-url`) as `journey run` does; over MCP `run_load_test`, `demo_journey` and `verify_journey` get a
 *    secret the call leaves out from the operator's targets.json binding for the run's origin.
 *
 * The marker values reach no result, stdout, stderr or file the runs leave.
 */

useSkippingTime({ per: "all", pageClock: false });

/** Every module that asks for the home gets the temp one: nothing is written to the real ~/.jevitate. */
const homeOverride = vi.hoisted(() => ({ dir: undefined as string | undefined }));
vi.mock("node:os", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:os")>();
  const homedir = (): string => homeOverride.dir ?? real.homedir();
  return { ...real, homedir, default: { ...real, homedir } };
});

const TOKEN = "MARKER_T-inv-4Kq9w";
const PASSWORD = "MARKER_P-pw-8Hz2v";
const TOKEN_VAR = "JEV_ROUTES_INVITE";
const PW_VAR = "JEV_ROUTES_PW";
const ENV = { [TOKEN_VAR]: TOKEN, [PW_VAR]: PASSWORD };

let server: Server;
/** Where the Journeys were recorded, and where the operator's targets.json binds the secrets. */
let site: string;
/** The same server under another origin, which nothing binds. */
let other: string;
let root: string;
let journeysDir: string;
let logs: string;
let targetsPath: string;
const hits: string[] = [];

function serve(): Promise<Server> {
  const s = createServer((req, res) => {
    const path = (req.url ?? "/").split("?")[0] ?? "/";
    const host = req.headers.host ?? "";
    if (path.startsWith("/invite/")) {
      const ok = decodeURIComponent(path.slice("/invite/".length)) === TOKEN;
      hits.push(`invite ${ok ? "ok" : "wrong"} ${host.startsWith("localhost") ? "other" : "site"}`);
      res.writeHead(200, { "content-type": "text/html" }).end(`<!doctype html><h1>Invite</h1><p data-testid=status>${ok ? "Welcome" : "Invalid"}</p>`);
      return;
    }
    if (req.method === "POST" && path === "/api/login") {
      let body = "";
      req.on("data", (c: Buffer) => (body += c.toString("utf8")));
      req.on("end", () => {
        const ok = (JSON.parse(body || "{}") as { password?: string }).password === PASSWORD;
        hits.push(`login ${ok ? "ok" : "wrong"}`);
        res.writeHead(ok ? 200 : 401, { "content-type": "application/json" }).end(ok ? '{"ok":true}' : '{"ok":false}');
      });
      return;
    }
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(
      `<!doctype html><html><body><h1>Sign in</h1><label>Password <input id=pw type=password></label><button type=button id=go>Sign in</button><p data-testid=status></p>
<script>document.getElementById("go").addEventListener("click", async () => { const r = await fetch("/api/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password: document.getElementById("pw").value }) }); document.querySelector("[data-testid=status]").textContent = r.ok ? "Signed in" : "Wrong password"; });</script></body></html>`,
    );
  });
  return new Promise((r) => s.listen(0, "127.0.0.1", () => r(s)));
}

/** A single-use invite link: the token is in the navigate URL, and no field ever types it. */
function inviteJourney(id: string, url: string, extra: Partial<Journey["metadata"]> = {}): Journey {
  return {
    metadata: { id, name: id, promoted: false, params: ["inviteToken"], parameters: [{ name: "inviteToken", secret: true }], createdAtIso: "2026-11-09T00:00:00.000Z", ...extra },
    recording: {
      version: "1",
      site,
      pages: [{ url: "/invite", steps: [{ step: { kind: "navigate", url, expect: { kind: "textIncludes", target: { testId: "status" }, text: "Welcome" } } }] }],
    },
  } as unknown as Journey;
}

/** A sign-in whose password field types the secret parameter `password`. */
function loginJourney(id: string): Journey {
  return {
    metadata: { id, name: id, promoted: false, params: ["password"], parameters: [{ name: "password", secret: true }], createdAtIso: "2026-11-09T00:00:00.000Z" },
    recording: {
      version: "1",
      site,
      pages: [
        {
          url: "/login",
          steps: [
            { step: { kind: "navigate", url: "/login", expect: { kind: "visible", target: { role: "heading", name: "Sign in" } } } },
            { step: { kind: "fill", target: { label: "Password" }, value: { var: "password" }, expect: { kind: "visible", target: { role: "button", name: "Sign in" } } } },
            { step: { kind: "click", target: { role: "button", name: "Sign in" }, expect: { kind: "textIncludes", target: { testId: "status" }, text: "Signed in" } } },
          ],
        },
      ],
    },
  } as unknown as Journey;
}

/** Stored, promoted and approved as a person at a terminal would (the content as stored). */
async function putApproved(j: Journey): Promise<void> {
  const store = new FsJourneyStore(journeysDir);
  await store.put(j);
  const stored = (await store.get(j.metadata.id))!;
  await store.put({ ...stored, metadata: { ...stored.metadata, promoted: true, approval: { contentHash: journeyReviewHash(stored), at: "2026-11-09T00:00:00.000Z", provenance: { channel: "tty", agentSignals: [] } } } } as Journey);
}

function writeTargets(body: Record<string, unknown>): void {
  mkdirSync(join(root, "home", ".jevitate"), { recursive: true });
  writeFileSync(targetsPath, JSON.stringify(body));
}

function cliDeps(): CliDeps {
  return {
    profiles: new ProfileManager(join(root, "profiles")),
    journeysDir,
    dbPath: join(root, "site.sqlite"),
    environmentsFile: join(root, "environments.json"),
    logs: { logsRoot: logs },
    explore: { browserPortFactory: () => new PlaywrightBrowserPort(), targetsConfigPath: targetsPath, env: ENV },
  } as unknown as CliDeps;
}

function tools(): Map<string, McpTool> {
  return new Map(
    buildMcpTools({
      journeysDir,
      pathRoots: [root],
      runRecordLogsRoot: logs,
      environmentsFile: join(root, "environments.json"),
      targetsConfigPath: targetsPath,
      sitePolicyDbPath: join(root, "site.sqlite"),
      browserPortFactory: () => new PlaywrightBrowserPort(),
      secretEnv: ENV,
      runCli: makeInProcessCliRunner(() => buildProgram(cliDeps())),
    }).map((t) => [t.name, t]),
  );
}

async function call(name: string, args: Record<string, unknown>): Promise<{ isError: boolean; text: string; body: Record<string, unknown> }> {
  const r = await tools().get(name)!.handler(args);
  const text = r.content[0]!.text;
  return { isError: r.isError === true, text, body: JSON.parse(text) as Record<string, unknown> };
}

async function cli(args: string[]): Promise<{ out: string; err: string; exitCode: number }> {
  let out = "";
  let err = "";
  const program = buildProgram(cliDeps());
  program.exitOverride();
  const sinks = { writeOut: (s: string) => void (out += s), writeErr: (s: string) => void (err += s) };
  const apply = (c: typeof program): void => {
    c.configureOutput(sinks);
    for (const sub of c.commands) apply(sub as typeof program);
  };
  apply(program);
  const saved = process.exitCode;
  process.exitCode = 0;
  try {
    await program.parseAsync(args, { from: "user" });
    return { out, err, exitCode: Number(process.exitCode ?? 0) };
  } finally {
    process.exitCode = saved;
  }
}

function allFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? allFiles(p) : [p];
  });
}

/** Every file the runs left (results, evidence, guides, logs, checkpoints) that holds a marker value. */
const filesWithMarker = (): string[] => allFiles(root).filter((f) => readFileSync(f).includes("MARKER_"));

beforeAll(async () => {
  server = await serve();
  const port = (server.address() as AddressInfo).port;
  site = `http://127.0.0.1:${port}`;
  other = `http://localhost:${port}`;
  root = mkdtempSync(join(tmpdir(), "jev-secret-routes-served-"));
  homeOverride.dir = join(root, "home");
  journeysDir = join(root, "journeys");
  logs = join(root, "logs");
  targetsPath = join(root, "home", ".jevitate", "targets.json");
  mkdirSync(journeysDir, { recursive: true });
  createCheckpointKey(join(root, "home", ".jevitate", "verify-checkpoint.key"));
  writeFileSync(join(root, "environments.json"), JSON.stringify({}));
  registerHoldHooks({ holdsDir: join(root, "holds"), keyFile: join(root, "home", ".jevitate", "verify-checkpoint.key"), inboxDir: join(root, "inbox") });
  await putApproved(inviteJourney("invite", "/invite/${inviteToken}"));
  // The token's URL is on another origin than the Journey's site.
  await putApproved(inviteJourney("invite-elsewhere", `${other}/invite/\${inviteToken}`, { allowedOrigins: [other] } as Partial<Journey["metadata"]>));
  await putApproved(loginJourney("login"));
});

afterAll(async () => {
  vi.unstubAllEnvs();
  homeOverride.dir = undefined;
  server.closeAllConnections();
  await new Promise<void>((r) => server.close(() => r()));
  rmSync(root, { recursive: true, force: true });
});

beforeEach(() => {
  vi.stubEnv("JEVITATE_RUN_RECORD", "");
  // The server's own environment, where a replay inside an MCP tool call reads a binding's `env:` source.
  for (const [k, v] of Object.entries(ENV)) vi.stubEnv(k, v);
  hits.length = 0;
  writeTargets({});
});

const okRun = (out: string): void => expect(JSON.parse(out)).toMatchObject({ ok: true, data: { outcome: "ok" } });

describe("#819 a secret in a navigate URL", { timeout: 120_000 }, () => {
  it("--param warns, and the warning names a route that works for a URL secret", async () => {
    const r = await cli(["journey", "run", "invite", "--param", `inviteToken=${TOKEN}`, "--json"]);
    okRun(r.out);
    expect(r.err).toContain(`--secret-field 'param=inviteToken=env:<VAR>'`);
    expect(r.err).toContain("navigate URL");
    expect(r.out + r.err).not.toContain(TOKEN);
  });

  it("the route the warning names: --secret-field 'param=inviteToken=env:VAR' sends it, with nothing on the command line", async () => {
    const r = await cli(["journey", "run", "invite", "--secret-field", `param=inviteToken=env:${TOKEN_VAR}`, "--json"]);
    okRun(r.out);
    expect(hits).toEqual(["invite ok site"]);
    expect(r.out + r.err).not.toContain(TOKEN);
    expect(filesWithMarker()).toEqual([]);
  });

  it("targets.json secretFields take the same binding with --base-url", async () => {
    writeTargets({ [site]: { secretFields: [`param=inviteToken=env:${TOKEN_VAR}`] } });
    const r = await cli(["journey", "run", "invite", "--base-url", site, "--json"]);
    okRun(r.out);
    expect(hits).toEqual(["invite ok site"]);
    expect(r.out + r.err).not.toContain(TOKEN);
  });

  it("a targets.json binding is for its own origin: a navigate URL to another one is refused before anything is sent", async () => {
    writeTargets({ [site]: { secretFields: [`param=inviteToken=env:${TOKEN_VAR}`] } });
    const r = await cli(["journey", "run", "invite-elsewhere", "--base-url", site, "--json"]);
    expect(JSON.parse(r.out)).toMatchObject({ ok: false, error: { code: "E_SECRET_ORIGIN_REFUSED" } });
    expect(r.out).toContain(other);
    expect(hits).toEqual([]);
    expect(r.out + r.err).not.toContain(TOKEN);
  });

  it("over MCP, the operator's targets.json binding sends it on an automation-mode target (vault-autofill); the value is in no result or file", async () => {
    writeTargets({ [site]: { secretFields: [`param=inviteToken=env:${TOKEN_VAR}`] } });
    const r = await call("run_journey", { id: "invite" });
    expect(r.body).toMatchObject({ outcome: "ok" });
    expect(hits).toEqual(["invite ok site"]);
    expect(r.text).not.toContain(TOKEN);
    expect(filesWithMarker()).toEqual([]);
  });

  it("over MCP with no binding: refused before any browser, naming the route (a person can't type a URL at a hold)", async () => {
    const r = await call("run_journey", { id: "invite" });
    expect(r.isError).toBe(true);
    expect(r.body).toMatchObject({ code: "E_SECRET_MODE_UNAVAILABLE" });
    expect(r.text).toContain("param=inviteToken=env:<VAR>");
    expect(hits).toEqual([]);
  });

  it("a value in the call's arguments is still refused by name", async () => {
    const r = await call("run_journey", { id: "invite", params: { inviteToken: TOKEN } });
    expect(r.body).toMatchObject({ code: "E_SECRET_PARAM_OVER_MCP", params: ["inviteToken"] });
    expect(r.text).not.toContain(TOKEN);
    expect(hits).toEqual([]);
  });
});

describe("#827 every replay command takes the secret off the command line", { timeout: 180_000 }, () => {
  it("journey demo --secret-field types it; the guide holds no value", async () => {
    const r = await cli(["journey", "demo", "login", "--secret-field", `label=Password=env:${PW_VAR}`, "--guide", join(root, "demo", "guide.md"), "--pace", "0", "--json"]);
    okRun(r.out);
    expect(hits).toEqual(["login ok"]);
    expect(r.out + r.err).not.toContain(PASSWORD);
    expect(filesWithMarker()).toEqual([]);
  });

  it("load run --secret-field types it in every iteration", async () => {
    const r = await cli(["load", "run", "login", "--secret-field", `param=password=env:${PW_VAR}`, "--authorized-origin", site, "--iterations", "2", "--json"]);
    expect(JSON.parse(r.out)).toMatchObject({ ok: true });
    expect(hits).toEqual(["login ok", "login ok"]);
    expect(r.out + r.err).not.toContain(PASSWORD);
  });

  it("journey verify --mutate with targets.json and --base-url: each replay gets it", async () => {
    writeTargets({ [site]: { secretFields: [`label=Password=env:${PW_VAR}`] } });
    const r = await cli(["journey", "verify", "login", "--mutate", "--base-url", site, "--json"]);
    expect(JSON.parse(r.out)).toMatchObject({ ok: true });
    expect(hits.filter((h) => h === "login wrong")).toEqual([]);
    expect(hits).toContain("login ok");
    expect(r.out + r.err).not.toContain(PASSWORD);
    expect(filesWithMarker()).toEqual([]);
  });

  for (const [how, flags] of [
    ["--secret-field", ["--secret-field", `param=inviteToken=env:${TOKEN_VAR}`]],
    ["--param (its scope's route globs held the token)", ["--param", `inviteToken=${TOKEN}`]],
  ] as const) {
    it(`explore --from-journey ${how}: the prefix sends the token, and no result, stdout or file holds it`, async () => {
      const out = join(root, "anchored");
      rmSync(out, { recursive: true, force: true });
      const r = await cli(["explore", "--from-journey", "invite", "--at-step", "1", ...flags, "--journeys-dir", journeysDir, "--strategy", "adversarial", "--fake-ai", "--max-actions", "2", "--out", out, "--json"]);
      expect(JSON.parse(r.out), r.out + r.err).toMatchObject({ ok: true });
      expect(hits[0]).toBe("invite ok site");
      const at = r.out.indexOf(TOKEN);
      expect(at, r.out.slice(Math.max(0, at - 200), at + 40)).toBe(-1);
      expect(filesWithMarker()).toEqual([]);
    });
  }

  it("a binding that matches no secret parameter is refused, naming it, before anything runs", async () => {
    const r = await cli(["journey", "demo", "login", "--secret-field", `param=nope=env:${PW_VAR}`, "--json"]);
    expect(JSON.parse(r.out)).toMatchObject({ ok: false, error: { code: "E_JOURNEY_DEMO_ARGS" } });
    expect(r.out).toContain("param=nope");
    expect(hits).toEqual([]);
  });

  it("the --param warning on these commands names their own --secret-field", async () => {
    const r = await cli(["journey", "verify", "login", "--plan", "--param", `password=${PASSWORD}`, "--json"]);
    expect(r.err).toContain("`jevitate journey verify` reads it from the environment instead: --secret-field 'param=password=env:<VAR>'");
    expect(r.out + r.err).not.toContain(PASSWORD);
  });
});

describe("#827 over MCP: the operator's targets.json, never the call's arguments", { timeout: 180_000 }, () => {
  it("run_load_test gets it from the binding for the run's origin", async () => {
    writeTargets({ [site]: { secretFields: [`label=Password=env:${PW_VAR}`] } });
    const r = await call("run_load_test", { journeyId: "login", authorizedOrigin: [site] });
    expect(r.isError).toBe(false);
    expect(hits).toEqual(["login ok"]);
    expect(r.text).not.toContain(PASSWORD);
    expect(filesWithMarker()).toEqual([]);
  });

  it("run_load_test with no binding is refused before any browser: a load test never holds", async () => {
    const r = await call("run_load_test", { journeyId: "login", authorizedOrigin: [site] });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("E_SECRET_MODE_UNAVAILABLE");
    expect(hits).toEqual([]);
  });

  it("demo_journey gets it from the binding", async () => {
    writeTargets({ [site]: { secretFields: [`label=Password=env:${PW_VAR}`] } });
    const r = await call("demo_journey", { id: "login", guide: join(root, "mcp-demo", "guide.md"), pace: 0 });
    expect(r.isError, r.text).toBe(false);
    expect(hits).toEqual(["login ok"]);
    expect(r.text).not.toContain(PASSWORD);
    expect(filesWithMarker()).toEqual([]);
  });

  it("verify_journey gets it from the binding in every replay", async () => {
    writeTargets({ [site]: { secretFields: [`label=Password=env:${PW_VAR}`] } });
    const r = await call("verify_journey", { id: "login", mutate: true });
    expect(r.text).not.toContain(PASSWORD);
    expect(hits, r.text).toContain("login ok");
    expect(hits).toContain("login ok");
    expect(hits.filter((h) => h === "login wrong")).toEqual([]);
    expect(filesWithMarker()).toEqual([]);
  });

  it("a value in the arguments of any of them is refused by name", async () => {
    for (const [name, args] of [
      ["run_load_test", { journeyId: "login", authorizedOrigin: [site], params: { password: PASSWORD } }],
      ["demo_journey", { id: "login", params: { password: PASSWORD } }],
      ["verify_journey", { id: "login", mutate: true, params: { password: PASSWORD } }],
    ] as const) {
      const r = await call(name, args);
      expect(r.body, name).toMatchObject({ code: "E_SECRET_PARAM_OVER_MCP", params: ["password"] });
      expect(r.text).not.toContain(PASSWORD);
    }
    expect(hits).toEqual([]);
  });

  it("serves exactly ALLOWED_TOOLS: no tool was added", () => {
    expect([...tools().keys()].sort()).toEqual([...ALLOWED_TOOLS].sort());
  });
});

describe("#827 the rest: files at rest, prefix replays, migrate", { timeout: 180_000 }, () => {
  const suite = (journeys: unknown[], extra: Record<string, unknown> = {}): string => {
    const f = join(root, `suite-${Math.random().toString(36).slice(2)}.json`);
    writeFileSync(f, JSON.stringify({ version: 1, name: "routes", targets: [{ name: "app", url: `${site}/`, allow: [site], journeysDir, journeys, ...extra }] }));
    return f;
  };
  /** Every file the runs wrote (the suite files hold the planted value on purpose, so they are left out). */
  const writtenWithMarker = (): string[] => filesWithMarker().filter((f) => !/suite-|campaign-spec-/.test(f));

  it("check: a secret value planted in the suite file is refused by name; it reaches no file the run writes", async () => {
    const out = join(root, "check-planted");
    const r = await cli(["check", "--suite", suite([{ id: "invite", params: { inviteToken: TOKEN } }]), "--out", out, "--json"]);
    expect(JSON.parse(r.out)).toMatchObject({ ok: false, error: { code: "E_CHECK_SUITE" } });
    expect(r.out).toContain("param=inviteToken=env:<VAR>");
    expect(r.out + r.err).not.toContain(TOKEN);
    expect(hits).toEqual([]);
    expect(writtenWithMarker()).toEqual([]);
  });

  it("check: the suite target's secretFields binding (a variable name only) supplies it; the results hold no value", async () => {
    const out = join(root, "check-bound");
    const r = await cli(["check", "--suite", suite(["invite"], { secretFields: [`param=inviteToken=env:${TOKEN_VAR}`] }), "--out", out, "--json"]);
    expect(JSON.parse(r.out), r.out).toMatchObject({ ok: true });
    expect(hits).toEqual(["invite ok site"]);
    expect(r.out + r.err).not.toContain(TOKEN);
    expect(writtenWithMarker()).toEqual([]);
  });

  it("run_check over MCP: a planted value is refused the same way, and a suite file's binding is not read (the operator's targets.json is)", async () => {
    // The output goes under root (a pathRoot), never the CLI default `jevitate-check/` in the cwd (the repo
    // root under vitest), so writtenWithMarker() scans what the MCP run wrote too.
    const planted = await call("run_check", { suite: suite([{ id: "login", params: { password: PASSWORD } }]), out: join(root, "mcp-check-planted") });
    expect(planted.isError).toBe(true);
    expect(planted.text).toContain("E_CHECK_SUITE");
    expect(planted.text).not.toContain(PASSWORD);
    writeTargets({ [site]: { secretFields: [`label=Password=env:${PW_VAR}`] } });
    const bound = await call("run_check", { suite: suite(["login"]), out: join(root, "mcp-check-bound") });
    // The run happened (exit 2: a pass with no done check, decision 3) and wrote under root.
    expect(bound.body).toMatchObject({ exitCode: 2, data: { kind: "jevitate-check", summary: { passed: 1 } } });
    expect(existsSync(join(root, "mcp-check-bound", "check.json"))).toBe(true);
    expect(bound.text).not.toContain(PASSWORD);
    expect(hits).toEqual(["login ok"]);
    expect(writtenWithMarker()).toEqual([]);
  });

  it("campaign: a secret value planted in the spec is refused by name before anything runs", async () => {
    const spec = join(root, "campaign-spec-planted.json");
    writeFileSync(spec, JSON.stringify({ version: 1, discovery: false, jobs: [{ id: "j", journey: "invite", params: { inviteToken: TOKEN }, anchors: [1], strategies: ["adversarial"] }] }));
    const r = await cli(["campaign", "run", spec, "--journeys-dir", journeysDir, "--fake-ai", "--out", join(root, "campaign-planted"), "--json"]);
    expect(JSON.parse(r.out)).toMatchObject({ ok: false, error: { code: "E_CAMPAIGN_SPEC" } });
    expect(r.out + r.err).not.toContain(TOKEN);
    expect(hits).toEqual([]);
    expect(writtenWithMarker()).toEqual([]);
  });

  it("explore --at-step all (a sweep, run as a campaign) with --secret-field: every stop's prefix gets it; no file holds it", async () => {
    const out = join(root, "sweep");
    const r = await cli(["explore", "--from-journey", "invite", "--at-step", "all", "--secret-field", `param=inviteToken=env:${TOKEN_VAR}`, "--journeys-dir", journeysDir, "--strategy", "adversarial", "--fake-ai", "--max-actions", "2", "--out", out, "--json"]);
    expect(JSON.parse(r.out), r.out + r.err).toMatchObject({ ok: true });
    expect(hits[0]).toBe("invite ok site");
    expect(r.out).not.toContain(TOKEN);
    expect(writtenWithMarker()).toEqual([]);
  });

  it("journey migrate --labels --secret-field: the replay types it, and no label or report holds it", async () => {
    const r = await cli(["journey", "migrate", "--labels", "--id", "login", "--secret-field", `label=Password=env:${PW_VAR}`, "--dry-run", "--journeys-dir", journeysDir, "--json"]);
    expect(JSON.parse(r.out), r.out + r.err).toMatchObject({ ok: true });
    expect(hits).toEqual(["login ok"]);
    expect(r.out + r.err).not.toContain(PASSWORD);
    expect(writtenWithMarker()).toEqual([]);
  });
});
