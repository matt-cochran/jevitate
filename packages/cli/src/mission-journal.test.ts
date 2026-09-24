import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MissionJournal, closeQuietly, resultPathFor, writeMissionResult } from "./mission-journal.js";
import type { TranscriptEntry } from "@jevitate/explore";

const entry = (step: number): TranscriptEntry => ({
  step,
  op: "click",
  target: `button "B${step}"`,
  confidence: null,
  chosenBy: "strategy",
  actOk: true,
  url: "http://x.test/",
  signature: `s${step}`,
  controlCount: 1,
});

let dir: string | undefined;
afterEach(async () => {
  if (dir !== undefined) await rm(dir, { recursive: true, force: true });
});

describe("MissionJournal — crash-safe incremental persistence (owner ruling 3)", () => {
  it("flushes the transcript and partial Recording after EVERY step, before the run ends", async () => {
    dir = await mkdtemp(join(tmpdir(), "jev-journal-"));
    const journal = new MissionJournal(join(dir, "adversarial-x.json"));
    const all: TranscriptEntry[] = [];
    for (const step of [1, 2]) {
      all.push(entry(step));
      journal.onTranscriptEntry(entry(step), all);
      // Already on disk — a crash right now loses nothing.
      expect(JSON.parse(await readFile(journal.transcriptPath, "utf8"))).toEqual(all);
    }
    journal.onRecording({ version: "1.0.0", site: "x", pages: [{ url: "/", steps: [] }] });
    expect(JSON.parse(await readFile(join(dir, "adversarial-x.json"), "utf8"))).toMatchObject({ site: "x" });
    expect(journal.transcriptPath).toBe(join(dir, "adversarial-x.transcript.json"));
  });

  it("persists the typed result next to the Recording", async () => {
    dir = await mkdtemp(join(tmpdir(), "jev-journal-"));
    const path = writeMissionResult(join(dir, "coverage-x.json"), "crashed", 2, { a: 1 });
    expect(path).toBe(resultPathFor(join(dir, "coverage-x.json")));
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({ missionOutcome: "crashed", exitCode: 2, result: { a: 1 } });
  });

  it("a failing teardown never replaces the run's typed result with an exception", async () => {
    await expect(closeQuietly({ close: async () => Promise.reject(new Error("browser gone")) })).resolves.toBeUndefined();
  });
});
