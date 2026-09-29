import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve as resolvePath } from "node:path";
import type { Command } from "commander";
import type { Journey } from "@jevitate/journey";
import type { Recording } from "@jevitate/recording";
import { ENVIRONMENTS_FILE, findProjectDir, type LayoutDeps } from "./project-dir.js";
import { loadTargetsFile, TargetConfigError, type TargetConfig } from "./target-config.js";

/**
 * Named environments (#247). A Journey is environment-free: its steps are app-relative paths
 * (`/login`), and its recorded `site` is only its DEFAULT environment. Which app a run replays
 * against is chosen at run time:
 *
 *  - `--env <name>` — an entry of the repo's committed `.jevitate/environments.json`:
 *
 *    ```json
 *    { "local":   { "baseUrl": "http://localhost:3000" },
 *      "staging": { "baseUrl": "https://staging.example.com", "allow": ["https://auth.example.com"],
 *                   "fixtures": "fixtures/staging.json", "hooks": { "before": "./scripts/seed.sh" } } }
 *    ```
 *
 *    `baseUrl` — the environment's origin (never a path, never credentials); `allow` — the other
 *    origins a Journey step may be on (an auth provider, say); `fixtures` — a mission fixtures file
 *    (relative to the environments file) used when `--fixtures` is absent; `hooks` — `before`/
 *    `after` shell hooks used when `--before`/`--after` are absent (they still need
 *    `--allow-shell-hooks`); `production: true` marks a live environment (`jevitate demo` refuses it,
 *    #249). Keys starting with `$` (`$comment`) are documentation. The file is
 *    committed, so it NEVER holds a secret or a session: a `storageState`/`secret`/`password`/
 *    `token`/`cookie`/`credential` key anywhere in it is refused.
 *  - `--base-url <origin>` — an ad-hoc environment (a preview deploy); with `--env`, it replaces
 *    that environment's `baseUrl` and keeps the rest.
 *
 * Per-environment sessions and secrets live in `~/.jevitate/targets.json`, keyed by the
 * environment's origin — the same per-origin operator file (#175) `mission run` and `verify_fix`
 * already read: `storageState` (the default session), `secretFields` (`env:VAR` bindings), and
 * `personas: { "<name>": { storageState?, secretFields? } }` for one session per persona. No `--env`
 * and no `--base-url` means exactly the pre-#247 behaviour: the Journey's recorded site.
 *
 * `resolveJourneyEnvironment` is THE one resolver every Journey-running command calls (`journey
 * run`, `regression run`, `load run`, check-suite Journey items, and later `journey annotate` /
 * `journey demo`); `applyJourneyEnvironment` rebases a Journey onto it and refuses a step on an
 * origin the environment does not allow — before any browser opens.
 */

export { ENVIRONMENTS_FILE, ENVIRONMENTS_SCAFFOLD, scaffoldEnvironmentsFile } from "./project-dir.js";

/** One environment, as declared in `.jevitate/environments.json` (paths resolved absolute). */
export interface EnvironmentDef {
  /** The environment's origin (`https://staging.example.com`), normalized. */
  readonly baseUrl: string;
  /** Other origins a Journey step may be on, normalized. */
  readonly allow: readonly string[];
  /** Mission fixtures file, absolute. */
  readonly fixtures?: string;
  /** Operator shell hooks (still gated by `--allow-shell-hooks`). */
  readonly hooks?: { readonly before?: string; readonly after?: string };
  /** `production: true` (#249): a live environment — `jevitate demo` refuses it. */
  readonly production?: boolean;
}

/** `.jevitate/environments.json` is missing a named environment, or is not what it should be. */
export class EnvironmentConfigError extends Error {
  readonly code = "E_ENV_CONFIG" as const;
  constructor(message: string) {
    super(message);
    this.name = "EnvironmentConfigError";
  }
}

/** `--env <name>` names no environment (exit 64, listing the known ones). */
export class UnknownEnvironmentError extends Error {
  readonly code = "E_ENV_UNKNOWN" as const;
  constructor(
    readonly env: string,
    readonly known: readonly string[],
    where: string | null,
  ) {
    super(
      `unknown environment ${JSON.stringify(env)}: ${
        known.length === 0
          ? `no environments are declared${where === null ? " (no .jevitate/environments.json — run `jevitate init` in the repo)" : ` in ${where}`}`
          : `known environments: ${known.join(", ")}${where === null ? "" : ` (${where})`}`
      }`,
    );
    this.name = "UnknownEnvironmentError";
  }
}

