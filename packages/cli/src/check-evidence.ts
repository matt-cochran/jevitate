import { createHash, timingSafeEqual } from "node:crypto";

/** #704: the complete immutable identity of evidence that may be reused. */
export interface EvidenceKeyInput {
  readonly app: { readonly build: string; readonly target: string; readonly origins: readonly string[] };
  readonly suite: { readonly name: string; readonly policyHash: string; readonly changedRoutes: readonly string[] };
  readonly inputs: { readonly journeys: Readonly<Record<string, string>>; readonly fixtures: string; readonly parameters: string; readonly invariants: string; readonly goals: string; readonly missions: string };
}

export interface EvidenceManifest {
  readonly version: 1;
  readonly key: string;
  readonly input: EvidenceKeyInput;
  /** sha256 of the canonical manifest without this field: tampering is refused before reuse. */
  readonly contentDigest: string;
  readonly outcome: "pass";
  readonly resultDigests: Readonly<Record<string, string>>;
}

export type EvidenceDecision =
  | { readonly decision: "run"; readonly reasons: readonly string[] }
  | { readonly decision: "skip"; readonly reasons: readonly ["matching-evidence"]; readonly manifest: EvidenceManifest };

type Json = null | boolean | number | string | readonly Json[] | { readonly [key: string]: Json };

function record(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function string(value: unknown, label: string): string {
  if (typeof value !== "string" || value === "") throw new Error(`${label} must be a non-empty string`);
  return value;
}

/** Parse a CLI evidence-input file before any gateway or browser is selected. */
export function parseEvidenceKeyInput(value: unknown): EvidenceKeyInput {
  const root = record(value, "evidence input");
  const app = record(root.app, "evidence input.app");
  const suite = record(root.suite, "evidence input.suite");
  const inputs = record(root.inputs, "evidence input.inputs");
  const origins = app.origins;
  if (!Array.isArray(origins) || origins.some((origin) => typeof origin !== "string" || origin === "")) throw new Error("evidence input.app.origins must be non-empty strings");
  const journeys = record(inputs.journeys, "evidence input.inputs.journeys");
  for (const [id, hash] of Object.entries(journeys)) string(hash, `evidence input.inputs.journeys.${id}`);
  const changedRoutes = suite.changedRoutes;
  if (!Array.isArray(changedRoutes) || changedRoutes.some((route) => typeof route !== "string")) throw new Error("evidence input.suite.changedRoutes must be strings");
  return {
    app: { build: string(app.build, "evidence input.app.build"), target: string(app.target, "evidence input.app.target"), origins: [...origins] },
    suite: { name: string(suite.name, "evidence input.suite.name"), policyHash: string(suite.policyHash, "evidence input.suite.policyHash"), changedRoutes: [...changedRoutes] },
    inputs: {
      journeys: journeys as Readonly<Record<string, string>>,
      fixtures: string(inputs.fixtures, "evidence input.inputs.fixtures"),
      parameters: string(inputs.parameters, "evidence input.inputs.parameters"),
      invariants: string(inputs.invariants, "evidence input.inputs.invariants"),
      goals: string(inputs.goals, "evidence input.inputs.goals"),
      missions: string(inputs.missions, "evidence input.inputs.missions"),
    },
  };
}

/** Parse an untrusted manifest before comparing its content digest. */
export function parseEvidenceManifest(value: unknown): EvidenceManifest {
  const root = record(value, "evidence manifest");
  if (root.version !== 1) throw new Error("evidence manifest.version must be 1");
  const resultDigests = record(root.resultDigests, "evidence manifest.resultDigests");
  for (const [path, digest] of Object.entries(resultDigests)) string(digest, `evidence manifest.resultDigests.${path}`);
  if (root.outcome !== "pass") throw new Error("evidence manifest.outcome must be pass");
  return { version: 1, key: string(root.key, "evidence manifest.key"), input: parseEvidenceKeyInput(root.input), contentDigest: string(root.contentDigest, "evidence manifest.contentDigest"), outcome: "pass", resultDigests: resultDigests as Readonly<Record<string, string>> };
}

/** Stable JSON, deliberately independent of object insertion order. */
export function canonicalJson(value: Json): string {
  if (value === null || typeof value === "boolean" || typeof value === "number" || typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const object = value as { readonly [key: string]: Json };
  return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key]!)}`).join(",")}}`;
}

