import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FakeGenerationGateway, FakeJudgmentGateway } from "@jevitate/ai-core";
import { PlaywrightBrowserPort } from "@jevitate/playwright";
import type { ProfileManager } from "@jevitate/daemon";
import { buildProgram } from "./program.js";
import type { MultiRunResult } from "./multi-run.js";

/**
 * #141 / #143 end to end through `jevitate explore`, on a served fixture and a real Chromium:
 *  - a nondeterministic endpoint (HTTP 500 for ONE of three sessions) shows up as `flaky` with
 *    --repeat 3 --min-agreement 2 — reported, not counted;
 *  - `/api/billing` answers 403 to a "sales" cookie and 200 to "admin": the persona matrix reports
 *    the status difference (a candidate RBAC finding) and the control only admin sees.
 */

let sessions = 0;
let server: Server;
let origin: string;

function cookie(req: IncomingMessage, name: string): string | undefined {
  const m = (req.headers.cookie ?? "").split(/;\s*/).find((c) => c.startsWith(`${name}=`));
  return m?.slice(name.length + 1);
}

beforeAll(async () => {
  server = createServer((req, res) => {
    const path = (req.url ?? "/").split("?")[0];
    if (path === "/flaky") {
      // Each fresh browser context is a new session; only the second one gets a failing API.
      const headers: Record<string, string> = { "content-type": "text/html" };
      if (cookie(req, "sid") === undefined) headers["set-cookie"] = `sid=${++sessions}; Path=/`;
      res
        .writeHead(200, headers)
        .end(`<!doctype html><html><body><button type="button">Go</button><script>fetch("/api/data")</script></body></html>`);
      return;
    }
    if (path === "/api/data") {
      res.writeHead(cookie(req, "sid") === "2" ? 500 : 200, { "content-type": "application/json" }).end("{}");
      return;
    }
    if (path === "/app") {
      const admin = cookie(req, "role") === "admin";
      res
        .writeHead(200, { "content-type": "text/html" })
        .end(
          `<!doctype html><html><body><a href="/app">Home</a>${admin ? `<button type="button">Billing</button>` : ""}` +
            `<script>fetch("/api/billing")</script></body></html>`,
        );
      return;
    }
    if (path === "/api/billing") {
      const role = cookie(req, "role");
      res.writeHead(role === "admin" ? 200 : 403, { "content-type": "application/json" }).end("{}");
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  if (addr === null || typeof addr === "string") throw new Error("no port");
  origin = `http://127.0.0.1:${(addr satisfies AddressInfo).port}`;
});
afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

function program(): { program: ReturnType<typeof buildProgram>; lines: string[] } {
  const lines: string[] = [];
  const p = buildProgram({
    profiles: {} as unknown as ProfileManager,
    explore: {
      judge: new FakeJudgmentGateway({ looksBroken: { kind: "noul", value: false, probability: 0 } }),
      gen: new FakeGenerationGateway(),
      // A real Chromium (this file runs in the vitest `browser` project).
      browserPortFactory: () => new PlaywrightBrowserPort(),
    },
  });
  p.exitOverride();
  p.configureOutput({ writeOut: (s) => lines.push(s), writeErr: () => undefined });
  return { program: p, lines };
}

const ADVERSARIAL = ["explore", "--strategy", "adversarial", "--max-decisions", "1", "--min-control-coverage", "0", "--no-require-form-submit"];

describe("explore --repeat (#141)", () => {
  it(
    "a finding from one of three runs is flaky with --min-agreement 2: reported with its stability, not counted",
    async () => {
      const out = await mkdtemp(join(tmpdir(), "jev-repeat-"));
      try {
        sessions = 0;
        const { program: p, lines } = program();
        await p.parseAsync([...ADVERSARIAL, "--url", `${origin}/flaky`, "--repeat", "3", "--min-agreement", "2", "--out", out, "--json"], {
          from: "user",
        });
        const env = JSON.parse(lines.join("")) as { ok: boolean; data: MultiRunResult };
        expect(env.ok).toBe(true);
        const r = env.data;
        expect(r).toMatchObject({ kind: "multi-run", strategy: "adversarial", repeat: 3, minAgreement: 2, complete: true });
        expect(sessions).toBe(3); // three runs, three fresh contexts
        const cell = r.cells[0]!;
        // One decision proves little (inconclusive), except where the 500 fired: the agreed outcome is 2 of 3.
        expect(cell.runs.map((run) => run.outcome)).toEqual(["inconclusive", "defects-found", "inconclusive"]);
        expect(r.outcome).toBe("inconclusive");
        expect(r.exitCode).toBe(2);
        expect(r.findings).toEqual([]);
        const flaky = r.flaky.find((f) => f.title.includes("/api/data"));
        expect(flaky).toMatchObject({ stability: "1/3", seen: 1, of: 3, runs: [2], status: "flaky" });
        const onDisk = JSON.parse(await readFile(join(out, "multi-run.result.json"), "utf8")) as MultiRunResult;
        expect(onDisk.flaky).toEqual(r.flaky);
        for (const i of [1, 2, 3]) {
          const perRun = JSON.parse(await readFile(join(out, `run-${i}`, "run.envelope.json"), "utf8")) as { ok: boolean };
          expect(perRun.ok).toBe(true);
        }
      } finally {
        process.exitCode = 0;
        await rm(out, { recursive: true, force: true });
      }
    },
    240_000,
  );
});

describe("explore --persona (#143)", () => {
  it(
    "reports the 403-vs-200 status difference on /api/billing as a candidate RBAC finding",
    async () => {
      const dir = await mkdtemp(join(tmpdir(), "jev-persona-"));
      try {
        const state = (role: string): string =>
          JSON.stringify({
            cookies: [{ name: "role", value: role, domain: "127.0.0.1", path: "/", expires: -1, httpOnly: false, secure: false, sameSite: "Lax" }],
            origins: [],
          });
        await writeFile(join(dir, "admin.json"), state("admin"));
        await writeFile(join(dir, "sales.json"), state("sales"));
        const { program: p, lines } = program();
        await p.parseAsync(
          [
            ...ADVERSARIAL,
            "--url",
            `${origin}/app`,
            "--persona",
            `admin=${join(dir, "admin.json")}`,
            "--persona",
            `sales=${join(dir, "sales.json")}`,
            "--out",
            join(dir, "out"),
            "--json",
          ],
          { from: "user" },
        );
        const raw = lines.join("");
        // Only paths travel: the storage state's cookie values never reach the output.
        expect(raw).not.toContain('"value":"admin"');
        const env = JSON.parse(raw) as { ok: boolean; data: MultiRunResult };
        expect(env.ok).toBe(true);
        const r = env.data;
        expect(r.cells.map((c) => c.persona)).toEqual(["admin", "sales"]);
        expect(r.cells.map((c) => c.storageStatePath)).toEqual([join(dir, "admin.json"), join(dir, "sales.json")]);
        expect(r.diff?.advisory).toBe(true);
        expect(r.diff?.statusDiffs).toContainEqual({ request: "GET /api/billing", statuses: { admin: [200], sales: [403] } });
        expect(r.diff?.rbacCandidates).toContainEqual(
          expect.objectContaining({ request: "GET /api/billing", denied: { sales: [403] }, allowed: ["admin"] }),
        );
        expect(r.diff?.controlsOnlyIn).toContainEqual({ item: 'button "Billing"', presentFor: ["admin"], absentFor: ["sales"] });
        expect(Object.keys(r.diff?.outcomes ?? {})).toEqual(["admin", "sales"]);
      } finally {
        process.exitCode = 0;
        await rm(dir, { recursive: true, force: true });
      }
    },
    240_000,
  );
});
