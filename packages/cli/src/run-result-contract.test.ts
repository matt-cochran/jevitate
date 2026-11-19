import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { MISSION_RESULT_SCHEMA_VERSION } from "@jevitate/domain";
import { ClaimResultSchema, RunResultClaimVerdictsEnvelopeSchema, RunResultClaimVerdictsSchema } from "@jevitate/journey";
import Ajv2020 from "ajv/dist/2020.js";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { ok } from "./envelope.js";
import { claimVerdictFields, evaluateClaims } from "./explore-job-claims.js";

const ROOT = fileURLToPath(new URL("../contracts/jevitate-run-result/v1", import.meta.url));
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
  $id: `https://jevitate.com/schemas/run-result/v1/${id}`,
  title,
});
const validators = () => {
  const Ajv = Ajv2020 as unknown as typeof Ajv2020.default;
  const ajv = new Ajv({ allErrors: true, strict: false, validateFormats: false });
  return { envelope: ajv.compile(read(join(SCHEMAS, "run-result.schema.json"))), claim: ajv.compile(read(join(SCHEMAS, "claim.schema.json"))) };
};
const VALID = ["claims.json", "no-claims.json", "claims-with-other-result-fields.json"];
const INVALID = ["claim-unknown-verdict.json", "claim-missing-basis.json", "claim-unknown-field.json"];

describe("the published Jevitate run-result contract v1 (claim verdicts)", () => {
  it("has an exact manifest for every published contract file", () => {
    const manifest = read(join(ROOT, "manifest.json"));
    expect(manifest).toMatchObject({
      kind: "jevitate.run-result-contract",
      version: "1.0.0",
      package: "@jevitate/cli",
      source: {
        repository: "https://github.com/matt-cochran/jevitate.git",
        commit: expect.stringMatching(/^[0-9a-f]{40}$/),
        packageVersionAtCommit: expect.stringMatching(/^\d+\.\d+\.\d+/),
      },
      compatibility: { jsonEnvelopeVersion: 1, resultSchemaVersion: 1 },
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
  });

  it("publishes the exact run-result and claim schemas implemented by the runtime", () => {
    expect(read(join(SCHEMAS, "run-result.schema.json"))).toEqual(generated(RunResultClaimVerdictsEnvelopeSchema, "run-result.schema.json", "Jevitate run result v1 (claim verdicts)"));
    expect(read(join(SCHEMAS, "claim.schema.json"))).toEqual(generated(ClaimResultSchema, "claim.schema.json", "Jevitate claim verdict v1"));
  });

  it("the contract's envelope and result versions are the ones the CLI emits", () => {
    expect(RunResultClaimVerdictsEnvelopeSchema.shape.v.value).toBe(ok({}).v);
    expect(RunResultClaimVerdictsSchema.shape.schemaVersion.value).toBe(MISSION_RESULT_SCHEMA_VERSION);
  });

  it.each(VALID)("accepts the valid fixture %s", (name) => {
    expect(validators().envelope(read(join(FIXTURES, "valid", name)))).toBe(true);
  });

  it.each(VALID)("the runtime schema accepts the valid fixture %s", (name) => {
    expect(RunResultClaimVerdictsEnvelopeSchema.safeParse(read(join(FIXTURES, "valid", name))).success).toBe(true);
  });

  it("the valid fixtures cover every verdict and every basis", () => {
    const claims = read(join(FIXTURES, "valid/claims.json")).data.claims as { verdict: string; basis: string }[];
    expect(new Set(claims.map((c) => c.verdict))).toEqual(new Set(["confirmed", "contradicted", "not_observed"]));
    expect(new Set(claims.map((c) => c.basis))).toEqual(new Set(["check", "model", "no-evidence", "model-error"]));
  });

  it("a run whose job has no claims carries jobContext and no claims", () => {
    const data = read(join(FIXTURES, "valid/no-claims.json")).data;
    expect({ jobContext: typeof data.jobContext, claims: data.claims }).toEqual({ jobContext: "object", claims: undefined });
  });

  it.each(INVALID)("refuses the invalid fixture %s", (name) => {
    expect(validators().envelope(read(join(FIXTURES, "invalid", name)))).toBe(false);
  });

  it.each(INVALID)("the runtime schema refuses the invalid fixture %s", (name) => {
    expect(RunResultClaimVerdictsEnvelopeSchema.safeParse(read(join(FIXTURES, "invalid", name))).success).toBe(false);
  });

  it("each claim of the valid fixture is valid under the standalone claim schema", () => {
    const { claim } = validators();
    expect(read(join(FIXTURES, "valid/claims.json")).data.claims.every((c: unknown) => claim(c))).toBe(true);
  });
});

describe("the CLI builds the contract's claim-verdict fields", () => {
  const evaluated = () =>
    evaluateClaims(
      [
        { id: "checked", statement: "a new invite shows as Pending", check: { version: 1, at: "/members", check: "textIncludes:role=table|Pending" } },
        { id: "unchecked", statement: "an invite uses one free seat" },
      ],
      { readCheck: async () => true, evidence: null },
    );

  it("evaluateClaims yields claim results the published claim schema accepts", async () => {
    const claims = await evaluated();
    expect(claims.every((c) => validators().claim(c))).toBe(true);
  });

  it("claimVerdictFields places the verdicts under the job and its content hash", async () => {
    const claims = await evaluated();
    const fields = claimVerdictFields({ jobId: "invite", contentHash: "a".repeat(64) }, claims);
    expect(fields).toEqual({ jobContext: { job: "invite", contentHash: "a".repeat(64) }, claims });
  });

  it("claimVerdictFields leaves claims out when the job has none", () => {
    expect(claimVerdictFields({ jobId: "invite", contentHash: "a".repeat(64) }, undefined)).toEqual({ jobContext: { job: "invite", contentHash: "a".repeat(64) } });
  });

  it("an emitted envelope with those fields is valid under the published contract", async () => {
    const data = { schemaVersion: MISSION_RESULT_SCHEMA_VERSION, strategy: "goal", missionOutcome: "clean", ...claimVerdictFields({ jobId: "invite", contentHash: "a".repeat(64) }, await evaluated()) };
    expect(validators().envelope(ok(data))).toBe(true);
  });
});
