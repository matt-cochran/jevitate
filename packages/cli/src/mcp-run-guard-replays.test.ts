import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// A real browser: the default new PlaywrightBrowserPort() behind `regression run` (test/browser-suites.ts reads this).
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { makeInProcessCliRunner } from "./mcp-cli-runner.js";
import { buildMcpTools } from "./mcp-api.js";
import { buildProgram } from "./program.js";

/** The MCP floor (#789) under what replays a committed regression or captures one. CLI use is the person's. */

const PAGE = (other: string): string => `<!doctype html><title>t</title><main><h1>App</h1>
<button onclick="fetch('/delete',{method:'POST'}).then(()=>{document.getElementById('o').textContent='Gone'})">Delete account</button><p id=o></p>
<button onclick="fetch('${other}/collect',{method:'POST',mode:'no-cors'}).finally(()=>{document.getElementById('o').textContent='Sent'})">Share</button></main>`;

let app: Server;
let other: Server;
let origin: string;
let otherOrigin: string;
let root: string;
let targetsFile: string;
const hits = { app: 0, other: 0 };

const NAV = { step: { kind: "navigate", url: "/", expect: { kind: "visible", target: { role: "heading", name: "App" } } } };
const DELETE = { step: { kind: "click", target: { role: "button", name: "Delete account" }, expect: { kind: "visible", target: { text: "Gone" } } } };
const SHARE = { step: { kind: "click", target: { role: "button", name: "Share" }, expect: { kind: "visible", target: { text: "Sent" } } } };

/** A recording made on a staging instance, as an exploration there would leave it. */
const recording = (steps: readonly unknown[], site = "http://127.0.0.1:9"): unknown => ({ version: "1", site, pages: [{ url: "/", steps }] });

function seedRegression(id: string, steps: readonly unknown[], meta: Record<string, unknown> = {}): void {
  writeFileSync(join(root, `.jevitate/regressions/${id}.recording.json`), JSON.stringify(recording(steps)));
  writeFileSync(join(root, `.jevitate/regressions/${id}.meta.json`), JSON.stringify({ id, ...meta }));
}

const deps = (): never => ({ environmentsFile: join(root, ".jevitate/environments.json"), explore: { targetsConfigPath: targetsFile } }) as never;

async function regressions(args: Record<string, unknown>): Promise<{ isError: boolean; body: Record<string, unknown> }> {
  const tools = buildMcpTools({ journeysDir: join(root, ".jevitate/journeys"), pathRoots: [root], environmentsFile: join(root, ".jevitate/environments.json"), targetsConfigPath: targetsFile, runCli: makeInProcessCliRunner(() => buildProgram(deps())) } as never);
  const res = await tools.find((t) => t.name === "regressions")!.handler(args);
  return { isError: res.isError === true, body: JSON.parse(res.content[0]!.text) as Record<string, unknown> };
}

const setTargets = (byOrigin: Record<string, unknown>): void => writeFileSync(targetsFile, JSON.stringify(byOrigin));

beforeAll(async () => {
  other = createServer((req, res) => {
    if (req.method === "POST") hits.other += 1;
    res.writeHead(200, { "access-control-allow-origin": "*" });
    res.end("ok");
  });
  await new Promise<void>((done) => other.listen(0, "127.0.0.1", done));
  otherOrigin = `http://127.0.0.1:${(other.address() as AddressInfo).port}`;
  app = createServer((req, res) => {
    if (req.method === "POST") hits.app += 1;
    res.writeHead(200, { "content-type": "text/html" });
    res.end(req.method === "POST" ? "ok" : PAGE(otherOrigin));
  });
  await new Promise<void>((done) => app.listen(0, "127.0.0.1", done));
  origin = `http://127.0.0.1:${(app.address() as AddressInfo).port}`;
  root = realpathSync(mkdtempSync(join(tmpdir(), "jev-guard-replays-")));
  targetsFile = join(root, "targets.json");
  mkdirSync(join(root, ".jevitate/regressions"), { recursive: true });
  mkdirSync(join(root, ".jevitate/journeys"), { recursive: true });
  writeFileSync(join(root, ".jevitate/environments.json"), JSON.stringify({ staging: { baseUrl: origin } }));
  seedRegression("delete", [NAV, DELETE]);
  seedRegression("share", [NAV, SHARE]);
  vi.spyOn(process, "cwd").mockReturnValue(root);
});

afterAll(async () => {
  vi.restoreAllMocks();
  app.closeAllConnections();
  other.closeAllConnections();
  await Promise.all([new Promise((done) => app.close(done)), new Promise((done) => other.close(done))]);
  rmSync(root, { recursive: true, force: true });
});

