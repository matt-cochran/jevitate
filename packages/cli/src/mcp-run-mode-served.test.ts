import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { RunEvidenceSchema } from "@jevitate/adjudicator";
import { ProfileManager } from "@jevitate/daemon";
import { ALLOWED_TOOLS } from "@jevitate/mcp-facade";
import { FsJourneyStore, type Journey } from "@jevitate/journey";
import { PlaywrightBrowserPort, type BrowserPort } from "@jevitate/playwright";
import { buildMcpTools, type McpApiDeps, type McpTool } from "./mcp-api.js";
import { makeInProcessCliRunner } from "./mcp-cli-runner.js";
import { buildProgram } from "./program.js";
import { journeyReviewHash } from "./journey-review.js";
import type { CliDeps } from "./cli-shared.js";
import { EVIDENCE_FILE } from "./journey-run-evidence.js";
import { E_APPROVAL_CHANNEL_FOR_MODE } from "./journey-run-mode-gate.js";
import { SECRET_PARAM_OVER_MCP } from "./secret-params.js";
import { useSkippingTime } from "../../explore/src/testkit.js";

/**
 * 0.30.0 Contract 4 (§5), served: the real MCP tools, the real in-process CLI and real Chromium. The
 * run mode comes from the target's declared trust and nothing else; an origin nobody declared is
 * automation mode, which runs only a Journey a person approved (owner decision 5), and there the
 * operator's targets.json may supply a secret to the browser (owner decision 6).
 */

useSkippingTime({ per: "all", pageClock: false });

const MARKER = "MARKER_pw_7Qz1x";
const VAR = "JEV_RUN_MODE_SECRET";

let server: Server;
/** The origin the Journeys were recorded on. */
let recorded: string;
/** The same server under another origin nobody declares (`localhost` vs `127.0.0.1`). */
let undeclared: string;
let root: string;
let journeysDir: string;
let logs: string;
const launches = { count: 0 };

function countingPort(): BrowserPort {
  launches.count += 1;
  return new PlaywrightBrowserPort();
}

function serve(): Promise<Server> {
  const s = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(
      `<!doctype html><html><body><label>Password <input id=pw data-testid=pw type=password></label><input data-testid=who aria-label=Who>` +
        `<button onclick="document.querySelector('[data-testid=status]').textContent='len='+document.getElementById('pw').value.length+' who='+document.querySelector('[data-testid=who]').value">Sign in</button><p data-testid=status></p></body></html>`,
    );
  });
  return new Promise((r) => s.listen(0, "127.0.0.1", () => r(s)));
}

/** A Journey that fills `who`, and with `secret` also the password (a secret parameter), then signs in. */
function journey(id: string, secret: boolean): Journey {
  return {
    metadata: {
      id,
      name: id,
      promoted: false,
      params: secret ? ["password1", "who"] : ["who"],
      parameters: secret ? [{ name: "password1", secret: true }, { name: "who" }] : [{ name: "who" }],
      createdAtIso: "2026-11-08T00:00:00.000Z",
    },
    recording: {
      version: "1",
      site: recorded,
      pages: [
        {
          url: "/",
          steps: [
            { step: { kind: "navigate", url: "/", expect: { kind: "visible", target: { testId: "pw" } } } },
            ...(secret ? [{ step: { kind: "fill", target: { label: "Password" }, value: { var: "password1" }, expect: { kind: "visible", target: { testId: "who" } } } }] : []),
            { step: { kind: "fill", target: { testId: "who" }, value: { var: "who" }, expect: { kind: "visible", target: { testId: "pw" } } } },
            { step: { kind: "click", target: { role: "button", name: "Sign in" }, expect: { kind: "textIncludes", target: { testId: "status" }, text: secret ? `len=${MARKER.length}` : "who=ann" } } },
          ],
        },
      ],
    },
  } as unknown as Journey;
}

