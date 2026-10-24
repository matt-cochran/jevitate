import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { JobSchema, JourneySchema } from "../../journey/dist/index.js";

const root = fileURLToPath(new URL("../contracts/jevitate-catalog/v1", import.meta.url));
const identityModule = fileURLToPath(new URL("../src/catalog-contract-identity.ts", import.meta.url));
const contractVersion = "1.1.0";
const schemaBase = "https://jevitate.com/schemas/catalog/v1";
const packageJson = JSON.parse(readFileSync(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8"));
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const json = (value) => `${JSON.stringify(value, null, 2)}\n`;
const write = (path, value) => {
  const full = join(root, path);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, typeof value === "string" ? value : json(value));
};

function generatedSchema(schema, id, title) {
  const out = z.toJSONSchema(schema, { target: "draft-2020-12", unrepresentable: "any" });
  return { ...out, $id: `${schemaBase}/${id}`, title };
}

const approval = {
  type: "object",
  additionalProperties: false,
  required: ["contentHash", "at"],
  properties: {
    contentHash: { type: "string", pattern: "^[0-9a-f]{64}$" },
    at: { type: "string", minLength: 1 },
    provenance: { type: "object" },
    acceptedFindings: { type: "object" },
  },
};

// personas.json predates the catalog contract and has three supported envelopes plus operational
// login/session keys. Descriptive legacy keys remain open in v1 because they participate in the
// approval hash. v2 will require those keys under `extensions`; the manifest names this exception.
const personaEntry = {
  type: "object",
  anyOf: [{ required: ["id"] }, { required: ["name"] }],
  properties: {
    id: { type: "string", pattern: "^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$" },
    name: { type: "string", pattern: "^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$" },
    description: { type: "string", maxLength: 2000 },
    role: { type: "string", maxLength: 200 },
    storageState: { type: "string", maxLength: 1000 },
    login: { type: "object" },
    approval,
    extensions: { type: "object", maxProperties: 16 },
  },
  additionalProperties: true,
};
const personaMapValue = {
  anyOf: [
    { type: "string", minLength: 1 },
    {
      ...personaEntry,
      anyOf: undefined,
      properties: Object.fromEntries(Object.entries(personaEntry.properties).filter(([key]) => key !== "id" && key !== "name")),
    },
  ],
};
const personasFile = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: `${schemaBase}/personas.schema.json`,
  title: "Jevitate personas.json v1",
  oneOf: [
    { type: "array", items: personaEntry },
    { type: "object", additionalProperties: false, required: ["personas"], properties: { personas: { type: "array", items: personaEntry } } },
    { type: "object", propertyNames: { pattern: "^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$" }, additionalProperties: personaMapValue },
  ],
};

const jobEntry = generatedSchema(JobSchema, "job.schema.json", "Jevitate job v1");
const jobsFile = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: `${schemaBase}/jobs.schema.json`,
  title: "Jevitate jobs.json v1",
  oneOf: [
    { type: "array", items: { $ref: "job.schema.json" } },
    { type: "object", additionalProperties: false, required: ["jobs"], properties: { jobs: { type: "array", items: { $ref: "job.schema.json" } } } },
  ],
};
const journey = generatedSchema(JourneySchema, "journey.schema.json", "Jevitate Journey v1");

function parseOptions(argv, env) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (!["--source-repository", "--source-commit", "--package-version-at-commit"].includes(name) || value === undefined) {
      throw new Error("usage: generate-jevitate-catalog-contract.mjs --source-commit <full-sha> [--source-repository <url>] [--package-version-at-commit <version>]");
    }
    values.set(name, value);
  }
  const source = {
    repository: values.get("--source-repository") ?? env.JEVITATE_CONTRACT_SOURCE_REPOSITORY ?? "https://github.com/matt-cochran/jevitate.git",
    commit: values.get("--source-commit") ?? env.JEVITATE_CONTRACT_SOURCE_COMMIT,
    packageVersionAtCommit: values.get("--package-version-at-commit") ?? env.JEVITATE_CONTRACT_PACKAGE_VERSION ?? packageJson.version,
  };
  if (!/^https:\/\/.+/.test(source.repository)) throw new Error("contract source repository must be an https URL");
  if (!/^[0-9a-f]{40}$/.test(source.commit ?? "")) throw new Error("contract source commit must be a full lowercase Git SHA");
  if (typeof source.packageVersionAtCommit !== "string" || source.packageVersionAtCommit.length === 0) throw new Error("contract packageVersionAtCommit is required");
  return source;
}

const source = parseOptions(process.argv.slice(2), process.env);

function compareUtf16CodeUnits(a, b) {
  const length = Math.min(a.length, b.length);
  for (let index = 0; index < length; index += 1) {
    const difference = a.charCodeAt(index) - b.charCodeAt(index);
    if (difference !== 0) return difference < 0 ? -1 : 1;
  }
  return a.length === b.length ? 0 : a.length < b.length ? -1 : 1;
}

