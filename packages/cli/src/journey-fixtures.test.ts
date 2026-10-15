import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FsJourneyStore, type Journey } from "@jevitate/journey";
import { parseAssertionSpec } from "./explore-api.js";
import { runAuthorJourney } from "./explore-author.js";
import { FixtureSpecError } from "./mission-fixtures.js";
import { fixtureDriftFor, recordedFixturesFor, withRecordedFixtures } from "./journey-fixtures.js";

/**
 * #544 part B: a Journey authored under --fixtures records the file (repo-relative, POSIX) and spec
 * hash; replays pick it up when no --fixtures flag is given.
 */

const SITE = "https://fixture.test";
const BOUNDS = { allowlist: [SITE], baseUrl: SITE };
const SPEC = { setup: [{ method: "POST", url: `${SITE}/seed` }], restore: [{ method: "POST", url: `${SITE}/reset` }] };

let root: string;
let journeysDir: string;
let fixturesPath: string;
const layout = () => ({ cwd: () => root });

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "jev-journey-fixtures-"));
  mkdirSync(join(root, ".jevitate"));
  mkdirSync(join(root, "fixtures"));
  journeysDir = join(root, ".jevitate", "journeys");
  fixturesPath = join(root, "fixtures", "seed.json");
  writeFileSync(fixturesPath, JSON.stringify(SPEC));
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

const authored: Journey = {
  metadata: { id: "fx-journey", name: "Fx", promoted: false, params: [], authoredBy: "jev-driven", createdAtIso: "2026-10-15T00:00:00Z" },
  recording: { version: "1.0", site: SITE, pages: [] },
};

async function author(extra: { fixturesFile?: string }): Promise<Journey | null> {
  await runAuthorJourney({
    url: `${SITE}/start`,
    goal: "g",
    successAssertion: parseAssertionSpec("visible:testId=done"),
    allowlist: [SITE],
    journeysDir,
    journeyId: "fx-journey",
    journeyName: "Fx",
    layout: layout(),
    authorImpl: async () => ({ outcome: "authored", journey: authored }),
    ...extra,
  });
  return new FsJourneyStore(journeysDir).get("fx-journey");
}

async function store(fixtures?: { file: string; specHash: string }): Promise<void> {
  await new FsJourneyStore(journeysDir).put({ ...authored, metadata: { ...authored.metadata, ...(fixtures === undefined ? {} : { fixtures }) } });
}

describe("authored Journey records its fixtures (#544)", () => {
  it("records the fixtures file relative to the repository root", async () => {
    expect((await author({ fixturesFile: fixturesPath }))?.metadata.fixtures?.file).toBe("fixtures/seed.json");
  });

  it("records the content hash of the fixture spec", async () => {
    expect((await author({ fixturesFile: fixturesPath }))?.metadata.fixtures?.specHash).toMatch(/^[0-9a-f]{16}$/);
  });

  it("records only the file and the hash", async () => {
    expect(Object.keys((await author({ fixturesFile: fixturesPath }))?.metadata.fixtures ?? {}).sort()).toEqual(["file", "specHash"]);
  });

  it("records nothing when no fixtures file was given", async () => {
    expect((await author({}))?.metadata.fixtures).toBeUndefined();
  });

  it("stores the recorded path with POSIX separators", () => {
    expect(recordedFixturesFor(fixturesPath, BOUNDS, layout()).file).not.toContain("\\");
  });
});

describe("recorded fixtures on replay (#544)", () => {
  it("uses the recorded file when no --fixtures flag is given", async () => {
    await store({ file: "fixtures/seed.json", specHash: recordedFixturesFor(fixturesPath, BOUNDS, layout()).specHash });
    const r = await withRecordedFixtures({}, { dir: journeysDir, id: "fx-journey", deps: layout() });
    expect(r.flags.fixtures).toBe(fixturesPath);
  });

  it("lets the --fixtures flag override the recorded file", async () => {
    await store({ file: "fixtures/seed.json", specHash: "0000000000000000" });
    const r = await withRecordedFixtures({ fixtures: "/elsewhere/other.json" }, { dir: journeysDir, id: "fx-journey", deps: layout() });
    expect(r.flags.fixtures).toBe("/elsewhere/other.json");
  });

  it("leaves flags alone for a Journey that records no fixtures", async () => {
    await store();
    const r = await withRecordedFixtures({}, { dir: journeysDir, id: "fx-journey", deps: layout() });
    expect(r.flags.fixtures).toBeUndefined();
  });

  it("refuses a missing recorded file naming the file", async () => {
    await store({ file: "fixtures/gone.json", specHash: "0000000000000000" });
    await expect(withRecordedFixtures({}, { dir: journeysDir, id: "fx-journey", deps: layout() })).rejects.toThrow(/fixtures\/gone\.json/);
  });

  it("names the --fixtures flag to override a missing recorded file", async () => {
    await store({ file: "fixtures/gone.json", specHash: "0000000000000000" });
    await expect(withRecordedFixtures({}, { dir: journeysDir, id: "fx-journey", deps: layout() })).rejects.toThrow(/--fixtures/);
  });

  it("refuses a missing recorded file as a fixture spec error", async () => {
    await store({ file: "fixtures/gone.json", specHash: "0000000000000000" });
    await expect(withRecordedFixtures({}, { dir: journeysDir, id: "fx-journey", deps: layout() })).rejects.toBeInstanceOf(FixtureSpecError);
  });

  it("reports no drift when the file still has the recorded hash", async () => {
    await store({ file: "fixtures/seed.json", specHash: recordedFixturesFor(fixturesPath, BOUNDS, layout()).specHash });
    const r = await withRecordedFixtures({}, { dir: journeysDir, id: "fx-journey", deps: layout() });
    expect(fixtureDriftFor(r.recorded, BOUNDS)).toBeUndefined();
  });

  it("reports drift when the file's hash differs from the recorded one", async () => {
    await store({ file: "fixtures/seed.json", specHash: "0000000000000000" });
    const r = await withRecordedFixtures({}, { dir: journeysDir, id: "fx-journey", deps: layout() });
    expect(fixtureDriftFor(r.recorded, BOUNDS)).toMatchObject({ file: "fixtures/seed.json", recordedSpecHash: "0000000000000000" });
  });
});
