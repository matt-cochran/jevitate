import { readFileSync } from "node:fs";
import { redactUrl } from "@jevitate/ai-core";
import { isAuthorizedExploreTarget } from "@jevitate/explore";
import { isRecord, sha256 } from "@jevitate/domain";
import type { RequestAuth } from "./fixture-auth.js";
import {
  FixtureSpecError,
  UnboundRestoreRefError,
  UnboundSetupRefError,
  type FixtureBindings,
  type FixtureBounds,
  type FixtureHttpStep,
  type FixtureSpec,
  type KnownOutputs,
  type PersistedFixtures,
} from "./mission-fixtures-types.js";

export const SETUP_REF = /\$\{setup\.([A-Za-z_][A-Za-z0-9_]*)\}/g;
/**
 * `${secretField.<VAR>}` (#166): a run's `--secret-field` value (bound to env `<VAR>`), allowed only
 * in a step's `json`/`body`/`headers` — so a login step can authenticate. Substituted into the
 * outgoing request only: never into a URL, the step log, the result or the Recording.
 */
export const SECRET_FIELD_REF = /\$\{secretField\.([A-Za-z_][A-Za-z0-9_]*)\}/g;
/**
 * A `${setup.x}`/`${restore.x}` (#560) output reference, for URL-origin, binding and credential
 * checks. `${restore.x}` is bound by an EARLIER restore step and lives only for that restore pass:
 * restore outputs are cleared at the start of every `restore()`, never join `bindings()`/setup
 * outputs, and are never persisted.
 */
