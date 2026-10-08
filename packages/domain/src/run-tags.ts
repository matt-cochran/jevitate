import { z } from "zod";

/**
 * Run metadata tags (#426): `--tag key=value` on every command that produces a run result. A tag
 * says which feature, journey or release a run exercised, so an external tool (a release dashboard,
 * a coverage tracker) attributes a run without guessing from its output path or final URL.
 *
 * Tags are stored verbatim in `result.tags`, in a multi-run's `run.envelope.json` and in the run
 * index (`~/.jevitate/run-index.jsonl`). They are PLAIN METADATA: they are never redacted, so a tag
 * must never carry a secret (a password, a token, a session id). Nothing here inspects values for
 * secrets — it would silently change what was asked for — the rule is documented instead.
 */

/** A tag key: 1-64 of `[A-Za-z0-9_.-]`. */
export const RUN_TAG_KEY = /^[A-Za-z0-9_.-]{1,64}$/;
/** Longest tag value accepted. */
export const MAX_RUN_TAG_VALUE = 256;
/** Most tags one run may carry. */
export const MAX_RUN_TAGS = 32;

/** Control characters (a newline would tear the run index's one-line records). */
const CONTROL = /[\u0000-\u001f\u007f]/;

export const RunTagsSchema = z.record(z.string().regex(RUN_TAG_KEY), z.string().min(1).max(MAX_RUN_TAG_VALUE));
export type RunTags = Readonly<Record<string, string>>;

export class RunTagError extends Error {
  readonly code = "E_TAG_ARGS" as const;
  constructor(message: string) {
    super(message);
    this.name = "RunTagError";
  }
}

/** Validates one tag (key and value) — throws `RunTagError`. */
export function assertRunTag(key: string, value: string, what = "--tag"): void {
  if (!RUN_TAG_KEY.test(key)) throw new RunTagError(`${what} key ${JSON.stringify(key)} must be 1-64 of [A-Za-z0-9_.-]`);
  if (value === "") throw new RunTagError(`${what} ${key}: value is empty`);
  if (value.length > MAX_RUN_TAG_VALUE) throw new RunTagError(`${what} ${key}: value is longer than ${MAX_RUN_TAG_VALUE} characters`);
  if (CONTROL.test(value)) throw new RunTagError(`${what} ${key}: value contains a control character`);
}

/** `key=value` → `[key, value]` (the value may itself contain `=`). */
export function parseRunTagSpec(spec: string): [string, string] {
  const eq = spec.indexOf("=");
  if (eq < 0) throw new RunTagError(`--tag must be key=value, got ${JSON.stringify(spec)}`);
  const key = spec.slice(0, eq);
  const value = spec.slice(eq + 1);
  assertRunTag(key, value);
  return [key, value];
}

/** Every `--tag key=value` → one record; a key given twice (or too many tags) is refused. */
export function parseRunTagSpecs(specs: readonly string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const spec of specs) {
    const [key, value] = parseRunTagSpec(spec);
    if (Object.hasOwn(out, key)) throw new RunTagError(`--tag ${key} is given twice`);
    out[key] = value;
  }
  if (Object.keys(out).length > MAX_RUN_TAGS) throw new RunTagError(`at most ${MAX_RUN_TAGS} tags per run`);
  return out;
}

/** A `{key: value}` object (MCP `tags`, a sweep target's `tags`) validated like `--tag`. */
export function validateRunTags(raw: unknown, what = "tags"): Record<string, string> {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) throw new RunTagError(`${what} must be an object of key → string value`);
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value !== "string") throw new RunTagError(`${what}.${key} must be a string`);
    assertRunTag(key, value, what);
    out[key] = value;
  }
  if (Object.keys(out).length > MAX_RUN_TAGS) throw new RunTagError(`at most ${MAX_RUN_TAGS} tags per run`);
  return out;
}

/** The tags a result carries (`result.tags`), or `{}` — a malformed record names no tag. */
export function runTagsOf(result: unknown): Record<string, string> {
  if (result === null || typeof result !== "object") return {};
  const tags = (result as { tags?: unknown }).tags;
  if (tags === null || typeof tags !== "object" || Array.isArray(tags)) return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(tags)) if (typeof v === "string") out[k] = v;
  return out;
}

/** AND semantics: the run carries EVERY filter tag with exactly that value. An empty filter matches all. */
export function matchesRunTags(tags: RunTags, filter: RunTags): boolean {
  return Object.entries(filter).every(([k, v]) => tags[k] === v);
}