beforeEach(() => {
  hits.app = 0;
  hits.other = 0;
  setTargets({});
  writeFileSync(join(root, ".jevitate/environments.json"), JSON.stringify({ staging: { baseUrl: origin } }));
});

const flagProduction = (): void => writeFileSync(join(root, ".jevitate/environments.json"), JSON.stringify({ prod: { baseUrl: origin, production: true } }));

describe("regressions run over MCP", () => {
  it("refuses a production origin named by baseUrl, before anything is sent", async () => {
    flagProduction();
    const r = await regressions({ action: "run", id: "delete", baseUrl: origin });
    expect(r.body).toMatchObject({ error: "refused", outcome: "refused", code: "E_RUN_REFUSED_PRODUCTION", retryable: false, setting: `targets.json["${origin}"].mcpRun.allowProduction` });
    expect(r.isError).toBe(true);
    expect(hits.app).toBe(0);
  });

  it("refuses a production environment named by env, before anything is sent", async () => {
    flagProduction();
    const r = await regressions({ action: "run", id: "delete", env: "prod" });
    expect(r.body).toMatchObject({ code: "E_RUN_REFUSED_PRODUCTION" });
    expect(hits.app).toBe(0);
  });

  it("refuses a destructive click, and sends nothing", async () => {
    const r = await regressions({ action: "run", id: "delete", baseUrl: origin });
    expect(r.body).toMatchObject({ error: "refused", code: "E_RUN_REFUSED_DESTRUCTIVE", rule: "builtin:destructive", at: 2, setting: `targets.json["${origin}"].mcpRun.allowDestructive` });
    expect(hits.app).toBe(0);
  });

  it("refuses a write off the run's allowlist, and it never leaves the browser", async () => {
    const r = await regressions({ action: "run", id: "share", baseUrl: origin });
    expect(r.body).toMatchObject({ code: "E_RUN_REFUSED_OFF_ALLOWLIST_WRITE", setting: `targets.json["${origin}"].mcpRun.allowOffAllowlistWrites` });
    expect(hits.other).toBe(0);
  });

  it("does not swallow the refusal in a network oracle's replay", async () => {
    seedRegression("delete-net", [NAV, DELETE], { oracle: { kind: "network", check: { kind: "requestMade", method: "POST", pathGlob: "/delete" } } });
    const r = await regressions({ action: "run", id: "delete-net", baseUrl: origin });
    expect(r.body).toMatchObject({ code: "E_RUN_REFUSED_DESTRUCTIVE" });
    expect(hits.app).toBe(0);
  });

  it("does not swallow the refusal in an invariant oracle's replay", async () => {
    seedRegression("delete-inv", [NAV, DELETE], {
      oracle: { kind: "invariant", invariantId: "no-403", invariantSpec: { invariants: [{ id: "no-403", never: { response: { url: "/api/**", status: "403" } } }] }, recordingStepIndex: 1, allowlist: [origin], baseUrl: origin, defectFingerprint: "abc" },
    });
    const r = await regressions({ action: "run", id: "delete-inv", baseUrl: origin, attempts: 3 });
    expect(r.body).toMatchObject({ code: "E_RUN_REFUSED_DESTRUCTIVE" });
    expect(hits.app).toBe(0);
  });

  it("a person lifts each refusal per target, with mcpRun", async () => {
    flagProduction();
    setTargets({ [origin]: { mcpRun: { allowProduction: true, allowDestructive: true } } });
    const r = await regressions({ action: "run", id: "delete", baseUrl: origin });
    expect(r.body).toMatchObject({ exitCode: 0, data: { verdict: "fixed" } });
    expect(hits.app).toBe(1);
  });

  it("lifts an off-allowlist write with mcpRun.allowOffAllowlistWrites", async () => {
    setTargets({ [origin]: { mcpRun: { allowOffAllowlistWrites: [otherOrigin] } } });
    const r = await regressions({ action: "run", id: "share", baseUrl: origin });
    expect(r.body).toMatchObject({ exitCode: 0, data: { verdict: "fixed" } });
    expect(hits.other).toBe(1);
  });

  it("a target's own safety.deny is not lifted by allowDestructive", async () => {
    setTargets({ [origin]: { safety: { deny: ["Share"] }, mcpRun: { allowDestructive: true, allowOffAllowlistWrites: [otherOrigin] } } });
    const r = await regressions({ action: "run", id: "share", baseUrl: origin });
    expect(r.body).toMatchObject({ code: "E_RUN_REFUSED_DESTRUCTIVE", setting: `targets.json["${origin}"].safety.deny` });
    expect(hits.other).toBe(0);
  });
});

