import { createServer, type IncomingMessage, type Server } from "node:http";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ProfileManager } from "@jevitate/daemon";
import { FakeGenerationGateway, type Answer, type JudgmentPort, type JudgmentState } from "@jevitate/ai-core";
import { buildProgram } from "./program.js";
import { runVerifyFix } from "./verify-fix-api.js";

/**
 * Mission fixtures end to end (#140/#144), REAL Chromium against a served app with a seed API:
 *
 *  - setup POSTs /api/items (authenticated with the bearer the SPA keeps in localStorage, read from
 *    --storage-state) and binds the created id; the goal, start URL and --success use `${setup.itemId}`;
 *  - restore DELETEs the item; the result and Recording carry the fixture identity;
 *  - verify-fix re-runs restore+setup around EVERY replay, and the replay navigates to the NEW item;
 *  - a failing setup ends the run `inconclusive` (a configuration error) without opening a browser;
 *  - secret canaries (the bearer, a secret output, a --secret echoed by a hook) appear in no artifact,
 *    no stdout and no model payload.
 */

const TOKEN = `tok-${randomUUID()}`;
const PASSWORD = `pw-${randomUUID()}`;
const HOOK_SECRET = `hook-${randomUUID()}`;
const CANARIES = [TOKEN, PASSWORD, HOOK_SECRET];

const items = new Map<string, string>();
const log: string[] = [];
let failSeed = false;
let server: Server;
let origin: string;

function authorized(req: IncomingMessage): boolean {
  return req.headers.authorization === `Bearer ${TOKEN}`;
}

