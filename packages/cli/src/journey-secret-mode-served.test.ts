import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ProfileManager } from "@jevitate/daemon";
import { ALLOWED_TOOLS } from "@jevitate/mcp-facade";
import { FsJourneyStore, type Journey } from "@jevitate/journey";
import { PlaywrightBrowserPort, type BrowserPort } from "@jevitate/playwright";
import type { CliDeps } from "./cli-shared.js";
import { registerHoldHooks, resumeHold } from "./journey-hold.js";
import { journeyReviewHash } from "./journey-review.js";
import { createCheckpointKey } from "./journey-verify-checkpoint.js";
import { buildMcpTools, type McpApiDeps, type McpTool } from "./mcp-api.js";
import { makeInProcessCliRunner } from "./mcp-cli-runner.js";
import { buildProgram } from "./program.js";
import { SECRET_PARAM_OVER_MCP } from "./secret-params.js";
import { useSkippingTime } from "../../explore/src/testkit.js";

/**
 * 0.30.0 §5.3 (#798, #809), served: the real MCP tools, the real in-process CLI and real Chromium. In
 * automation mode a Journey with a recorded handback step holds over MCP (`outcome: "held"`), and a
 * person resuming it at a terminal (scripted here) completes it to `ok`; with the operator's
 * targets.json binding the field on the run's origin, vault-autofill types the value, which reaches no
 * result, evidence, hold, checkpoint or log; bound on another origin, it is refused. A value passed in
 * the arguments is refused by name in both modes, as in 0.29.0.
 */

useSkippingTime({ per: "all", pageClock: false });

/** Every module that asks for the home gets the temp one: nothing is written to the real ~/.jevitate. */
const homeOverride = vi.hoisted(() => ({ dir: undefined as string | undefined }));
vi.mock("node:os", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:os")>();
  const homedir = (): string => homeOverride.dir ?? real.homedir();
  return { ...real, homedir, default: { ...real, homedir } };
});

const SECRET = "MARKER_S-pw-7Qz1x";
const VAR = "JEV_SECRET_MODE_SERVED";

let server: Server;
/** Nothing declares it, nothing binds it. */
let plain: string;
/** The same server under the origin the operator's targets.json binds the password on. */
let bound: string;
let root: string;
let journeysDir: string;
let logs: string;
let holdsDir: string;
let inboxDir: string;
let keyFile: string;
const launches = { count: 0 };
const logins: string[] = [];

function countingPort(): BrowserPort {
  launches.count += 1;
  return new PlaywrightBrowserPort();
}

