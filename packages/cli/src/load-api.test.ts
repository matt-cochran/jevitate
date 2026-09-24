import { describe, it, expect, vi } from "vitest";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FsJourneyStore, JourneyRegistry } from "@jevitate/journey";
import { UnauthorizedLoadTargetError } from "@jevitate/load";
import type { BrowserPort, BrowserSession, OpenOptions } from "@jevitate/playwright";
import type { RunPolicy } from "@jevitate/domain";
import { runJourneyLoadTest, UnknownLoadJourneyError } from "./load-api.js";
import { JourneyRequiresAuthError } from "./journey-api.js";

async function seedJourney(dir: string, site = "https://example.com", overrides: { requiresAuth?: boolean } = {}) {
  const store = new FsJourneyStore(dir);
  const registry = new JourneyRegistry(store);
  await registry.put({
    metadata: {
      id: "checkout",
      name: "checkout",
      promoted: true,
      params: [],
      createdAtIso: "2026-09-20T00:00:00Z",
      ...(overrides.requiresAuth !== undefined ? { requiresAuth: overrides.requiresAuth } : {}),
    },
    recording: { version: "1", site, pages: [] },
  } as any);
}

type FakeSession = BrowserSession & { close: ReturnType<typeof vi.fn> };

/**
 * A fake `BrowserPort` that never launches a real browser — each `open()`
 * call returns a fresh fake `BrowserSession` whose `close()` is a spy, and
 * every session it creates is pushed to `sessions` so a test can assert on
 * the whole pool's lifecycle (opened count, closed count) with no real
 * Playwright/Chromium involved.
 */
function fakeBrowserPortFactory(sessions: FakeSession[], opens?: OpenOptions[]): () => BrowserPort {
  return () => ({
    async open(opts): Promise<BrowserSession> {
      opens?.push(opts);
      const session: FakeSession = {
        page: {} as BrowserSession["page"],
        startTracing: vi.fn(async () => {}),
        stopTracingToFile: vi.fn(async () => {}),
        saveStorageState: vi.fn(async () => {}),
        admission: undefined,
        close: vi.fn(async () => {}),
      };
      sessions.push(session);
      return session;
    },
  });
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

  it("closes every per-actor Playwright session exactly once after its iterations complete (no leak) — no real browser", async () => {
    const dir = await mkdtemp(join(tmpdir(), "load-api-"));
    await seedJourney(dir);
    const sessions: FakeSession[] = [];

    const report = await runJourneyLoadTest({
      dir,
      id: "checkout",
      params: {},
      concurrency: 3,
      iterationsPerActor: 2,
      seed: 1,
      authorizedOrigins: ["https://example.com"],
      browserPortFactory: fakeBrowserPortFactory(sessions),
    });

    expect(report.provenance).toBe("measured");
    expect(sessions).toHaveLength(3); // one session opened per actor
    for (const session of sessions) {
      expect(session.close).toHaveBeenCalledTimes(1); // closed exactly once, after both iterations
    }
  });

  it("still closes each per-actor session when every run() throws (cleanup must not depend on success)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "load-api-"));
    await seedJourney(dir);
    const sessions: FakeSession[] = [];

    // An incomplete RunPolicy makes JourneyRunner.run() reject with
    // PolicyEnforcementError on every call, before it ever touches the
    // interpreter/page — proves the cleanup runs on the error path too,
    // without needing a real browser/page failure.
    const incompletePolicy = { selfHeal: { mode: "fail-closed" } } as unknown as RunPolicy;

    const report = await runJourneyLoadTest({
      dir,
      id: "checkout",
      params: {},
      concurrency: 2,
      iterationsPerActor: 3,
      seed: 1,
      authorizedOrigins: ["https://example.com"],
      policy: incompletePolicy,
      browserPortFactory: fakeBrowserPortFactory(sessions),
    });

    expect(report.errorRuns).toBe(6); // 2 actors * 3 iterations, every run() rejected
    expect(sessions).toHaveLength(2);
    for (const session of sessions) {
      expect(session.close).toHaveBeenCalledTimes(1);
    }
  });

  it("#118: --storage-state reaches every pool member's BrowserPort.open", async () => {
    const dir = await mkdtemp(join(tmpdir(), "load-api-"));
    await seedJourney(dir);
    const sessions: FakeSession[] = [];
    const opens: OpenOptions[] = [];

    await runJourneyLoadTest({
      dir,
      id: "checkout",
      params: {},
      concurrency: 2,
      iterationsPerActor: 1,
      seed: 1,
      authorizedOrigins: ["https://example.com"],
      storageState: "/tmp/state.json",
      browserPortFactory: fakeBrowserPortFactory(sessions, opens),
    });

    expect(opens).toHaveLength(2);
    for (const opts of opens) expect(opts.storageState).toBe("/tmp/state.json");
  });

  it("#118: a journey declaring metadata.requiresAuth refuses BEFORE any browser opens when no --storage-state is given", async () => {
    const dir = await mkdtemp(join(tmpdir(), "load-api-"));
    await seedJourney(dir, "https://example.com", { requiresAuth: true });
    const sessions: FakeSession[] = [];

    await expect(
      runJourneyLoadTest({
        dir,
        id: "checkout",
        params: {},
        concurrency: 1,
        iterationsPerActor: 1,
        seed: 1,
        authorizedOrigins: ["https://example.com"],
        browserPortFactory: fakeBrowserPortFactory(sessions),
      }),
    ).rejects.toBeInstanceOf(JourneyRequiresAuthError);
    expect(sessions).toHaveLength(0);
  });
});
