import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";
import { buildCatalogBundle, CatalogBundleInputError, type CatalogBundleFinding, type CatalogBundleV1 } from "./catalog-bundle.js";
import { exportCatalogBundle, type ExportCatalogBundleResult } from "./catalog-bundle-api.js";
import type { Catalog } from "./catalog.js";
import type { GitExec } from "./change-context.js";

/**
 * #464 (d464a): the Journeeze catalog bundle v1.0 jevitate exports, checked against the PINNED
 * contract — journeeze-saas 61f8c92: `docs/schemas/catalog-bundle.v1.json` and
 * `proto/fixtures/catalog-bundle/{minimal,full,cases}` copied verbatim into `test-fixtures/`. The
 * sample project (`test-fixtures/catalog-bundle/sample-project`) is exported and its bundle must
 * validate, match the golden file, and recompute every approval hash per contract §8.
 */

const FIXTURES = fileURLToPath(new URL("../test-fixtures/", import.meta.url));
const SAMPLE = join(FIXTURES, "catalog-bundle", "sample-project");
const GOLDEN = join(FIXTURES, "catalog-bundle", "sample-project.bundle.json");
const HEAD = "592a7021c4f0be9d3a8e6b1f2c7d4e5a6b7c8d9e";
const readJson = (p: string): any => JSON.parse(readFileSync(p, "utf8"));
const schema = readJson(join(FIXTURES, "catalog-bundle.v1.json"));

const Ajv = Ajv2020 as unknown as typeof Ajv2020.default;
const strictValidate = new Ajv({ allErrors: true, strict: false }).compile(schema);
const pruningValidate = new Ajv({ allErrors: true, strict: false, removeAdditional: true }).compile(schema);
/** Contract §6: a reader on minor 0 validates minor ≤ 0 strictly, and prunes a later minor first. */
function validate(bundle: unknown): Array<{ instancePath: string; keyword: string }> {
  const copy = structuredClone(bundle) as { minor?: number };
  const v = (copy.minor ?? 0) > 0 ? pruningValidate : strictValidate;
  return v(copy) ? [] : (v.errors ?? []).map((e) => ({ instancePath: e.instancePath, keyword: e.keyword }));
}

/** RFC 6902 add / replace / remove (what the fixture cases use). */
function applyPatch(doc: any, patch: Array<{ op: string; path: string; value?: unknown }>): any {
  const out = structuredClone(doc);
  for (const p of patch) {
    const parts = p.path.split("/").slice(1).map((s) => s.replace(/~1/g, "/").replace(/~0/g, "~"));
    const last = parts.pop()!;
    const parent = parts.reduce((o, k) => o[k], out);
    if (Array.isArray(parent)) {
      const i = last === "-" ? parent.length : Number(last);
      if (p.op === "add") parent.splice(i, 0, p.value);
      else if (p.op === "replace") parent[i] = p.value;
      else parent.splice(i, 1);
    } else if (p.op === "remove") delete parent[last];
    else parent[last] = p.value;
  }
  return out;
}

/** Contract §8: SHA-256 of canonical JSON, keys sorted by `localeCompare` — written independently of jevitate's. */
function canonical(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  const entries = Object.entries(v as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b));
  return `{${entries.map(([k, x]) => `${JSON.stringify(k)}:${canonical(x)}`).join(",")}}`;
}
const sha256 = (v: unknown): string => createHash("sha256").update(canonical(v)).digest("hex");

const fakeGit: GitExec = async (args) => ({ stdout: args[0] === "rev-parse" ? `${HEAD}\n` : "" });

