import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FsJourneyStore, JourneyRegistry, JourneyReviewSchema, type Journey } from "@jevitate/journey";
import { journeyDoneCheck } from "./catalog-refs.js";
import { loadCatalog } from "./catalog-api.js";
import { lintJourneyById } from "./journey-api.js";
import { buildJourneyReview, renderReviewMarkdown, renderReviewText } from "./journey-review.js";

/**
 * 0.30.0 design §3.1: "a Journey with no linked job may carry [a done check] itself in `metadata.done`".
 * Which check a run reads (`journeyDoneCheck`, the done-check hook's choice), the lint of the Journey's own
 * check (`journey lint`), and the review sheet.
 */

const own = { version: 1, at: "/items", check: "textIncludes:testId=items|${item}", distinguishedBy: ["item"] } as const;
const jobDone = { version: 1, at: "/all", check: "count:testId=row|min=1" } as const;
const story = { trigger: "When I have a new item", motivation: "I want to save it", outcome: "I can find it later" };

function journey(id: string, metadata: Record<string, unknown> = {}): Journey {
  return {
    metadata: { id, name: id, promoted: true, params: ["item"], createdAtIso: "2026-11-09T00:00:00.000Z", ...metadata },
    recording: {
      version: "1",
      site: "http://127.0.0.1:3000",
      pages: [{ url: "/new", steps: [{ step: { kind: "navigate", url: "/new", expect: { kind: "visible", target: { testId: "name" } } } }] }],
    },
  } as unknown as Journey;
}

let root: string;
let projectDir: string;
let journeysDir: string;
beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "jev-own-done-check-"));
  projectDir = join(root, ".jevitate");
  journeysDir = join(root, "journeys");
  mkdirSync(projectDir, { recursive: true });
  writeFileSync(join(projectDir, "jobs.json"), JSON.stringify({ jobs: [{ id: "save-item", ...story, done: jobDone }, { id: "no-check", ...story }] }));
  const registry = new JourneyRegistry(new FsJourneyStore(journeysDir));
  await registry.put(journey("own", { done: own }));
  await registry.put(journey("own-bad", { done: { ...own, check: "textIncludes:testId=items|step:2" } }));
  await registry.put(journey("both", { job: "no-check", done: own }));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("journeyDoneCheck: which done check a run reads", () => {
  it("a Journey that links no job reads its own metadata.done, with no catalog", () => {
    expect(journeyDoneCheck(undefined, journey("own", { done: own }))).toEqual({ source: "journey", done: own });
  });

  it("a Journey that links a job reads the job's check, never its own", async () => {
    const catalog = await loadCatalog(projectDir, journeysDir);
    expect(journeyDoneCheck(catalog, journey("j", { job: "save-item", done: own }))).toEqual({ source: "job", done: jobDone });
    expect(journeyDoneCheck(catalog, journey("j", { job: "no-check", done: own }))).toBeUndefined();
  });

  it("an explicit job (journey shorten --job) reads that job's check over the Journey's own", async () => {
    const catalog = await loadCatalog(projectDir, journeysDir);
    expect(journeyDoneCheck(catalog, journey("j", { done: own }), "save-item")).toEqual({ source: "job", done: jobDone });
  });

  it("no job and no metadata.done is no check", () => {
    expect(journeyDoneCheck(undefined, journey("j"))).toBeUndefined();
  });
});

describe("journey lint: the Journey's own done check, by the jobs.json rules", () => {
  it("a valid own check is clean", async () => {
    const r = await lintJourneyById(journeysDir, "own", { catalogDir: projectDir });
    expect(r.findings.filter((f) => f.rule.startsWith("done-check"))).toEqual([]);
  });

  it("an invalid own check is done-check-invalid (an error)", async () => {
    const r = await lintJourneyById(journeysDir, "own-bad", { catalogDir: projectDir });
    expect(r.findings).toContainEqual(expect.objectContaining({ rule: "done-check-invalid", level: "error" }));
  });

  it("an own check beside a linked job is an error: it would never be read", async () => {
    const r = await lintJourneyById(journeysDir, "both", { catalogDir: projectDir });
    expect(r.findings).toContainEqual(expect.objectContaining({ rule: "done-check-invalid", level: "error", message: expect.stringContaining("metadata.done") }));
  });
});

describe("review sheet: the Journey's own done check", () => {
  it("shows it (placeholders, never a value) and validates against the sheet schema", () => {
    const review = buildJourneyReview(journey("own", { done: own }));
    expect(review.proof.doneCheck).toEqual({ source: "journey", at: "/items", check: "textIncludes:testId=items|${item}", distinguishedBy: ["item"] });
    expect(JourneyReviewSchema.safeParse(review).success).toBe(true);
    expect(renderReviewText(review)).toContain("DONE CHECK");
    const md = renderReviewMarkdown(review);
    expect(md).toContain("## Done check");
    expect(md).toContain("this Journey's own (metadata.done): textIncludes:testId=items|${item} at /items, in a fresh session · distinguished by item");
  });

  it("carries the own check's lint finding", () => {
    const review = buildJourneyReview(journey("own-bad", { done: { ...own, check: "textIncludes:testId=items|step:2" } }));
    expect(review.proof.lint.findings).toContainEqual(expect.objectContaining({ rule: "done-check-invalid", level: "error" }));
  });

  it("a Journey without metadata.done has no doneCheck on its sheet", () => {
    expect(buildJourneyReview(journey("plain")).proof.doneCheck).toBeUndefined();
  });
});