/** `--base-url` is not an origin. */
export class EnvironmentArgsError extends Error {
  readonly code = "E_ENV_ARGS" as const;
  constructor(message: string) {
    super(message);
    this.name = "EnvironmentArgsError";
  }
}

/** A Journey step is on an origin the chosen environment does not allow (exit 64, nothing opened). */
export class EnvironmentOriginRefusedError extends Error {
  readonly code = "E_ENV_ORIGIN_REFUSED" as const;
  constructor(message: string) {
    super(message);
    this.name = "EnvironmentOriginRefusedError";
  }
}

/** Every error the resolver or the rebase can throw — each a usage refusal (exit 64). */
export type EnvironmentError = EnvironmentConfigError | UnknownEnvironmentError | EnvironmentArgsError | EnvironmentOriginRefusedError;

export function isEnvironmentError(err: unknown): err is EnvironmentError {
  return (
    err instanceof EnvironmentConfigError ||
    err instanceof UnknownEnvironmentError ||
    err instanceof EnvironmentArgsError ||
    err instanceof EnvironmentOriginRefusedError
  );
}

const ENV_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const ENV_KEYS = new Set(["baseUrl", "allow", "fixtures", "hooks", "production"]);
const HOOK_KEYS = new Set(["before", "after"]);
/** A key that would put a secret or a session into a committed file. */
const SECRET_KEY = /storage.?state|secret|passw(or)?d|token|cookie|credential|api.?key|session|auth(orization)?$/i;

/** An `http(s)` origin — no path, query, fragment or credentials. `null` + the reason otherwise. */
function originOf(raw: unknown): { origin: string } | { reason: string } {
  if (typeof raw !== "string" || raw.trim() === "") return { reason: "must be an http(s) origin string" };
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return { reason: `must be an http(s) origin (got ${JSON.stringify(raw)})` };
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return { reason: `must be an http(s) origin (got ${JSON.stringify(raw)})` };
  if (u.username !== "" || u.password !== "") return { reason: "must not carry credentials (user:password@) — sessions and secrets live in ~/.jevitate/targets.json" };
  if ((u.pathname !== "/" && u.pathname !== "") || u.search !== "" || u.hash !== "") {
    return { reason: `must be an origin with no path, query or fragment (got ${JSON.stringify(raw)}; Journeys carry app-relative paths)` };
  }
  return { origin: u.origin };
}

/** Refuses any secret-looking key, anywhere in the value (path-precise). */
function refuseSecretKeys(v: unknown, where: string): void {
  if (Array.isArray(v)) {
    v.forEach((x, i) => refuseSecretKeys(x, `${where}[${i}]`));
    return;
  }
  if (v === null || typeof v !== "object") return;
  for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
    if (SECRET_KEY.test(k)) {
      throw new EnvironmentConfigError(
        `${where}.${k}: environments.json is committed with the app's code and never holds secrets or sessions — ` +
          `put storage states and secret fields in ~/.jevitate/targets.json under the environment's origin ("storageState", "secretFields", "personas")`,
      );
    }
    refuseSecretKeys(x, `${where}.${k}`);
  }
}

