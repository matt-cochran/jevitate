import { createHash } from "node:crypto";
import { z } from "zod";
import { journeyParamSchema } from "./param-schema.js";
import { secretParamNames } from "./intent.js";
import type { Journey } from "./journey.js";

/**
 * #582 (docs/contracts/journey-handoff.md): the typed Journey handoff. A producing Journey declares
 * the record it outputs (`metadata.outputs`); a consuming Journey declares the record it accepts, the
 * request a caller supplies and how both bind to its params (`metadata.inputs`). This module holds the
 * two optional schema blocks (§1-§3) and the PURE §4 validation a chain runs before the consuming
 * Journey runs once: compatibility, record/request field validation, duplicate detection, binding to
 * params and the record fingerprint. It never fetches, reads a page or evaluates captured text.
 */

/** §1: the five handoff field types. */
export const HANDOFF_FIELD_TYPES = ["id", "text", "path", "url", "timestamp"] as const;
export type HandoffFieldType = (typeof HANDOFF_FIELD_TYPES)[number];

/** §2/§3: a handoff contract id, `<name>@<major>`. */
export const HANDOFF_CONTRACT_RE = /^[a-z0-9][a-z0-9.-]{0,63}@[1-9][0-9]{0,3}$/;

/** §2: one declared output/request field. `required` defaults to true. */
export interface HandoffFieldDecl {
  readonly type: HandoffFieldType;
  readonly required?: boolean;
  /** §2 (#624): a `url` field's data origins, checked instead of the browser origins. */
  readonly origins?: readonly string[];
}
export type HandoffFields = Record<string, HandoffFieldDecl>;

/** §2: a producing Journey's `metadata.outputs`. */
export interface HandoffOutputsDecl {
  readonly contract: string;
  /** Names a `forEach` `as`; absent: one record from flat `<field>` outputs. */
  readonly collection?: string;
  /** The fields that identify a record; default: every required `id` field. */
  readonly key?: readonly string[];
  readonly fields: HandoffFields;
}

/** §3: exactly one source of a param's value. */
export type HandoffBinding =
  | { readonly record: string }
  | { readonly request: string }
  | { readonly const: string }
  | { readonly secret: string };

/** §3: a consuming Journey's `metadata.inputs`. */
export interface HandoffInputsDecl {
  readonly accepts: string;
  readonly request: { readonly fields: HandoffFields; readonly key: readonly string[] };
  readonly bindings: Record<string, HandoffBinding>;
}

/** One discovered record, as read from a run's outputs (only the declared fields present). */
export type HandoffRecord = Record<string, unknown>;

/** §4: a field-level rule a record or request broke. */
export interface HandoffFieldError {
  readonly field: string;
  readonly code: "missing" | "unknown" | "type" | "malformed";
}

/** §4/§5: one record or request a chain refuses to run. */
export interface HandoffRejection {
  readonly key: string;
  readonly reason: "invalid-record" | "ambiguous" | "invalid-request";
  readonly errors: readonly HandoffFieldError[];
}

/** A §4 validation outcome: the records/requests that proceed, and the ones that do not. */
export interface HandoffValidation<T> {
  readonly valid: readonly T[];
  readonly rejected: readonly HandoffRejection[];
}

/** Where a schema or compatibility rule was broken (a path from the Journey root) and why. */
export interface HandoffIssue {
  readonly path: ReadonlyArray<string | number>;
  readonly message: string;
}

/** §1: the value rules need the run's allowed origins (`recording.site`, `metadata.allowedOrigins`, the environment). */
export interface HandoffContext {
  readonly allowedOrigins?: readonly string[];
}

/** The outcome of validating one value: `null` when it satisfies its type. */
export interface HandoffValueError {
  readonly code: "type" | "malformed";
}

const HandoffFieldSchema = z
  .object({
    type: z.enum(HANDOFF_FIELD_TYPES, { message: `E_HANDOFF_SCHEMA: a field type is one of ${HANDOFF_FIELD_TYPES.join("|")}` }),
    required: z.boolean().optional(),
    origins: z.array(z.string()).optional(),
  })
  .strict();

const HandoffFieldsSchema = z.record(z.string().min(1), HandoffFieldSchema);