export const OUTPUT_REF = /\$\{(setup|restore)\.([A-Za-z_][A-Za-z0-9_]*)\}/g;
/** Any reference, matched in ONE pass (a substituted value is never re-expanded). */
const STEP_REF = /\$\{(setup|restore|secretField)\.([A-Za-z_][A-Za-z0-9_]*)\}/g;
export const OUTPUT_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
/** A fixture identity's name (#243) — the same shape as a persona/actor name. */
const IDENTITY_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
const METHODS = new Set(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"]);
/** Keys that would make a fixtures file run a command: refused anywhere in a step. */
const COMMAND_KEYS = new Set(["command", "cmd", "shell", "exec", "run", "script", "argv", "spawn", "before", "after"]);
const STEP_KEYS = new Set(["name", "method", "url", "headers", "json", "body", "auth", "expectStatus", "outputs", "secretOutputs", "timeoutMs"]);
/** Literal credentials would be persisted with the spec: auth comes from the run's session instead. */
export const CREDENTIAL_HEADERS = new Set(["authorization", "cookie", "proxy-authorization", "x-api-key"]);
const MAX_LOGGED_OUTPUT = 1_000;

export function referencedNames(text: string): string[] {
  return [...text.matchAll(OUTPUT_REF)].map((m) => m[2] as string);
}

function onlyReferences(value: string): boolean {
  if (value.search(STEP_REF) === -1) return false;
  return /^([A-Za-z-]+)?$/.test(value.replace(STEP_REF, "").trim());
}

export function stringsIn(v: unknown, out: string[] = []): string[] {
  if (typeof v === "string") out.push(v);
  else if (Array.isArray(v)) for (const x of v) stringsIn(x, out);
  else if (isRecord(v)) for (const x of Object.values(v)) stringsIn(x, out);
  return out;
}

function findCommandKey(v: unknown, path: string): string | null {
  if (Array.isArray(v)) {
    for (const [i, x] of v.entries()) {
      const hit = findCommandKey(x, `${path}[${i}]`);
      if (hit !== null) return hit;
    }
  } else if (isRecord(v)) {
    for (const [k, x] of Object.entries(v)) {
      if (COMMAND_KEYS.has(k.toLowerCase())) return `${path}.${k}`;
      // `json` is an opaque request body: its keys are the app's, not ours.
      if (k === "json") continue;
      const hit = findCommandKey(x, `${path}.${k}`);
      if (hit !== null) return hit;
    }
  }
  return null;
}

function resolveStepUrl(url: string, baseUrl: string): URL | null {
  try {
    return new URL(url, baseUrl);
  } catch {
    return null;
  }
}

/** `url` resolved against the base URL and passed through `rebaseUrl` (#560/#561), or null when unusable. */
function resolvedStepUrl(url: string, bounds: FixtureBounds): URL | null {
  const u = resolveStepUrl(url, bounds.baseUrl);
  if (u === null || bounds.rebaseUrl === undefined) return u;
  try {
    return new URL(bounds.rebaseUrl(u.href));
  } catch {
    return null;
  }
}

/** Throws unless `url` (with references substituted) is http(s) on an allowlisted origin; returns the rebased absolute URL. */
export function assertStepUrl(url: string, bounds: FixtureBounds, where: string): string {
  const u = resolvedStepUrl(url, bounds);
  if (u === null || (u.protocol !== "http:" && u.protocol !== "https:")) {
    throw new FixtureSpecError(`${where}.url must be an http(s) URL (got ${JSON.stringify(redactUrl(url))})`);
  }
  if (!isAuthorizedExploreTarget(u.href, bounds.allowlist)) {
    throw new FixtureSpecError(`${where}.url origin ${u.origin} is not an --allow origin (${[...bounds.allowlist].join(", ")})`);
  }
  return u.href;
}

function parseAuth(v: unknown, where: string): RequestAuth {
  if (!isRecord(v) || typeof v.from !== "string") throw new FixtureSpecError(`${where} must be {from: "localStorage"|"cookies"|"secretField", ...}`);
  const opt = (k: string): string | undefined => {
    const x = v[k];
    if (x === undefined) return undefined;
    if (typeof x !== "string") throw new FixtureSpecError(`${where}.${k} must be a string`);
    return x;
  };
  const allowed = (keys: string[]): void => {
    for (const k of Object.keys(v)) if (!keys.includes(k)) throw new FixtureSpecError(`${where}.${k} is not a known auth key`);
  };
  const scheme = opt("scheme");
  const header = opt("header");
  const extra = { ...(scheme === undefined ? {} : { scheme }), ...(header === undefined ? {} : { header: header.toLowerCase() }) };
  // #243: authenticate this step as a NAMED identity (its own storageState), not the mission's session.
  const identity = opt("identity");
  if (identity !== undefined && !IDENTITY_NAME.test(identity)) {
    throw new FixtureSpecError(`${where}.identity must be an identity name (1-64 of [A-Za-z0-9_.-], starting alphanumeric)`);
  }
  const as = identity === undefined ? {} : { identity };
  if (v.from === "cookies") {
    allowed(["from", "identity"]);
    return { from: "cookies", ...as };
  }
  if (v.from === "localStorage") {
    allowed(["from", "key", "scheme", "header", "identity"]);
    const key = opt("key");
    if (key === undefined || key === "") throw new FixtureSpecError(`${where}.key (the localStorage item) is required`);
    return { from: "localStorage", key, ...extra, ...as };
  }
  if (v.from === "secretField") {
    allowed(["from", "name", "scheme", "header"]);
    const name = opt("name");
    if (name === undefined || name === "") throw new FixtureSpecError(`${where}.name (the --secret-field env variable) is required`);
    return { from: "secretField", name, ...extra };
  }
  throw new FixtureSpecError(`${where}.from must be localStorage, cookies or secretField`);
}

function parseStep(v: unknown, where: string, bounds: FixtureBounds, known: KnownOutputs, phase: "setup" | "restore"): FixtureHttpStep {
  if (!isRecord(v)) throw new FixtureSpecError(`${where} must be an object`);
  const cmd = findCommandKey(v, where);
  if (cmd !== null) {
    throw new FixtureSpecError(
      `${cmd}: a fixtures file cannot declare a command — shell hooks are the operator's own flags (--before/--after with --allow-shell-hooks)`,
    );
  }
  for (const k of Object.keys(v)) if (!STEP_KEYS.has(k)) throw new FixtureSpecError(`${where}.${k} is not a known step key`);
  const method = typeof v.method === "string" ? v.method.toUpperCase() : "";
  if (!METHODS.has(method)) throw new FixtureSpecError(`${where}.method must be one of ${[...METHODS].join(", ")}`);
  if (typeof v.url !== "string" || v.url === "") throw new FixtureSpecError(`${where}.url is required`);
  // A URL is logged and persisted: a secret never goes there (#166).
  if (v.url.search(SECRET_FIELD_REF) !== -1) {
    throw new FixtureSpecError(`${where}.url: \${secretField.*} is allowed only in json, body or headers (a URL is logged)`);
  }
  // A reference may fill a path or query value, never choose the origin: check it with placeholders.
  assertStepUrl(v.url.replace(OUTPUT_REF, "0"), bounds, where);
  const u = resolveStepUrl(v.url.replace(OUTPUT_REF, "0"), bounds.baseUrl);
  const probe = resolveStepUrl(v.url.replace(OUTPUT_REF, "x.evil.test"), bounds.baseUrl);
  if (u === null || probe === null || probe.origin !== u.origin) throw new FixtureSpecError(`${where}.url: a \${setup.*}/\${restore.*} reference cannot choose the origin`);
  let headers: Record<string, string> | undefined;
  if (v.headers !== undefined) {
    if (!isRecord(v.headers)) throw new FixtureSpecError(`${where}.headers must be an object of strings`);
    headers = {};
    for (const [k, x] of Object.entries(v.headers)) {
      if (typeof x !== "string") throw new FixtureSpecError(`${where}.headers.${k} must be a string`);
      // A credential header may only be references (`Bearer ${setup.token}`, `${secretField.API_KEY}`, #166).
      if (CREDENTIAL_HEADERS.has(k.toLowerCase()) && !onlyReferences(x)) {
        throw new FixtureSpecError(
          `${where}.headers.${k}: no literal credentials in a fixtures file — use "auth" (storage state or --secret-field), \${secretField.<VAR>} or a secret \${setup.<name>}`,
        );
      }
      headers[k] = x;
    }
  }
  if (v.json !== undefined && v.body !== undefined) throw new FixtureSpecError(`${where}: give json or body, not both`);
  if (v.body !== undefined && typeof v.body !== "string") throw new FixtureSpecError(`${where}.body must be a string`);
  let expectStatus: number[] | undefined;
  if (v.expectStatus !== undefined) {
    if (!Array.isArray(v.expectStatus) || v.expectStatus.length === 0 || !v.expectStatus.every((s) => Number.isInteger(s) && s >= 100 && s <= 599)) {
      throw new FixtureSpecError(`${where}.expectStatus must be a non-empty array of HTTP status codes`);
    }
    expectStatus = v.expectStatus as number[];
  }
  if (v.timeoutMs !== undefined && !(Number.isInteger(v.timeoutMs) && (v.timeoutMs as number) > 0)) {
    throw new FixtureSpecError(`${where}.timeoutMs must be a positive integer`);
  }
  let outputs: Record<string, string> | undefined;
  if (v.outputs !== undefined) {
    if (!isRecord(v.outputs)) throw new FixtureSpecError(`${where}.outputs must be an object of name → "$.path" | "header:<name>"`);
    outputs = {};
    for (const [name, path] of Object.entries(v.outputs)) {
      if (!OUTPUT_NAME.test(name)) throw new FixtureSpecError(`${where}.outputs.${name}: output names are identifiers`);
      if (typeof path !== "string" || !(path.startsWith("$") || path.startsWith("header:"))) {
        throw new FixtureSpecError(`${where}.outputs.${name} must be "$.path" or "header:<name>"`);
      }
      if (path.startsWith("$")) parseJsonPath(path, `${where}.outputs.${name}`);
      outputs[name] = path;
    }
  }
  let secretOutputs: string[] | undefined;
  if (v.secretOutputs !== undefined) {
    if (!Array.isArray(v.secretOutputs) || !v.secretOutputs.every((s) => typeof s === "string" && outputs?.[s] !== undefined)) {
      throw new FixtureSpecError(`${where}.secretOutputs must name this step's own outputs`);
    }
    secretOutputs = v.secretOutputs as string[];
  }
  const step: FixtureHttpStep = {
    ...(typeof v.name === "string" ? { name: v.name } : {}),
    method,
    url: v.url,
    ...(headers === undefined ? {} : { headers }),
    ...(v.json === undefined ? {} : { json: v.json }),
    ...(v.body === undefined ? {} : { body: v.body as string }),
    ...(v.auth === undefined ? {} : { auth: parseAuth(v.auth, `${where}.auth`) }),
    ...(expectStatus === undefined ? {} : { expectStatus }),
    ...(outputs === undefined ? {} : { outputs }),
    ...(secretOutputs === undefined ? {} : { secretOutputs }),
    ...(v.timeoutMs === undefined ? {} : { timeoutMs: v.timeoutMs as number }),
  };
  for (const s of stringsIn([step.url, step.headers ?? {}, step.json ?? null, step.body ?? ""])) {
    for (const m of s.matchAll(OUTPUT_REF)) {
      const kind = m[1] as "setup" | "restore";
      const name = m[2] as string;
      if (kind === "restore") {
        if (phase === "setup") throw new FixtureSpecError(`${where} references \${restore.${name}}, which is only usable inside the restore phase (#560)`);
        if (!known.restore.has(name)) throw new FixtureSpecError(`${where} references \${restore.${name}}, which no earlier restore step outputs`);
      } else if (known.setup !== null && !known.setup.has(name)) {
        throw new FixtureSpecError(`${where} references \${setup.${name}}, which no earlier setup step outputs`);
      }
    }
  }
  return step;
}

/**
 * Validates a fixtures spec (fail closed, before any browser or request). `openRefs` allows
 * references a `--before` hook may bind at run time (unknown statically; still checked when used).
 */
export function parseFixtureSpec(raw: unknown, bounds: FixtureBounds, opts: { openRefs?: boolean } = {}): FixtureSpec {
  if (!isRecord(raw)) throw new FixtureSpecError("a fixtures spec must be a JSON object {setup, restore}");
  const cmd = findCommandKey(
    Object.fromEntries(Object.entries(raw).filter(([k]) => k !== "setup" && k !== "restore" && k !== "teardown")),
    "fixtures",
  );
  if (cmd !== null) {
    throw new FixtureSpecError(`${cmd}: a fixtures file cannot declare a command — shell hooks are the operator's own flags (--before/--after with --allow-shell-hooks)`);
  }
  for (const k of Object.keys(raw)) {
    if (!["name", "setup", "restore", "teardown", "version"].includes(k)) throw new FixtureSpecError(`fixtures.${k} is not a known key`);
  }
  if (raw.version !== undefined && raw.version !== 1) throw new FixtureSpecError("fixtures.version must be 1");
  if (raw.restore !== undefined && raw.teardown !== undefined) throw new FixtureSpecError("give restore or teardown (an alias), not both");
  const list = (v: unknown, where: string): unknown[] => {
    if (v === undefined) return [];
    if (!Array.isArray(v)) throw new FixtureSpecError(`${where} must be an array of steps`);
    return v;
  };
  const known: KnownOutputs = { setup: opts.openRefs === true ? null : new Set<string>(), restore: new Set<string>() };
  const setupOutputsSeen = new Set<string>();
  const setup = list(raw.setup, "fixtures.setup").map((s, i) => {
    const step = parseStep(s, `fixtures.setup[${i}]`, bounds, known, "setup");
    for (const name of Object.keys(step.outputs ?? {})) {
      if (setupOutputsSeen.has(name)) throw new FixtureSpecError(`fixtures.setup[${i}].outputs.${name} is bound twice`);
      setupOutputsSeen.add(name);
      known.setup?.add(name);
    }
    return step;
  });
  const restoreKey = raw.teardown !== undefined ? "teardown" : "restore";
  const restoreOutputsSeen = new Set<string>();
  const restore = list(raw[restoreKey], `fixtures.${restoreKey}`).map((s, i) => {
    const step = parseStep(s, `fixtures.${restoreKey}[${i}]`, bounds, known, "restore");
    for (const name of Object.keys(step.outputs ?? {})) {
      if (restoreOutputsSeen.has(name)) throw new FixtureSpecError(`fixtures.${restoreKey}[${i}].outputs.${name} is bound twice`);
      restoreOutputsSeen.add(name);
      known.restore.add(name);
    }
    return step;
  });
  if (setup.length === 0 && restore.length === 0) throw new FixtureSpecError("a fixtures spec needs at least one setup or restore step");
  // A credential header built from an output needs that output to be SECRET: a public output is
  // persisted with the result, and a credential never is (setup and restore alike, #560).
  if (known.setup !== null) {
    const setupSecret = new Set(setup.flatMap((s) => s.secretOutputs ?? []));
    const restoreSecret = new Set(restore.flatMap((s) => s.secretOutputs ?? []));
    for (const [phase, steps] of [["setup", setup], [restoreKey, restore]] as const) {
      for (const [i, s] of steps.entries()) {
        for (const [k, x] of Object.entries(s.headers ?? {})) {
          if (!CREDENTIAL_HEADERS.has(k.toLowerCase())) continue;
          for (const m of x.matchAll(OUTPUT_REF)) {
            const kind = m[1] as "setup" | "restore";
            const name = m[2] as string;
            const secret = kind === "setup" ? setupSecret : restoreSecret;
            if (!secret.has(name)) throw new FixtureSpecError(`fixtures.${phase}[${i}].headers.${k}: \${${kind}.${name}} carries a credential — list it in secretOutputs`);
          }
        }
      }
    }
  }
  return { ...(typeof raw.name === "string" ? { name: raw.name } : {}), setup, restore };
}

/** Reads and validates a fixtures JSON file. */
export function loadFixtureFile(path: string, bounds: FixtureBounds, opts: { openRefs?: boolean } = {}): FixtureSpec {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    throw new FixtureSpecError(`cannot read fixtures file ${path}: ${e instanceof SyntaxError ? "not valid JSON" : e instanceof Error ? e.message : String(e)}`);
  }
  return parseFixtureSpec(raw, bounds, opts);
}