export function sha256(value: Json): string {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}

export function evidenceKey(input: EvidenceKeyInput): string {
  return `sha256:${sha256(input as unknown as Json)}`;
}

/** The changed proof inputs are safe to expose to a scheduler; values and credentials never are. */
export function evidenceMismatchReasons(input: EvidenceKeyInput, candidate: EvidenceKeyInput): readonly string[] {
  const changed = (a: unknown, b: unknown): boolean => canonicalJson(a as Json) !== canonicalJson(b as Json);
  const reasons = [
    ...(input.app.build !== candidate.app.build ? ["application-build-changed"] : []),
    ...(input.app.target !== candidate.app.target || changed(input.app.origins, candidate.app.origins) ? ["target-drift"] : []),
    ...(input.suite.name !== candidate.suite.name ? ["suite-changed"] : []),
    ...(input.suite.policyHash !== candidate.suite.policyHash ? ["suite-policy-changed"] : []),
    ...(changed(input.suite.changedRoutes, candidate.suite.changedRoutes) ? ["changed-routes-changed"] : []),
    ...(changed(input.inputs.journeys, candidate.inputs.journeys) ? ["journey-content-changed"] : []),
    ...(input.inputs.fixtures !== candidate.inputs.fixtures ? ["fixtures-changed"] : []),
    ...(input.inputs.parameters !== candidate.inputs.parameters ? ["parameters-changed"] : []),
    ...(input.inputs.invariants !== candidate.inputs.invariants ? ["invariants-changed"] : []),
    ...(input.inputs.goals !== candidate.inputs.goals ? ["goals-changed"] : []),
    ...(input.inputs.missions !== candidate.inputs.missions ? ["missions-changed"] : []),
  ];
  return reasons;
}

export function createEvidenceManifest(input: EvidenceKeyInput, resultDigests: Readonly<Record<string, string>>): EvidenceManifest {
  const key = evidenceKey(input);
  const unsigned = { version: 1 as const, key, input, outcome: "pass" as const, resultDigests };
  return { ...unsigned, contentDigest: `sha256:${sha256(unsigned as unknown as Json)}` };
}

/** Returns an explicit reuse-refusal reason when a manifest's referenced proof is unavailable or changed. */
export function evidenceArtifactsReason(manifest: EvidenceManifest, read: (path: string) => string): string | undefined {
  try {
    for (const [path, digest] of Object.entries(manifest.resultDigests)) {
      if (`sha256:${sha256(read(path))}` !== digest) return "evidence-artifact-tampered";
    }
  } catch {
    return "evidence-artifact-missing";
  }
  return undefined;
}

/** Refuses malformed, non-passing, mismatched, and content-tampered evidence. */
export function reuseDecision(input: EvidenceKeyInput, candidate: EvidenceManifest | undefined): EvidenceDecision {
  if (candidate === undefined) return { decision: "run", reasons: ["missing-evidence"] };
  if (candidate.version !== 1) return { decision: "run", reasons: ["unsupported-evidence-version"] };
  if (candidate.outcome !== "pass") return { decision: "run", reasons: ["evidence-not-successful"] };
  const expectedKey = evidenceKey(input);
  if (candidate.key !== expectedKey) {
    const reasons = evidenceMismatchReasons(input, candidate.input);
    return { decision: "run", reasons: reasons.length === 0 ? ["evidence-key-mismatch"] : reasons };
  }
  const unsigned = { version: candidate.version, key: candidate.key, input: candidate.input, outcome: candidate.outcome, resultDigests: candidate.resultDigests };
  const expectedDigest = `sha256:${sha256(unsigned as unknown as Json)}`;
  const a = Buffer.from(expectedDigest);
  const b = Buffer.from(candidate.contentDigest);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return { decision: "run", reasons: ["evidence-tampered"] };
  return { decision: "skip", reasons: ["matching-evidence"], manifest: candidate };
}
