import { afterAll, beforeAll, describe, expect, test } from "vitest";
import type { Page } from "playwright";
import { startServer } from "@jevitate/example-site";
import { PlaywrightBrowserPort, type BrowserSession } from "@jevitate/playwright";
import { CastActor, BrowseTheWeb } from "@jevitate/screenplay";
import { FakeJudgmentGateway, FakeGenerationGateway } from "@jevitate/ai-core";
import { runInductionMission } from "./induction.js";

let site: { url: string; close(): Promise<void> };
let session: BrowserSession;
let page: Page;
let actor: CastActor;

const noDefects = () =>
  new FakeJudgmentGateway({ isDefect: { kind: "noul", value: false, probability: 0 } });

beforeAll(async () => {
  site = await startServer();
  const browserPort = new PlaywrightBrowserPort();
  session = await browserPort.open({ headless: true, allowedOrigins: [site.url], baseUrl: site.url });
  page = session.page;
  actor = CastActor.named("tester").whoCan(new BrowseTheWeb(session, [site.url]));
  // Authenticate ONCE so the persistent-context cookie (sid=ok) carries into the
  // authenticated /inbox and /thread pages later tasks explore.
  await page.goto(`${site.url}/login`);
  await page.fill('input[name="username"]', "jane");
  await page.click('button[type="submit"]');
  await page.waitForURL(/\/inbox/);
}, 30_000);

afterAll(async () => {
  await session.close();
  await site.close();
});

describe("runInductionMission — single state", () => {
  // RULING: the plan seeded this at /login and expected statesVisited=1, but on
  // the real fixture clicking the login submit navigates to a 400 error page
  // (form gone) — a DIFFERENT fingerprint, so /login can never be single-state.
  // /whoami is a genuinely control-free page on the authorized origin, which
  // realizes the plan's original intent (statesVisited=1, transitionsExercised=0)
  // and stays single-state across the Task-6 fixture change.
  test("a control-free page exhausts the frontier immediately (statesVisited=1)", async () => {
    const result = await runInductionMission({
      page,
      actor,
      judgment: noDefects(),
      generation: new FakeGenerationGateway(),
      seedUrl: `${site.url}/whoami`,
      allowlist: [site.url],
    });
    expect(result.outcome).toBe("exhausted");
    expect(result.coverage.statesVisited).toBe(1);
    expect(result.coverage.transitionsExercised).toBe(0);
    expect(result.coverage.frontierExhausted).toBe(true);
    expect(result.coverage.defects).toEqual([]);
    expect(result.recordings).toHaveLength(1);
  }, 30_000);
});

describe("runInductionMission — branching", () => {
  test("exercises both thread links from /inbox; the prefixed thread ids template to ONE state (#95)", async () => {
    const result = await runInductionMission({
      page,
      actor,
      judgment: noDefects(),
      generation: new FakeGenerationGateway(),
      seedUrl: `${site.url}/inbox`,
      allowlist: [site.url],
      // /thread/* is a SIBLING route of /inbox, not under it: #89 scopes the frontier to the seed's
      // own route by default, so this deliberately cross-route discovery test widens the scope.
      routeGlobs: ["/**"],
    });
    expect(result.outcome).toBe("exhausted");
    // inbox + :id = 2 distinct states. `/thread/t-1` and `/thread/t-2` are PREFIXED ids (a literal
    // "t-" prefix + a numeric suffix): #95/#127 templates the WHOLE segment, so both collapse to
    // the same `/thread/:id` state — the mission still exercises BOTH links (both transitions
    // land), it just correctly recognizes the second as an already-visited state, not a new one.
    expect(result.coverage.statesVisited).toBe(2);
    expect(result.coverage.transitionsExercised).toBeGreaterThanOrEqual(2);
    expect(result.recordings.length).toBeGreaterThanOrEqual(2);
  }, 30_000);
});

describe("runInductionMission — cycles", () => {
  // The cycle-a <-> cycle-b fixture forms a real inter-page loop. The mission
  // must exercise the return edge but detect the already-visited state, so it
  // terminates with exactly 2 distinct states and never spins forever.
  test("a link back to an already-visited state is exercised but not re-expanded", async () => {
    const result = await runInductionMission({
      page,
      actor,
      judgment: noDefects(),
      generation: new FakeGenerationGateway(),
      seedUrl: `${site.url}/exploratory-testing/cycle-a`,
      allowlist: [site.url],
      // cycle-b is a SIBLING of cycle-a, not under it: widen scope for this deliberately
      // cross-route cycle-detection test (#89 scopes to the seed's own route by default).
      routeGlobs: ["/**"],
    });
    expect(result.outcome).toBe("exhausted");
    expect(result.coverage.statesVisited).toBe(2);
    // Both edges (A->B and the B->A return edge) were exercised.
    expect(result.coverage.transitionsExercised).toBeGreaterThanOrEqual(2);
  }, 15_000);
});

