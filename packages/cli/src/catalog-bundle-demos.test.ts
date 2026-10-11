import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";
import type { CatalogBundleV1 } from "./catalog-bundle.js";
import { exportCatalogBundle, type ExportCatalogBundleResult } from "./catalog-bundle-api.js";
import { approvedDemoDir, recordApprovedDemo, type ApprovedDemoRecord } from "./approved-demo.js";
import type { DemoJourneyResult, DemoJzReport } from "./journey-demo-api.js";
import type { GitExec } from "./change-context.js";

/**
 * #471: approved demos travel in the Journeeze catalog bundle with their jz-mask-v1 media — checked
 * against the PINNED contract (journeeze-saas `docs/schemas/catalog-bundle.v1.json`, copied verbatim
 * into `test-fixtures/catalog-bundle.v1.json`; the media are `proto/fixtures/catalog-bundle/full/media/`
 * copied into `test-fixtures/catalog-bundle/full/media/`). Each test asserts one behaviour.
 */

const FIXTURES = fileURLToPath(new URL("../test-fixtures/", import.meta.url));
const SAMPLE = join(FIXTURES, "catalog-bundle", "sample-project");
const MEDIA = join(FIXTURES, "catalog-bundle", "full", "media", "jz-guide-fixture");
const ID = "jz-guide-fixture";
/** The sample Journey's approved review hash (its approval.contentHash). */
const APPROVED = "627218a7f4a6be3e3324115eb3e1488a6afe703acbaa778176e3ff8414d671f9";
const readJson = (p: string): any => JSON.parse(readFileSync(p, "utf8"));
const Ajv = Ajv2020 as unknown as typeof Ajv2020.default;
const validate = new Ajv({ allErrors: true, strict: false }).compile(readJson(join(FIXTURES, "catalog-bundle.v1.json")));
const fakeGit: GitExec = async (args) => ({ stdout: args[0] === "rev-parse" ? "592a7021c4f0be9d3a8e6b1f2c7d4e5a6b7c8d9e\n" : "" });
const sha256 = (b: Buffer): string => createHash("sha256").update(b).digest("hex");

