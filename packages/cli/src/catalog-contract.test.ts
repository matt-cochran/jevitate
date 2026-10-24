import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { contentHash } from "@jevitate/domain";
import { JobSchema, JourneySchema } from "@jevitate/journey";
import Ajv2020 from "ajv/dist/2020.js";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { CatalogLoader } from "./catalog.js";

const ROOT = fileURLToPath(new URL("../contracts/jevitate-catalog/v1", import.meta.url));
const SCHEMAS = join(ROOT, "schemas");
const FIXTURES = join(ROOT, "fixtures");
const read = (path: string): any => JSON.parse(readFileSync(path, "utf8"));
const digest = (path: string): string => createHash("sha256").update(readFileSync(path)).digest("hex");
const generated = (schema: Parameters<typeof z.toJSONSchema>[0], id: string, title: string): object => ({
  ...z.toJSONSchema(schema, { target: "draft-2020-12", unrepresentable: "any" }),
  $id: `https://jevitate.com/schemas/catalog/v1/${id}`,
  title,
});

const temp: string[] = [];
afterEach(() => {
  for (const dir of temp.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("the published Jevitate repository-catalog contract", () => {
  it("has an exact manifest for every published contract file", () => {
    const manifest = read(join(ROOT, "manifest.json"));
    expect(manifest).toMatchObject({
      kind: "jevitate.catalog-contract",
      version: "1.0.0",
      package: "@jevitate/cli",
      compatibility: { repositoryCatalogMajor: 1, approvalHash: "jevitate-content-hash-v1" },
    });
    for (const file of manifest.files) {
      const path = join(ROOT, file.path);
      expect({ bytes: statSync(path).size, sha256: digest(path) }, file.path).toEqual({ bytes: file.bytes, sha256: file.sha256 });
    }
  });

  it("publishes the exact Job and Journey schemas implemented by the runtime", () => {
    expect(read(join(SCHEMAS, "job.schema.json"))).toEqual(generated(JobSchema, "job.schema.json", "Jevitate job v1"));
    expect(read(join(SCHEMAS, "journey.schema.json"))).toEqual(generated(JourneySchema, "journey.schema.json", "Jevitate Journey v1"));
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
    expect(vectors.algorithm).toBe("jevitate-content-hash-v1");
    for (const vector of vectors.vectors) expect(contentHash(vector.input), vector.kind).toBe(vector.sha256);
  });
});