function canonical(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const entries = Object.entries(value).sort(([a], [b]) => compareUtf16CodeUnits(a, b));
  return `{${entries.map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`).join(",")}}`;
}
const vector = (kind, input) => ({ kind, input, canonical: canonical(input), sha256: sha256(canonical(input)) });
const vectors = {
  algorithm: "jevitate-content-hash-v1",
  canonicalization: "UTF-8 JSON; arrays retain order; object keys sort lexicographically by unsigned UTF-16 code units; no whitespace",
  vectors: [
    vector("persona", { id: "owner", description: "Owns the product", role: "owner", extensions: { journeeze: { tier: "private" } } }),
    vector("job", { id: "review-work", trigger: "work is ready", motivation: "review it", outcome: "ship with confidence", personas: ["owner"] }),
    vector("unicode-order", { z: 1, "ä": 2, a: 3, "Å": 4 }),
    vector("unicode-code-unit-order", { "\uE000": 1, "𐀀": 2, "e\u0301": 3, "é": 4 }),
    vector("journey-review", {
      metadata: { id: "review-work", name: "Review work", params: [], createdAtIso: "2026-10-24T00:00:00.000Z" },
      recording: { version: "1.0.0", site: "http://localhost", pages: [] },
    }),
  ],
};

const validPersona = [{ id: "owner", description: "Owns the product", role: "owner" }];
const validJob = [{ id: "review-work", trigger: "work is ready", motivation: "review it", outcome: "ship with confidence", personas: ["owner"] }];
const validJourney = {
  metadata: { id: "review-work", name: "Review work", promoted: false, params: [], createdAtIso: "2026-10-24T00:00:00.000Z" },
  recording: { version: "1.0.0", site: "http://localhost", pages: [] },
};

rmSync(root, { recursive: true, force: true });
write("README.md", `# Jevitate repository catalog contract v1\n\nThis immutable contract release defines the git-backed \`.jevitate/\` files shared with consumers.\nThe JSON Schemas are closed where the runtime schemas are closed. The sole v1 exception is legacy\npersona descriptive keys: they remain open and participate in the persona approval hash; a future\nv2 moves non-core data under the namespaced \`extensions\` object.\n\nApproval hashes use \`approval-hash-vectors.json\`. Canonical object keys sort lexicographically by\nunsigned UTF-16 code units; arrays retain order and the encoded JSON has no insignificant whitespace.\nSession paths and login settings are operational and excluded from persona approval hashes. A\nconsumer must still run Jevitate's semantic reference and approval checks; JSON Schema validation\nalone is insufficient.\n\nThe manifest records the source repository, the full source commit and the package version at that\ncommit. Publication is intentionally two commits: first commit source and generator changes, then\nrun the generator with that commit's SHA and commit the regenerated immutable contract.\n`);
write("schemas/job.schema.json", jobEntry);
write("schemas/jobs.schema.json", jobsFile);
write("schemas/journey.schema.json", journey);
write("schemas/personas.schema.json", personasFile);
write("approval-hash-vectors.json", vectors);
write("fixtures/valid/personas.json", validPersona);
write("fixtures/valid/jobs.json", validJob);
write("fixtures/valid/journey.json", validJourney);
write("fixtures/invalid/jobs-unknown-field.json", [{ ...validJob[0], typo: true }]);
write("fixtures/invalid/journey-unknown-field.json", { ...validJourney, typo: true });

function files(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    return entry.isDirectory() ? files(full) : [full];
  });
}
const manifestFiles = files(root)
  .map((full) => ({ path: relative(root, full).replaceAll("\\", "/"), bytes: statSync(full).size, sha256: sha256(readFileSync(full)) }))
  .sort((a, b) => compareUtf16CodeUnits(a.path, b.path));
const manifest = {
  kind: "jevitate.catalog-contract",
  version: contractVersion,
  package: "@jevitate/cli",
  source,
  compatibility: {
    repositoryCatalogMajor: 1,
    approvalHash: "jevitate-content-hash-v2",
    readsApprovalHashes: ["jevitate-content-hash-v2", "jevitate-content-hash-v1"],
  },
  exceptions: ["personas.v1.legacy-descriptive-keys"],
  files: manifestFiles,
};
const manifestBytes = json(manifest);
write("manifest.json", manifestBytes);
writeFileSync(
  identityModule,
  `// Generated by scripts/generate-jevitate-catalog-contract.mjs; do not edit.\n` +
    `export const CATALOG_CONTRACT_IDENTITY = ${JSON.stringify({
      kind: manifest.kind,
      version: manifest.version,
      manifestSha256: sha256(manifestBytes),
    }, null, 2)} as const;\n`,
);

console.log(`generated Jevitate catalog contract ${contractVersion}: ${manifestFiles.length} files`);
