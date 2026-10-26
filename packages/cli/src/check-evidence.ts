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

export function createEvidenceManifest(input: EvidenceKeyInput, resultDigests: Readonly<Record<string, string>>): EvidenceManifest {
  const key = evidenceKey(input);
  const unsigned = { version: 1 as const, key, input, outcome: "pass" as const, resultDigests };
  return { ...unsigned, contentDigest: `sha256:${sha256(unsigned as unknown as Json)}` };
}

/** Refuses malformed, non-passing, mismatched, and content-tampered evidence. */
export function reuseDecision(input: EvidenceKeyInput, candidate: EvidenceManifest | undefined): EvidenceDecision {
  if (candidate === undefined) return { decision: "run", reasons: ["missing-evidence"] };
  if (candidate.version !== 1) return { decision: "run", reasons: ["unsupported-evidence-version"] };
  if (candidate.outcome !== "pass") return { decision: "run", reasons: ["evidence-not-successful"] };
  const expectedKey = evidenceKey(input);
  if (candidate.key !== expectedKey) return { decision: "run", reasons: ["evidence-key-mismatch"] };
  const unsigned = { version: candidate.version, key: candidate.key, input: candidate.input, outcome: candidate.outcome, resultDigests: candidate.resultDigests };
  const expectedDigest = `sha256:${sha256(unsigned as unknown as Json)}`;
  const a = Buffer.from(expectedDigest);
  const b = Buffer.from(candidate.contentDigest);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return { decision: "run", reasons: ["evidence-tampered"] };
  return { decision: "skip", reasons: ["matching-evidence"], manifest: candidate };
}
