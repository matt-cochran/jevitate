import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FakeGenerationGateway, FakeJudgmentGateway } from "@jevitate/ai-core";
import { BrowseTheWeb, CastActor } from "@jevitate/screenplay";
import { PlaywrightBrowserPort } from "@jevitate/playwright";
import type { Page } from "playwright";
import { runAdversarialMission, type AdversarialMissionParams, type AdversarialOutcome } from "./adversarial.js";
import type { MisuseStrategy } from "../adversarial/misuse.js";
import type { VerifySession } from "../verify-fix.js";
import { withSession } from "../testkit.js";

/**
 * #300 — a "Sign in as demo user" shortcut swaps the session mid-run: the run must notice, never
 * judge the original identity's invariants against the demo session, never click it again, and
 * go back to the original identity (a fresh session from the original storage state).
 */

const state = { demoLogins: 0 };

const APP = (who: string): string => `<!doctype html><html><body>
  <h1>Signed in as ${who}</h1>
  ${who === "demo" ? "<p>Demo data: Raise Pro to $149</p>" : "<p>Your workspace</p>"}
  <button id="demo">Sign in as demo user</button>
  <button id="refresh">Refresh feed</button>
  <div id="feed"></div>
  <script>
    document.getElementById('demo').addEventListener('click', async () => {
      await fetch('/api/demo-login', { method: 'POST' });
      location.reload();
    });
    document.getElementById('refresh').addEventListener('click', async () => {
      const r = await fetch('/api/feed');
      document.getElementById('feed').textContent = await r.text();
    });
  </script>
</body></html>`;

let server: Server;
let origin: string;

function sidOf(cookie: string | undefined): string | null {
  const m = /(?:^|;\s*)sid=([^;]+)/.exec(cookie ?? "");
  return m?.[1] ?? null;
}

beforeAll(async () => {
  server = createServer((req, res) => {
    const path = (req.url ?? "").split("?")[0] ?? "";
    const html = (body: string): void => {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(body);
    };
    if (path === "/app") return html(APP(sidOf(req.headers.cookie) ?? "nobody"));
    if (path === "/api/demo-login" && req.method === "POST") {
      state.demoLogins += 1;
      res.writeHead(200, { "content-type": "application/json", "set-cookie": "sid=demo; Path=/" }).end("{}");
      return;
    }
    if (path === "/api/feed") {
      res.writeHead(200, { "content-type": "text/plain" }).end("nothing new");
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  if (addr === null || typeof addr === "string") throw new Error("server has no port");
  origin = `http://127.0.0.1:${(addr satisfies AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

/** The ORIGINAL identity (the run's storage state): signed in as alice. */
async function signInAsAlice(page: Page): Promise<void> {
  await page.context().addCookies([{ name: "sid", value: "alice", url: origin }]);
}

const port = new PlaywrightBrowserPort();
/** A fresh session from the original storage state — what the CLI's `freshSessionOpener` opens. */
async function freshSession(): Promise<VerifySession> {
  const session = await port.open({ headless: true, allowedOrigins: [origin], baseUrl: origin });
  await signInAsAlice(session.page);
  const actor = CastActor.named("fresh").whoCan(new BrowseTheWeb(session, [origin]));
  return { page: session.page, actor, close: () => session.close() };
}

async function hunt(
  seedPath: string,
  strategies: readonly MisuseStrategy[],
  extra: Partial<AdversarialMissionParams> = {},
): Promise<AdversarialOutcome> {
  return withSession(
    "adv-300-",
    async (session) => {
      await signInAsAlice(session.page);
      const actor = CastActor.named("adversary").whoCan(new BrowseTheWeb(session, [origin]));
      return runAdversarialMission({
        page: session.page,
        actor,
        judgment: new FakeJudgmentGateway({ looksBroken: { kind: "noul", value: false, probability: 0.1 } }),
        generation: new FakeGenerationGateway(),
        seedUrl: `${origin}${seedPath}`,
        allowlist: [origin],
        strategies,
        ...extra,
      });
    },
    origin,
  );
}

const NO_DEMO_DATA = { invariants: [{ id: "no-demo-data", never: { pageText: "/Raise Pro to \\$149/" } }] };

describe("#300 — an action that switches the signed-in identity", () => {
  it(
    "is detected, its invariants are not judged, the control is not clicked again, and the original identity is restored",
    async () => {
      state.demoLogins = 0;
      const judgedPages: string[] = [];
      const result = await hunt("/app", ["exercise-controls", "repeat-rapid"], {
        bounds: { maxDecisions: 10, maxActions: 12 },
        openFreshSession: freshSession,
        invariants: NO_DEMO_DATA,
        userInvariant: async (page) => {
          const text = await page.locator("body").innerText();
          judgedPages.push(text);
          return /Demo data/.test(text) ? { ok: false, reason: "demo data shown" } : { ok: true };
        },
      });
      expect(result.outcome).not.toBe("crashed");
      // The shortcut fired once, and never again.
      expect(state.demoLogins).toBe(1);
      // Detected and typed; the original identity was restored.
      expect(result.identityChanges).toHaveLength(1);
      const change = result.identityChanges?.[0];
      expect(change?.action).toBe("Sign in as demo user");
      expect(change?.restored).toBe(true);
      expect(change?.reason).toMatch(/cookie:sid/);
      expect(JSON.stringify(result.identityChanges)).not.toMatch(/alice|"demo"/);
      // No invariant was judged against the demo session — no false positive.
      expect(result.defects.filter((d) => d.kind === "invariant")).toEqual([]);
      expect(judgedPages.some((t) => /Demo data/.test(t))).toBe(false);
      expect(result.invariants?.find((r) => r.id === "no-demo-data")?.violated).toBe(0);
      // Back as alice: the reset entry, then more steps judged on alice's page.
      const reset = result.transcript.find((e) => e.strategy === "identity-reset");
      expect(reset?.actOk).toBe(true);
      expect(judgedPages.filter((t) => /Signed in as alice/.test(t)).length).toBeGreaterThan(1);
      expect(result.stop).not.toBe("identity-changed");
    },
    180_000,
  );

  it(
    "stops inconclusive (identity-changed) when the original identity cannot be restored",
    async () => {
      state.demoLogins = 0;
      const result = await hunt("/app", ["exercise-controls"], {
        bounds: { maxDecisions: 8 },
        invariants: NO_DEMO_DATA,
      });
      expect(result.stop).toBe("identity-changed");
      expect(result.outcome).toBe("inconclusive");
      expect(result.failure?.kind).toBe("identity-changed");
      expect(result.identityChanges?.[0]?.restored).toBe(false);
      expect(result.defects.filter((d) => d.kind === "invariant")).toEqual([]);
    },
    180_000,
  );
});
