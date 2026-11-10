import { createHash } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { contentHash } from "@jevitate/domain";
import { JobSchema, JourneySchema } from "@jevitate/journey";
import Ajv2020 from "ajv/dist/2020.js";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { CatalogLoader } from "./catalog.js";
import { CATALOG_CONTRACT_IDENTITY } from "./catalog-contract-identity.js";

const ROOT = fileURLToPath(new URL("../contracts/jevitate-catalog/v3", import.meta.url));
const V1_ROOT = fileURLToPath(new URL("../contracts/jevitate-catalog/v1", import.meta.url));
const V2_ROOT = fileURLToPath(new URL("../contracts/jevitate-catalog/v2", import.meta.url));
const SCHEMAS = join(ROOT, "schemas");
const FIXTURES = join(ROOT, "fixtures");
const read = (path: string): any => JSON.parse(readFileSync(path, "utf8"));
const digest = (path: string): string => createHash("sha256").update(readFileSync(path)).digest("hex");
const files = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
  const path = join(dir, entry.name);
  return entry.isDirectory() ? files(path) : [path];
});
const generated = (schema: Parameters<typeof z.toJSONSchema>[0], id: string, title: string): object => ({
  ...z.toJSONSchema(schema, { target: "draft-2020-12", unrepresentable: "any" }),
  $id: `https://jevitate.com/schemas/catalog/v3/${id}`,
  title,
});

