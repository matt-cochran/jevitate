import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Page } from "playwright";
import { startServer } from "@jevitate/example-site";
import { PlaywrightBrowserPort, type BrowserSession } from "@jevitate/playwright";
import { CastActor, BrowseTheWeb } from "@jevitate/screenplay";
import { FakeJudgmentGateway, FakeGenerationGateway } from "@jevitate/ai-core";
import { runInductionMission } from "./induction.js";

let site: { url: string; close(): Promise<void> };
let profileDir: string;
let session: BrowserSession;
let page: Page;
let actor: CastActor;

const noDefects = () =>
  new FakeJudgmentGateway({ isDefect: { kind: "noul", value: false, probability: 0 } });

beforeAll(async () => {
  site = await startServer();
  profileDir = await mkdtemp(join(tmpdir(), "jevitate-induction-"));
  const browserPort = new PlaywrightBrowserPort();
  session = await browserPort.open({ profileDir, headless: true, allowedOrigins: [site.url], baseUrl: site.url });
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
  await rm(profileDir, { recursive: true, force: true });
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
  test("discovers both thread states from /inbox and exercises both transitions", async () => {
    const result = await runInductionMission({
      page,
      actor,
      judgment: noDefects(),
      generation: new FakeGenerationGateway(),
      seedUrl: `${site.url}/inbox`,
      allowlist: [site.url],
    });
    expect(result.outcome).toBe("exhausted");
    // inbox + thread-t-1 + thread-t-2 = 3 distinct states. The thread ids ("t-1",
    // "t-2") are NOT id-normalized by urlTemplate (they contain a letter), so the
    // two threads template to distinct states — exactly the coverage the mission
    // should find.
    expect(result.coverage.statesVisited).toBe(3);
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
    });
    expect(result.outcome).toBe("exhausted");
    expect(result.coverage.defects.length).toBeGreaterThan(0);
    for (const d of result.coverage.defects) {
      expect(d.recording.pages.length).toBeGreaterThan(0);
    }
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
