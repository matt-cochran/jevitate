import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { ClaimResultSchema, RunResultClaimVerdictsEnvelopeSchema } from "../../journey/dist/index.js";

// The run-result contract v1: the claim-verdict part of an `explore --job <id> --job-context` result,
// generated from its runtime source of truth (@jevitate/journey `run-result-claims.ts`).
const root = fileURLToPath(new URL("../contracts/jevitate-run-result/v1", import.meta.url));
const contractVersion = "1.0.0";
const schemaBase = "https://jevitate.com/schemas/run-result/v1";
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

function parseOptions(argv, env) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (!["--source-repository", "--source-commit", "--package-version-at-commit"].includes(name) || value === undefined) {
      throw new Error("usage: generate-jevitate-run-result-contract.mjs --source-commit <full-sha> [--source-repository <url>] [--package-version-at-commit <version>]");
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

const contentHash = "3f1c0a9e5b7d2c4e6f8a0b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f7a8b9c0d1e";
const envelope = (data) => ({ v: 1, ok: true, data: { schemaVersion: 1, strategy: "goal", jobContext: { job: "invite", contentHash }, ...data } });
const claims = [
  { id: "invite-pending", statement: "a new invite shows as Pending", verdict: "confirmed", basis: "check" },
  { id: "invite-email", statement: "the invite email names the team", verdict: "contradicted", basis: "check" },
  { id: "invite-expiry", statement: "an invite expires after seven days", verdict: "not_observed", basis: "check" },
  { id: "one-seat", statement: "an invite uses one free seat", verdict: "confirmed", basis: "model" },
  { id: "owner-only", statement: "only an owner can invite", verdict: "contradicted", basis: "model" },
  { id: "resend", statement: "a pending invite can be resent", verdict: "not_observed", basis: "model" },
  { id: "audit-log", statement: "every invite is written to the audit log", verdict: "not_observed", basis: "no-evidence" },
  { id: "revoke", statement: "a pending invite can be revoked", verdict: "not_observed", basis: "model-error", reason: "the judgment call timed out" },
];

rmSync(root, { recursive: true, force: true });
const readme = [
  "# Jevitate run-result contract v1 (claim verdicts)",
  "",
  "This immutable contract release defines the claim-verdict part of a run result, for external tools",
  "that consume run results. It covers what a consumer needs to read the verdicts of a job's claims",
  "after `jevitate explore --job <id> --job-context --json`.",
  "",
  "## Where the fields are",
  "",
  "The command prints one JSON envelope on stdout, `{v, ok, data}`, described by",
  "`schemas/run-result.schema.json`:",
  "",
  "- `v` is the envelope version (1); `ok` is `true` for a run that produced a result.",
  "- `data.schemaVersion` is the result schema version (1) and `data.strategy` is `goal`.",
  "- `data.jobContext` is `{job, contentHash}`: the catalog job id the run was told about and the",
  "  content hash of the approved job it used, so a verdict is placed on that exact job version.",
  "- `data.claims[]` holds one verdict per `guidance.claims[]` entry of that job, in order",
  "  (`schemas/claim.schema.json`): `id` and `statement` as the job states them, `verdict`",
  "  (`confirmed`, `contradicted` or `not_observed`), `basis` (`check`, `model`, `no-evidence` or",
  "  `model-error`) and, with `model-error`, a `reason`. `claims` is absent when the job has no claims.",
  "",
  "`data` is open: every other field of the result passes through and is outside this contract. A claim",
  "and the job context are closed: a field this version does not name is refused. A `contradicted`",
  "claim is a divergence between a document and the product for a person to triage; it never changes",
  "the run's exit code. The result carries no run start time.",
  "",
  "The claim verdicts are in the emitted envelope only. The persisted `<recording>.result.json` is",
  "written before the claims are evaluated and does not hold `jobContext` or `claims`.",
  "",
  "## Stability",
  "",
  "A published contract never changes. An additive, optional field in a later release keeps this",
  "contract valid for what it names; a change that a v1 validator would refuse, or that changes the",
  "meaning of a named field, is a new contract major published beside this one at a sibling path.",
  "Consumers vendor one exact released package and verify the manifest; they do not fetch a mutable",
  "schema URL at runtime.",
  "",
  "The manifest records the source repository, the full source commit and the package version at that",
  "commit. Publication is intentionally two commits: first commit source and generator changes, then",
  "run the generator with that commit's SHA and commit the regenerated immutable contract.",
  "",
].join("\n");
write("README.md", readme);
write("schemas/run-result.schema.json", generatedSchema(RunResultClaimVerdictsEnvelopeSchema, "run-result.schema.json", "Jevitate run result v1 (claim verdicts)"));
write("schemas/claim.schema.json", generatedSchema(ClaimResultSchema, "claim.schema.json", "Jevitate claim verdict v1"));
// Every verdict with each basis that can decide it (no-evidence and model-error only decide not_observed).
write("fixtures/valid/claims.json", envelope({ claims }));
// A job with no claims: the run still records the job context, and no `claims`.
write("fixtures/valid/no-claims.json", envelope({}));
// `data` is open: the result's other fields pass through.
write("fixtures/valid/claims-with-other-result-fields.json", envelope({ missionOutcome: "clean", goalOutcome: "succeeded", exitCode: 0, claims: claims.slice(0, 1) }));
write("fixtures/invalid/claim-unknown-verdict.json", envelope({ claims: [{ ...claims[0], verdict: "partially_confirmed" }] }));
write("fixtures/invalid/claim-missing-basis.json", envelope({ claims: [{ id: claims[0].id, statement: claims[0].statement, verdict: claims[0].verdict }] }));
write("fixtures/invalid/claim-unknown-field.json", envelope({ claims: [{ ...claims[0], confidence: 0.9 }] }));

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
  kind: "jevitate.run-result-contract",
  version: contractVersion,
  package: "@jevitate/cli",
  source,
  compatibility: {
    // The `--json` envelope's `v` and the result's `schemaVersion` this contract describes.
    jsonEnvelopeVersion: 1,
    resultSchemaVersion: 1,
  },
  files: manifestFiles,
};
write("manifest.json", manifest);

console.log(`generated Jevitate run-result contract ${contractVersion}: ${manifestFiles.length} files`);