function parseEnvironment(v: unknown, where: string, baseDir: string): EnvironmentDef {
  if (v === null || typeof v !== "object" || Array.isArray(v)) throw new EnvironmentConfigError(`${where} must be an object { baseUrl, allow?, fixtures?, hooks? }`);
  refuseSecretKeys(v, where);
  const o = v as Record<string, unknown>;
  for (const k of Object.keys(o)) {
    if (!ENV_KEYS.has(k) && !k.startsWith("$")) throw new EnvironmentConfigError(`${where}.${k}: unknown key (allowed: baseUrl, allow, fixtures, hooks, production)`);
  }
  if (o.baseUrl === undefined) throw new EnvironmentConfigError(`${where}.baseUrl is required`);
  const base = originOf(o.baseUrl);
  if ("reason" in base) throw new EnvironmentConfigError(`${where}.baseUrl ${base.reason}`);
  const allow: string[] = [];
  if (o.allow !== undefined) {
    if (!Array.isArray(o.allow)) throw new EnvironmentConfigError(`${where}.allow must be an array of http(s) origins`);
    o.allow.forEach((a, i) => {
      const r = originOf(a);
      if ("reason" in r) throw new EnvironmentConfigError(`${where}.allow[${i}] ${r.reason}`);
      if (!allow.includes(r.origin)) allow.push(r.origin);
    });
  }
  let fixtures: string | undefined;
  if (o.fixtures !== undefined) {
    if (typeof o.fixtures !== "string" || o.fixtures === "") throw new EnvironmentConfigError(`${where}.fixtures must be a file path`);
    fixtures = resolvePath(baseDir, o.fixtures);
  }
  let hooks: { before?: string; after?: string } | undefined;
  if (o.hooks !== undefined) {
    if (o.hooks === null || typeof o.hooks !== "object" || Array.isArray(o.hooks)) throw new EnvironmentConfigError(`${where}.hooks must be an object { before?, after? }`);
    hooks = {};
    for (const [k, h] of Object.entries(o.hooks as Record<string, unknown>)) {
      if (k.startsWith("$")) continue;
      if (!HOOK_KEYS.has(k)) throw new EnvironmentConfigError(`${where}.hooks.${k}: unknown key (allowed: before, after)`);
      if (typeof h !== "string" || h.trim() === "") throw new EnvironmentConfigError(`${where}.hooks.${k} must be a shell command string`);
      hooks[k as "before" | "after"] = h;
    }
  }
  if (o.production !== undefined && typeof o.production !== "boolean") throw new EnvironmentConfigError(`${where}.production must be true or false`);
  return {
    baseUrl: base.origin,
    allow: allow.filter((a) => a !== base.origin),
    ...(fixtures === undefined ? {} : { fixtures }),
    ...(hooks === undefined ? {} : { hooks }),
    ...(o.production === true ? { production: true } : {}),
  };
}

/** Validates a parsed environments file (`where` names it in every error). */
export function parseEnvironments(parsed: unknown, where: string, baseDir: string): Readonly<Record<string, EnvironmentDef>> {
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new EnvironmentConfigError(`${where} must be an object keyed by environment name ({ "local": { "baseUrl": "http://localhost:3000" } })`);
  }
  const out: Record<string, EnvironmentDef> = {};
  for (const [name, v] of Object.entries(parsed as Record<string, unknown>)) {
    if (name.startsWith("$")) continue;
    if (!ENV_NAME.test(name) || name.includes("..") || name.length > 64) {
      throw new EnvironmentConfigError(`${where}[${JSON.stringify(name)}]: an environment name is letters, digits, '.', '_' or '-', starting with a letter or digit`);
    }
    out[name] = parseEnvironment(v, `${where}[${name}]`, baseDir);
  }
  return out;
}

/** The repo's `.jevitate/environments.json` (found as `.jevitate/` is), or `null` outside a project. */
export function environmentsFilePath(deps: LayoutDeps = {}): string | null {
  const dir = findProjectDir(deps);
  return dir === null ? null : join(dir, ENVIRONMENTS_FILE);
}

