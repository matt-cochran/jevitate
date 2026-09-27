import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FakeGenerationGateway, FakeJudgmentGateway, type Answer, type JudgmentPort } from "@jevitate/ai-core";
import { signalFingerprint } from "@jevitate/explore";
import { MissionResultSchema } from "@jevitate/domain";
import { runAdversarialCliMission, runCoverageMission, runExploration } from "./explore-api.js";

/**
 * #208 — the HTTP 5xx hard signal in EVERY strategy, on served pages in real Chromium.
 *
 * The dogfood bug: a goal "save the profile" run whose Save answered `PUT /api/profile → 500` (the page
 * still said "Saved") ended `succeeded`, exit 0, `defects: []`. And an adversarial run whose START
 * page itself answered 500 ended `inconclusive` ("no interactive controls") with no defect.
 *
 * The app runs on 127.0.0.1:<app>; a third party (a second server, off the allowlist) is reached as
 * `localhost:<tp>` — another site (#194). Its 5xx is not the app's defect.
 */

let app: Server;
let tp: Server;
let origin: string;
let tpPort: number;

const profilePage = (saveUrl: string, extra = ""): string => `<!doctype html><html><body><main>
<h1>Profile</h1>
<button id="save" type="button">Save</button>
<p id="status"></p>
<script>
  ${extra}
  document.getElementById("save").addEventListener("click", async () => {
    // The bug: the page reports success whatever the server answered.
    await fetch(${JSON.stringify(saveUrl)}, { method: "PUT", headers: { "content-type": "application/json" }, body: '{"name":"Zoë 🚀"}' }).catch(() => {});
    document.getElementById("status").textContent = "Saved";
    history.pushState({}, "", location.pathname + "?saved=1");
  });
</script></main></body></html>`;