describe("runInductionMission — defect judgment is advisory only", () => {
  test("a flagged state lands in coverage.defects but does not stop the mission or corrupt other branches", async () => {
    // The fake always answers isDefect=true. Every transition is flagged — the
    // mission must still exhaust cleanly (never throw/hang), and each flagged
    // state is captured with its own replayable repro Recording (guardrail #4).
    const judgment = new FakeJudgmentGateway({ isDefect: { kind: "noul", value: true, probability: 0.9 } });
    const result = await runInductionMission({
      page,
      actor,
      judgment,
      generation: new FakeGenerationGateway(),
      seedUrl: `${site.url}/inbox`,
      allowlist: [site.url],
      // /thread/* is a sibling route: widen scope so this test still reaches it (#89 default-scopes
      // the frontier to the seed's own route).
      routeGlobs: ["/**"],
    });
    expect(result.outcome).toBe("exhausted");
    expect(result.coverage.defects.length).toBeGreaterThan(0);
    for (const d of result.coverage.defects) {
      expect(d.recording.pages.length).toBeGreaterThan(0);
    }
  }, 30_000);
});

describe("runInductionMission — a lost --storage-state session (#82)", () => {
  test("a seed that redirects to /login ends scope-unreachable/inconclusive with an authentication-shaped reason, never exploring the logged-out pages", async () => {
    // A FRESH, unauthenticated session — no login step — so /inbox's own auth redirect fires,
    // exactly as a lost/expired --storage-state session would.
    const browserPort = new PlaywrightBrowserPort();
    const unauthSession = await browserPort.open({ headless: true, allowedOrigins: [site.url], baseUrl: site.url });
    try {
      const unauthActor = CastActor.named("unauth-tester").whoCan(new BrowseTheWeb(unauthSession, [site.url]));
      const result = await runInductionMission({
        page: unauthSession.page,
        actor: unauthActor,
        judgment: noDefects(),
        generation: new FakeGenerationGateway(),
        seedUrl: `${site.url}/inbox`,
        allowlist: [site.url],
      });
      expect(result.outcome).toBe("scope-unreachable");
      expect(result.failure?.kind).toBe("target-unreachable");
      expect(result.failure?.message).toBe(
        "seed /inbox redirected to /login — the --storage-state session is not authenticated",
      );
      // Nothing was explored past the redirect — the run never touched /login's own controls.
      expect(result.coverage.statesVisited).toBe(0);
      expect(result.coverage.transitionsExercised).toBe(0);
      expect(result.recordings).toEqual([]);
    } finally {
      await unauthSession.close();
    }
  }, 30_000);
});

describe("runInductionMission — the seed itself cannot be loaded (#128)", () => {
  test("a net::ERR_UNSAFE_PORT on the first navigation ends scope-unreachable/inconclusive with target-unreachable, never crashed", async () => {
    const browserPort = new PlaywrightBrowserPort();
    const url = "http://127.0.0.1:1/";
    const badSession = await browserPort.open({ headless: true, allowedOrigins: [url], baseUrl: url });
    try {
      const badActor = CastActor.named("unreachable-tester").whoCan(new BrowseTheWeb(badSession, [url]));
      const result = await runInductionMission({
        page: badSession.page,
        actor: badActor,
        judgment: noDefects(),
        generation: new FakeGenerationGateway(),
        seedUrl: url,
        allowlist: [url],
      });
      expect(result.outcome).toBe("scope-unreachable");
      expect(result.failure?.kind).toBe("target-unreachable");
      expect(result.failure?.message).toMatch(/^target unreachable \(.*unsafe port.*\)$/i);
      expect(result.coverage.statesVisited).toBe(0);
      expect(result.recordings).toEqual([]);
    } finally {
      await badSession.close();
    }
  }, 30_000);
});

