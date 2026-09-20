import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer } from "@doit/example-site";
import { FsJourneyStore, JourneyRegistry } from "@doit/journey";
import { runJourneyLoadTest } from "./load-api.js";

/**
 * Minimal real-browser smoke test: a single-navigate Journey against a real
 * (local, ephemeral) example-site instance, run through the FULL `load run`
 * pipeline with a small pool. Mirrors
 * `packages/runtime/src/journey-login-e2e.test.ts` in spirit — a real
 * headless Playwright session, not a fake.
 *
 * NOTE: `startServer` takes a plain port number (default 0), not an options
 * object — verified against `apps/example-site/src/index.ts`, which differs
 * from an earlier sketch of this test.
 *
 * NOTE: the Recording fixture below was checked against the real
 * `RecordingSchema` (`packages/recording/src/schema.ts`): a `navigate` step
 * requires an `expect` assertion (an earlier sketch omitted it, which would
 * fail `JourneySchema.parse` on read). `urlIncludes` with `text: "/login"`
 * mirrors the existing `journey-login-e2e.test.ts` fixture's use of the
 * example-site's real `/login` route.
 */
describe("load run — real-browser smoke test", () => {
  let server: Awaited<ReturnType<typeof startServer>>;
  let baseUrl: string;
  let journeysDir: string;

  beforeAll(async () => {
    server = await startServer(0);
    baseUrl = server.url;
    journeysDir = await mkdtemp(join(tmpdir(), "load-e2e-journeys-"));

    const store = new FsJourneyStore(journeysDir);
    const registry = new JourneyRegistry(store);
    await registry.put({
      metadata: {
        id: "home",
        name: "home",
        promoted: true,
        params: [],
        createdAtIso: "2026-09-20T00:00:00Z",
      },
      recording: {
        version: "1",
        site: baseUrl,
        pages: [
          {
            url: `${baseUrl}/login`,
            steps: [
              {
                step: {
                  kind: "navigate",
                  url: "/login",
                  expect: { kind: "urlIncludes", text: "/login" },
                },
              },
            ],
          },
        ],
      },
    });
  });

  afterAll(async () => {
    await server.close();
  });

  it(
    "produces a measured CapacityReport for a 2-actor, 1-iteration pool",
    async () => {
      const report = await runJourneyLoadTest({
        dir: journeysDir,
        id: "home",
        params: {},
        concurrency: 2,
        iterationsPerActor: 1,
        seed: 1,
        authorizedOrigins: [baseUrl],
      });
      expect(report.provenance).toBe("measured");
      expect(report.totalRuns).toBe(2);
      expect(report.okRuns + report.quarantinedRuns + report.errorRuns).toBe(2);
    },
    30_000,
  );
});