/** Reads and validates an environments file. A missing file is "no environments". */
export function loadEnvironmentsFile(path: string): Readonly<Record<string, EnvironmentDef>> {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (e) {
    if (typeof e === "object" && e !== null && "code" in e && e.code === "ENOENT") return {};
    throw new EnvironmentConfigError(`cannot read ${path}: ${e instanceof Error ? e.message : String(e)}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new EnvironmentConfigError(`${path} is not valid JSON`);
  }
  return parseEnvironments(parsed, path, dirname(path));
}

/** The chosen environment for one run: where the Journey goes, what it may reach, and its local session. */
export interface ResolvedJourneyEnvironment {
  /** The environment's name (`--env`), absent for a bare `--base-url`. */
  readonly name?: string;
  /** The origin the Journey's paths are moved onto. */
  readonly baseUrl: string;
  /** Every origin a step may be on: `baseUrl`, then the environment's `allow`. */
  readonly allowedOrigins: readonly string[];
  readonly fixtures?: string;
  readonly hooks?: { readonly before?: string; readonly after?: string };
  /** From `~/.jevitate/targets.json[baseUrl]` (or its `personas[persona]`): the default session. */
  readonly storageState?: string;
  /** From `~/.jevitate/targets.json[baseUrl]` (or its persona): `env:VAR` secret-field specs. */
  readonly secretFields?: readonly string[];
  /** Where the environment came from (`--env`'s file, or `--base-url`). */
  readonly source: string;
  /** The named environment is flagged `production: true` (#249: `demo` refuses it). */
  readonly production?: true;
}

export interface JourneyEnvironmentRequest {
  /** `--env <name>`. */
  readonly env?: string;
  /** `--base-url <origin>`. */
  readonly baseUrl?: string;
  /** A persona under the origin's `personas` in `~/.jevitate/targets.json` (its session and secrets). */
  readonly persona?: string;
  /** The environments file (default: the repo's `.jevitate/environments.json`). */
  readonly environmentsFile?: string;
  /** `~/.jevitate/targets.json` (the per-origin operator file). */
  readonly targetsFile?: string;
  /** An already-loaded targets file (wins over `targetsFile`). */
  readonly targets?: Readonly<Record<string, TargetConfig>>;
  readonly layout?: LayoutDeps;
}

/**
 * THE environment resolver (#247). `undefined` when neither `env` nor `baseUrl` is given — the
 * caller then runs exactly as before, on the Journey's recorded site. Throws `UnknownEnvironmentError`
 * (listing the known names), `EnvironmentConfigError` (a bad file, path-precise; a persona the
 * origin does not declare), or `EnvironmentArgsError` (a `baseUrl` that is not an origin).
 */
export function resolveJourneyEnvironment(req: JourneyEnvironmentRequest): ResolvedJourneyEnvironment | undefined {
  if (req.env === undefined && req.baseUrl === undefined) {
    if (req.persona !== undefined) throw new EnvironmentArgsError("a persona needs an environment (--env <name> or --base-url <origin>)");
    return undefined;
  }
  let def: EnvironmentDef | undefined;
  let source = "--base-url";
  if (req.env !== undefined) {
    const file = req.environmentsFile ?? environmentsFilePath(req.layout);
    const envs = file === null ? {} : loadEnvironmentsFile(file);
    def = Object.prototype.hasOwnProperty.call(envs, req.env) ? envs[req.env] : undefined;
    if (def === undefined) throw new UnknownEnvironmentError(req.env, Object.keys(envs).sort(), file !== null && existsSync(file) ? file : null);
    source = `${file}[${req.env}]`;
  }
  let baseUrl = def?.baseUrl;
  if (req.baseUrl !== undefined) {
    const r = originOf(req.baseUrl);
    if ("reason" in r) throw new EnvironmentArgsError(`--base-url ${r.reason}`);
    baseUrl = r.origin;
  }
  if (baseUrl === undefined) throw new EnvironmentArgsError("no base URL"); // unreachable: env or baseUrl is set
  const allow = (def?.allow ?? []).filter((a) => a !== baseUrl);
  let targets: Readonly<Record<string, TargetConfig>>;
  try {
    targets = req.targets ?? (req.targetsFile === undefined ? loadTargetsFile() : loadTargetsFile(req.targetsFile));
  } catch (e) {
    if (e instanceof TargetConfigError) throw new EnvironmentConfigError(e.message);
    throw e;
  }
  const local = targets[baseUrl];
  let session: { storageState?: string; secretFields?: readonly string[] } | undefined = local;
  if (req.persona !== undefined) {
    session = local?.personas?.[req.persona];
    if (session === undefined) {
      const known = Object.keys(local?.personas ?? {});
      throw new EnvironmentConfigError(
        `persona ${JSON.stringify(req.persona)} has no session for ${baseUrl} in ~/.jevitate/targets.json` +
          (known.length === 0 ? "" : ` (known personas: ${known.join(", ")})`),
      );
    }
  }
  return {
    ...(req.env === undefined ? {} : { name: req.env }),
    baseUrl,
    allowedOrigins: [baseUrl, ...allow],
    ...(def?.fixtures === undefined ? {} : { fixtures: def.fixtures }),
    ...(def?.hooks === undefined ? {} : { hooks: def.hooks }),
    ...(session?.storageState === undefined ? {} : { storageState: session.storageState }),
    ...(session?.secretFields === undefined ? {} : { secretFields: session.secretFields }),
    source,
    ...(def?.production === true ? { production: true as const } : {}),
  };
}

function absoluteUrl(s: string): URL | null {
  if (!/^https?:\/\//i.test(s)) return null;
  try {
    return new URL(s);
  } catch {
    return null;
  }
}

/**
 * Moves a Recording onto `env` (#247): its `site` becomes the environment's `baseUrl`; every
 * absolute URL on the recorded site's origin (page urls, `navigate` urls, `urlIncludes` texts)
 * keeps its path/query/fragment on the new origin; app-relative paths are left as they are (they
 * resolve against the environment). A page or `navigate` step on any OTHER origin must be in the
 * environment's `allow` — otherwise `EnvironmentOriginRefusedError`, before anything opens.
 * Never guesses, never mutates the input.
 */
export function rebaseRecording(recording: Recording, env: ResolvedJourneyEnvironment): Recording {
  const recordedOrigin = absoluteUrl(recording.site)?.origin;
  const refusals: string[] = [];
  const move = (raw: string, where: string, mustBeAllowed: boolean): string => {
    const u = absoluteUrl(raw);
    if (u === null) return raw;
    if (recordedOrigin !== undefined && u.origin === recordedOrigin) return `${env.baseUrl}${u.pathname}${u.search}${u.hash}`;
    if (mustBeAllowed && !env.allowedOrigins.includes(u.origin)) refusals.push(`${where} is on ${u.origin}`);
    return raw;
  };
  const walk = (v: unknown, where: string): unknown => {
    if (Array.isArray(v)) return v.map((x, i) => walk(x, `${where}[${i}]`));
    if (v === null || typeof v !== "object") return v;
    const o = v as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(o)) out[k] = walk(x, `${where}.${k}`);
    if (o.kind === "navigate" && typeof o.url === "string") out.url = move(o.url, `${where} (navigate ${o.url})`, true);
    if (o.kind === "urlIncludes" && typeof o.text === "string") out.text = move(o.text, `${where}.text`, false);
    return out;
  };
  const pages = recording.pages.map((p, i) => ({
    ...(walk(p, `pages[${i}]`) as typeof p),
    url: move(p.url, `pages[${i}] (${p.url})`, true),
  }));
  if (refusals.length > 0) {
    throw new EnvironmentOriginRefusedError(
      `${refusals.join("; ")} — not allowed by the ${env.name === undefined ? `--base-url ${env.baseUrl}` : `environment '${env.name}'`} ` +
        `(allowed: ${env.allowedOrigins.join(", ")}). Add the origin to its "allow" in .jevitate/environments.json to permit it; nothing was opened`,
    );
  }
  return { ...recording, site: env.baseUrl, pages };
}

/** `rebaseRecording` for a whole Journey (its metadata, incl. origin-bound secretRefs, is untouched: fail closed). */
export function applyJourneyEnvironment(journey: Journey, env: ResolvedJourneyEnvironment | undefined): Journey {
  if (env === undefined) return journey;
  return { ...journey, recording: rebaseRecording(journey.recording, env) };
}

/** Raw commander values of `--env` / `--base-url`. */
export interface EnvironmentFlags {
  readonly env?: string;
  readonly baseUrl?: string;
}

/** Adds `--env <name>` and `--base-url <origin>` (#247). */
export function withEnvironmentFlags(cmd: Command): Command {
  return cmd
    .option("--env <name>", "run against a named environment from the repo's .jevitate/environments.json (default: the Journey's recorded site)")
    .option("--base-url <origin>", "run against this origin (an ad-hoc environment; with --env, replaces its baseUrl)");
}

/** The environment a command's `--env`/`--base-url` flags choose (see `resolveJourneyEnvironment`). */
export function environmentFromFlags(
  flags: EnvironmentFlags,
  seams: { readonly environmentsFile?: string; readonly targetsFile?: string } = {},
): ResolvedJourneyEnvironment | undefined {
  return resolveJourneyEnvironment({
    ...(flags.env === undefined ? {} : { env: flags.env }),
    ...(flags.baseUrl === undefined ? {} : { baseUrl: flags.baseUrl }),
    ...(seams.environmentsFile === undefined ? {} : { environmentsFile: seams.environmentsFile }),
    ...(seams.targetsFile === undefined ? {} : { targetsFile: seams.targetsFile }),
  });
}