beforeAll(async () => {
  tp = createServer((_req, res) => {
    res.writeHead(503, { "access-control-allow-origin": "*", "content-type": "text/plain" }).end("down");
  });
  await new Promise<void>((resolve) => tp.listen(0, "127.0.0.1", resolve));
  tpPort = (tp.address() as AddressInfo).port;
  app = createServer((req, res) => {
    const path = (req.url ?? "").split("?")[0] ?? "";
    const html = (body: string, status = 200): void => {
      res.writeHead(status, { "content-type": "text/html; charset=utf-8" }).end(body);
    };
    if (path === "/profile") return html(profilePage("/api/profile"));
    if (path === "/profile-ok") return html(profilePage("/api/profile-ok"));
    // The app itself saves fine; a third-party beacon on the page answers 503.
    if (path === "/profile-beacon")
      return html(profilePage("/api/profile-ok", `fetch("http://localhost:${tpPort}/beacon", { method: "POST", mode: "no-cors", body: "sig" }).catch(() => {});`));
    if (path === "/api/profile") {
      res.writeHead(500, { "content-type": "application/json" }).end('{"error":"boom"}');
      return;
    }
    if (path === "/api/profile-ok") {
      res.writeHead(200, { "content-type": "application/json" }).end("{}");
      return;
    }
    if (path === "/boom") return html("<!doctype html><html><body><h1>Internal Server Error</h1></body></html>", 500);
    res.writeHead(404).end();
  });
  await new Promise<void>((resolve) => app.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(app.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await new Promise<void>((resolve) => app.close(() => resolve()));
  await new Promise<void>((resolve) => tp.close(() => resolve()));
});

/** Clicks Save, then proposes `done` (every goal-completion question answered yes). */
class ClickThenDone implements JudgmentPort {
  #i = 0;
  async systemOne(args: { questions: Record<string, { kind: string; options?: readonly string[] }> }): Promise<Record<string, Answer>> {
    const out: Record<string, Answer> = {};
    if (!("action" in args.questions)) {
      for (const [name, q] of Object.entries(args.questions)) if (q.kind === "noul") out[name] = { kind: "noul", value: true, probability: 0.95 };
      return out;
    }
    const options = args.questions.action?.options ?? [];
    const value = this.#i++ === 0 ? (options.find((o) => o.startsWith("click")) ?? "done") : "done";
    out.action = { kind: "choice", value, confidence: 0.9 };
    return out;
  }
}

async function goal(path: string): Promise<Awaited<ReturnType<typeof runExploration>>> {
  const outDir = await mkdtemp(join(tmpdir(), "jev-208-goal-"));
  try {
    return await runExploration({
      url: `${origin}${path}`,
      goal: "save the profile",
      allowlist: [origin],
      judge: new ClickThenDone(),
      gen: new FakeGenerationGateway({}),
      successAssertion: { kind: "urlIncludes", text: "saved=1" },
      bounds: { maxDecisions: 4, maxActions: 4 },
      outDir,
    });
  } finally {
    await rm(outDir, { recursive: true, force: true });
  }
}

describe("HTTP 5xx is a hard-signal defect in every strategy (#208)", () => {
  it(
    "goal: the checks hold but Save answered 500 — an http-5xx defect, defects-found (exit 1), never succeeded",
    async () => {
      const r = await goal("/profile");
      expect(r.assertionPassed).toBe(true);
      expect(r.outcome).toBe("defects-found");
      expect(r.exitCode).toBe(1);
      expect(r.sideEffects.some((e) => e.request.method === "PUT" && e.request.status === 500)).toBe(true);
      const d = r.defects.find((x) => x.kind === "http-5xx");
      expect(d).toBeDefined();
      const url = `${origin}/api/profile`;
      // The SAME identity the adversarial mission gives this bug.
      expect(d?.fingerprint).toBe(signalFingerprint({ kind: "http-5xx", detail: `500 ${url}`, url, status: 500 }));
      expect(d).toMatchObject({ kind: "http-5xx", method: "PUT", route: "/profile", signals: [{ kind: "http-5xx", status: 500, url }] });
      expect(r.reason).toMatch(/PUT \/api\/profile → 500/);
      expect(r.reason).toMatch(/success checks held/);
      expect(MissionResultSchema.safeParse(JSON.parse(JSON.stringify(r))).success).toBe(true);
    },
    120_000,
  );

  it(
    "goal: a save that answers 200 stays clean — succeeded, exit 0, no defects",
    async () => {
      const r = await goal("/profile-ok");
      expect(r.outcome).toBe("succeeded");
      expect(r.exitCode).toBe(0);
      expect(r.defects).toEqual([]);
    },
    120_000,
  );

  it(
    "goal: a 5xx from a third-party origin is not an app defect",
    async () => {
      const r = await goal("/profile-beacon");
      expect(r.outcome).toBe("succeeded");
      expect(r.exitCode).toBe(0);
      expect(r.defects).toEqual([]);
    },
    120_000,
  );

  it(
    "coverage: a control whose request answers 500 is an http-5xx defect (defects-found)",
    async () => {
      const outDir = await mkdtemp(join(tmpdir(), "jev-208-cov-"));
      try {
        const r = await runCoverageMission({
          url: `${origin}/profile`,
          allowlist: [origin],
          judge: new FakeJudgmentGateway({ isDefect: { kind: "noul", value: false, probability: 0 } }),
          gen: new FakeGenerationGateway(),
          outDir,
        });
        expect(r.defects.some((d) => d.kind === "http-5xx")).toBe(true);
        expect(r.missionOutcome).toBe("defects-found");
        expect(r.exitCode).toBe(1);
      } finally {
        await rm(outDir, { recursive: true, force: true });
      }
    },
    120_000,
  );

  it(
    "adversarial: a START page that answers 500 is an http-5xx defect on the document request, not inconclusive",
    async () => {
      const outDir = await mkdtemp(join(tmpdir(), "jev-208-adv-"));
      try {
        const r = await runAdversarialCliMission({
          seedUrl: `${origin}/boom`,
          allowlist: [origin],
          strategies: ["boundary-input"],
          bounds: { maxDecisions: 2 },
          judgment: new FakeJudgmentGateway({ looksBroken: { kind: "noul", value: false, probability: 0.1 } }),
          generation: new FakeGenerationGateway(),
          outDir,
        });
        expect(r.outcome).toBe("defects-found");
        expect(r.exitCode).toBe(1);
        expect(r.stop).toBe("not-rendered");
        const d = r.defects.find((x) => x.kind === "http-5xx");
        expect(d?.signals.some((s) => s.kind === "http-5xx" && s.status === 500 && s.url === `${origin}/boom`)).toBe(true);
      } finally {
        await rm(outDir, { recursive: true, force: true });
      }
    },
    120_000,
  );
});
