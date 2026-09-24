import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { FakeGenerationGateway, FakeJudgmentGateway } from "@jevitate/ai-core";
import { PlaywrightBrowserPort } from "@jevitate/playwright";
import { BrowseTheWeb, CastActor, type Actor } from "@jevitate/screenplay";
import { validateInvariantSpec, type InvariantSpec, type Recording } from "@jevitate/recording";
import { InvariantMonitor } from "./declared-invariants.js";
import { invariantFingerprint } from "./adversarial/defect-fingerprint.js";
import { runGoalBasedMission } from "./missions/goal-based.js";
import { runFeatureMission } from "./missions/feature.js";
import { runAdversarialMission } from "./missions/adversarial.js";
import { runInductionMission } from "./missions/induction.js";
import { verifyFix, type VerifySession } from "./verify-fix.js";
import { ScriptedJudge } from "./testkit.js";

/**
 * #86 — app-declared invariants against a served fixture: an "Import" that charges credits but
 * (in broken mode) never adds the import. The declared before/after invariant turns that into a
 * hard defect with a stable fingerprint; verify-fix re-checks the same invariant; probes are GET-only
 * with the session's own cookies, never off the allowlist; values are redacted.
 */

let fixed = false;
const requests: Array<{ method: string; path: string; headers: IncomingHttpHeaders }> = [];
const offOriginHits: string[] = [];
let server: Server;
let evil: Server;
let origin: string;
let evilOrigin: string;

const APP = (): string => `<!doctype html><html><body><main data-testid="app-shell">
  <h1>Imports</h1>
  <p>Credits: <span data-testid="credit-balance">1,000</span></p>
  <ul data-testid="imports"></ul>
  <button type="button" id="imp">Import</button>
  <p data-testid="token">tok-SECRET-123</p>
  <script>
    const fixed = ${fixed ? "true" : "false"};
    let bal = 1000;
    document.getElementById("imp").onclick = () => {
      bal -= 40;
      document.querySelector("[data-testid=credit-balance]").textContent = bal.toLocaleString("en-US");
      if (fixed) {
        const li = document.createElement("li");
        li.textContent = "import";
        document.querySelector("[data-testid=imports]").appendChild(li);
      }
    };
  </script></main></body></html>`;

async function listen(s: Server): Promise<string> {
  await new Promise<void>((resolve) => s.listen(0, "127.0.0.1", resolve));
  const addr = s.address();
  if (addr === null || typeof addr === "string") throw new Error("no port");
  return `http://127.0.0.1:${(addr satisfies AddressInfo).port}`;
}

beforeAll(async () => {
  server = createServer((req, res) => {
    const path = (req.url ?? "").split("?")[0] ?? "";
    requests.push({ method: req.method ?? "", path, headers: req.headers });
    if (path === "/app") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "set-cookie": "sid=session-cookie; Path=/" }).end(APP());
      return;
    }
    if (path === "/api/imports") {
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ total: 7, owner: "tok-SECRET-123" }));
      return;
    }
    if (path === "/api/secure") {
      // #135 — an authenticated BFF read: only a matching bearer token unlocks it.
      const ok = req.headers.authorization === "Bearer SECRET-LS-TOKEN-abc";
      res.writeHead(ok ? 200 : 401, { "content-type": "application/json" }).end(JSON.stringify({ secure: ok }));
      return;
    }
    if (path === "/api/cookie-secure") {
      const ok = req.headers.authorization === "SECRET-COOKIE-TOKEN-xyz";
      res.writeHead(ok ? 200 : 401, { "content-type": "application/json" }).end(JSON.stringify({ secure: ok }));
      return;
    }
    res.writeHead(404).end();
  });
  evil = createServer((req, res) => {
    offOriginHits.push(req.url ?? "");
    res.writeHead(200, { "content-type": "application/json" }).end('{"total":1}');
  });
  origin = await listen(server);
  evilOrigin = await listen(evil);
});
afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await new Promise<void>((resolve) => evil.close(() => resolve()));
});
beforeEach(() => {
  fixed = false;
  requests.length = 0;
  offOriginHits.length = 0;
});