const temp: string[] = [];
afterEach(() => {
  for (const dir of temp.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("the published Jevitate repository-catalog contract", () => {
  /** A published contract never changes: its manifest digest is pinned and every file matches the manifest. */
  const expectImmutable = (root: string, manifestSha256: string, identity: object): void => {
    const manifestPath = join(root, "manifest.json");
    const manifest = read(manifestPath);
    expect(digest(manifestPath)).toBe(manifestSha256);
    expect(manifest).toMatchObject(identity);
    const expected = new Set<string>(["manifest.json"]);
    for (const file of manifest.files) {
      expected.add(file.path);
      const path = join(root, file.path);
      expect({ bytes: statSync(path).size, sha256: digest(path) }, file.path).toEqual({ bytes: file.bytes, sha256: file.sha256 });
    }
    const actual = new Set(files(root).map((path) => path.slice(root.length + 1).replaceAll("\\", "/")));
    expect([...actual].sort()).toEqual([...expected].sort());
  };

  it("preserves the immutable v1.0.0 contract for previous-major consumers", () => {
    expectImmutable(V1_ROOT, "63d468537b34bfd9072d48de5b53f58d688c0f4370f8083ffd3fae26714f4c8e", {
      kind: "jevitate.catalog-contract",
      version: "1.0.0",
      package: "@jevitate/cli",
      compatibility: { repositoryCatalogMajor: 1, approvalHash: "jevitate-content-hash-v1" },
    });
  });

  it("preserves the immutable v2.0.0 contract for previous-major consumers", () => {
    expectImmutable(V2_ROOT, "481a4dc41ef6d619539500b2d141a07ceb003e9d83bc1f5cd11214360c83dbbd", {
      kind: "jevitate.catalog-contract",
      version: "2.0.0",
      package: "@jevitate/cli",
      compatibility: { repositoryCatalogMajor: 1, approvalHash: "jevitate-content-hash-v2" },
    });
  });

  it("has an exact manifest for every published contract file", () => {
    const manifest = read(join(ROOT, "manifest.json"));
    expect(manifest).toMatchObject({
      kind: "jevitate.catalog-contract",
      version: "3.0.0",
      package: "@jevitate/cli",
      source: {
        repository: "https://github.com/matt-cochran/jevitate.git",
        commit: expect.stringMatching(/^[0-9a-f]{40}$/),
        packageVersionAtCommit: expect.stringMatching(/^\d+\.\d+\.\d+/),
      },
      compatibility: {
        repositoryCatalogMajor: 1,
        approvalHash: "jevitate-content-hash-v2",
        readsApprovalHashes: ["jevitate-content-hash-v2", "jevitate-content-hash-v1"],
      },
    });
    const expected = new Set<string>(["manifest.json"]);
    for (const file of manifest.files) {
      expect(expected.has(file.path), `duplicate manifest path: ${file.path}`).toBe(false);
      expected.add(file.path);
      const path = join(ROOT, file.path);
      expect({ bytes: statSync(path).size, sha256: digest(path) }, file.path).toEqual({ bytes: file.bytes, sha256: file.sha256 });
    }
    const actual = new Set(files(ROOT).map((path) => path.slice(ROOT.length + 1).replaceAll("\\", "/")));
    expect([...actual].sort()).toEqual([...expected].sort());
    expect(CATALOG_CONTRACT_IDENTITY).toEqual({
      kind: manifest.kind,
      version: manifest.version,
      manifestSha256: digest(join(ROOT, "manifest.json")),
    });
  });

  it("publishes the exact Job and Journey schemas implemented by the runtime", () => {
    expect(read(join(SCHEMAS, "job.schema.json"))).toEqual(generated(JobSchema, "job.schema.json", "Jevitate job v3"));
    expect(read(join(SCHEMAS, "journey.schema.json"))).toEqual(generated(JourneySchema, "journey.schema.json", "Jevitate Journey v3"));
  });

  it("accepts the positive fixtures and refuses the closed-schema negative fixtures", () => {
    const Ajv = Ajv2020 as unknown as typeof Ajv2020.default;
    const ajv = new Ajv({ allErrors: true, strict: false, validateFormats: false });
    const job = read(join(SCHEMAS, "job.schema.json"));
    ajv.addSchema(job);
    const jobs = ajv.compile(read(join(SCHEMAS, "jobs.schema.json")));
    const journey = ajv.compile(read(join(SCHEMAS, "journey.schema.json")));
    const personas = ajv.compile(read(join(SCHEMAS, "personas.schema.json")));
    expect(jobs(read(join(FIXTURES, "valid/jobs.json")))).toBe(true);
    expect(journey(read(join(FIXTURES, "valid/journey.json")))).toBe(true);
    expect(personas(read(join(FIXTURES, "valid/personas.json")))).toBe(true);
    expect(jobs(read(join(FIXTURES, "invalid/jobs-unknown-field.json")))).toBe(false);
    expect(journey(read(join(FIXTURES, "invalid/journey-unknown-field.json")))).toBe(false);
  });

  it("v3 is a contract major: the closed v2 schemas refuse the v3 additions that v3 accepts", () => {
    const Ajv = Ajv2020 as unknown as typeof Ajv2020.default;
    const validators = (root: string) => {
      const ajv = new Ajv({ allErrors: true, strict: false, validateFormats: false });
      ajv.addSchema(read(join(root, "schemas/job.schema.json")));
      return { jobs: ajv.compile(read(join(root, "schemas/jobs.schema.json"))), journey: ajv.compile(read(join(root, "schemas/journey.schema.json"))) };
    };
    const v3 = validators(ROOT);
    const v2 = validators(V2_ROOT);
    const jobsDone = read(join(FIXTURES, "valid/jobs-done.json"));
    const typedJourney = read(join(FIXTURES, "valid/journey-typed-parameters.json"));
    expect(v3.jobs(jobsDone)).toBe(true);
    expect(v3.journey(typedJourney)).toBe(true);
    expect(v2.jobs(jobsDone)).toBe(false);
    expect(v2.journey(typedJourney)).toBe(false);
    // A file without the additions is valid under both, so a v3 reader may accept files written for v2.
    expect(v2.jobs(read(join(FIXTURES, "valid/jobs.json")))).toBe(true);
    expect(v2.journey(read(join(FIXTURES, "valid/journey.json")))).toBe(true);
    expect(JobSchema.safeParse(jobsDone[0]).success).toBe(true);
    expect(JourneySchema.safeParse(typedJourney).success).toBe(true);
  });

  it("the runtime loader accepts the same valid persona and job fixtures", async () => {
    const dir = mkdtempSync(join(tmpdir(), "jev-contract-"));
    temp.push(dir);
    writeFileSync(join(dir, "personas.json"), readFileSync(join(FIXTURES, "valid/personas.json")));
    writeFileSync(join(dir, "jobs.json"), readFileSync(join(FIXTURES, "valid/jobs.json")));
    const catalog = await new CatalogLoader({ catalogDir: dir, journeysDir: join(dir, "journeys") }).load();
    expect(catalog.personas.map((p) => p.id)).toEqual(["owner"]);
    expect(catalog.jobs.map((j) => j.id)).toEqual(["review-work"]);
  });

  it("approval-hash vectors are reproduced by the production hash implementation", () => {
    const vectors = read(join(ROOT, "approval-hash-vectors.json"));
    expect(vectors.algorithm).toBe("jevitate-content-hash-v2");
    for (const vector of vectors.vectors) expect(contentHash(vector.input), vector.kind).toBe(vector.sha256);
  });
});