/** §2: the optional `metadata.outputs` block. */
export const JourneyOutputsSchema = z
  .object({
    contract: z.string().regex(HANDOFF_CONTRACT_RE, "E_HANDOFF_SCHEMA: outputs.contract must be <name>@<major>"),
    collection: z.string().min(1).optional(),
    key: z.array(z.string().min(1)).optional(),
    fields: HandoffFieldsSchema,
  })
  .strict();

/** §3: one binding is exactly one source — record, request, const or secret. */
const HandoffBindingSchema = z.union(
  [
    z.object({ record: z.string().min(1) }).strict(),
    z.object({ request: z.string().min(1) }).strict(),
    z.object({ const: z.string() }).strict(),
    z.object({ secret: z.string().min(1) }).strict(),
  ],
  { message: "E_HANDOFF_SCHEMA: a binding is exactly one of record|request|const|secret" },
);

/** §3: the optional `metadata.inputs` block. */
export const JourneyInputsSchema = z
  .object({
    accepts: z.string().regex(HANDOFF_CONTRACT_RE, "E_HANDOFF_SCHEMA: inputs.accepts must be <name>@<major>"),
    request: z
      .object({ fields: HandoffFieldsSchema, key: z.array(z.string().min(1)) })
      .strict(),
    bindings: z.record(z.string().min(1), HandoffBindingSchema),
  })
  .strict();

/** The declared fields of one type as a set. */
const CONTROL_RE = /[\u0000-\u001f\u007f]/;
const SCHEME_RE = /^[a-z][a-z0-9+.-]*:/i;

/** Normalize an allowed origin (a bare origin or a URL) to a comparable origin. */
function normalizeOrigin(origin: string): string {
  try {
    return new URL(origin).origin;
  } catch {
    return origin;
  }
}

/**
 * §1: validate one field value against its declared type. `null` accepts it verbatim; `id` is compared
 * byte for byte (never trimmed or case-folded); a `url` whose origin is not allowed is `malformed`.
 */