const port = new PlaywrightBrowserPort();
async function openSession(): Promise<VerifySession> {
  const session = await port.open({ headless: true, allowedOrigins: [origin], baseUrl: origin });
  const actor = CastActor.named("inv").whoCan(new BrowseTheWeb(session, [origin]));
  return { page: session.page, actor, close: () => session.close() };
}

const SPEC = (): InvariantSpec =>
  validateInvariantSpec(
    {
      observe: {
        balance: { dom: { selector: "[data-testid=credit-balance]", number: true } },
        imports: { dom: { selector: "[data-testid=imports] li", read: "count" } },
      },
      invariants: [{ id: "charge-implies-delivery", require: "delta(balance) < 0 -> delta(imports) >= 1" }],
    },
    { allowlist: [origin], baseUrl: `${origin}/app` },
  );

async function clickImport(actor: Actor, monitor: InvariantMonitor, page: VerifySession["page"]) {
  await page.goto(`${origin}/app`);
  await monitor.before(actor);
  await page.click("#imp");
  return monitor.after(actor, { op: "click", control: "Import", url: page.url() });
}

describe("declared invariants around an action (#86)", () => {
  it(
    "a charge with no delivery is a violation with before/after values and a stable id+route fingerprint",
    async () => {
      const fingerprints: string[] = [];
      for (let i = 0; i < 2; i++) {
        const s = await openSession();
        try {
          const monitor = new InvariantMonitor(SPEC(), { allowlist: [origin], baseUrl: `${origin}/app` });
          const r = await clickImport(s.actor, monitor, s.page);
          expect(r.violations).toHaveLength(1);
          const v = r.violations[0]!;
          expect(v).toMatchObject({
            id: "charge-implies-delivery",
            kind: "require",
            expression: "delta(balance) < 0 -> delta(imports) >= 1",
            values: { balance: { before: 1000, after: 960 }, imports: { before: 0, after: 0 } },
            action: { op: "click", control: "Import" },
            route: "/app",
          });
          expect(v.reason).toContain("balance: 1000 → 960; imports: 0 → 0");
          expect(v.fingerprint).toBe(invariantFingerprint(`${origin}/app`, "", "charge-implies-delivery"));
          expect(monitor.report()).toEqual([{ id: "charge-implies-delivery", checked: 1, held: 0, violated: 1, unknown: 0 }]);
          fingerprints.push(v.fingerprint);
        } finally {
          await s.close();
        }
      }
      expect(fingerprints[0]).toBe(fingerprints[1]);
    },
    120_000,
  );

  it(
    "the fixed app holds; an unreadable observable is unknown, never a violation or a pass",
    async () => {
      fixed = true;
      const s = await openSession();
      try {
        const ok = await clickImport(s.actor, new InvariantMonitor(SPEC(), { allowlist: [origin], baseUrl: `${origin}/app` }), s.page);
        expect(ok).toEqual({ violations: [], unknown: [], held: ["charge-implies-delivery"] });
        const missing = validateInvariantSpec(
          { observe: { gone: { dom: { selector: "#nope", number: true } } }, invariants: [{ id: "gone", require: "delta(gone) == 0" }] },
          {},
        );
        const r = await clickImport(s.actor, new InvariantMonitor(missing, { allowlist: [origin], baseUrl: origin }), s.page);
        expect(r).toEqual({ violations: [], unknown: ["gone"], held: [] });
      } finally {
        await s.close();
      }
    },
    120_000,
  );

  it(
    "probes are GET-only with the session's own cookie, never off the allowlist, and their bodies never reach a finding",
    async () => {
      const s = await openSession();
      try {
        const spec = validateInvariantSpec(
          {
            observe: { total: { probe: { get: "/api/imports", json: "$.total" } }, token: { dom: { selector: "[data-testid=token]" } } },
            invariants: [
              { id: "total-fixed", require: "delta(total) == 0 && total == 8" },
              { id: "no-token", require: "token == null" },
            ],
          },
          { allowlist: [origin], baseUrl: `${origin}/app` },
        );
        const monitor = new InvariantMonitor(spec, { allowlist: [origin], baseUrl: `${origin}/app`, secrets: ["tok-SECRET-123"] });
        const r = await clickImport(s.actor, monitor, s.page);
        const probes = requests.filter((q) => q.path === "/api/imports");
        expect(probes.length).toBeGreaterThan(0);
        for (const p of probes) {
          expect(p.method).toBe("GET");
          expect(p.headers.cookie).toContain("sid=session-cookie");
          expect(p.headers.authorization).toBeUndefined();
        }
        expect(r.violations.map((v) => v.id).sort()).toEqual(["no-token", "total-fixed"]);
        const text = JSON.stringify(r.violations);
        expect(text).not.toContain("tok-SECRET-123"); // the DOM value and the probe body's owner field
        expect(text).not.toContain('"owner"');
        expect(r.violations.find((v) => v.id === "total-fixed")?.evidence).toEqual([`probe GET ${origin}/api/imports → 200`]);

        // The dispatch refuses an off-allowlist probe; even a spec that skipped validation never sends one.
        const forged: InvariantSpec = {
          observe: { total: { probe: { get: `${evilOrigin}/steal` } } },
          invariants: [{ id: "forged", require: "total == 200" }],
        };
        expect(() => validateInvariantSpec(forged, { allowlist: [origin], baseUrl: origin })).toThrow(/not an authorized origin/);
        const f = await clickImport(s.actor, new InvariantMonitor(forged, { allowlist: [origin], baseUrl: origin }), s.page);
        expect(f.unknown).toEqual(["forged"]);
        expect(offOriginHits).toEqual([]);
      } finally {
        await s.close();
      }
    },
    120_000,
  );

  it(
    "#135: a probe authenticates from a localStorage token — attached as Authorization, absent from every artifact (secret-canary)",
    async () => {
      const s = await openSession();
      try {
        await s.page.goto(`${origin}/app`);
        await s.page.evaluate(() => window.localStorage.setItem("tok", "SECRET-LS-TOKEN-abc"));
        const spec = validateInvariantSpec(
          {
            observe: { secure: { probe: { get: "/api/secure", json: "$.secure", authFrom: { localStorage: "tok" } } } },
            invariants: [{ id: "secure-ok", require: "secure == true" }],
          },
          { allowlist: [origin], baseUrl: `${origin}/app` },
        );
        const monitor = new InvariantMonitor(spec, { allowlist: [origin], baseUrl: `${origin}/app` });
        await monitor.before(s.actor);
        const r = await monitor.after(s.actor, { op: "click", control: null, url: s.page.url() });
        expect(r.violations).toEqual([]);
        expect(r.held).toEqual(["secure-ok"]);

        const probes = requests.filter((q) => q.path === "/api/secure");
        expect(probes.length).toBeGreaterThan(0);
        for (const p of probes) {
          expect(p.method).toBe("GET");
          expect(p.headers.authorization).toBe("Bearer SECRET-LS-TOKEN-abc");
        }
        // secret-canary: the token never shows up anywhere this run's artifacts could echo it.
        expect(JSON.stringify(r)).not.toContain("SECRET-LS-TOKEN-abc");
        expect(monitor.report()).toContainEqual({ id: "secure-ok", checked: 1, held: 1, violated: 0, unknown: 0 });
      } finally {
        await s.close();
      }
    },
    120_000,
  );

  it(
    "#135: an unavailable auth token fails the probe closed — never sent unauthenticated",
    async () => {
      const s = await openSession();
      try {
        await s.page.goto(`${origin}/app`);
        // No localStorage token was ever set here.
        const spec = validateInvariantSpec(
          {
            observe: { secure: { probe: { get: "/api/secure", json: "$.secure", authFrom: { localStorage: "missing-key" } } } },
            invariants: [{ id: "secure-ok", require: "secure == true" }],
          },
          { allowlist: [origin], baseUrl: `${origin}/app` },
        );
        const monitor = new InvariantMonitor(spec, { allowlist: [origin], baseUrl: `${origin}/app` });
        await monitor.before(s.actor);
        const r = await monitor.after(s.actor, { op: "click", control: null, url: s.page.url() });
        expect(r).toEqual({ violations: [], unknown: ["secure-ok"], held: [] });
        const probes = requests.filter((q) => q.path === "/api/secure");
        // Refused before ever being sent (fail-closed): never an unauthenticated 401 hit.
        expect(probes).toEqual([]);
      } finally {
        await s.close();
      }
    },
    120_000,
  );

  it(
    "#135: a probe authenticates from a named cookie the same way",
    async () => {
      const s = await openSession();
      try {
        await s.page.goto(`${origin}/app`);
        await s.page.context().addCookies([{ name: "auth_tok", value: "SECRET-COOKIE-TOKEN-xyz", url: origin }]);
        const spec = validateInvariantSpec(
          {
            observe: { secure: { probe: { get: "/api/cookie-secure", json: "$.secure", authFrom: { cookie: "auth_tok", scheme: "" } } } },
            invariants: [{ id: "secure-ok", require: "secure == true" }],
          },
          { allowlist: [origin], baseUrl: `${origin}/app` },
        );
        const monitor = new InvariantMonitor(spec, { allowlist: [origin], baseUrl: `${origin}/app` });
        await monitor.before(s.actor);
        const r = await monitor.after(s.actor, { op: "click", control: null, url: s.page.url() });
        expect(r.held).toEqual(["secure-ok"]);
        const probes = requests.filter((q) => q.path === "/api/cookie-secure");
        expect(probes.length).toBeGreaterThan(0);
        for (const p of probes) expect(p.headers.authorization).toBe("SECRET-COOKIE-TOKEN-xyz");
      } finally {
        await s.close();
      }
    },
    120_000,
  );
});

