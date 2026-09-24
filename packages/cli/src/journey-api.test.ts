import { describe, expect, it, vi } from "vitest";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FsJourneyStore, JourneyRegistry } from "@jevitate/journey";
import type { BrowserPort, BrowserSession, OpenOptions } from "@jevitate/playwright";
import { runJourneyProgrammatically, promoteJourney, UnknownJourneyError, JourneyRequiresAuthError } from "./journey-api.js";

/**
 * `--storage-state <file>` / `metadata.requiresAuth` (#118): a Journey authored behind a login
 * needs a deterministic authenticated pre-step to replay. These tests prove the storageState
 * path reaches `BrowserPort.open` and that a Journey declaring `requiresAuth` refuses BEFORE any
 * browser opens when no storageState was given — with no real Playwright/Chromium involved.
 */

async function seedJourney(dir: string, overrides: { requiresAuth?: boolean } = {}) {
  const store = new FsJourneyStore(dir);
  const registry = new JourneyRegistry(store);
  await registry.put({
    metadata: {
      id: "settings",
      name: "settings",
      promoted: true,
      params: [],
      createdAtIso: "2026-09-24T00:00:00Z",
      ...(overrides.requiresAuth !== undefined ? { requiresAuth: overrides.requiresAuth } : {}),
    },
    recording: { version: "1", site: "https://example.test", pages: [] },
  } as any);
}

function fakeBrowserPortFactory(opens: OpenOptions[]): () => BrowserPort {
  return () => ({
    async open(opts): Promise<BrowserSession> {
      opens.push(opts);
      return {
        page: {} as BrowserSession["page"],
        startTracing: vi.fn(async () => {}),
        stopTracingToFile: vi.fn(async () => {}),
        saveStorageState: vi.fn(async () => {}),
        admission: undefined,
        close: vi.fn(async () => {}),
      };
    },
  });
}

describe("runJourneyProgrammatically", () => {
  it("#118: --storage-state reaches BrowserPort.open", async () => {
    const dir = await mkdtemp(join(tmpdir(), "journey-api-"));
    await seedJourney(dir);
    const opens: OpenOptions[] = [];

    const result = await runJourneyProgrammatically({
      dir,
      id: "settings",
      params: {},
      storageState: "/tmp/state.json",
      browserPortFactory: fakeBrowserPortFactory(opens),
    });

    expect(result.outcome).not.toBe(undefined);
    expect(opens).toHaveLength(1);
    expect(opens[0]!.storageState).toBe("/tmp/state.json");
  });

  it("without --storage-state the session carries none", async () => {
    const dir = await mkdtemp(join(tmpdir(), "journey-api-"));
    await seedJourney(dir);
    const opens: OpenOptions[] = [];

    await runJourneyProgrammatically({ dir, id: "settings", params: {}, browserPortFactory: fakeBrowserPortFactory(opens) });

    expect(opens).toHaveLength(1);
    expect("storageState" in opens[0]!).toBe(false);
  });

  it("#118: a journey declaring metadata.requiresAuth refuses BEFORE any browser opens when no storageState is given", async () => {
    const dir = await mkdtemp(join(tmpdir(), "journey-api-"));
    await seedJourney(dir, { requiresAuth: true });
    const opens: OpenOptions[] = [];

    await expect(
      runJourneyProgrammatically({ dir, id: "settings", params: {}, browserPortFactory: fakeBrowserPortFactory(opens) }),
    ).rejects.toBeInstanceOf(JourneyRequiresAuthError);
    expect(opens).toHaveLength(0);
  });

  it("#118: a journey declaring metadata.requiresAuth proceeds (reaches the browser, authenticated) once --storage-state is given", async () => {
    const dir = await mkdtemp(join(tmpdir(), "journey-api-"));
    await seedJourney(dir, { requiresAuth: true });
    const opens: OpenOptions[] = [];

    const result = await runJourneyProgrammatically({
      dir,
      id: "settings",
      params: {},
      storageState: "/tmp/auth-fixture.json",
      browserPortFactory: fakeBrowserPortFactory(opens),
    });

    expect(opens).toHaveLength(1);
    expect(opens[0]!.storageState).toBe("/tmp/auth-fixture.json");
    expect(result.outcome).not.toBe(undefined);
  });

  it("throws UnknownJourneyError for an unknown journey id", async () => {
    const dir = await mkdtemp(join(tmpdir(), "journey-api-"));
    await expect(runJourneyProgrammatically({ dir, id: "does-not-exist", params: {} })).rejects.toBeInstanceOf(
      UnknownJourneyError,
    );
  });
});

describe("#124: promoteJourney", () => {
  it("promotes an unpromoted journey (human-approval gate) and persists the change", async () => {
    const dir = await mkdtemp(join(tmpdir(), "journey-api-"));
    const store = new FsJourneyStore(dir);
    await store.put({
      metadata: { id: "draft", name: "draft", promoted: false, params: [], createdAtIso: "2026-09-24T00:00:00Z" },
      recording: { version: "1", site: "https://example.test", pages: [] },
    } as any);

    const result = await promoteJourney(dir, "draft");
    expect(result.metadata.promoted).toBe(true);

    const reread = await store.get("draft");
    expect(reread?.metadata.promoted).toBe(true);
  });

  it("throws UnknownJourneyError for an unknown journey id", async () => {
    const dir = await mkdtemp(join(tmpdir(), "journey-api-"));
    await expect(promoteJourney(dir, "does-not-exist")).rejects.toBeInstanceOf(UnknownJourneyError);
  });
});
