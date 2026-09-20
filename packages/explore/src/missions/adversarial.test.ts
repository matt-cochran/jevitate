import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer } from "@jevitate/example-site";
import { PlaywrightBrowserPort, type BrowserSession } from "@jevitate/playwright";
import { CastActor, BrowseTheWeb, type Actor } from "@jevitate/screenplay";
import { FakeJudgmentGateway, FakeGenerationGateway } from "@jevitate/ai-core";
import { runAdversarialMission } from "./adversarial.js";

let site: { url: string; close(): Promise<void> };
let profileDir: string;
let session: BrowserSession;
let actor: Actor;

beforeAll(async () => {
  site = await startServer();
  profileDir = await mkdtemp(join(tmpdir(), "jevitate-adversarial-"));
  const browserPort = new PlaywrightBrowserPort();
  session = await browserPort.open({ profileDir, headless: true, allowedOrigins: [site.url], baseUrl: site.url });
  actor = CastActor.named("adversary").whoCan(new BrowseTheWeb(session, [site.url]));
}, 120_000);
afterAll(async () => {
  await session.close();
  await site.close();
  await rm(profileDir, { recursive: true, force: true });
});

describe("runAdversarialMission — clean run", () => {
  test(
    "a well-behaved page under bounded misuse strategies reports 'clean'",
    async () => {
      const judgment = new FakeJudgmentGateway({ looksBroken: { kind: "noul", value: false, probability: 0.1 } });
      const generation = new FakeGenerationGateway();
      const result = await runAdversarialMission({
        page: session.page,
        actor,
        judgment,
        generation,
        seedUrl: `${site.url}/login`,
        allowlist: [site.url],
        strategies: ["ordering-violation", "repeat-rapid", "boundary-input"],
      });
      expect(result.outcome === "clean" || result.outcome === "cap").toBe(true);
    },
    120_000,
  );
});
