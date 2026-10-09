import { beforeEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FsJourneyStore, type Journey } from "@jevitate/journey";
import type { Step } from "@jevitate/recording";
import { isStepIdOnlyChange } from "./journey-anchor-gate.js";
import { migrateStepIds } from "./journey-migrate-api.js";
import { journeyReviewHash } from "./journey-review.js";

/** #467b: the one-time step-id backfill. */

const CLICK: Step = { kind: "click", target: { testId: "go" }, expect: { kind: "textIncludes", target: { testId: "ok" }, text: "OK" } };
const ASSERT: Step = { kind: "assert", check: { kind: "textIncludes", target: { testId: "ok" }, text: "OK" } };

const legacy = (id: string, promoted = false): Journey => ({
  metadata: {
    id,
    name: id,
    promoted,
    params: [],
    createdAtIso: "2026-10-09T00:00:00Z",
    anchors: [{ name: "done", step: 2 }],
  },
  recording: { version: "1", site: "https://example.test", pages: [{ url: "/", steps: [{ step: CLICK }, { step: ASSERT }] }] },
});

let dir: string;
const file = (id: string): string => join(dir, `${id}.json`);
const seed = async (j: Journey): Promise<void> => writeFile(file(j.metadata.id), JSON.stringify(j));
const read = async (id: string): Promise<string> => readFile(file(id), "utf8");
const run = (dryRun: boolean) => migrateStepIds({ journeysDir: dir, projectDir: null, dryRun });

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "jev-467-migrate-"));
});

describe("#467b migrateStepIds", () => {
  it("--dry-run writes nothing", async () => {
    await seed(legacy("a"));
    const before = await read("a");
    await run(true);
    expect(await read("a")).toBe(before);
  });

  it("--dry-run reports the steps it would give ids", async () => {
    await seed(legacy("a"));
    expect((await run(true)).totals.stepsMinted).toBe(2);
  });

  it("gives every step an id", async () => {
    await seed(legacy("a"));
    await run(false);
    const steps = (await new FsJourneyStore(dir).get("a"))!.recording.pages.flatMap((p) => p.steps);
    expect(steps.every((s) => s.stepId !== undefined)).toBe(true);
  });

  it("stamps the anchor with its step's id", async () => {
    await seed(legacy("a"));
    await run(false);
    const j = (await new FsJourneyStore(dir).get("a"))!;
    expect(j.metadata.anchors?.[0]?.stepId).toBe(j.recording.pages[0]!.steps[1]!.stepId);
  });

  it("is idempotent: a second run changes nothing", async () => {
    await seed(legacy("a"));
    await run(false);
    expect((await run(false)).totals.files).toBe(0);
  });

  it("leaves the files byte-identical on the second run", async () => {
    await seed(legacy("a"));
    await run(false);
    const once = await read("a");
    await run(false);
    expect(await read("a")).toBe(once);
  });

  it("reports an approved Journey as needing re-approval", async () => {
    const j = legacy("p", true);
    await seed(j);
    expect((await run(false)).journeys[0]?.needsReapproval).toBe(true);
  });

  it("changes an approved Journey by step ids only", async () => {
    const before = legacy("p", true);
    await seed(before);
    await run(false);
    expect(isStepIdOnlyChange(before, (await new FsJourneyStore(dir).get("p"))!)).toBe(true);
  });

  it("changes the approved Journey's review hash", async () => {
    const before = legacy("p", true);
    await seed(before);
    await run(false);
    expect(journeyReviewHash((await new FsJourneyStore(dir).get("p"))!)).not.toBe(journeyReviewHash(before));
  });

  it("does not flag a draft for re-approval", async () => {
    await seed(legacy("d"));
    expect((await run(false)).totals.needsReapproval).toBe(0);
  });

  it("leaves the sources cache untouched", async () => {
    const cache = join(dir, "..", `${dir.split("/").pop()}-sources`);
    await mkdir(cache, { recursive: true });
    await writeFile(join(cache, "remote.json"), JSON.stringify(legacy("remote")));
    const before = await readFile(join(cache, "remote.json"), "utf8");
    await seed(legacy("a"));
    await run(false);
    expect(await readFile(join(cache, "remote.json"), "utf8")).toBe(before);
  });
});