describe("regressions capture over MCP", () => {
  const seedFrom = (name: string, steps: readonly unknown[]): string => {
    const file = join(root, `${name}.recording.json`);
    writeFileSync(file, JSON.stringify(recording(steps, origin)));
    return file;
  };

  it("refuses a recording on a production origin, before anything is sent", async () => {
    flagProduction();
    const r = await regressions({ action: "capture", id: "cap-prod", from: seedFrom("from-prod", [NAV, DELETE]) });
    expect(r.body).toMatchObject({ code: "E_RUN_REFUSED_PRODUCTION" });
    expect(hits.app).toBe(0);
  });

  it("refuses a destructive click on the way to reproducing a failure, and commits nothing", async () => {
    const r = await regressions({ action: "capture", id: "cap-del", from: seedFrom("from-del", [NAV, DELETE]) });
    expect(r.body).toMatchObject({ code: "E_RUN_REFUSED_DESTRUCTIVE", at: 2 });
    expect(hits.app).toBe(0);
  });
});

describe("verify_fix over MCP", () => {
  const FP = "1ad9521b771f3bd4";
  const RESULT = "explore-2026-11-05T00-00-00-000Z";
  // A markup-injection finding opens no browser, so a refusal is the only thing that could stop it reading `inconclusive`.
  const seedFinding = (): void => {
    const dir = join(root, ".jevitate/results");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, `${RESULT}.result.json`),
      JSON.stringify({ missionOutcome: "defects-found", exitCode: 1, result: { target: { seedUrl: `${origin}/`, allowlist: [origin] }, recording: { version: "1", site: origin, pages: [] }, defects: [{ fingerprint: FP, kind: "markup-injection", repro: { recordingStepIndex: 0 } }] } }),
    );
  };
  const verifyFix = async (args: Record<string, unknown> = {}): Promise<{ isError: boolean; body: Record<string, unknown> }> => {
    seedFinding();
    const tools = buildMcpTools({ journeysDir: join(root, ".jevitate/journeys"), recordingsDir: join(root, ".jevitate/results"), pathRoots: [root], environmentsFile: join(root, ".jevitate/environments.json"), targetsConfigPath: targetsFile } as never);
    const res = await tools.find((t) => t.name === "verify_fix")!.handler({ id: RESULT, fingerprint: FP, ...args });
    return { isError: res.isError === true, body: JSON.parse(res.content[0]!.text) as Record<string, unknown> };
  };

  it("refuses a finding on a production origin, in the floor's shape", async () => {
    flagProduction();
    const r = await verifyFix();
    expect(r.isError).toBe(true);
    expect(r.body).toMatchObject({ error: "refused", outcome: "refused", code: "E_RUN_REFUSED_PRODUCTION", retryable: false, setting: `targets.json["${origin}"].mcpRun.allowProduction` });
  });

  it("refuses a production environment's allow list, whatever the seed's origin", async () => {
    writeFileSync(join(root, ".jevitate/environments.json"), JSON.stringify({ prod: { baseUrl: otherOrigin, allow: [origin], production: true } }));
    expect((await verifyFix({ env: "prod" })).body).toMatchObject({ code: "E_RUN_REFUSED_PRODUCTION" });
  });

  it("mcpRun.allowProduction lifts it", async () => {
    flagProduction();
    setTargets({ [origin]: { mcpRun: { allowProduction: true } } });
    expect((await verifyFix()).body).toMatchObject({ status: "inconclusive" });
  });

  it("a non-production origin replays as before", async () => {
    expect((await verifyFix()).body).toMatchObject({ status: "inconclusive" });
  });
});

describe("regression run on the CLI", () => {
  it("is unchanged: the person at the terminal is the guard", async () => {
    flagProduction();
    const out: string[] = [];
    const program = buildProgram(deps());
    program.exitOverride();
    program.configureOutput({ writeOut: (s) => void out.push(s), writeErr: () => undefined });
    for (const c of program.commands) c.configureOutput({ writeOut: (s) => void out.push(s), writeErr: () => undefined });
    const saved = process.exitCode;
    try {
      await program.parseAsync(["regression", "run", "delete", "--base-url", origin, "--json"], { from: "user" });
    } finally {
      process.exitCode = saved;
    }
    expect(hits.app).toBe(1);
  });
});