beforeAll(async () => {
  let n = 0;
  server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    const itemMatch = /^\/items\/([^/]+)$/.exec(url.pathname);
    const apiMatch = /^\/api\/items\/([^/]+)$/.exec(url.pathname);
    if (req.method === "POST" && url.pathname === "/api/items") {
      if (!authorized(req) || failSeed) {
        log.push(`POST ${failSeed ? 500 : 401}`);
        res.writeHead(failSeed ? 500 : 401).end();
        return;
      }
      const id = `item-${++n}-${randomUUID().slice(0, 8)}`;
      items.set(id, `Fixture item ${id}`);
      log.push(`POST ${id}`);
      res.writeHead(201, { "content-type": "application/json" }).end(JSON.stringify({ id, password: PASSWORD }));
      return;
    }
    if (req.method === "DELETE" && apiMatch !== null) {
      const id = apiMatch[1] as string;
      const existed = authorized(req) && items.delete(id);
      log.push(`DELETE ${id} ${existed ? 204 : 404}`);
      res.writeHead(existed ? 204 : 404).end();
      return;
    }
    if (req.method === "GET" && itemMatch !== null) {
      const id = itemMatch[1] as string;
      const title = items.get(id);
      log.push(`GET ${id} ${title === undefined ? 404 : 200}`);
      res.writeHead(title === undefined ? 404 : 200, { "content-type": "text/html; charset=utf-8" });
      res.end(`<!doctype html><html><body><h1>${title ?? "Not found"}</h1><button type="button">Archive</button></body></html>`);
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  if (addr === null || typeof addr === "string") throw new Error("server has no TCP address");
  origin = `http://127.0.0.1:${addr.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
});

/** Proposes `done` and captures every payload the model would see. */
class DoneJudge implements JudgmentPort {
  readonly seen: string[] = [];
  async systemOne(state: JudgmentState): Promise<Record<string, Answer>> {
    this.seen.push(JSON.stringify(state));
    return { action: { kind: "choice", value: "done", confidence: 0.9 } };
  }
}

async function allFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...(await allFiles(p)));
    else out.push(await readFile(p, "utf8"));
  }
  return out;
}

async function explore(args: string[], judge: DoneJudge): Promise<{ data: Record<string, unknown>; raw: string; exitCode: number | undefined }> {
  const lines: string[] = [];
  const program = buildProgram({
    profiles: new ProfileManager("/unused"),
    explore: { judge, gen: new FakeGenerationGateway({}) },
  });
  program.configureOutput({ writeOut: (s) => lines.push(s), writeErr: (s) => lines.push(s) });
  program.exitOverride();
  const before = process.exitCode;
  await program.parseAsync(["explore", ...args], { from: "user" });
  const exitCode = typeof process.exitCode === "number" ? process.exitCode : undefined;
  process.exitCode = before;
  const raw = lines.join("");
  const parsed = JSON.parse(raw) as { ok: boolean; data: Record<string, unknown>; error?: unknown };
  expect(parsed.ok, raw).toBe(true);
  return { data: parsed.data, raw, exitCode };
}

describe("mission fixtures — setup, bound outputs, restore, verify-fix replays (served, real browser)", () => {
  it(
    "binds the created item into the run, restores it, re-runs setup around every verify-fix replay, and leaks no secret",
    async () => {
      const dir = await mkdtemp(join(tmpdir(), "jev-fixtures-served-"));
      const outDir = join(dir, "out");
      try {
        const state = join(dir, "state.json");
        await writeFile(state, JSON.stringify({ cookies: [], origins: [{ origin, localStorage: [{ name: "token", value: TOKEN }] }] }));
        const fixtures = join(dir, "fixtures.json");
        const auth = { from: "localStorage", key: "token" };
        await writeFile(
          fixtures,
          JSON.stringify({
            name: "one item",
            setup: [{ name: "create-item", method: "POST", url: "/api/items", json: { title: "x" }, auth, outputs: { itemId: "$.id", password: "$.password" }, secretOutputs: ["password"] }],
            restore: [{ name: "delete-item", method: "DELETE", url: "/api/items/${setup.itemId}", auth }],
          }),
        );
        const judge = new DoneJudge();
        log.length = 0;
        const { data, raw, exitCode } = await explore(
          [
            "--url", `${origin}/items/\${setup.itemId}`,
            "--goal", "confirm item ${setup.itemId} is shown",
            "--success", "textIncludes:css=h1|${setup.itemId}",
            "--allow", origin,
            "--storage-state", state,
            "--fixtures", fixtures,
            "--before", `node -e "console.error('reseeding ${HOOK_SECRET}')"`,
            "--allow-shell-hooks",
            "--secret", HOOK_SECRET,
            "--out", outDir,
            "--json",
          ],
          judge,
        );
        expect(data.outcome).toBe("succeeded");
        expect(exitCode).toBe(0);
        const fx = data.fixtures as { identity: string; specHash: string; outputs: { itemId: string }; secretOutputs: string[]; log: { phase: string; name: string; ok: boolean; stderr?: string }[] };
        const itemId = fx.outputs.itemId;
        expect(itemId).toMatch(/^item-1-/);
        expect(fx.secretOutputs).toEqual(["password"]);
        expect(fx.identity).toMatch(/^fx-/);
        expect(fx.log.map((l) => `${l.phase}:${l.name}:${l.ok}`)).toEqual(["setup:--before:true", "setup:create-item:true", "restore:delete-item:true"]);
        expect(fx.log[0]?.stderr).toContain("reseeding «redacted»");
        // The mission ran on the created item and the teardown deleted it.
        expect(log).toEqual([`POST ${itemId}`, `GET ${itemId} 200`, `DELETE ${itemId} 204`]);
        expect(items.size).toBe(0);
        expect(String(data.finalUrl)).toContain(`/items/${itemId}`);
        // The Recording carries the identity (non-secret outputs only).
        const recording = JSON.parse(await readFile(String(data.recordingPath), "utf8")) as { fixture?: unknown };
        expect(recording.fixture).toEqual({ identity: fx.identity, specHash: fx.specHash, outputs: { itemId } });

        // verify-fix: plant a finding on the start step; every replay restores + re-runs setup and
        // navigates to the NEW item (the recorded id is rebound).
        const resultPath = String(data.resultPath);
        const persisted = JSON.parse(await readFile(resultPath, "utf8")) as { result: Record<string, unknown> };
        persisted.result.defects = [{ fingerprint: "fp-planted", kind: "console-error", repro: { recordingStepIndex: 0 } }];
        await writeFile(resultPath, JSON.stringify(persisted));
        await expect(runVerifyFix({ resultPath, fingerprint: "fp-planted", replays: 2 })).rejects.toThrow(/re-supply the SAME commands/);
        log.length = 0;
        const report = await runVerifyFix({
          resultPath,
          fingerprint: "fp-planted",
          replays: 2,
          fixtureFlags: { before: `node -e "console.error('reseeding ${HOOK_SECRET}')"`, allowShellHooks: true },
          secrets: [HOOK_SECRET],
        });
        expect(report.verdict).toBe("fixed");
        expect(report.fixtures?.missionIdentity).toBe(fx.identity);
        expect(report.fixtures?.cycles).toBe(2);
        const posts = log.filter((l) => l.startsWith("POST "));
        expect(posts).toHaveLength(2);
        const [id1, id2] = posts.map((p) => p.slice("POST ".length));
        expect(log).toEqual([`POST ${id1}`, `GET ${id1} 200`, `DELETE ${id1} 204`, `POST ${id2}`, `GET ${id2} 200`, `DELETE ${id2} 204`]);
        expect(items.size).toBe(0);

        // No secret canary in any artifact, the envelope, the verify-fix report or a model payload.
        const surfaces = [raw, JSON.stringify(report), ...judge.seen, ...(await allFiles(outDir))];
        for (const canary of CANARIES) {
          for (const s of surfaces) expect(s.includes(canary), `canary ${canary.slice(0, 8)}… leaked`).toBe(false);
        }
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
    240_000,
  );

  it(
    "a failing setup ends the run inconclusive (configuration) and never runs the mission",
    async () => {
      const dir = await mkdtemp(join(tmpdir(), "jev-fixtures-fail-"));
      try {
        const state = join(dir, "state.json");
        await writeFile(state, JSON.stringify({ cookies: [], origins: [{ origin, localStorage: [{ name: "token", value: TOKEN }] }] }));
        const fixtures = join(dir, "fixtures.json");
        await writeFile(fixtures, JSON.stringify({ setup: [{ method: "POST", url: "/api/items", auth: { from: "localStorage", key: "token" }, outputs: { itemId: "$.id" } }] }));
        const judge = new DoneJudge();
        failSeed = true;
        log.length = 0;
        const { data, raw, exitCode } = await explore(
          ["--url", `${origin}/items/\${setup.itemId}`, "--goal", "g", "--success", "urlIncludes:/items/", "--allow", origin, "--storage-state", state, "--fixtures", fixtures, "--json"],
          judge,
        );
        expect(data.outcome).toBe("inconclusive");
        expect(String(data.reason)).toMatch(/^fixture setup failed: setup\[0\]: POST .* answered 500/);
        expect(data.failure).toMatchObject({ kind: "configuration" });
        expect(exitCode).toBe(2);
        expect(judge.seen).toHaveLength(0);
        expect(log).toEqual(["POST 500"]);
        expect(raw.includes(TOKEN)).toBe(false);
      } finally {
        failSeed = false;
        await rm(dir, { recursive: true, force: true });
      }
    },
    120_000,
  );

  it("refuses unknown or secret references, hooks without the opt-in, and fixtures with other strategies, before any request", async () => {
    const dir = await mkdtemp(join(tmpdir(), "jev-fixtures-refuse-"));
    try {
      const fixtures = join(dir, "fixtures.json");
      await writeFile(fixtures, JSON.stringify({ setup: [{ method: "POST", url: "/api/items", outputs: { itemId: "$.id", pw: "$.password" }, secretOutputs: ["pw"] }] }));
      const lines: string[] = [];
      const program = buildProgram({ profiles: new ProfileManager("/unused"), explore: { judge: new DoneJudge(), gen: new FakeGenerationGateway({}) } });
      program.configureOutput({ writeOut: (s) => lines.push(s), writeErr: (s) => lines.push(s) });
      program.exitOverride();
      log.length = 0;
      for (const goal of ["type ${setup.nope}", "type ${setup.pw}"]) {
        await program.parseAsync(["explore", "--url", `${origin}/items/x`, "--goal", goal, "--success", "urlIncludes:/", "--fixtures", fixtures, "--json"], { from: "user" });
        expect(lines.join("")).toContain("E_FIXTURE_REF");
        lines.length = 0;
      }
      await program.parseAsync(["explore", "--url", `${origin}/items/x`, "--goal", "g", "--success", "urlIncludes:/", "--fixtures", fixtures, "--before", "true", "--json"], { from: "user" });
      expect(lines.join("")).toContain("--allow-shell-hooks");
      lines.length = 0;
      await program.parseAsync(["explore", "--strategy", "adversarial", "--url", `${origin}/items/x`, "--fixtures", fixtures, "--json"], { from: "user" });
      expect(lines.join("")).toContain("supported only with --strategy goal");
      expect(log).toEqual([]);
      process.exitCode = undefined;
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
