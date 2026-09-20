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