describe("declared invariants in missions (#86)", () => {
  it(
    "goal: the goal is reached but the invariant broke on the way — defects-found, with the repro step",
    async () => {
      const outcome = async () => {
        const s = await openSession();
        try {
          return await runGoalBasedMission({
            actor: s.actor,
            judge: new ScriptedJudge([{ op: "click", target: "0" }, { op: "done" }]),
            gen: new FakeGenerationGateway(),
            goal: "import one file",
            allowlist: [origin],
            startUrl: `${origin}/app`,
            successChecks: [{ kind: "page", assertion: { kind: "textIncludes", target: { testId: "credit-balance" }, text: "960" } }],
            oracleTimeoutMs: 300,
            waitOpMs: 300,
            bounds: { maxDecisions: 6 },
            invariants: SPEC(),
          });
        } finally {
          await s.close();
        }
      };
      const broken = await outcome();
      expect(broken.assertionPassed).toBe(true);
      expect(broken.outcome).toBe("defects-found");
      expect(broken.invariantDefects).toHaveLength(1);
      expect(broken.invariantDefects?.[0]).toMatchObject({
        kind: "invariant",
        fingerprint: invariantFingerprint(`${origin}/app`, "", "charge-implies-delivery"),
        invariant: { values: { balance: { before: 1000, after: 960 } } },
        repro: { recordingStepIndex: 1 },
      });
      expect(broken.reason).toMatch(/invariant charge-implies-delivery violated/);

      fixed = true;
      const ok = await outcome();
      expect(ok.outcome).toBe("succeeded");
      expect(ok.invariantDefects).toEqual([]);
      expect(ok.invariants?.[0]).toMatchObject({ id: "charge-implies-delivery", violated: 0 });
      expect(ok.invariants?.[0]?.held).toBeGreaterThan(0);
    },
    180_000,
  );

  it(
    "feature: a frontier action that breaks the invariant is a defect carrying its own replayable path",
    async () => {
      const s = await openSession();
      try {
        const r = await runFeatureMission({
          page: s.page,
          actor: s.actor,
          seedUrl: `${origin}/app`,
          allowlist: [origin],
          scope: { name: "import", originAllowlist: [origin], routeGlobs: ["/app**"] },
          bounds: { maxActions: 3 },
          invariants: SPEC(),
        });
        const d = r.invariantDefects?.[0];
        expect(d?.fingerprint).toBe(invariantFingerprint(`${origin}/app`, "", "charge-implies-delivery"));
        expect(d?.repro.recording?.pages[0]?.steps[0]?.step.kind).toBe("navigate");
        expect(d?.repro.recordingStepIndex).toBe(1);
      } finally {
        await s.close();
      }
    },
    180_000,
  );
});

