import { describe, it, expect } from "vitest";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FsJourneyStore, JourneyRegistry } from "@doit/journey";
import { UnauthorizedLoadTargetError } from "@doit/load";
import { runJourneyLoadTest, UnknownLoadJourneyError } from "./load-api.js";

async function seedJourney(dir: string) {
  const store = new FsJourneyStore(dir);
  const registry = new JourneyRegistry(store);
  await registry.put({
    metadata: {
      id: "checkout",
      name: "checkout",
      promoted: true,
      params: [],
      createdAtIso: "2026-09-20T00:00:00Z",
    },
    recording: { version: "1", site: "https://example.com", pages: [] },
  } as any);
}

describe("runJourneyLoadTest", () => {
  it("throws UnauthorizedLoadTargetError before opening any browser when the journey's site is not authorized", async () => {
    const dir = await mkdtemp(join(tmpdir(), "load-api-"));
    await seedJourney(dir);

    await expect(
      runJourneyLoadTest({
        dir,
        id: "checkout",
        params: {},
        concurrency: 1,
        iterationsPerActor: 1,
        seed: 1,
        authorizedOrigins: ["https://some-other-origin.example.com"],
      }),
    ).rejects.toBeInstanceOf(UnauthorizedLoadTargetError);
  });

  it("throws UnknownLoadJourneyError for an unknown journey id", async () => {
    const dir = await mkdtemp(join(tmpdir(), "load-api-"));

    await expect(
      runJourneyLoadTest({
        dir,
        id: "does-not-exist",
        params: {},
        concurrency: 1,
        iterationsPerActor: 1,
        seed: 1,
        authorizedOrigins: ["https://example.com"],
      }),
    ).rejects.toBeInstanceOf(UnknownLoadJourneyError);
  });
});
