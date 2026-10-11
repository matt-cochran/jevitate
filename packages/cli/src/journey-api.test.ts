import { describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FsJourneyStore, JourneyRegistry } from "@jevitate/journey";
import type { BrowserPort, BrowserSession, OpenOptions } from "@jevitate/playwright";
import { runJourneyProgrammatically, lintJourneyById, journeyFixtureBaseDir, resolveProjectMissionFixture, promoteJourney, UnknownJourneyError, WeakJourneyError, JourneyRequiresAuthError } from "./journey-api.js";

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

// === #488: relative upload fixture paths resolve against the project root ===

describe("#488 journeyFixtureBaseDir", () => {
  it("is the parent of the nearest .jevitate directory", async () => {
    const root = await mkdtemp(join(tmpdir(), "jev-base-"));
    await mkdir(join(root, ".jevitate"));
    expect(journeyFixtureBaseDir({ cwd: () => root })).toBe(root);
  });

  // 0.12.0 review H1: only a found project confines fixtures — never the git root or the cwd.
  it("is undefined inside a git repo with no .jevitate directory", async () => {
    const root = await mkdtemp(join(tmpdir(), "jev-base-"));
    await mkdir(join(root, ".git"));
    const nested = join(root, "a", "b");
    await mkdir(nested, { recursive: true });
    expect(journeyFixtureBaseDir({ cwd: () => nested })).toBeUndefined();
  });

  it("is undefined when only the home .jevitate exists", async () => {
    const home = await mkdtemp(join(tmpdir(), "jev-home-"));
    await mkdir(join(home, ".jevitate"));
    expect(journeyFixtureBaseDir({ cwd: () => home, homedir: () => home })).toBeUndefined();
  });
});

describe("0.12.0 review: resolveProjectMissionFixture", () => {
  it("refuses a mission fixture with fixture-no-root when there is no project", async () => {
    const root = await mkdtemp(join(tmpdir(), "jev-noproj-"));
    await writeFile(join(root, "data.csv"), "a,b");
    const err = await resolveProjectMissionFixture(join(root, "data.csv"), { cwd: () => root, homedir: () => root }).catch((e: unknown) => e);
    expect((err as { code?: string }).code).toBe("fixture-no-root");
  });
});

async function seedUploadJourney(dir: string, file = "receipt.pdf", promoted = true): Promise<void> {
  const store = new FsJourneyStore(dir);
  const registry = new JourneyRegistry(store);
  await registry.put({
    metadata: { id: "upload", name: "upload", promoted, params: [], createdAtIso: "2026-09-24T00:00:00Z" },
    recording: {
      version: "1",
      site: "https://example.test",
      pages: [
        {
          url: "/form",
          steps: [
            {
              step: {
                kind: "upload",
                target: { testId: "file" },
                file: { redacted: false, value: file },
                expect: { kind: "visible", target: { testId: "file" } },
              },
            },
          ],
        },
      ],
    },
  } as any);
}

function fakeUploadBrowserPortFactory(setInputFiles: (path: string) => Promise<void>): () => BrowserPort {
  return () => ({
    async open(): Promise<BrowserSession> {
      const locator = {
        count: vi.fn(async () => 1),
        isVisible: vi.fn(async () => true),
        setInputFiles: vi.fn(setInputFiles),
      };
      const page = {
        getByTestId: vi.fn(() => locator),
        getByRole: vi.fn(() => locator),
        getByLabel: vi.fn(() => locator),
        getByText: vi.fn(() => locator),
        locator: vi.fn(() => locator),
        url: vi.fn(() => "https://example.test/form"),
        goto: vi.fn(async () => {}),
      };
      return {
        page: page as unknown as BrowserSession["page"],
        startTracing: vi.fn(async () => {}),
        stopTracingToFile: vi.fn(async () => {}),
        saveStorageState: vi.fn(async () => {}),
        admission: undefined,
        close: vi.fn(async () => {}),
      };
    },
  });
}

describe("#488 runJourneyProgrammatically upload fixtures", () => {
  it("attaches a relative fixture resolved against fixtureBaseDir", async () => {
    const root = await mkdtemp(join(tmpdir(), "jev-run-"));
    await writeFile(join(root, "receipt.pdf"), "pdf");
    const dir = join(root, ".jevitate", "journeys");
    await mkdir(dir, { recursive: true });
    await seedUploadJourney(dir);
    const attached: string[] = [];

    await runJourneyProgrammatically({
      dir,
      id: "upload",
      params: {},
      fixtureBaseDir: root,
      browserPortFactory: fakeUploadBrowserPortFactory(async (p) => void attached.push(p)),
    });

    expect(attached).toEqual([join(root, "receipt.pdf")]);
  });
});

describe("#488 lintJourneyById upload fixtures", () => {
  it("errors on a missing relative upload fixture with the resolved path", async () => {
    const dir = await mkdtemp(join(tmpdir(), "jev-lint-"));
    await seedUploadJourney(dir);

    const result = await lintJourneyById(dir, "upload", { baseDir: "/proj", catalogDir: null });

    expect(result.findings.some((f) => f.rule === "upload-file-missing" && f.message.includes("/proj/receipt.pdf"))).toBe(true);
  });
});

describe("#498 promoteJourney upload fixtures outside the project root", () => {
  it("refuses to promote, even with --accept-weak, reporting upload-outside-project", async () => {
    const base = await realpath(await mkdtemp(join(tmpdir(), "jev-promote-outside-")));
    await mkdir(join(base, "proj"));
    await writeFile(join(base, "secret.txt"), "secret");
    const dir = join(base, "proj", ".jevitate", "journeys");
    await mkdir(dir, { recursive: true });
    await seedUploadJourney(dir, join(base, "secret.txt"), false);

    const err = await promoteJourney(dir, "upload", { fixtureBaseDir: join(base, "proj"), acceptWeak: "ok" }).catch((e: unknown) => e);

    expect(err instanceof WeakJourneyError && err.findings.map((f) => f.rule)).toEqual(["upload-outside-project"]);
  });
});

describe("0.12.0 review: promoteJourney refuses a sensitive upload fixture", () => {
  it("refuses to promote, even with --accept-weak, reporting upload-sensitive-file", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "jev-promote-sensitive-")));
    await writeFile(join(root, ".env"), "TOKEN=x");
    const dir = join(root, ".jevitate", "journeys");
    await mkdir(dir, { recursive: true });
    await seedUploadJourney(dir, ".env", false);

    const err = await promoteJourney(dir, "upload", { fixtureBaseDir: root, acceptWeak: "ok" }).catch((e: unknown) => e);

    expect(err instanceof WeakJourneyError && err.findings.map((f) => f.rule)).toEqual(["upload-sensitive-file"]);
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