describe("declared invariants in adversarial and coverage missions (#86)", () => {
  it(
    "adversarial: the generalised invariant hook turns the broken rule into a hard, deduped defect",
    async () => {
      const s = await openSession();
      try {
        const r = await runAdversarialMission({
          page: s.page,
          actor: s.actor,
          judgment: new FakeJudgmentGateway({ looksBroken: { kind: "noul", value: false, probability: 0.1 } }),
          generation: new FakeGenerationGateway({ "triage.narrative": { summary: "invariant", likelyCause: "charge" } }),
          seedUrl: `${origin}/app`,
          allowlist: [origin],
          bounds: { maxDecisions: 3 },
          strategies: ["exercise-controls"],
          invariants: SPEC(),
        });
        const d = r.defects.find((x) => x.kind === "invariant");
        expect(r.outcome).toBe("defects-found");
        expect(d).toMatchObject({
          fingerprint: invariantFingerprint(`${origin}/app`, "", "charge-implies-delivery"),
          invariant: { id: "charge-implies-delivery", values: { balance: { before: 1000, after: 960 } } },
        });
        expect(r.invariants?.[0]).toMatchObject({ id: "charge-implies-delivery" });
        expect(r.invariants?.[0]?.violated).toBeGreaterThan(0);
      } finally {
        await s.close();
      }
    },
    180_000,
  );

  it(
    "coverage: a frontier action that breaks the invariant is a defect with its seed-rooted path",
    async () => {
      const s = await openSession();
      try {
        const r = await runInductionMission({
          page: s.page,
          actor: s.actor,
          judgment: new FakeJudgmentGateway({ isDefect: { kind: "noul", value: false, probability: 0.1 } }),
          seedUrl: `${origin}/app`,
          allowlist: [origin],
          bounds: { maxActions: 3 },
          invariants: SPEC(),
        });
        const d = r.invariantDefects?.[0];
        expect(d?.fingerprint).toBe(invariantFingerprint(`${origin}/app`, "", "charge-implies-delivery"));
        expect(d?.repro.recording?.pages[0]?.steps[0]?.step.kind).toBe("navigate");
        expect(d?.repro.recordingStepIndex).toBe(1);
      } finally {
        await s.close();
      }
    },
    180_000,
  );
});

