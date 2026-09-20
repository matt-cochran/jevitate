import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadManifest, loadJourneyFiles, JevitateManifestSchema, SharedJourneyFileSchema } from "./manifest.js";
import { SourceValidationError } from "./errors.js";

const validManifest = {
  version: 1,
  source: "jevitate-gmail",
  sites: [{ origin: "https://mail.example.com", automationPolicy: "allowed", touBasis: "https://mail.example.com/tos" }],
};

const validJourney = {
  metadata: { id: "j1", name: "j1", promoted: true, params: [], createdAtIso: "2026-09-20T00:00:00Z" },
  recording: { version: "1", site: "mail.example.com", pages: [] },
  declaredOrigins: ["https://mail.example.com"],
};

function mkClone(): string {
  const dir = mkdtempSync(join(tmpdir(), "clone-"));
  mkdirSync(join(dir, "journeys"), { recursive: true });
  return dir;
}

describe("loadManifest", () => {
  it("loads a valid manifest", async () => {
    const dir = mkClone();
    writeFileSync(join(dir, "jevitate.json"), JSON.stringify(validManifest));
    const m = await loadManifest(dir);
    expect(m.source).toBe("jevitate-gmail");
  });

  it("throws SourceValidationError when jevitate.json is missing", async () => {
    const dir = mkClone();
    await expect(loadManifest(dir)).rejects.toBeInstanceOf(SourceValidationError);
  });

  it("throws on an unknown top-level key (.strict())", async () => {
    const dir = mkClone();
    writeFileSync(join(dir, "jevitate.json"), JSON.stringify({ ...validManifest, extra: true }));
    await expect(loadManifest(dir)).rejects.toBeInstanceOf(SourceValidationError);
  });

  it("throws on a version:2 manifest (forward-compat gate)", async () => {
    const dir = mkClone();
    writeFileSync(join(dir, "jevitate.json"), JSON.stringify({ ...validManifest, version: 2 }));
    await expect(loadManifest(dir)).rejects.toBeInstanceOf(SourceValidationError);
  });
});

describe("loadJourneyFiles", () => {
  it("loads valid journey files", async () => {
    const dir = mkClone();
    writeFileSync(join(dir, "journeys", "j1.journey.json"), JSON.stringify(validJourney));
    const files = await loadJourneyFiles(dir);
    expect(files).toHaveLength(1);
    expect(files[0].metadata.id).toBe("j1");
  });

  it("throws when a journey file is missing declaredOrigins", async () => {
    const dir = mkClone();
    const { declaredOrigins, ...bad } = validJourney;
    writeFileSync(join(dir, "journeys", "bad.journey.json"), JSON.stringify(bad));
    await expect(loadJourneyFiles(dir)).rejects.toBeInstanceOf(SourceValidationError);
  });

  it("fails the WHOLE load when one journey file is corrupt (fail-closed, unlike tolerant FsJourneyStore.list)", async () => {
    const dir = mkClone();
    writeFileSync(join(dir, "journeys", "j1.journey.json"), JSON.stringify(validJourney));
    writeFileSync(join(dir, "journeys", "corrupt.journey.json"), "{ not json");
    await expect(loadJourneyFiles(dir)).rejects.toBeInstanceOf(SourceValidationError);
  });

  it("ignores non-.journey.json files in the directory", async () => {
    const dir = mkClone();
    writeFileSync(join(dir, "journeys", "j1.journey.json"), JSON.stringify(validJourney));
    writeFileSync(join(dir, "journeys", "README.md"), "not a journey");
    const files = await loadJourneyFiles(dir);
    expect(files).toHaveLength(1);
  });
});

describe("SharedJourneyFileSchema", () => {
  it("requires at least one declaredOrigin", () => {
    expect(() => SharedJourneyFileSchema.parse({ ...validJourney, declaredOrigins: [] })).toThrow();
  });
});

describe("JevitateManifestSchema", () => {
  it("parses a valid manifest", () => {
    expect(JevitateManifestSchema.parse(validManifest).version).toBe(1);
  });
});