/** Approved as a person at a terminal would (the content as stored). */
async function approveAtTty(id: string): Promise<void> {
  const store = new FsJourneyStore(journeysDir);
  const j = (await store.get(id))!;
  await store.put({ ...j, metadata: { ...j.metadata, promoted: true, approval: { contentHash: journeyReviewHash(j), at: "2026-11-08T00:00:00.000Z", provenance: { channel: "tty", agentSignals: [] } } } } as Journey);
}

function tools(over: Partial<McpApiDeps> = {}): Map<string, McpTool> {
  const cliDeps = {
    profiles: new ProfileManager(join(root, "profiles")),
    journeysDir,
    dbPath: join(root, "site.sqlite"),
    environmentsFile: join(root, "environments.json"),
    logs: { logsRoot: logs },
    explore: { browserPortFactory: countingPort, targetsConfigPath: join(root, "targets.json") },
  } as unknown as CliDeps;
  const deps: McpApiDeps = {
    journeysDir,
    pathRoots: [root],
    runRecordLogsRoot: logs,
    environmentsFile: join(root, "environments.json"),
    targetsConfigPath: join(root, "targets.json"),
    sitePolicyDbPath: join(root, "site.sqlite"),
    browserPortFactory: countingPort,
    secretEnv: { [VAR]: MARKER },
    runCli: makeInProcessCliRunner(() => buildProgram(cliDeps)),
    ...over,
  };
  return new Map(buildMcpTools(deps).map((t) => [t.name, t]));
}