describe("verify-fix re-checks a declared invariant (#86)", () => {
  const recording: Recording = {
    version: "1.0.0",
    site: "test",
    pages: [
      {
        url: "/app",
        steps: [
          { step: { kind: "navigate", url: "/app", expect: { kind: "urlIncludes", text: "/app" } } },
          { step: { kind: "click", target: { role: "button", name: "Import" }, expect: { kind: "urlIncludes", text: "/app" } } },
        ],
      },
    ],
  };
  const verify = () =>
    verifyFix({
      recording,
      recordingStepIndex: 1,
      fingerprint: invariantFingerprint(`${origin}/app`, "", "charge-implies-delivery"),
      defectKind: "invariant",
      invariant: { spec: SPEC(), id: "charge-implies-delivery", allowlist: [origin], baseUrl: `${origin}/app` },
      openSession,
      replays: 2,
      settleCeilingMs: 3_000,
    });

  it(
    "still reproduces on the broken app, fixed once the app delivers — and never fixed without the spec",
    async () => {
      const broken = await verify();
      expect(broken.verdict).toBe("still-reproduces");
      expect(broken.observedFingerprints).toEqual([invariantFingerprint(`${origin}/app`, "", "charge-implies-delivery")]);

      fixed = true;
      const ok = await verify();
      expect(ok.verdict).toBe("fixed");
      expect(ok.attempts?.every((a) => a.ran && !a.fired)).toBe(true);

      const noSpec = await verifyFix({
        recording,
        recordingStepIndex: 1,
        fingerprint: "0".repeat(16),
        defectKind: "invariant",
        openSession,
      });
      expect(noSpec.verdict).toBe("inconclusive");
    },
    240_000,
  );
});