/** `$`, `.key`, `[0]`, `["key"]` — the JSONPath-lite output selectors. */
type PathSeg = string | number;

export function parseJsonPath(path: string, where = "path"): PathSeg[] {
  if (!path.startsWith("$")) throw new FixtureSpecError(`${where}: a JSON path starts with $`);
  const segs: PathSeg[] = [];
  const re = /\.([A-Za-z_$][A-Za-z0-9_$-]*)|\[(\d+)\]|\[\s*"([^"]*)"\s*\]|\[\s*'([^']*)'\s*\]/y;
  let i = 1;
  while (i < path.length) {
    re.lastIndex = i;
    const m = re.exec(path);
    if (m === null) throw new FixtureSpecError(`${where}: cannot parse ${JSON.stringify(path)} at offset ${i}`);
    segs.push(m[1] ?? (m[2] !== undefined ? Number(m[2]) : (m[3] ?? m[4] ?? "")));
    i = re.lastIndex;
  }
  return segs;
}

/** The scalar at `path` in `doc`, as a string; `undefined` when absent or not a scalar. */
export function selectJsonPath(doc: unknown, path: string): string | undefined {
  let cur: unknown = doc;
  for (const seg of parseJsonPath(path)) {
    if (typeof seg === "number") cur = Array.isArray(cur) ? cur[seg] : undefined;
    else cur = isRecord(cur) ? cur[seg] : undefined;
  }
  if (typeof cur === "string") return cur;
  if (typeof cur === "number" || typeof cur === "boolean") return String(cur);
  return undefined;
}