export function validateFieldValue(type: HandoffFieldType, value: unknown, ctx: HandoffContext = {}): HandoffValueError | null {
  if (typeof value !== "string") return { code: "type" };
  switch (type) {
    case "id":
      if (value.length === 0 || value.length > 512 || CONTROL_RE.test(value)) return { code: "malformed" };
      return null;
    case "text":
      return value.length > 20_000 ? { code: "malformed" } : null;
    case "path": {
      if (!value.startsWith("/") || value.startsWith("//") || value.length > 2048) return { code: "malformed" };
      if (SCHEME_RE.test(value)) return { code: "malformed" };
      if (value.split(/[?#]/, 1)[0]!.split("/").includes("..")) return { code: "malformed" };
      return null;
    }
    case "url": {
      let url: URL;
      try {
        url = new URL(value);
      } catch {
        return { code: "malformed" };
      }
      if (url.protocol !== "http:" && url.protocol !== "https:") return { code: "malformed" };
      const allowed = (ctx.allowedOrigins ?? []).map(normalizeOrigin);
      return allowed.includes(url.origin) ? null : { code: "malformed" };
    }
    case "timestamp":
      if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(value)) return { code: "malformed" };
      return Number.isFinite(Date.parse(value)) ? null : { code: "malformed" };
  }
}

/** §2: the fields that identify a record — the declared `key`, or every required `id` field. */
export function outputKeyFields(outputs: HandoffOutputsDecl): string[] {
  if (outputs.key !== undefined) return [...outputs.key];
  return Object.keys(outputs.fields).filter((f) => outputs.fields[f]!.type === "id" && outputs.fields[f]!.required !== false);
}

/** A record/request key: the key fields' values joined, so two records with the same identity collide. */
export function handoffKey(keyFields: readonly string[], bag: HandoffRecord): string {
  return keyFields.map((f) => (bag[f] === undefined ? "" : String(bag[f]))).join("\u0000");
}

/**
 * §2/§4: read a run's records. A `collection` reads `<collection>.<i>.<field>` and
 * `<collection>.count`; without one, a single record from the flat `<field>` outputs. A missing or
 * non-positive count yields no records (the chain then stops as empty, §4 step 4).
 */
export function readRecords(outputs: HandoffOutputsDecl, runOutput: unknown): HandoffRecord[] {
  const bag = runOutput !== null && typeof runOutput === "object" ? (runOutput as HandoffRecord) : {};
  if (outputs.collection === undefined) {
    const record: HandoffRecord = {};
    for (const name of Object.keys(outputs.fields)) {
      const value = bag[name];
      if (value !== undefined) record[name] = value;
    }
    return [record];
  }
  const raw = bag[`${outputs.collection}.count`];
  const count = typeof raw === "string" && /^\d+$/.test(raw) ? Number.parseInt(raw, 10) : Number.NaN;
  if (!Number.isInteger(count) || count <= 0) return [];
  return Array.from({ length: count }, (_, i) => {
    const record: HandoffRecord = {};
    for (const name of Object.keys(outputs.fields)) {
      const value = bag[`${outputs.collection}.${i}.${name}`];
      if (value !== undefined) record[name] = value;
    }
    return record;
  });
}

/** §4 step 2/5: every field-level rule a value against `fields` breaks. */
function fieldErrors(fields: HandoffFields, bag: HandoffRecord, ctx: HandoffContext): HandoffFieldError[] {
  const errors: HandoffFieldError[] = [];
  for (const [name, decl] of Object.entries(fields)) {
    const value = bag[name];
    if (value === undefined) {
      if (decl.required !== false) errors.push({ field: name, code: "missing" });
      continue;
    }
    const fieldCtx = decl.type === "url" && decl.origins !== undefined ? { allowedOrigins: decl.origins } : ctx;
    const err = validateFieldValue(decl.type, value, fieldCtx);
    if (err !== null) errors.push({ field: name, code: err.code });
  }
  for (const name of Object.keys(bag)) if (fields[name] === undefined) errors.push({ field: name, code: "unknown" });
  return errors;
}

/**
 * §4 steps 2-3: validate each discovered record against `outputs.fields`, then reject duplicate keys as
 * ambiguous (neither runs — no guess, no first-wins). An invalid record is `invalid-record`.
 */
export function validateRecords(outputs: HandoffOutputsDecl, records: readonly HandoffRecord[], ctx: HandoffContext = {}): HandoffValidation<HandoffRecord> {
  const keyFields = outputKeyFields(outputs);
  const counts = new Map<string, number>();
  if (keyFields.length > 0) for (const r of records) counts.set(handoffKey(keyFields, r), (counts.get(handoffKey(keyFields, r)) ?? 0) + 1);
  const valid: HandoffRecord[] = [];
  const rejected: HandoffRejection[] = [];
  for (const record of records) {
    const key = handoffKey(keyFields, record);
    const errors = fieldErrors(outputs.fields, record, ctx);
    if (errors.length > 0) rejected.push({ key, reason: "invalid-record", errors });
    else if (keyFields.length > 0 && (counts.get(key) ?? 0) > 1) rejected.push({ key, reason: "ambiguous", errors: [] });
    else valid.push(record);
  }
  return { valid, rejected };
}

/**
 * §4 step 1: `to.inputs.accepts` must equal `from.outputs.contract`, and every `record` binding must
 * name a field `from.outputs.fields` declares. Empty when either Journey declares no block.
 */
export function checkCompatibility(fromJourney: Journey, toJourney: Journey): HandoffIssue[] {
  const to = toJourney.metadata.inputs;
  if (to === undefined) return [];
  const from = fromJourney.metadata.outputs;
  if (from === undefined) {
    return [{ path: ["metadata", "inputs", "accepts"], message: `E_HANDOFF_INCOMPATIBLE: the producing Journey declares no outputs (accepts "${to.accepts}")` }];
  }
  const issues: HandoffIssue[] = [];
  if (to.accepts !== from.contract) {
    issues.push({ path: ["metadata", "inputs", "accepts"], message: `E_HANDOFF_INCOMPATIBLE: accepts "${to.accepts}" does not match the producing contract "${from.contract}"` });
  }
  for (const [param, binding] of Object.entries(to.bindings)) {
    if ("record" in binding && from.fields[binding.record] === undefined) {
      issues.push({ path: ["metadata", "inputs", "bindings", param, "record"], message: `E_HANDOFF_INCOMPATIBLE: record binding "${binding.record}" is not a field of contract "${from.contract}"` });
    }
  }
  return issues;
}

/** §4 step 5: each request against `inputs.request.fields`; a malformed request is `invalid-request`. */
export function validateRequests(inputs: HandoffInputsDecl, requests: readonly HandoffRecord[], ctx: HandoffContext = {}): HandoffValidation<HandoffRecord> {
  const valid: HandoffRecord[] = [];
  const rejected: HandoffRejection[] = [];
  for (const request of requests) {
    const errors = fieldErrors(inputs.request.fields, request, ctx);
    const key = handoffKey(inputs.request.key, request);
    if (errors.length > 0) rejected.push({ key, reason: "invalid-request", errors });
    else valid.push(request);
  }
  return { valid, rejected };
}

/**
 * §4 step 6: params come only from the bindings. A secret binding is never filled from a record,
 * request or const and is left out; a binding whose source is absent is left out too.
 */
export function bindParams(inputs: HandoffInputsDecl, record: HandoffRecord, request: HandoffRecord): Record<string, string> {
  const params: Record<string, string> = {};
  for (const [param, binding] of Object.entries(inputs.bindings)) {
    if ("secret" in binding) continue;
    if ("const" in binding) {
      params[param] = binding.const;
      continue;
    }
    const value = "record" in binding ? record[binding.record] : request[binding.request];
    if (typeof value === "string") params[param] = value;
  }
  return params;
}

/**
 * §5: a `sha256:` fingerprint of the record's declared fields (keys sorted) — a reviewer can tell two
 * runs saw the same context without seeing it. An absent field is `null`, so the digest is stable.
 */
export function recordFingerprint(outputs: HandoffOutputsDecl, record: HandoffRecord): string {
  const canonical: Record<string, unknown> = {};
  for (const name of Object.keys(outputs.fields).sort()) canonical[name] = record[name] ?? null;
  return `sha256:${createHash("sha256").update(JSON.stringify(canonical)).digest("hex")}`;
}

/** Every `extract` `as` a Journey produces (top-level and inside a `forEach`). */
function extractedNames(journey: Journey): Set<string> {
  const names = new Set<string>();
  for (const page of journey.recording.pages) {
    for (const { step } of page.steps) {
      if (step.kind === "extract") names.add(step.as);
      if (step.kind === "forEach") for (const child of step.steps) if (child.kind === "extract") names.add(child.as);
    }
  }
  return names;
}

/** Every `forEach` `as` a Journey declares — the valid `outputs.collection` names (§2). */
function forEachNames(journey: Journey): Set<string> {
  const names = new Set<string>();
  for (const page of journey.recording.pages) for (const { step } of page.steps) if (step.kind === "forEach") names.add(step.as);
  return names;
}

/** §2 (#624): an `origins` entry must be an exact origin — https, or http only for a loopback host. */
const LOOPBACK_ORIGIN_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** The reason an `origins` entry is not an exact origin, or `null` when it is. */
function originEntryError(entry: string): string | null {
  let url: URL;
  try {
    url = new URL(entry);
  } catch {
    return "is not an origin";
  }
  if (url.origin !== entry || url.hostname.includes("*")) return "is not an exact origin";
  if (url.protocol === "https:") return null;
  if (url.protocol === "http:" && LOOPBACK_ORIGIN_HOSTS.has(url.hostname)) return null;
  return "must be https, or http only for a loopback host";
}

/** §2 (#624): `origins` is a `url`-only list of exact origins. */
function originsFieldIssues(path: ReadonlyArray<string | number>, fields: HandoffFields): HandoffIssue[] {
  const issues: HandoffIssue[] = [];
  for (const [name, decl] of Object.entries(fields)) {
    if (decl.origins === undefined) continue;
    if (decl.type !== "url") {
      issues.push({ path: [...path, name], message: `E_HANDOFF_SCHEMA: origins is only allowed on url fields ("${name}" is ${decl.type})` });
      continue;
    }
    decl.origins.forEach((entry, i) => {
      const reason = originEntryError(entry);
      if (reason !== null) issues.push({ path: [...path, name, i], message: `E_HANDOFF_SCHEMA: origins entry "${entry}" ${reason}` });
    });
  }
  return issues;
}

/**
 * §2/§3 load-time refusals, as `E_HANDOFF_SCHEMA` issues run by `JourneySchema`'s `superRefine`: an
 * `outputs` field no `extract` produces; key rules; a binding to an undeclared param or request field,
 * a missing required-param binding, and the secret/non-secret binding rules.
 */
export function handoffSchemaIssues(journey: Journey): HandoffIssue[] {
  const issues: HandoffIssue[] = [];
  const outputs = journey.metadata.outputs;
  if (outputs !== undefined) {
    const extracted = extractedNames(journey);
    for (const name of Object.keys(outputs.fields)) {
      if (!extracted.has(name)) issues.push({ path: ["metadata", "outputs", "fields", name], message: `E_HANDOFF_SCHEMA: outputs: field ${name} is never extracted` });
    }
    if (outputs.collection !== undefined && !forEachNames(journey).has(outputs.collection)) {
      issues.push({ path: ["metadata", "outputs", "collection"], message: `E_HANDOFF_SCHEMA: outputs.collection "${outputs.collection}" names no forEach as` });
    }
    issues.push(...originsFieldIssues(["metadata", "outputs", "fields"], outputs.fields));
    if (outputs.key !== undefined) {
      if (new Set(outputs.key).size !== outputs.key.length) issues.push({ path: ["metadata", "outputs", "key"], message: "E_HANDOFF_SCHEMA: outputs.key: duplicate field" });
      outputs.key.forEach((field, i) => {
        const decl = outputs.fields[field];
        if (decl === undefined) issues.push({ path: ["metadata", "outputs", "key", i], message: `E_HANDOFF_SCHEMA: outputs.key names undeclared field "${field}"` });
        else if (decl.type !== "id") issues.push({ path: ["metadata", "outputs", "key", i], message: `E_HANDOFF_SCHEMA: outputs.key field "${field}" must be type id` });
        else if (decl.required === false) issues.push({ path: ["metadata", "outputs", "key", i], message: `E_HANDOFF_SCHEMA: outputs.key field "${field}" must be required` });
      });
    }
  }

  const inputs = journey.metadata.inputs;
  if (inputs !== undefined) {
    const declared = new Set([...journey.metadata.params, ...(journey.metadata.parameters ?? []).map((p) => p.name)]);
    const required = journeyParamSchema(journey).required;
    const secret = new Set(secretParamNames(journey));
    const allowed = new Set([...declared, ...required]);
    for (const [param, binding] of Object.entries(inputs.bindings)) {
      if (!allowed.has(param)) {
        issues.push({ path: ["metadata", "inputs", "bindings", param], message: `E_HANDOFF_SCHEMA: bindings names undeclared param "${param}"` });
        continue;
      }
      const isSecret = secret.has(param);
      if ("secret" in binding && !isSecret) issues.push({ path: ["metadata", "inputs", "bindings", param], message: `E_HANDOFF_SCHEMA: param "${param}" is not secret and may not bind to a secret` });
      if (!("secret" in binding) && isSecret) issues.push({ path: ["metadata", "inputs", "bindings", param], message: `E_HANDOFF_SCHEMA: secret param "${param}" may only bind to a secret` });
      if ("request" in binding && inputs.request.fields[binding.request] === undefined) {
        issues.push({ path: ["metadata", "inputs", "bindings", param, "request"], message: `E_HANDOFF_SCHEMA: request binding names undeclared request field "${binding.request}"` });
      }
    }
    for (const param of required) {
      if (!(param in inputs.bindings)) issues.push({ path: ["metadata", "inputs", "bindings"], message: `E_HANDOFF_SCHEMA: required param "${param}" has no binding` });
    }
    issues.push(...originsFieldIssues(["metadata", "inputs", "request", "fields"], inputs.request.fields));
    inputs.request.key.forEach((field, i) => {
      const decl = inputs.request.fields[field];
      if (decl === undefined) issues.push({ path: ["metadata", "inputs", "request", "key", i], message: `E_HANDOFF_SCHEMA: request.key names undeclared field "${field}"` });
      else if (decl.type !== "id") issues.push({ path: ["metadata", "inputs", "request", "key", i], message: `E_HANDOFF_SCHEMA: request.key field "${field}" must be type id` });
    });
  }
  return issues;
}
