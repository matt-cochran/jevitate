import { ParamValidationError, journeyParamSchema, secretNamedValues, secretParamValues, type Journey } from "@jevitate/journey";
import { normalizeAllowlist } from "@jevitate/explore";
import { redactText } from "@jevitate/ai-core";
import { DEFECT_OUTCOME_STATUSES, GOAL_OUTCOMES, JOURNEY_RUN_OUTCOMES, MISSION_OUTCOMES, MUTATION_PROOF_VERDICTS } from "@jevitate/domain";
import type { ResolvedJourneyEnvironment } from "./environments.js";

/**
 * #246: a secret parameter's value (declared `secret: true`, or a credential-like name) never comes
 * back in a run's output — the interpreter's vars start as the params, so the value is masked there.
 */
export function redactSecretParams<T>(result: T, journey: Journey, params: Record<string, string>): T {
  return redactSecretValues(result, secretParamValues(journey, params));
}

/** Every string in `result` (deeply) with each secret, in each of its URL forms, masked. */

export function runSecretValues(secrets: readonly string[], result: unknown, nonSecret: ReadonlySet<string> = new Set()): string[] {
  const output = result !== null && typeof result === "object" && "output" in result ? (result as { output: unknown }).output : undefined;
  return [...new Set([...secrets, ...secretNamedValues(output, nonSecret)])];
}

export function redactSecretValues<T>(result: T, secrets: readonly string[]): T {
  if (secrets.length === 0) return result;
  // Independent check M7: a structural field holding one of the run's own code tokens is never masked
  // (a secret `ok` must not mask `outcome: "ok"`, or no exit code is attached). Free text, and anything
  // under a value subtree (`output`, `fixtures`, `params`), is redacted as before.
  const scrub = (v: unknown, inValues: boolean, key?: string): unknown =>
    typeof v === "string"
      ? !inValues && key !== undefined && isStructuralToken(key, v)
        ? v
        : redactText(v, secrets)
      : Array.isArray(v)
        ? v.map((x) => scrub(x, inValues, key))
        : v !== null && typeof v === "object"
          ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, scrub(x, inValues || VALUE_SUBTREES.has(k), k)]))
          : v;
  return scrub(result, false) as T;
}

/** Where a run's values live: under these keys every string is a value, whatever its own key is named. */
const VALUE_SUBTREES: ReadonlySet<string> = new Set(["output", "fixtures", "params", "values", "bindings", "vars"]);
/** The closed vocabularies of the fields a run's own code writes: outcomes, verdicts, statuses. */
const CODE_TOKENS: ReadonlySet<string> = new Set<string>([
  ...JOURNEY_RUN_OUTCOMES,
  ...MISSION_OUTCOMES,
  ...GOAL_OUTCOMES,
  ...MUTATION_PROOF_VERDICTS,
  ...DEFECT_OUTCOME_STATUSES,
  "held",
  "cascade",
  "not-applied",
  "error",
  "unpaired",
  "passed",
  "failed",
  "refused",
  "not-reached",
  "skipped",
]);
const ENUM_FIELDS: ReadonlySet<string> = new Set(["outcome", "verdict", "status", "goalOutcome", "jobOutcome"]);
const CODE_FIELDS: ReadonlySet<string> = new Set(["code", "codes", "errorCode", "refusal"]);
const ERROR_CODE_TOKEN = /^E_[A-Z0-9_]{1,62}$/;

function isStructuralToken(key: string, value: string): boolean {
  if (ENUM_FIELDS.has(key)) return CODE_TOKENS.has(value);
  if (CODE_FIELDS.has(key)) return ERROR_CODE_TOKEN.test(value) || CODE_TOKENS.has(value);
  return false;
}

/**
 * #293: the params a Journey PREFIX runs with — a `--param` the whole Journey does not take is
 * refused (`ParamValidationError`), one only a later step uses is dropped; the prefix's own required
 * params are then checked by `validateParams` as usual.
 */
export function prefixParams(full: Journey, prefix: Journey, params: Record<string, string>): Record<string, string> {
  const known = journeyParamSchema(full).required;
  const unknown = Object.keys(params).filter((k) => !known.includes(k));
  if (unknown.length > 0) throw new ParamValidationError(`param mismatch — missing: [], unknown: [${unknown.join(", ")}]`);
  const needed = journeyParamSchema(prefix).required;
  return Object.fromEntries(Object.entries(params).filter(([k]) => needed.includes(k)));
}

/** The `evidenceError` a run's thrown error carries, if any. */
export function evidenceErrorOf(err: unknown): string | undefined {
  const v = err !== null && typeof err === "object" ? (err as { evidenceError?: unknown }).evidenceError : undefined;
  return typeof v === "string" ? v : undefined;
}

/**
 * #542: a replay's allowlist — the recorded site (or the environment's origins), then the Journey's
 * `metadata.allowedOrigins`, then `--allow`, each normalized and deduplicated. Recorded origins are not
 * remapped under `--env`/`--base-url` (no per-origin remap exists; `--allow` or the environment's
 * `allow` name the replacement).
 */
export function effectiveAllowedOrigins(journey: Journey, environment: ResolvedJourneyEnvironment | undefined, allow: readonly string[] = []): string[] {
  const base = environment === undefined ? [journey.recording.site] : [...environment.allowedOrigins];
  const out = [...base];
  for (const o of normalizeAllowlist([...(journey.metadata.allowedOrigins ?? []), ...allow])) if (!out.includes(o)) out.push(o);
  return out;
}

/**
 * The origins a person or operator named for this run, where a `--secret-field` binding may type its
 * secret: the environment's (`--env`/`--base-url`, `environments.json`), else the recorded site the run
 * goes to, then `--allow`. Never the Journey's own `metadata.allowedOrigins`: a Journey file (a draft an
 * agent wrote, say) cannot choose where a person's secret goes.
 */
export function operatorAllowedOrigins(journey: Journey, environment: ResolvedJourneyEnvironment | undefined, allow: readonly string[] = []): string[] {
  return normalizeAllowlist([...(environment === undefined ? [journey.recording.site] : environment.allowedOrigins), ...allow]);
}

/** `err` with every secret (and its URL-encoded forms) masked in its message and stack — same object, same class. */
export function redactErrorSecrets(err: unknown, secrets: readonly string[]): unknown {
  if (!(err instanceof Error) || secrets.length === 0) return err;
  err.message = redactText(err.message, secrets);
  if (err.stack !== undefined) err.stack = redactText(err.stack, secrets);
  return err;
}