function serve(): Promise<Server> {
  const s = createServer((req, res) => {
    const path = (req.url ?? "/").split("?")[0] ?? "/";
    if (req.method === "POST" && path === "/api/login") {
      let body = "";
      req.on("data", (c: Buffer) => (body += c.toString("utf8")));
      req.on("end", () => {
        const ok = (JSON.parse(body || "{}") as { password?: string }).password === SECRET;
        logins.push(ok ? "ok" : "wrong");
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

/** A recorded handback at the password field (a person, or the operator's vault, fills it), then sign in. */
function journey(id: string, opts: { readonly secretParam?: boolean } = {}): Journey {
  return {
    metadata: {
      id,
      name: id,
      promoted: false,
      params: opts.secretParam === true ? ["password"] : [],
      ...(opts.secretParam === true ? { parameters: [{ name: "password", secret: true }] } : {}),
      createdAtIso: "2026-11-08T00:00:00.000Z",
    },
    recording: {
      version: "1",
      site: plain,
      pages: [
        {
          url: "/login",
          steps: [
            { step: { kind: "navigate", url: "/login", expect: { kind: "visible", target: { role: "heading", name: "Sign in" } } } },
            opts.secretParam === true
              ? { step: { kind: "fill", target: { label: "Password" }, value: { var: "password" }, expect: { kind: "visible", target: { role: "button", name: "Sign in" } } } }
              : { step: { kind: "handback", prompt: "Enter your password", resume: { kind: "visible", target: { label: "Password" } } } },
            { step: { kind: "click", target: { role: "button", name: "Sign in" }, expect: { kind: "textIncludes", target: { testId: "status" }, text: "Signed in" } } },
          ],
        },
      ],
    },
  } as unknown as Journey;
}

/** Approved as a person at a terminal would (the content as stored). */
async function putApproved(j: Journey): Promise<void> {
  const store = new FsJourneyStore(journeysDir);
  await store.put(j);
  const stored = (await store.get(j.metadata.id))!;
  await store.put({ ...stored, metadata: { ...stored.metadata, promoted: true, approval: { contentHash: journeyReviewHash(stored), at: "2026-11-08T00:00:00.000Z", provenance: { channel: "tty", agentSignals: [] } } } } as Journey);
}

function tools(targetsFile: string): Map<string, McpTool> {
  const cliDeps = {
    profiles: new ProfileManager(join(root, "profiles")),
    journeysDir,
    inboxDir,
    dbPath: join(root, "site.sqlite"),
    environmentsFile: join(root, "environments.json"),
    logs: { logsRoot: logs },
    explore: { browserPortFactory: countingPort, targetsConfigPath: targetsFile, env: { [VAR]: SECRET } },
  } as unknown as CliDeps;
  const deps: McpApiDeps = {
    journeysDir,
    inboxDir,
    pathRoots: [root],
    runRecordLogsRoot: logs,
    environmentsFile: join(root, "environments.json"),
    targetsConfigPath: targetsFile,
    sitePolicyDbPath: join(root, "site.sqlite"),
    browserPortFactory: countingPort,
    secretEnv: { [VAR]: SECRET },
    runCli: makeInProcessCliRunner(() => buildProgram(cliDeps)),
  };
  return new Map(buildMcpTools(deps).map((t) => [t.name, t]));
}

function targetsFile(name: string, body: Record<string, unknown>): string {
  const f = join(root, `${name}.targets.json`);
  writeFileSync(f, JSON.stringify(body));
  return f;
}

async function call(targets: string, name: string, args: Record<string, unknown>): Promise<{ isError: boolean; text: string; body: Record<string, unknown> }> {
  const r = await tools(targets).get(name)!.handler(args);
  const text = r.content[0]!.text;
  return { isError: r.isError === true, text, body: JSON.parse(text) as Record<string, unknown> };
}

function allFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? allFiles(p) : [p];
  });
}

/** `grep -c MARKER_S` over every file the runs left: results, evidence, holds, checkpoints, logs, the inbox. */
const filesWithSecret = (): string[] => allFiles(root).filter((f) => readFileSync(f).includes("MARKER_S"));

beforeAll(async () => {
  server = await serve();
  const port = (server.address() as AddressInfo).port;
  plain = `http://127.0.0.1:${port}`;
  bound = `http://localhost:${port}`;
  root = mkdtempSync(join(tmpdir(), "jev-secret-mode-served-"));
  homeOverride.dir = join(root, "home");
  journeysDir = join(root, "journeys");
  logs = join(root, "logs");
  holdsDir = join(root, "holds");
  inboxDir = join(root, "inbox");
  keyFile = join(root, "home", ".jevitate", "verify-checkpoint.key");
  mkdirSync(journeysDir, { recursive: true });
  createCheckpointKey(keyFile);
  writeFileSync(join(root, "environments.json"), JSON.stringify({}));
  // The holds this process makes, in the temp dir (registerRunSurfaceHooks keeps a registration it finds).
  registerHoldHooks({ holdsDir, keyFile, inboxDir });
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
  launches.count = 0;
  logins.length = 0;
});

describe("0.30.0 §5.3 secrets in automation mode over MCP (real Chromium)", { timeout: 180_000 }, () => {
  it("acceptance 1: a recorded handback on a trust 'unknown' target holds over MCP, and a person's headed completion resumes it to ok", async () => {
    await putApproved(journey("login"));
    const none = targetsFile("none", {});
    const held = await call(none, "run_journey", { id: "login" });
    expect(held.body, held.text).toMatchObject({ outcome: "held", code: "E_RUN_HELD", kind: "handback", step: 2, retryable: false, exitCode: 2 });
    const holdId = held.body["holdId"] as string;
    expect(holdId).toMatch(/^hold-[0-9a-f]{16}$/);
    // The run stopped at the handback: the sign-in was never sent.
    expect(logins).toEqual([]);
    expect(readdirSync(holdsDir).sort()).toEqual([`${holdId}.checkpoint.json`, `${holdId}.json`]);
    expect(JSON.parse(readFileSync(join(holdsDir, `${holdId}.json`), "utf8")).body).toMatchObject({ kind: "handback", target: { origin: plain, trust: "unknown" }, pending: { step: 2 } });

    // An agent cannot complete it: a resume without a person at a terminal is refused, and nothing opens.
    const before = launches.count;
    await expect(resumeHold({ id: holdId, journeysDir, params: {}, holdsDir, keyFile, inboxDir, browserPortFactory: countingPort, approval: { stdinIsTTY: () => false, stdoutIsTTY: () => false } })).rejects.toMatchObject({ code: "E_HUMAN_APPROVAL_REQUIRED" });
    expect(launches.count).toBe(before);

    // `jevitate inbox resume` at a terminal: the person types the password in the browser it opens (scripted).
    const typedBy: string[] = [];
    const resumed = await resumeHold({
      id: holdId,
      journeysDir,
      params: {},
      holdsDir,
      keyFile,
      inboxDir,
      browserPortFactory: countingPort,
      approval: { stdinIsTTY: () => true, stdoutIsTTY: () => true },
      presentHandback: async (prompt, page) => {
        typedBy.push(prompt);
        await page.getByLabel("Password").fill(SECRET);
      },
    });
    expect(resumed.outcome).toBe("resumed");
    if (resumed.outcome !== "resumed") return;
    expect(resumed.fromStep).toBe(2);
    expect(resumed.result.outcome, JSON.stringify(resumed.result)).toBe("ok");
    expect(typedBy).toEqual(["Enter your password"]);
    expect(logins).toEqual(["ok"]);
    // One completion: the hold is consumed.
    expect(existsSync(join(holdsDir, `${holdId}.json`))).toBe(false);
    expect(JSON.stringify(resumed.result)).not.toContain("MARKER_S");
    expect(filesWithSecret()).toEqual([]);
  });

  it("verify_journey on the same Journey holds instead of refusing: the tool's answer is the hold", async () => {
    await putApproved(journey("login-v"));
    const r = await call(targetsFile("none", {}), "verify_journey", { id: "login-v", mutate: true });
    expect(r.body, r.text).toMatchObject({ outcome: "held", code: "E_RUN_HELD", kind: "handback", exitCode: 2 });
    expect(logins).toEqual([]);
  });

  it("acceptance 2: targets.json binds the field on the run's origin: vault-autofill types it; MARKER_S is in no result, evidence, hold, checkpoint or log", async () => {
    await putApproved(journey("login-vault"));
    const t = targetsFile("bound", { [bound]: { secretFields: [`label=Password=env:${VAR}`] } });
    const holdsBefore = readdirSync(holdsDir).length;
    const r = await call(t, "run_journey", { id: "login-vault", baseUrl: bound });
    expect(r.body["outcome"], r.text).toBe("ok");
    // The server checked the value: the right one was typed, by code, on the bound origin.
    expect(logins).toEqual(["ok"]);
    expect(r.text).not.toContain("MARKER_S");
    expect(readdirSync(holdsDir)).toHaveLength(holdsBefore);
    expect(allFiles(logs).length).toBeGreaterThan(0);
    expect(filesWithSecret()).toEqual([]);
  });

  it("acceptance 2: bound to another origin only, it refuses E_SECRET_ORIGIN_REFUSED before any browser", async () => {
    await putApproved(journey("login-elsewhere"));
    const t = targetsFile("bound", { [bound]: { secretFields: [`label=Password=env:${VAR}`] } });
    const r = await call(t, "run_journey", { id: "login-elsewhere", baseUrl: plain });
    expect(r.isError).toBe(true);
    expect(r.body).toMatchObject({ error: "refused", code: "E_SECRET_ORIGIN_REFUSED", mode: "automation", retryable: false });
    expect(launches.count).toBe(0);
    expect(logins).toEqual([]);
    expect(r.text).not.toContain("MARKER_S");
  });

  it("a secret parameter nobody supplied holds as kind 'secret' over MCP (automation mode), never a value asked of the model", async () => {
    await putApproved(journey("login-param", { secretParam: true }));
    const r = await call(targetsFile("none", {}), "run_journey", { id: "login-param" });
    expect(r.body, r.text).toMatchObject({ outcome: "held", kind: "secret", step: 2, exitCode: 2 });
    expect(logins).toEqual([]);
  });

  it("acceptance 4: run_journey with {password: 'x'} in the arguments is still E_SECRET_PARAM_OVER_MCP, in automation and in test mode", async () => {
    await putApproved(journey("login-param", { secretParam: true }));
    for (const t of [targetsFile("none", {}), targetsFile("test", { [plain]: { trust: "test" } })]) {
      const r = await call(t, "run_journey", { id: "login-param", params: { password: "x" } });
      expect(r.body).toMatchObject({ error: "invalid_args", code: SECRET_PARAM_OVER_MCP, params: ["password"] });
    }
    expect(launches.count).toBe(0);
  });

  it("§5.3 test mode: a test target's bound secretField supplies the secret over MCP, even for an MCP promotion; MARKER_S is in no file", async () => {
    const t = targetsFile("test-bound", { [bound]: { trust: "test", secretFields: [`label=Password=env:${VAR}`] } });
    await new FsJourneyStore(journeysDir).put(journey("login-test", { secretParam: true }));
    // An MCP promotion authorises test-mode runs (owner decision 5).
    expect((await call(t, "promote_journey", { id: "login-test" })).isError).toBe(false);
    const holdsBefore = readdirSync(holdsDir).length;
    const r = await call(t, "run_journey", { id: "login-test", baseUrl: bound });
    expect(r.body["outcome"], r.text).toBe("ok");
    // The server checked it: the right value was typed, by code, on the test target.
    expect(logins).toEqual(["ok"]);
    expect(r.text).not.toContain("MARKER_S");
    expect(readdirSync(holdsDir)).toHaveLength(holdsBefore);
    expect(allFiles(logs).length).toBeGreaterThan(0);
    expect(filesWithSecret()).toEqual([]);
  });

  it("§5.3 test mode: with no binding the run is refused E_HUMAN_STEP_IN_TEST_MODE before any browser, never held; a value in the arguments is still E_SECRET_PARAM_OVER_MCP", async () => {
    await putApproved(journey("login-test-none", { secretParam: true }));
    const t = targetsFile("test-none", { [bound]: { trust: "test" } });
    const holdsBefore = readdirSync(holdsDir).length;
    const r = await call(t, "run_journey", { id: "login-test-none", baseUrl: bound });
    expect(r.body, r.text).toMatchObject({ error: "refused", outcome: "refused", code: "E_HUMAN_STEP_IN_TEST_MODE", mode: "test", trust: "test", retryable: false, exitCode: 2 });
    expect(launches.count).toBe(0);
    expect(readdirSync(holdsDir)).toHaveLength(holdsBefore);
    const tb = targetsFile("test-bound-2", { [bound]: { trust: "test", secretFields: [`label=Password=env:${VAR}`] } });
    const carried = await call(tb, "run_journey", { id: "login-test-none", baseUrl: bound, params: { password: "typed-by-model" } });
    expect(carried.body).toMatchObject({ error: "invalid_args", code: SECRET_PARAM_OVER_MCP, params: ["password"] });
    expect(launches.count).toBe(0);
    expect(logins).toEqual([]);
  });

  it("serves exactly ALLOWED_TOOLS: no tool was added", () => {
    expect([...tools(targetsFile("none", {})).keys()].sort()).toEqual([...ALLOWED_TOOLS].sort());
  });
});