describe("runInductionMission — scope containment (#89, reusing #64's scope model)", () => {
  test("a coverage run started at area-a explores area-a's own states, records area-b as a departure, and never expands it", async () => {
    const result = await runInductionMission({
      page,
      actor,
      judgment: noDefects(),
      generation: new FakeGenerationGateway(),
      seedUrl: `${site.url}/coverage-scope/area-a`,
      allowlist: [site.url],
    });
    expect(result.outcome).toBe("exhausted");
    // area-a + area-a/detail: exactly the in-scope target — area-b never counts as coverage.
    expect(result.coverage.statesVisited).toBe(2);
    expect(result.coverage.scope.outOfScopeTransitions).toBeGreaterThan(0);
    expect(result.coverage.scope.departures.some((d) => d.url.includes("/coverage-scope/area-b"))).toBe(true);
    // Area B's own control was never exercised: its state was recorded, never expanded.
    expect(result.transcript.some((e) => e.target?.includes("Area B action") === true)).toBe(false);
    // Area A's own in-scope detail action WAS exercised.
    expect(result.transcript.some((e) => e.target?.includes("Detail action") === true && e.actOk)).toBe(true);
  }, 30_000);

  test("--route '/**' widens the scope, so area-b IS explored", async () => {
    const result = await runInductionMission({
      page,
      actor,
      judgment: noDefects(),
      generation: new FakeGenerationGateway(),
      seedUrl: `${site.url}/coverage-scope/area-a`,
      allowlist: [site.url],
      routeGlobs: ["/**"],
    });
    expect(result.outcome).toBe("exhausted");
    expect(result.coverage.scope.outOfScopeTransitions).toBe(0);
    expect(result.transcript.some((e) => e.target?.includes("Area B action") === true && e.actOk)).toBe(true);
  }, 30_000);
});

describe("runInductionMission — route templating collapses prefixed ids to one state (#95)", () => {
  test("three /coverage-templating/items/item-<n> instances count as ONE route state", async () => {
    const result = await runInductionMission({
      page,
      actor,
      judgment: noDefects(),
      generation: new FakeGenerationGateway(),
      seedUrl: `${site.url}/coverage-templating/items`,
      allowlist: [site.url],
    });
    expect(result.outcome).toBe("exhausted");
    // The items hub + ONE templated item-:id state = 2, never 4 (hub + 3 separate item states).
    expect(result.coverage.statesVisited).toBe(2);
  }, 30_000);
});

describe("runInductionMission — bounds", () => {
  test("hitting maxActions terminates with outcome 'cap' and frontierExhausted=false", async () => {
    const result = await runInductionMission({
      page,
      actor,
      judgment: noDefects(),
      generation: new FakeGenerationGateway(),
      seedUrl: `${site.url}/inbox`,
      allowlist: [site.url],
      bounds: { maxActions: 1, maxDecisions: 120, maxCandidates: 250 },
    });
    expect(result.outcome).toBe("cap");
    expect(result.coverage.frontierExhausted).toBe(false);
  }, 30_000);
});

describe("runInductionMission — horizontal-overflow hard signal (#149)", () => {
  async function runAt(seedPath: string, viewport: { width: number; height: number }, checkOverflow = false) {
    const browserPort = new PlaywrightBrowserPort();
    const narrowSession = await browserPort.open({ headless: true, allowedOrigins: [site.url], baseUrl: site.url, viewport });
    try {
      const narrowActor = CastActor.named("responsive-tester").whoCan(new BrowseTheWeb(narrowSession, [site.url]));
      return await runInductionMission({
        page: narrowSession.page,
        actor: narrowActor,
        judgment: noDefects(),
        generation: new FakeGenerationGateway(),
        seedUrl: `${site.url}${seedPath}`,
        allowlist: [site.url],
        overflow: { checkOverflow },
      });
    } finally {
      await narrowSession.close();
    }
  }

  test("--viewport 375x812 on /responsive/overflow gives a horizontal-overflow defect attributed to [data-testid=wide]", async () => {
    const result = await runAt("/responsive/overflow", { width: 375, height: 812 });
    expect(result.outcome).toBe("exhausted");
    const overflowDefects = result.coverage.defects.filter((d) => d.overflow !== undefined);
    expect(overflowDefects).toHaveLength(1);
    const finding = overflowDefects[0]!.overflow!;
    expect(finding.kind).toBe("horizontal-overflow");
    expect(finding.element.descriptor).toBe("[data-testid=wide]");
    expect(finding.overflowPx).toBeGreaterThanOrEqual(200);
    expect(finding.overflowPx).toBeLessThanOrEqual(250);
  }, 30_000);

  test("/responsive/ok is clean at 375px (no overflow defect)", async () => {
    const result = await runAt("/responsive/ok", { width: 375, height: 812 });
    expect(result.coverage.defects.filter((d) => d.overflow !== undefined)).toEqual([]);
  }, 30_000);

  test("/responsive/contained is clean at 375px (overflow is inside a scroll container, never page-level)", async () => {
    const result = await runAt("/responsive/contained", { width: 375, height: 812 });
    expect(result.coverage.defects.filter((d) => d.overflow !== undefined)).toEqual([]);
  }, 30_000);

  test("/responsive/overflow is clean at 1280px (the same page fits at a desktop width)", async () => {
    const result = await runAt("/responsive/overflow", { width: 1280, height: 800 }, true);
    expect(result.coverage.defects.filter((d) => d.overflow !== undefined)).toEqual([]);
  }, 30_000);
});