async function call(name: string, args: Record<string, unknown>): Promise<{ isError: boolean; text: string; body: Record<string, unknown> }> {
  const r = await tools().get(name)!.handler(args);
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

const evidenceFiles = (): string[] => allFiles(logs).filter((f) => f.endsWith(`/${EVIDENCE_FILE}`));

beforeAll(async () => {
  server = await serve();
  const port = (server.address() as AddressInfo).port;
  recorded = `http://127.0.0.1:${port}`;
  undeclared = `http://localhost:${port}`;
  root = mkdtempSync(join(tmpdir(), "jev-run-mode-served-"));
  journeysDir = join(root, "journeys");
  logs = join(root, "logs");
  mkdirSync(journeysDir, { recursive: true });
  writeFileSync(join(root, "environments.json"), JSON.stringify({}));
  // The operator's file binds the password on the undeclared origin only (a person wrote it; no tool can).
  writeFileSync(join(root, "targets.json"), JSON.stringify({ [undeclared]: { secretFields: [`label=Password=env:${VAR}`] } }));
});

afterAll(async () => {
  vi.unstubAllEnvs();
  server.closeAllConnections();
  await new Promise<void>((r) => server.close(() => r()));
  rmSync(root, { recursive: true, force: true });
});

beforeEach(() => {
  vi.stubEnv("JEVITATE_RUN_RECORD", "");
  rmSync(logs, { recursive: true, force: true });
  launches.count = 0;
});

describe("0.30.0 run modes over MCP (real Chromium)", { timeout: 180_000 }, () => {
  it("promote_journey over MCP, then run_journey on an undeclared origin: E_APPROVAL_CHANNEL_FOR_MODE, no browser", async () => {
    await new FsJourneyStore(journeysDir).put(journey("save", false));
    const promoted = await call("promote_journey", { id: "save" });
    expect(promoted.isError, promoted.text).toBe(false);
    expect((await new FsJourneyStore(journeysDir).get("save"))?.metadata.approval?.provenance?.channel).toBe("mcp");

    const r = await call("run_journey", { id: "save", baseUrl: undeclared, params: { who: "ann" } });
    expect(r.isError).toBe(true);
    expect(r.body).toMatchObject({ error: "refused", outcome: "refused", code: E_APPROVAL_CHANNEL_FOR_MODE, mode: "automation", trust: "unknown", retryable: false, exitCode: 2 });
    expect(launches.count).toBe(0);
    // Whatever the arguments: the recorded origin, undeclared too, is automation mode as well.
    const plain = await call("run_journey", { id: "save", params: { who: "ann" } });
    expect(plain.body).toMatchObject({ code: E_APPROVAL_CHANNEL_FOR_MODE });
    expect(launches.count).toBe(0);
    // The refused run's evidence still says what mode it was refused in.
    for (const f of evidenceFiles()) expect(RunEvidenceSchema.parse(JSON.parse(readFileSync(f, "utf8"))).run).toMatchObject({ mode: "automation", target: { trust: "unknown" } });
  });

  it("the same Journey approved at a terminal (tty) runs on that origin, and evidence.json says run.mode automation", async () => {
    await new FsJourneyStore(journeysDir).put(journey("save", false));
    await approveAtTty("save");
    const r = await call("run_journey", { id: "save", baseUrl: undeclared, params: { who: "ann" } });
    expect(r.body["outcome"], r.text).toBe("ok");
    expect(launches.count).toBe(1);
    const files = evidenceFiles();
    expect(files).toHaveLength(1);
    const evidence = RunEvidenceSchema.parse(JSON.parse(readFileSync(files[0]!, "utf8")));
    expect(evidence.run).toMatchObject({ channel: "mcp", mode: "automation", target: { origin: undeclared, trust: "unknown" } });
  });

  it("a secret-bound Journey, approved at a terminal, takes its secret from targets.json: in the browser, never in the result or the evidence", async () => {
    await new FsJourneyStore(journeysDir).put(journey("login", true));
    await approveAtTty("login");
    const r = await call("run_journey", { id: "login", baseUrl: undeclared, params: { who: "ann" } });
    // The page saw a password of the marker's length: the right value was typed.
    expect(r.body["outcome"], r.text).toBe("ok");
    expect(r.text).not.toContain(MARKER);
    const files = evidenceFiles();
    expect(files.length).toBeGreaterThan(0);
    for (const f of files) {
      const text = readFileSync(f, "utf8");
      expect(text).not.toContain(MARKER);
      expect(RunEvidenceSchema.parse(JSON.parse(text)).run).toMatchObject({ mode: "automation", secretParamNames: ["password1"] });
    }
    expect(allFiles(root).filter((f) => readFileSync(f).includes(MARKER))).toEqual([]);
  });

  it("bound in targets.json to another origin only, it is refused E_SECRET_ORIGIN_REFUSED, before any browser (§5.3)", async () => {
    await new FsJourneyStore(journeysDir).put(journey("login", true));
    await approveAtTty("login");
    const r = await call("run_journey", { id: "login", baseUrl: recorded, params: { who: "ann" } });
    expect(r.body).toMatchObject({ error: "refused", code: "E_SECRET_ORIGIN_REFUSED", mode: "automation", retryable: false });
    expect(r.text).not.toContain(MARKER);
    expect(launches.count).toBe(0);
  });

  it("a secret value in the arguments is refused by name, even where targets.json binds it", async () => {
    await new FsJourneyStore(journeysDir).put(journey("login", true));
    await approveAtTty("login");
    const r = await call("run_journey", { id: "login", baseUrl: undeclared, params: { who: "ann", password1: "typed-by-model" } });
    expect(r.body).toMatchObject({ code: SECRET_PARAM_OVER_MCP, params: ["password1"] });
    expect(launches.count).toBe(0);
  });

  it("an agent's approval never reads targets.json: the secret-bound Journey promoted over MCP is refused E_SECRET_PARAM_OVER_MCP", async () => {
    await new FsJourneyStore(journeysDir).put(journey("login-agent", true));
    expect((await call("promote_journey", { id: "login-agent" })).isError).toBe(false);
    const r = await call("run_journey", { id: "login-agent", baseUrl: undeclared, params: { who: "ann" } });
    expect(r.body).toMatchObject({ code: SECRET_PARAM_OVER_MCP, params: ["password1"] });
    expect(r.text).not.toContain(MARKER);
    expect(launches.count).toBe(0);
  });

  it("serves exactly ALLOWED_TOOLS: no tool was added", () => {
    expect([...tools().keys()].sort()).toEqual([...ALLOWED_TOOLS].sort());
  });
});