const tmpDirs: string[] = [];
const suiteDirs: string[] = [];
afterEach(() => {
  for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
afterAll(() => {
  for (const d of suiteDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

interface DemoSetup {
  jz?: Partial<DemoJzReport>;
  renderedFrom?: string;
  caption?: string;
  screenshot?: string;
  /** Edits the project after the record is written (e.g. tampering with a media file). */
  after?: (journeysDir: string) => void;
  /** No record at all (only a draft). */
  noRecord?: boolean;
}

/** The sample project, with an approved-demo record for its promoted Journey, exported. */
async function exportWithDemo(setup: DemoSetup = {}, dirs: string[] = tmpDirs): Promise<{ bundle: CatalogBundleV1; result: ExportCatalogBundleResult; out: string; record?: ApprovedDemoRecord }> {
  const root = mkdtempSync(join(tmpdir(), "jev-bundle-demo-"));
  dirs.push(root);
  cpSync(SAMPLE, root, { recursive: true });
  const journeysDir = join(root, ".jevitate", "journeys");
  // A draft demo record (`demo "<aspect>"` output) is never what the export reads.
  mkdirSync(join(journeysDir, ".drafts"), { recursive: true });
  writeFileSync(join(journeysDir, ".drafts", `${ID}.demo.json`), JSON.stringify({ kind: "jevitate.demo.draft", version: 1, id: ID }));
  let record: ApprovedDemoRecord | undefined;
  if (setup.noRecord !== true) {
    const demo: DemoJourneyResult = {
      id: ID,
      outcome: "ok",
      totalSteps: 2,
      steps: [
        { number: 1, caption: setup.caption ?? "Open the review board", expectedResult: "The item list is visible", cue: { startMs: 0, endMs: 1500 }, screenshot: setup.screenshot ?? join(MEDIA, "step-01.png") },
        { number: 2, caption: "Mark the item as broken", cue: { startMs: 1500, endMs: 4000 }, screenshot: join(MEDIA, "step-01.png") },
      ],
      video: join(MEDIA, "demo.webm"),
      jz: { method: "dom-before-capture", steps: [{ step: 1, regions: 3 }, { step: 2, regions: 2 }], video: { proven: true }, ...setup.jz },
    };
    record = await recordApprovedDemo({ journeysDir, id: ID, renderedFrom: setup.renderedFrom ?? APPROVED, approvedAtIso: "2026-10-09T12:00:00.000Z", environment: "seeded", title: "Record a verdict", demo });
  }
  setup.after?.(journeysDir);
  const out = join(root, "out");
  const result = await exportCatalogBundle(
    { format: "journeeze-bundle", catalogDir: join(root, ".jevitate"), journeysDir, outDir: out },
    { git: fakeGit, version: () => "0.11.0", findings: async () => [] },
  );
  return { bundle: readJson(result.bundlePath), result, out, ...(record === undefined ? {} : { record }) };
}

describe("an approved demo in the bundle (#471)", () => {
  let r: Awaited<ReturnType<typeof exportWithDemo>>;
  beforeAll(async () => {
    r = await exportWithDemo({}, suiteDirs);
  });

  it("validates against the pinned schema with demos and files", () => {
    expect(validate(r.bundle) ? [] : validate.errors).toEqual([]);
  });

  it("names the Journey's current approved hash as renderedFrom", () => {
    expect(r.bundle.demos?.[0]?.renderedFrom).toBe(APPROVED);
  });

  it("carries the jz-mask-v1 + synthetic attestation with the proven region count", () => {
    expect(r.bundle.demos?.[0]?.privacy).toEqual({ mask: "jz-mask-v1", data: "synthetic", method: "dom-before-capture", regions: 5 });
  });

  it("places every listed file beside bundle.json with its listed sha256", () => {
    expect(r.bundle.files?.map((f) => sha256(readFileSync(join(r.out, f.path))) === f.sha256)).toEqual([true, true, true, true]);
  });

  it("references every listed file from its demo, and lists every reference", () => {
    const d = r.bundle.demos![0]!;
    const referenced = [...d.steps.map((s) => s.screenshot), d.video, d.subtitles].filter((x): x is string => x !== undefined).sort();
    expect(referenced).toEqual(r.bundle.files!.map((f) => f.path).sort());
  });

  it("puts the media under media/<journey id>/", () => {
    expect(r.bundle.files?.every((f) => f.path.startsWith(`media/${ID}/`))).toBe(true);
  });

  it("counts the exported media", () => {
    expect(r.result.counts.media).toBe(4);
  });
});

describe("what never leaves (#471)", () => {
  it("a demo with only a draft (no approved record) is not exported", async () => {
    expect("demos" in (await exportWithDemo({ noRecord: true })).bundle).toBe(false);
  });

  it("a demo rendered from another version of its Journey is left out", async () => {
    expect((await exportWithDemo({ renderedFrom: "0".repeat(64) })).bundle.demos).toBeUndefined();
  });

  it("a stale demo is reported as a warning", async () => {
    expect((await exportWithDemo({ renderedFrom: "0".repeat(64) })).result.warnings).toContainEqual(expect.stringMatching(/^demo jz-guide-fixture: rendered from another version/));
  });

  it("a screenshot changed after it was proven masked is not listed", async () => {
    const r = await exportWithDemo({ after: (j) => writeFileSync(join(approvedDemoDir(j, ID), "step-01.png"), Buffer.concat([readFileSync(join(MEDIA, "step-01.png")), Buffer.from([0])])) });
    expect(r.bundle.files?.map((f) => f.path)).not.toContain(`media/${ID}/step-01.png`);
  });

  it("an unproven video is never recorded for export", async () => {
    const r = await exportWithDemo({ jz: { video: { proven: false, reason: "a frame could not be proven" } } });
    expect(r.bundle.demos?.[0]?.video).toBeUndefined();
  });

  it("an unproven screenshot is never recorded for export", async () => {
    const r = await exportWithDemo({ jz: { steps: [{ step: 1, leftOut: "a modal dialog was open" }, { step: 2, regions: 2 }], video: { proven: false, reason: "step 1" } } });
    expect(r.bundle.demos?.[0]?.steps[0]?.screenshot).toBeUndefined();
  });

  it("a screenshot over the contract's 2 MiB is left out, never sent", async () => {
    const dir = mkdtempSync(join(tmpdir(), "jev-big-"));
    tmpDirs.push(dir);
    const big = join(dir, "big.png");
    writeFileSync(big, Buffer.concat([readFileSync(join(MEDIA, "step-01.png")), Buffer.alloc(2 * 1024 * 1024)]));
    const r = await exportWithDemo({ screenshot: big });
    expect(existsSync(join(r.out, "media", ID, "step-01.png"))).toBe(false);
  });

  it("a demo whose caption carries a URL is left out whole", async () => {
    expect((await exportWithDemo({ caption: "Open https://example.com/board" })).bundle.demos).toBeUndefined();
  });
});
