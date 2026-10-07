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

  it("#149: --viewport/--device (opts.emulation) reaches BrowserPort.open", async () => {
    const dir = await mkdtemp(join(tmpdir(), "journey-api-"));
    await seedJourney(dir);
    const opens: OpenOptions[] = [];

    await runJourneyProgrammatically({
      dir,
      id: "settings",
      params: {},
      emulation: { device: "iPhone 13" },
      browserPortFactory: fakeBrowserPortFactory(opens),
    });

    expect(opens).toHaveLength(1);
    expect(opens[0]!.device).toBe("iPhone 13");
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
      // #401: strengthened so the promote gate does not refuse it (an effect assertion, not just visibility).
      recording: {
        version: "1",
        site: "https://example.test",
        pages: [
          { url: "/", steps: [{ step: { kind: "assert", check: { kind: "textIncludes", target: { testId: "ok" }, text: "OK" } } }] },
        ],
      },
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

describe("#399: an error escaping a run never carries a secret parameter", () => {
  it("a crash whose message echoes the navigated URL comes back redacted (same error class)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "journey-api-399-"));
    await new FsJourneyStore(dir).put({
      metadata: { id: "invite", name: "invite", promoted: true, params: [], parameters: [{ name: "inviteToken", secret: true }], createdAtIso: "2026-10-07T00:00:00Z" },
      recording: {
        version: "1",
        site: "https://example.test",
        pages: [{ url: "/accept", steps: [{ step: { kind: "navigate", url: "/accept?token=${inviteToken}", expect: { kind: "urlIncludes", text: "/accept" } } }] }],
      },
    });
    const secret = "tok it's/9";
    class BrowserCrash extends Error {}
    const crashing = (): BrowserPort => ({
      async open(): Promise<BrowserSession> {
        throw new BrowserCrash(`browser crashed at https://example.test/accept?token=${encodeURIComponent(secret)} (${secret})`);
      },
    });
    const err = await runJourneyProgrammatically({ dir, id: "invite", params: { inviteToken: secret }, browserPortFactory: crashing }).catch((e: unknown) => e as Error);
    expect(err).toBeInstanceOf(BrowserCrash);
    expect(err.message).toContain("browser crashed");
    expect(err.message).not.toContain(secret);
    expect(err.message).not.toContain(encodeURIComponent(secret));
    expect(String(err.stack)).not.toContain(secret);
  });
});

describe("#399: a fixture output used as a secret param never comes back in the run's fixture record", () => {
  it("the record's outputs and log are redacted with the run's secret params", async () => {
    const dir = await mkdtemp(join(tmpdir(), "journey-api-399fx-"));
    await new FsJourneyStore(dir).put({
      metadata: { id: "invite", name: "invite", promoted: true, params: ["inviteToken"], parameters: [{ name: "inviteToken", secret: true }], createdAtIso: "2026-10-07T00:00:00Z" },
      recording: {
        version: "1",
        site: "https://example.test",
        pages: [{ url: "/accept", steps: [{ step: { kind: "navigate", url: "/accept?token=${inviteToken}", expect: { kind: "urlIncludes", text: "/accept" } } }] }],
      },
    });
    const token = "fx-tok-399";
    const fx = {
      setup: vi.fn(async () => {}),
      restore: vi.fn(async () => {}),
      bindings: () => ({ values: { inviteToken: token }, secretNames: new Set<string>() }),
      record: () => ({ identity: "h", specHash: "s", outputs: { inviteToken: token }, secretOutputs: [], cycles: 1, log: [{ ok: true, url: `/api/invite -> ${token}` }] }),
    };
    const opens: OpenOptions[] = [];
    const result = await runJourneyProgrammatically({
      dir,
      id: "invite",
      params: { inviteToken: "${setup.inviteToken}" },
      browserPortFactory: fakeBrowserPortFactory(opens),
      fixtures: () => fx as any,
    });
    expect(result.fixtures).toBeDefined();
    expect(JSON.stringify(result)).not.toContain(token);
  });
});