const tmpDirs: string[] = [];
afterEach(() => {
  for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** A copy of the sample project, changed by `edit`, exported; the bundle (or the refusal). */
async function exportSample(
  edit: (root: string) => void = () => {},
  findings?: readonly CatalogBundleFinding[],
): Promise<{ result: ExportCatalogBundleResult; bundle: CatalogBundleV1 } | { error: unknown }> {
  const root = mkdtempSync(join(tmpdir(), "jev-bundle-"));
  tmpDirs.push(root);
  cpSync(SAMPLE, root, { recursive: true });
  edit(root);
  try {
    const result = await exportCatalogBundle(
      { format: "journeeze-bundle", catalogDir: join(root, ".jevitate"), journeysDir: join(root, ".jevitate", "journeys"), outDir: join(root, "out") },
      { git: fakeGit, version: () => "0.10.0", ...(findings === undefined ? {} : { findings: async () => findings }) },
    );
    return { result, bundle: readJson(result.bundlePath) };
  } catch (error) {
    return { error };
  }
}
async function sampleBundle(edit?: (root: string) => void, findings?: readonly CatalogBundleFinding[]): Promise<CatalogBundleV1 & { result: ExportCatalogBundleResult }> {
  const r = await exportSample(edit, findings);
  if ("error" in r) throw r.error;
  // `result` rides beside the written bundle, never in it (not enumerable: validation and the golden see the file only).
  return Object.defineProperty(r.bundle, "result", { value: r.result, enumerable: false }) as CatalogBundleV1 & { result: ExportCatalogBundleResult };
}
async function refusal(edit: (root: string) => void, findings?: readonly CatalogBundleFinding[]): Promise<unknown> {
  const r = await exportSample(edit, findings);
  return "error" in r ? r.error : null;
}
function editJson(path: string, f: (v: any) => void): void {
  const v = readJson(path);
  f(v);
  writeFileSync(path, JSON.stringify(v, null, 2));
}
const journeyFile = (root: string): string => join(root, ".jevitate", "journeys", "jz-guide-fixture.json");
const checkFile = (root: string): string => join(root, "jevitate-check", "check.json");

// ── The pinned contract ─────────────────────────────────────────────────────────────────────

describe("the pinned contract (journeeze-saas 61f8c92)", () => {
  it.each(["minimal", "full"])("the %s fixture bundle validates", (name) => {
    expect(validate(readJson(join(FIXTURES, "catalog-bundle", name, "bundle.json")))).toEqual([]);
  });

  const cases = readdirSync(join(FIXTURES, "catalog-bundle", "cases")).filter((f) => f.endsWith(".json"));
  it.each(cases)("case %s raises the error it documents", (file) => {
    const c = readJson(join(FIXTURES, "catalog-bundle", "cases", file));
    const errors = validate(applyPatch(readJson(join(FIXTURES, "catalog-bundle", c.base, "bundle.json")), c.patch));
    if (c.expect.valid) expect(errors).toEqual([]);
    else expect(errors).toContainEqual({ instancePath: c.expect.instancePath, keyword: c.expect.keyword });
  });
});

// ── The sample project's bundle ─────────────────────────────────────────────────────────────

describe("the sample project's bundle", () => {
  let bundle: CatalogBundleV1 & { result: ExportCatalogBundleResult };
  beforeAll(async () => {
    bundle = await sampleBundle();
  });

  it("validates against the pinned schema", () => {
    expect(validate(bundle)).toEqual([]);
  });

  it("matches the golden bundle", () => {
    const written = { ...bundle };
    if (process.env.JEV_UPDATE_GOLDEN === "1") writeFileSync(GOLDEN, `${JSON.stringify(written, null, 2)}\n`);
    expect(written).toEqual(readJson(GOLDEN));
  });

  it("recomputes every exported approval hash per §8 (persona, job, journey review hash)", () => {
    const recomputed = [
      ...bundle.catalog.personas.filter((p) => p.approval).map((p) => [p.approval!.contentHash, sha256({ id: p.id, description: p.description, role: p.role, ...p.otherFields })]),
      ...bundle.catalog.jobs.filter((j) => j.approval).map((j) => {
        const { approval, ...rest } = j;
        return [approval!.contentHash, sha256(rest)];
      }),
      ...bundle.catalog.journeys.map(({ journey }: any) => {
        const { promoted: _p, approval, acceptedWeak: _w, ...metadata } = journey.metadata;
        return [approval.contentHash, sha256({ metadata, recording: journey.recording })];
      }),
    ];
    expect(recomputed.map(([stored, again]) => stored === again)).toEqual([true, true, true]);
  });

  it("exports no persona session keys", () => {
    expect(JSON.stringify(bundle.catalog.personas)).not.toMatch(/storageState|login|state\/reviewer\.json|sign-in/);
  });

  it("exports promoted Journeys only, with a warning for the rest", () => {
    expect(bundle.result.warnings).toContainEqual(expect.stringMatching(/^journey draft-flow: not promoted/));
  });

  it("links the Journey to its job, persona, anchors (1-based steps) and served outcomes", () => {
    expect(bundle.catalog.journeys[0]!.link).toEqual({
      job: "record-verdict",
      persona: "reviewer",
      anchors: [{ name: "verdict-recorded", step: 2, jobStep: "judge", boundary: "end" }],
      serves: ["verdict-fast", "verdict-wrong-item"],
    });
  });

  it("keeps no OS user or approval reason in the Journey's approval bookkeeping", () => {
    expect((bundle.catalog.journeys[0]!.journey as any).metadata.approval.provenance).toEqual({ channel: "tty", agentSignals: [] });
  });

  it("carries no demos and no media files in 0.10", () => {
    expect(["demos", "files"].filter((k) => k in bundle)).toEqual([]);
  });

  it("carries an empty findings list until the findings source (d464c) is wired", () => {
    expect(bundle.findings).toEqual([]);
  });

  it("exports the machine baseline of the clean run, its anchor points named `anchor` with steps resolved from stepId", () => {
    expect(bundle.checks.find((c) => c.runId === "journey-run-1")!.baseline).toEqual({
      steps: 2,
      totalMs: 4000,
      anchors: [
        { anchor: "job_start", step: 1, atMs: 0 },
        { anchor: "verdict-recorded", step: 2, atMs: 4000 },
        { anchor: "job_end", step: 2, atMs: 4000 },
      ],
    });
  });

  it("never puts a baseline on a run that was not clean (baseline-on-failed-run)", () => {
    expect(bundle.checks.find((c) => c.runId === "journey-run-2")).toMatchObject({ outcome: "defects-found", exitCode: 1, journeyOutcome: "quarantined" });
  });

  it("leaves skipped items and the approvals gate out of the checks", () => {
    expect(bundle.checks.map((c) => c.target.id)).toEqual(["board-adversarial", "fix-verdict-save", "jz-guide-fixture", "jz-guide-fixture"]);
  });

  it("exports an errored mission as inconclusive with its failure kind", () => {
    expect(bundle.checks.find((c) => c.target.id === "board-adversarial")).toMatchObject({ outcome: "inconclusive", exitCode: 2, failureKind: "insufficient-coverage" });
  });
});

// ── What jevitate never exports ─────────────────────────────────────────────────────────────

const fillStep = (label: string, value: string) => ({
  stepId: "s-typed",
  step: { kind: "fill", target: { label }, value: { redacted: false, value }, expect: { kind: "urlIncludes", text: "/board" } },
});

describe("what jevitate never exports", () => {
  it("refuses a Journey that types personal data in clear (typed-personal-data)", async () => {
    const err = await refusal((root) => editJson(journeyFile(root), (j) => j.recording.pages[0].steps.push(fillStep("Email", "ana@example.com"))));
    expect(err).toMatchObject({ code: "E_CATALOG_EXPORT_INPUT", message: expect.stringMatching(/personal data in clear/) });
  });

  it("refuses a Journey that types a credential-looking field in clear", async () => {
    const err = await refusal((root) => editJson(journeyFile(root), (j) => j.recording.pages[0].steps.push(fillStep("Password", "hunter2"))));
    expect(err).toMatchObject({ code: "E_CATALOG_EXPORT_INPUT", message: expect.stringMatching(/credential-looking field in clear/) });
  });

  it("refuses a job whose text carries personal data", async () => {
    const err = await refusal((root) => editJson(join(root, ".jevitate", "jobs.json"), (jobs) => (jobs[1].trigger = "ana@example.com files a release")));
    expect(err).toBeInstanceOf(CatalogBundleInputError);
  });

  it("leaves out a Journey whose anchor takes a reserved name (reserved-anchor-name)", async () => {
    const b = await sampleBundle((root) => editJson(journeyFile(root), (j) => (j.metadata.anchors[0].name = "job_end")));
    expect(b.catalog.journeys).toEqual([]);
  });

  it("leaves out a Journey whose persona is free text, not a persona id", async () => {
    const b = await sampleBundle((root) => editJson(journeyFile(root), (j) => (j.metadata.persona = "a reviewer on the board")));
    expect(b.result.warnings).toContainEqual(expect.stringMatching(/^journey jz-guide-fixture: metadata\.persona .* is free text/));
  });

  it("drops a persona key the bundle cannot carry, and its approval with it (the hash could not recompute)", async () => {
    const b = await sampleBundle((root) => editJson(join(root, ".jevitate", "personas.json"), (ps) => (ps[0].tags = ["a", "b"])));
    expect(b.catalog.personas[0]).not.toHaveProperty("approval");
  });

  it("leaves out the checks of a run that names no commit", async () => {
    const b = await sampleBundle((root) => editJson(checkFile(root), (c) => delete c.data.targetBuild));
    expect(b.checks).toEqual([]);
  });

  it("drops a baseline measured on a Journey revision that is not the approved one", async () => {
    const b = await sampleBundle((root) => editJson(checkFile(root), (c) => (c.data.items[0].journeyHash = "0".repeat(64))));
    expect(b.checks.find((c) => c.runId === "journey-run-1")).not.toHaveProperty("baseline");
  });

  it("refuses a finding whose route carries a query string (route-with-query)", async () => {
    const err = await refusal(() => {}, [{ fingerprint: "5b7e448babe54616", kind: "defect", severity: "major", at: "2026-10-09T12:30:00.000Z", route: "/board?item=7", observation: "Saving the verdict fails" }]);
    expect(err).toMatchObject({ code: "E_CATALOG_EXPORT_INPUT", message: expect.stringMatching(/not a route template/) });
  });

  it("refuses a finding whose text carries personal data (personal-data-in-finding)", async () => {
    const err = await refusal(() => {}, [{ fingerprint: "5b7e448babe54616", kind: "defect", severity: "major", at: "2026-10-09T12:30:00.000Z", observation: "Saving fails for ana@example.com" }]);
    expect(err).toBeInstanceOf(CatalogBundleInputError);
  });

  const variants: ReadonlyArray<readonly [string, (root: string) => void, readonly CatalogBundleFinding[]?]> = [
    ["a degraded persona", (root) => editJson(join(root, ".jevitate", "personas.json"), (ps) => (ps[0].description = "two\nlines"))],
    ["an omitted Journey", (root) => editJson(journeyFile(root), (j) => (j.metadata.anchors[0].name = "job_start"))],
    ["a stale Journey approval", (root) => editJson(journeyFile(root), (j) => (j.metadata.goal = "Judge two review items"))],
    ["checks only partly carried", (root) => editJson(checkFile(root), (c) => (c.data.items[0].outcome = "host-starved"))],
    ["a templated defect finding", () => {}, [{ fingerprint: "5b7e448babe54616", kind: "defect", severity: "major", at: "2026-10-09T12:30:00.000Z", route: "/board/{item}", observation: "Saving the verdict fails" }]],
  ];
  it.each(variants)("every bundle it writes validates: %s", async (_name, edit, findings) => {
    expect(validate(await sampleBundle(edit, findings))).toEqual([]);
  });
});

// ── Check outcomes → exit codes (exit-code-mismatch) ────────────────────────────────────────

describe("check outcomes", () => {
  const EMPTY: Catalog = { dir: null, personasFile: null, jobsFile: null, personas: [], jobs: [], journeys: [] };
  /** Contract §5, written out: outcome → exit code. */
  const CONTRACT_EXIT: Record<string, number> = { clean: 0, "defects-found": 1, inconclusive: 2, crashed: 2, hang: 3, intermittent: 4, "pending-review": 5 };
  const one = (item: Record<string, unknown>) =>
    buildCatalogBundle({
      producer: { version: "0.10.0" },
      productName: "sample",
      catalog: EMPTY,
      personaFields: new Map(),
      checks: [{ source: "check.json", record: { kind: "jevitate-check", targetBuild: HEAD, startedAt: "2026-10-09T12:30:00.000Z", items: [{ name: "t", status: "ran", durationMs: 1, ...item }] } }],
    }).bundle.checks[0]!;

  it.each([
    ["journey", "ok"],
    ["journey", "healed-pending-review"],
    ["journey", "heal-exhausted"],
    ["journey", "quarantined"],
    ["mission", "clean"],
    ["mission", "defects-found"],
    ["mission", "hang"],
    ["mission", "intermittent"],
    ["mission", "inconclusive"],
    ["mission", "crashed"],
    ["mission", "not-started"],
    ["goal", "host-starved"],
    ["verify-fix", "fixed"],
    ["verify-fix", "still-reproduces"],
  ])("a %s item ending %s carries the contract's exit code for its outcome", (kind, outcome) => {
    const c = one({ kind, outcome });
    expect(c.exitCode).toBe(CONTRACT_EXIT[c.outcome]);
  });
});
