import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Page } from "playwright";
import { startServer } from "@jevitate/example-site";
import { PlaywrightBrowserPort, type BrowserSession } from "@jevitate/playwright";
import { CastActor, BrowseTheWeb } from "@jevitate/screenplay";
import { runFeatureMission } from "./feature.js";
import type { CapabilityScope } from "../feature/capability-scope.js";

let site: { url: string; close(): Promise<void> };
let profileDir: string;
let session: BrowserSession;
let actor: CastActor;

beforeAll(async () => {
  site = await startServer();
  profileDir = await mkdtemp(join(tmpdir(), "jevitate-feature-"));
  const browserPort = new PlaywrightBrowserPort();
  session = await browserPort.open({ profileDir, headless: true, allowedOrigins: [site.url], baseUrl: site.url });
  actor = CastActor.named("feature-explorer").whoCan(new BrowseTheWeb(session, [site.url]));
}, 120_000);

afterAll(async () => {
  await session?.close();
  await site?.close();
  if (profileDir) await rm(profileDir, { recursive: true, force: true });
});

describe("runFeatureMission — single path", () => {
  test(
    "a sign-in submit exhausts the scope without discovering a new in-scope state",
    async () => {
      const scope: CapabilityScope = { name: "sign in", originAllowlist: [site.url], routeGlobs: ["/login"] };
      const result = await runFeatureMission({
        page: session.page as Page,
        actor,
        seedUrl: `${site.url}/login`,
        allowlist: [site.url],
        scope,
      });
      expect(result.outcome).toBe("exhausted");
      expect(result.coverage.statesExercised).toBe(1);
      expect(result.coverage.pathsDiscovered).toBeGreaterThanOrEqual(1);
    },
    120_000,
  );
});
