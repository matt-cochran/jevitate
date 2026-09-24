import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProfileManager } from "@jevitate/daemon";
import { FsJourneyStore, JourneyRegistry } from "@jevitate/journey";
import type { BrowserPort, OpenOptions } from "@jevitate/playwright";
import { buildProgram } from "./program.js";

/**
 * #118: `--storage-state <file>` on `journey run` / `load run` — the CLI-flag-wiring
 * counterpart to `journey-api.test.ts`/`load-api.test.ts`'s programmatic-surface tests. The
 * browser port is a capturing fake that never opens a real browser (mirrors
 * `explore-storage-state.test.ts`'s established pattern for this codebase).
 */

function capture(): { program: ReturnType<typeof buildProgram>; lines: string[]; opens: OpenOptions[] } {
  const opens: OpenOptions[] = [];
  const port: BrowserPort = {
    async open(opts) {
      opens.push(opts);
      return {
        page: {} as never,
        startTracing: async () => {},
        stopTracingToFile: async () => {},
        saveStorageState: async () => {},
        admission: undefined,
        close: async () => {},
      };
    },
  };
  const lines: string[] = [];
  const program = buildProgram({
    profiles: new ProfileManager("/unused-in-these-tests"),
    explore: { browserPortFactory: () => port },
  });
  program.configureOutput({ writeOut: (s) => lines.push(s) });
  program.exitOverride();
  return { program, lines, opens };
}

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

function withStateFile(fn: (path: string) => Promise<void>): () => Promise<void> {
  return async () => {
    const dir = mkdtempSync(join(tmpdir(), "jev-journey-state-"));
    const path = join(dir, "state.json");
    writeFileSync(path, JSON.stringify({ cookies: [], origins: [] }));
    try {
      await fn(path);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };
}

describe("journey run --storage-state", () => {
  it(
    "reaches BrowserPort.open and lets an authenticated (metadata.requiresAuth) journey run",
    withStateFile(async (state) => {
      const journeysDir = mkdtempSync(join(tmpdir(), "jev-journeys-"));
      mkdirSync(journeysDir, { recursive: true });
      await seedJourney(journeysDir, { requiresAuth: true });
      const { program, lines, opens } = capture();

      await program.parseAsync(
        ["journey", "run", "settings", "--dir", journeysDir, "--storage-state", state, "--json"],
        { from: "user" },
      );

      expect(opens).toHaveLength(1);
      expect(opens[0]!.storageState).toBe(state);
      const parsed = JSON.parse(lines.join(""));
      expect(parsed.ok).toBe(true);
    }),
  );

  it("a journey declaring metadata.requiresAuth fails fast (E_JOURNEY_REQUIRES_AUTH, no browser opened) with no --storage-state", async () => {
    const journeysDir = mkdtempSync(join(tmpdir(), "jev-journeys-"));
    await seedJourney(journeysDir, { requiresAuth: true });
    const { program, lines, opens } = capture();

    await program.parseAsync(["journey", "run", "settings", "--dir", journeysDir, "--json"], { from: "user" });

    expect(opens).toHaveLength(0);
    const parsed = JSON.parse(lines.join(""));
    expect(parsed).toMatchObject({ ok: false, error: { code: "E_JOURNEY_REQUIRES_AUTH" } });
  });

  it("fails fast (no browser opened) when the storage state file does not exist", async () => {
    const journeysDir = mkdtempSync(join(tmpdir(), "jev-journeys-"));
    await seedJourney(journeysDir);
    const { program, lines, opens } = capture();

    await program.parseAsync(
      ["journey", "run", "settings", "--dir", journeysDir, "--storage-state", "/nope/state.json", "--json"],
      { from: "user" },
    );

    expect(opens).toHaveLength(0);
    const parsed = JSON.parse(lines.join(""));
    expect(parsed).toMatchObject({ ok: false, error: { code: "E_JOURNEY_RUN_ARGS" } });
  });
});

describe("load run --storage-state", () => {
  it(
    "reaches BrowserPort.open for every pool member",
    withStateFile(async (state) => {
      const journeysDir = mkdtempSync(join(tmpdir(), "jev-journeys-"));
      await seedJourney(journeysDir);
      const { program, opens } = capture();

      await program.parseAsync(
        [
          "load", "run", "settings",
          "--dir", journeysDir,
          "--authorized-origin", "https://example.test",
          "--storage-state", state,
          "--json",
        ],
        { from: "user" },
      );

      expect(opens.length).toBeGreaterThan(0);
      for (const opts of opens) expect(opts.storageState).toBe(state);
    }),
  );
});