/**
 * Substitutes every `${setup.x}` in `text`. An unknown name throws (never a hollow run); a SECRET
 * output throws unless `allowSecret` — goal/URL/success text is model- or artifact-visible.
 */
export function substituteSetupRefs(text: string, b: FixtureBindings, opts: { allowSecret?: boolean; where?: string } = {}): string {
  return text.replace(SETUP_REF, (_whole, name: string) => {
    const v = b.values[name];
    if (v === undefined) throw new UnboundSetupRefError(`${opts.where ?? "text"} references \${setup.${name}}, which the fixture setup did not output`);
    if (b.secretNames.has(name) && opts.allowSecret !== true) {
      throw new UnboundSetupRefError(`${opts.where ?? "text"} references the secret output \${setup.${name}}; secret outputs stay inside the fixture's own requests`);
    }
    return v;
  });
}

/**
 * A step's `url`/`json`/`body`/`headers` text with every `${setup.x}`, `${restore.x}` (#560) and
 * `${secretField.VAR}` filled in, in one pass (#166). Secrets are allowed here — the result goes on
 * the wire ONLY, never into a log line or an artifact (the URL is redacted when logged).
 */
export function substituteStepText(
  text: string,
  b: FixtureBindings,
  restore: FixtureBindings,
  phase: "setup" | "restore",
  secretFields: Readonly<Record<string, string>>,
  where: string,
): string {
  return text.replace(STEP_REF, (_whole, kind: string, name: string) => {
    if (kind === "setup") {
      const v = b.values[name];
      if (v === undefined) throw new UnboundSetupRefError(`${where} references \${setup.${name}}, which the fixture setup did not output`);
      return v;
    }
    if (kind === "restore") {
      if (phase !== "restore") throw new UnboundRestoreRefError(`${where} references \${restore.${name}}, which is only usable inside the restore phase`);
      const v = restore.values[name];
      if (v === undefined) throw new UnboundRestoreRefError(`${where} references \${restore.${name}}, which no earlier restore step output`);
      return v;
    }
    const v = secretFields[name];
    if (v === undefined || v === "") throw new UnboundSetupRefError(`${where} references \${secretField.${name}}, but the run has no --secret-field bound to env:${name}`);
    return v;
  });
}

export function substituteDeep(v: unknown, sub: (text: string) => string): unknown {
  if (typeof v === "string") return sub(v);
  if (Array.isArray(v)) return v.map((x) => substituteDeep(x, sub));
  if (isRecord(v)) return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, substituteDeep(x, sub)]));
  return v;
}

/** The content hash of a fixture spec (and its hooks, when any) — recordings and Journeys record it. */
export function fixtureSpecHash(spec: FixtureSpec | undefined, hooks?: PersistedFixtures["hooks"]): string {
  return sha256(canonical({ spec: spec ?? null, hooks: hooks ?? null })).slice(0, 16);
}

export function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (isRecord(v)) {
    return `{${Object.keys(v)
      .sort()
      .filter((k) => v[k] !== undefined)
      .map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(v);
}

export function hookHash(cmd: string): string {
  return sha256(`hook:${cmd}`).slice(0, 16);
}

export function clip(s: string, n = MAX_LOGGED_OUTPUT): string {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

export function firstLine(e: unknown): string {
  const m = e instanceof Error ? e.message : String(e);
  return m.split("\n")[0] ?? m;
}
