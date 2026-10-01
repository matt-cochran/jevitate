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
 * #243 end to end, REAL Chromium against a served invite app: the fixture mints an invite link AS
 * THE OWNER (a named `--fixture-identity`, its cookie read from the owner's storageState) and the
 * mission opens it as a COLD recipient (no `--storage-state`): the recipient landing page is what
 * the run proves, not the owner's "already signed in" redirect. The minted root-relative link is the
 * whole `--url` path (`<origin>${setup.link}`); verify-fix re-mints as the same identity on every
 * replay; the owner's session never reaches an artifact or a model payload.
 */

const OWNER_SID = `owner-${randomUUID()}`;
const invites = new Set<string>();
const log: string[] = [];
let server: Server;
let origin: string;

const isOwner = (req: IncomingMessage): boolean => (req.headers.cookie ?? "").split(/;\s*/).includes(`sid=${OWNER_SID}`);

beforeAll(async () => {
  server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    const join_ = /^\/join\/([^/]+)$/.exec(url.pathname);
    const api = /^\/api\/invites\/([^/]+)$/.exec(url.pathname);
    if (req.method === "POST" && url.pathname === "/api/invites") {
      if (!isOwner(req)) {
        log.push("POST 401");
        res.writeHead(401).end();
        return;
      }
      const token = `inv-${randomUUID().slice(0, 8)}`;
      invites.add(token);
      log.push(`POST ${token}`);
      res.writeHead(201, { "content-type": "application/json" }).end(JSON.stringify({ token, url: `/join/${token}` }));
      return;
    }
    if (req.method === "DELETE" && api !== null) {
      const ok = isOwner(req) && invites.delete(api[1] as string);
      log.push(`DELETE ${api[1]} ${ok ? 204 : 404}`);
      res.writeHead(ok ? 204 : 404).end();
      return;
    }
    if (req.method === "GET" && join_ !== null) {
      const token = join_[1] as string;
      const owner = isOwner(req);
      const valid = invites.has(token);
      log.push(`GET ${token} ${owner ? "owner" : "cold"} ${valid ? 200 : 404}`);
      res.writeHead(valid ? 200 : 404, { "content-type": "text/html; charset=utf-8" });
      const h1 = !valid ? "Invite not found" : owner ? "You are already signed in as the owner" : "Welcome, guest";
      res.end(`<!doctype html><html><body><h1>${h1}</h1><button type="button">Accept invite</button></body></html>`);
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

async function explore(args: string[], judge: DoneJudge): Promise<{ ok: boolean; data: Record<string, unknown>; raw: string; exitCode: number | undefined }> {
  const lines: string[] = [];
  const program = buildProgram({ profiles: new ProfileManager("/unused"), explore: { judge, gen: new FakeGenerationGateway({}) } });
  program.configureOutput({ writeOut: (s) => lines.push(s), writeErr: (s) => lines.push(s) });
  program.exitOverride();
  const before = process.exitCode;
  await program.parseAsync(["explore", ...args], { from: "user" });
  const exitCode = typeof process.exitCode === "number" ? process.exitCode : undefined;
  process.exitCode = before;
  const raw = lines.join("");
  const parsed = JSON.parse(raw) as { ok: boolean; data: Record<string, unknown> };
  return { ok: parsed.ok, data: parsed.data, raw, exitCode };
}

describe("#243 fixture identities — mint as the owner, open as a cold recipient (served, real browser)", () => {
  it(
    "the mission runs cold on the owner-minted link; verify-fix re-mints as the same identity; the owner session leaks nowhere",
    async () => {
      const dir = await mkdtemp(join(tmpdir(), "jev-fx-identity-served-"));
      const outDir = join(dir, "out");
      try {
        const ownerState = join(dir, "owner.json");
        await writeFile(ownerState, JSON.stringify({ cookies: [{ name: "sid", value: OWNER_SID, domain: "127.0.0.1", path: "/" }], origins: [] }));
        const fixtures = join(dir, "invite.fixtures.json");
        const auth = { from: "cookies", identity: "owner" };
        await writeFile(
          fixtures,
          JSON.stringify({
            setup: [{ name: "mint-invite", method: "POST", url: "/api/invites", auth, expectStatus: [201], outputs: { link: "$.url", token: "$.token" } }],
            restore: [{ name: "revoke-invite", method: "DELETE", url: "/api/invites/${setup.token}", auth }],
          }),
        );
        const judge = new DoneJudge();
        log.length = 0;
        const { ok, data, raw, exitCode } = await explore(
          [
            "--url", `${origin}\${setup.link}`,
            "--goal", "accept the invite",
            "--success", "textIncludes:css=h1|Welcome, guest",
            "--allow-vacuous-checks",
            "--allow", origin,
            "--fixtures", fixtures,
            "--fixture-identity", `owner=${ownerState}`,
            "--out", outDir,
            "--json",
          ],
          judge,
        );
        expect(ok, raw).toBe(true);
        expect(data.outcome, raw).toBe("succeeded");
        expect(exitCode).toBe(0);
        const fx = data.fixtures as { outputs: { link: string; token: string }; identities?: Record<string, string> };
        const token = fx.outputs.token;
        expect(fx.outputs.link).toBe(`/join/${token}`);
        expect(fx.identities).toEqual({ owner: ownerState });
        // Minted as the owner, opened COLD by the mission browser, revoked as the owner.
        expect(log).toEqual([`POST ${token}`, `GET ${token} cold 200`, `DELETE ${token} 204`]);
        expect(String(data.finalUrl)).toBe(`${origin}/join/${token}`);

        // verify-fix: every replay re-mints as the recorded identity and opens the NEW link cold.
        const resultPath = String(data.resultPath);
        const persisted = JSON.parse(await readFile(resultPath, "utf8")) as { result: Record<string, unknown> };
        persisted.result.defects = [{ fingerprint: "fp-planted", kind: "console-error", repro: { recordingStepIndex: 0 } }];
        await writeFile(resultPath, JSON.stringify(persisted));
        log.length = 0;
        const report = await runVerifyFix({ resultPath, fingerprint: "fp-planted", replays: 2 });
        expect(report.verdict).toBe("fixed");
        const posts = log.filter((l) => l.startsWith("POST "));
        expect(posts).toHaveLength(2);
        const [t1, t2] = posts.map((p) => p.slice("POST ".length));
        expect(log).toEqual([`POST ${t1}`, `GET ${t1} cold 200`, `DELETE ${t1} 204`, `POST ${t2}`, `GET ${t2} cold 200`, `DELETE ${t2} 204`]);
        expect(invites.size).toBe(0);

        for (const s of [raw, JSON.stringify(report), ...judge.seen, ...(await allFiles(outDir))]) expect(s.includes(OWNER_SID)).toBe(false);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
    240_000,
  );

  it("an unbound identity refuses before any request or browser", async () => {
    const dir = await mkdtemp(join(tmpdir(), "jev-fx-identity-refuse-"));
    try {
      const fixtures = join(dir, "f.json");
      await writeFile(fixtures, JSON.stringify({ setup: [{ method: "POST", url: "/api/invites", auth: { from: "cookies", identity: "owner" }, outputs: { link: "$.url" } }] }));
      const judge = new DoneJudge();
      log.length = 0;
      const { ok, raw } = await explore(["--url", `${origin}\${setup.link}`, "--goal", "g", "--success", "urlIncludes:/join/", "--allow", origin, "--fixtures", fixtures, "--json"], judge);
      expect(ok).toBe(false);
      expect(raw).toContain("E_FIXTURE_SPEC");
      expect(raw).toContain("--fixture-identity owner=");
      expect(log).toEqual([]);
      expect(judge.seen).toHaveLength(0);
      process.exitCode = undefined;
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
