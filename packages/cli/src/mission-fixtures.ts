import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { redactText, redactUrl } from "@jevitate/ai-core";
import { isAuthorizedExploreTarget } from "@jevitate/explore";
import { authHeaders, type AuthSources, type RequestAuth } from "./fixture-auth.js";

/**
 * Mission fixtures (#140 declarative app setup, #144 setup/restore around missions and replays) —
 * ONE capability: put the app into a known state before a mission, bind what that setup created
 * (an item id, an invite URL) into the run as `${setup.<name>}`, restore the state afterwards, and
 * do the same around EVERY replay (hang reproduction, `verify-fix`, regression capture) so a replay
 * starts from the state the finding was made in, not whatever earlier runs left behind.
 *
 * Two step kinds, both operator-declared:
 *
 *  - HTTP steps, from a fixtures JSON file (`--fixtures`, or `fixtures` in `~/.jevitate/targets.json`).
 *    Only to an `--allow`-listed http(s) origin; authenticated like the page is (`fixture-auth.ts`:
 *    a storageState localStorage bearer, its cookies, or a `--secret-field` binding). A file can
 *    never declare a command.
 *  - Shell hooks, from the operator's own CLI flags only (`--before <cmd>` / `--after <cmd>`, and
 *    only with `--allow-shell-hooks`). Never model-chosen, never read from a file a run wrote. Exit
 *    codes are recorded; stdout is never persisted (it may carry `{vars, secret}`), stderr only
 *    redacted and clipped.
 *
 * Fail closed: a setup that fails, times out, or leaves a `${setup.x}` reference unresolved ends
 * the run `inconclusive` (`fixture setup failed: …`, a configuration error) — a mission never runs
 * on unknown state. Secret outputs join the run's redaction set and may only be used inside the
 * fixture's own requests, never in text a model sees.
 */

export const SETUP_REF = /\$\{setup\.([A-Za-z_][A-Za-z0-9_]*)\}/g;
const OUTPUT_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const METHODS = new Set(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"]);
/** Keys that would make a fixtures file run a command: refused anywhere in a step. */
const COMMAND_KEYS = new Set(["command", "cmd", "shell", "exec", "run", "script", "argv", "spawn", "before", "after"]);
const STEP_KEYS = new Set(["name", "method", "url", "headers", "json", "body", "auth", "expectStatus", "outputs", "secretOutputs", "timeoutMs"]);
/** Literal credentials would be persisted with the spec: auth comes from the run's session instead. */
const CREDENTIAL_HEADERS = new Set(["authorization", "cookie", "proxy-authorization", "x-api-key"]);
const DEFAULT_STEP_TIMEOUT_MS = 30_000;
const DEFAULT_HOOK_TIMEOUT_MS = 60_000;
const MAX_HOOK_STDOUT = 64 * 1024;
const MAX_LOGGED_OUTPUT = 1_000;

export interface FixtureHttpStep {
  readonly name?: string;
  readonly method: string;
  /** Absolute, or relative to the mission's start URL. May reference `${setup.<name>}` (not in its origin). */
  readonly url: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly json?: unknown;
  readonly body?: string;
  readonly auth?: RequestAuth;
  /** Accepted statuses. Default: any 2xx. */
  readonly expectStatus?: readonly number[];
  /** Output name → `$.json.path` (JSONPath-lite) or `header:<name>`. */
  readonly outputs?: Readonly<Record<string, string>>;
  /** Output names that are credentials: redacted everywhere, never substituted into model-visible text. */
  readonly secretOutputs?: readonly string[];
  readonly timeoutMs?: number;
}

export interface FixtureSpec {
  readonly name?: string;
  readonly setup: readonly FixtureHttpStep[];
  readonly restore: readonly FixtureHttpStep[];
}

/** The operator's own shell hooks (CLI flags; never from a file or a model). */
export interface ShellHooks {
  readonly before?: string;
  readonly after?: string;
  readonly timeoutMs?: number;
}

export class FixtureSpecError extends Error {
  readonly code = "E_FIXTURE_SPEC" as const;
  constructor(message: string) {
    super(message);
    this.name = "FixtureSpecError";
  }
}

/** Setup failed: the run must end `inconclusive` (a configuration error) without touching the app. */
export class FixtureSetupError extends Error {
  readonly code = "E_FIXTURE_SETUP" as const;
  constructor(detail: string) {
    super(`fixture setup failed: ${detail}`);
    this.name = "FixtureSetupError";
  }
}

export interface FixtureBounds {
  readonly allowlist: readonly string[];
  /** What a relative step URL resolves against (the mission's start URL). */
  readonly baseUrl: string;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/** Every `${setup.x}` name referenced in `text`. */
export function referencedNames(text: string): string[] {
  return [...text.matchAll(SETUP_REF)].map((m) => m[1] as string);
}

function stringsIn(v: unknown, out: string[] = []): string[] {
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

/** Throws unless `url` (with references substituted) is an http(s) URL on an allowlisted origin. */
function assertStepUrl(url: string, bounds: FixtureBounds, where: string): void {
  const u = resolveStepUrl(url, bounds.baseUrl);
  if (u === null || (u.protocol !== "http:" && u.protocol !== "https:")) {
    throw new FixtureSpecError(`${where}.url must be an http(s) URL (got ${JSON.stringify(redactUrl(url))})`);
  }
  if (!isAuthorizedExploreTarget(u.href, bounds.allowlist)) {
    throw new FixtureSpecError(`${where}.url origin ${u.origin} is not an --allow origin (${[...bounds.allowlist].join(", ")})`);
  }
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
  if (v.from === "cookies") {
    allowed(["from"]);
    return { from: "cookies" };
  }
  if (v.from === "localStorage") {
    allowed(["from", "key", "scheme", "header"]);
    const key = opt("key");
    if (key === undefined || key === "") throw new FixtureSpecError(`${where}.key (the localStorage item) is required`);
    return { from: "localStorage", key, ...extra };
  }
  if (v.from === "secretField") {
    allowed(["from", "name", "scheme", "header"]);
    const name = opt("name");
    if (name === undefined || name === "") throw new FixtureSpecError(`${where}.name (the --secret-field env variable) is required`);
    return { from: "secretField", name, ...extra };
  }
  throw new FixtureSpecError(`${where}.from must be localStorage, cookies or secretField`);
}

function parseStep(v: unknown, where: string, bounds: FixtureBounds, known: Set<string> | null, phase: "setup" | "restore"): FixtureHttpStep {
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
  // A reference may fill a path or query value, never choose the origin: check it with placeholders.
  assertStepUrl(v.url.replace(SETUP_REF, "0"), bounds, where);
  const u = resolveStepUrl(v.url.replace(SETUP_REF, "0"), bounds.baseUrl);
  const probe = resolveStepUrl(v.url.replace(SETUP_REF, "x.evil.test"), bounds.baseUrl);
  if (u === null || probe === null || probe.origin !== u.origin) throw new FixtureSpecError(`${where}.url: a \${setup.*} reference cannot choose the origin`);
  let headers: Record<string, string> | undefined;
  if (v.headers !== undefined) {
    if (!isRecord(v.headers)) throw new FixtureSpecError(`${where}.headers must be an object of strings`);
    headers = {};
    for (const [k, x] of Object.entries(v.headers)) {
      if (typeof x !== "string") throw new FixtureSpecError(`${where}.headers.${k} must be a string`);
      if (CREDENTIAL_HEADERS.has(k.toLowerCase())) {
        throw new FixtureSpecError(`${where}.headers.${k}: no literal credentials in a fixtures file — use "auth" (storage state or --secret-field)`);
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
    if (phase === "restore") throw new FixtureSpecError(`${where}.outputs: only setup steps bind outputs`);
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
  if (known !== null) {
    for (const s of stringsIn([step.url, step.headers ?? {}, step.json ?? null, step.body ?? ""])) {
      for (const name of referencedNames(s)) {
        if (!known.has(name)) throw new FixtureSpecError(`${where} references \${setup.${name}}, which no earlier setup step outputs`);
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
  const known: Set<string> | null = opts.openRefs === true ? null : new Set();
  const outputsSeen = new Set<string>();
  const setup = list(raw.setup, "fixtures.setup").map((s, i) => {
    const step = parseStep(s, `fixtures.setup[${i}]`, bounds, known, "setup");
    for (const name of Object.keys(step.outputs ?? {})) {
      if (outputsSeen.has(name)) throw new FixtureSpecError(`fixtures.setup[${i}].outputs.${name} is bound twice`);
      outputsSeen.add(name);
      known?.add(name);
    }
    return step;
  });
  const restoreKey = raw.teardown !== undefined ? "teardown" : "restore";
  const restore = list(raw[restoreKey], `fixtures.${restoreKey}`).map((s, i) => parseStep(s, `fixtures.${restoreKey}[${i}]`, bounds, known, "restore"));
  if (setup.length === 0 && restore.length === 0) throw new FixtureSpecError("a fixtures spec needs at least one setup or restore step");
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

/** A setup's bound outputs: values, and which of them are secrets. */
export interface FixtureBindings {
  readonly values: Readonly<Record<string, string>>;
  readonly secretNames: ReadonlySet<string>;
}

export class UnboundSetupRefError extends Error {
  readonly code = "E_FIXTURE_REF" as const;
  constructor(message: string) {
    super(message);
    this.name = "UnboundSetupRefError";
  }
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

function substituteDeep(v: unknown, b: FixtureBindings): unknown {
  if (typeof v === "string") return substituteSetupRefs(v, b, { allowSecret: true, where: "a fixture step" });
  if (Array.isArray(v)) return v.map((x) => substituteDeep(x, b));
  if (isRecord(v)) return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, substituteDeep(x, b)]));
  return v;
}

/** One step of setup/restore, as recorded in the result (redacted; never headers or bodies). */
export interface FixtureStepLog {
  readonly phase: "setup" | "restore";
  readonly kind: "http" | "shell";
  readonly name: string;
  readonly ok: boolean;
  readonly durationMs: number;
  readonly method?: string;
  readonly url?: string;
  readonly status?: number;
  readonly exitCode?: number | null;
  readonly detail?: string;
  /** A shell hook's stderr, redacted and clipped (stdout is never persisted). */
  readonly stderr?: string;
}

/** What the result/Recording carries: identity + non-secret outputs; secrets by NAME only. */
export interface FixtureRecord {
  /** Hash of the spec (+ hook commands) and the bound outputs (secret outputs by name only). */
  readonly identity: string;
  /** Hash of the spec (+ hook commands) alone: equal across runs of the same fixture. */
  readonly specHash: string;
  readonly outputs: Readonly<Record<string, string>>;
  readonly secretOutputs: readonly string[];
  /** Setup/restore cycles run (1 for the mission + one per replay). */
  readonly cycles: number;
  readonly log: readonly FixtureStepLog[];
}

/** What a mission result persists so `verify-fix`/regression capture restore the SAME state. */
export interface PersistedFixtures {
  readonly identity: string;
  readonly specHash: string;
  readonly spec?: FixtureSpec;
  /** sha256 of each operator hook command — the commands themselves are re-supplied, never replayed from a file. */
  readonly hooks?: { readonly before?: string; readonly after?: string };
  readonly outputs: Readonly<Record<string, string>>;
  readonly secretOutputs: readonly string[];
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function canonical(v: unknown): string {
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

export interface FixtureRunOptions extends FixtureBounds {
  readonly spec?: FixtureSpec;
  readonly hooks?: ShellHooks;
  /** Required to run `hooks` at all (CLI `--allow-shell-hooks`). */
  readonly allowShellHooks?: boolean;
  readonly auth: AuthSources;
  /** The run's own secrets: redacted from everything a fixture logs. */
  readonly secrets?: readonly string[];
  /** Testing seam. */
  readonly fetchImpl?: typeof fetch;
}

function clip(s: string, n = MAX_LOGGED_OUTPUT): string {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

function firstLine(e: unknown): string {
  const m = e instanceof Error ? e.message : String(e);
  return m.split("\n")[0] ?? m;
}

interface HookResult {
  readonly exitCode: number | null;
  readonly timedOut: boolean;
  readonly stdout: string;
  readonly stderr: string;
}

function runHook(cmd: string, timeoutMs: number, stdin: string, env: Record<string, string>): Promise<HookResult> {
  return new Promise((resolve) => {
    const child = spawn(cmd, { shell: true, detached: true, stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, ...env } });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const killGroup = (): void => {
      try {
        if (child.pid !== undefined) process.kill(-child.pid, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      killGroup();
    }, timeoutMs);
    child.stdout.on("data", (d: Buffer) => {
      if (stdout.length < MAX_HOOK_STDOUT) stdout += d.toString("utf8");
    });
    child.stderr.on("data", (d: Buffer) => {
      if (stderr.length < MAX_HOOK_STDOUT) stderr += d.toString("utf8");
    });
    child.on("error", (e) => {
      clearTimeout(timer);
      resolve({ exitCode: null, timedOut, stdout, stderr: `${stderr}${e.message}` });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ exitCode: code, timedOut, stdout, stderr });
    });
    child.stdin.on("error", () => undefined);
    child.stdin.end(stdin);
  });
}

/**
 * One mission's fixture lifecycle. `setup()` before the mission, `restore()` after it (every exit
 * path), and `reset()` (restore the active state, then set up again) before each replay.
 */
export class MissionFixtures {
  readonly #opts: FixtureRunOptions;
  readonly #specHash: string;
  #values: Record<string, string> = {};
  #secretNames = new Set<string>();
  #active = false;
  #cycles = 0;
  readonly #log: FixtureStepLog[] = [];

  constructor(opts: FixtureRunOptions) {
    if (opts.hooks !== undefined && (opts.hooks.before !== undefined || opts.hooks.after !== undefined) && opts.allowShellHooks !== true) {
      throw new FixtureSpecError("--before/--after run operator shell commands: pass --allow-shell-hooks to opt in");
    }
    this.#opts = opts;
    this.#specHash = sha256(canonical({ spec: opts.spec ?? null, hooks: this.hookHashes() ?? null })).slice(0, 16);
  }

  hookHashes(): PersistedFixtures["hooks"] | undefined {
    const h = this.#opts.hooks;
    if (h?.before === undefined && h?.after === undefined) return undefined;
    return { ...(h.before === undefined ? {} : { before: hookHash(h.before) }), ...(h.after === undefined ? {} : { after: hookHash(h.after) }) };
  }

  get specHash(): string {
    return this.#specHash;
  }

  /** The output names the spec declares; `null` when a `--before` hook may bind more at run time. */
  declaredOutputs(): Set<string> | null {
    if (this.#opts.hooks?.before !== undefined) return null;
    return new Set((this.#opts.spec?.setup ?? []).flatMap((s) => Object.keys(s.outputs ?? {})));
  }

  /** The output names the spec declares secret. */
  declaredSecretOutputs(): Set<string> {
    return new Set((this.#opts.spec?.setup ?? []).flatMap((s) => s.secretOutputs ?? []));
  }

  bindings(): FixtureBindings {
    return { values: { ...this.#values }, secretNames: new Set(this.#secretNames) };
  }

  /** Non-secret outputs (what a replay's recorded values are rebound to). */
  publicOutputs(): Record<string, string> {
    return Object.fromEntries(Object.entries(this.#values).filter(([k]) => !this.#secretNames.has(k)));
  }

  /** Secret output values: the caller adds them to the run's redaction set. */
  secrets(): string[] {
    return [...this.#secretNames].map((n) => this.#values[n]).filter((v): v is string => v !== undefined && v !== "");
  }

  #redact(text: string): string {
    return redactUrl(redactText(text, [...(this.#opts.secrets ?? []), ...this.secrets()]));
  }

  identity(): string {
    return `fx-${sha256(canonical({ spec: this.#specHash, outputs: this.publicOutputs(), secret: [...this.#secretNames].sort() })).slice(0, 16)}`;
  }

  record(): FixtureRecord {
    return {
      identity: this.identity(),
      specHash: this.#specHash,
      outputs: this.publicOutputs(),
      secretOutputs: [...this.#secretNames].sort(),
      cycles: this.#cycles,
      log: [...this.#log],
    };
  }

  persisted(): PersistedFixtures {
    const hooks = this.hookHashes();
    return {
      identity: this.identity(),
      specHash: this.#specHash,
      ...(this.#opts.spec === undefined ? {} : { spec: this.#opts.spec }),
      ...(hooks === undefined ? {} : { hooks }),
      outputs: this.publicOutputs(),
      secretOutputs: [...this.#secretNames].sort(),
    };
  }

  /** Sets up the fixture. Throws `FixtureSetupError`; the caller still calls `restore()`. */
  async setup(): Promise<void> {
    this.#values = {};
    this.#secretNames = new Set();
    this.#active = true;
    this.#cycles += 1;
    const before = this.#opts.hooks?.before;
    if (before !== undefined) await this.#runSetupHook(before);
    for (const [i, step] of (this.#opts.spec?.setup ?? []).entries()) {
      const failure = await this.#runHttp(step, "setup", i);
      if (failure !== null) throw new FixtureSetupError(failure);
    }
  }

  /** Restores the state the last `setup()` created. Never throws: every step is logged. */
  async restore(): Promise<void> {
    if (!this.#active) return;
    this.#active = false;
    for (const [i, step] of (this.#opts.spec?.restore ?? []).entries()) await this.#runHttp(step, "restore", i);
    const after = this.#opts.hooks?.after;
    if (after !== undefined) {
      const started = Date.now();
      const r = await runHook(after, this.#opts.hooks?.timeoutMs ?? DEFAULT_HOOK_TIMEOUT_MS, JSON.stringify({ vars: this.publicOutputs() }), {
        JEVITATE_FIXTURE_PHASE: "restore",
      });
      this.#log.push({
        phase: "restore",
        kind: "shell",
        name: "--after",
        ok: !r.timedOut && r.exitCode === 0,
        durationMs: Date.now() - started,
        exitCode: r.exitCode,
        ...(r.timedOut ? { detail: "timed out" } : {}),
        ...(r.stderr === "" ? {} : { stderr: clip(this.#redact(r.stderr)) }),
      });
    }
  }

  /** Before a replay: restore whatever is active, then set up afresh. Throws `FixtureSetupError`. */
  async reset(): Promise<void> {
    await this.restore();
    await this.setup();
  }

  async #runSetupHook(cmd: string): Promise<void> {
    const started = Date.now();
    const r = await runHook(cmd, this.#opts.hooks?.timeoutMs ?? DEFAULT_HOOK_TIMEOUT_MS, "", { JEVITATE_FIXTURE_PHASE: "setup" });
    let detail: string | undefined;
    if (r.timedOut) detail = "the --before hook timed out";
    else if (r.exitCode !== 0) detail = `the --before hook exited ${r.exitCode ?? "abnormally"}`;
    else detail = this.#bindHookStdout(r.stdout);
    this.#log.push({
      phase: "setup",
      kind: "shell",
      name: "--before",
      ok: detail === undefined,
      durationMs: Date.now() - started,
      exitCode: r.exitCode,
      ...(detail === undefined ? {} : { detail }),
      ...(r.stderr === "" ? {} : { stderr: clip(this.#redact(r.stderr)) }),
    });
    if (detail !== undefined) throw new FixtureSetupError(detail);
  }

  /** The `--before` stdout contract: empty, or one JSON object `{vars: {name: scalar}, secret?: [name]}`. */
  #bindHookStdout(stdout: string): string | undefined {
    const text = stdout.trim();
    if (text === "") return undefined;
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return "the --before hook printed something other than one JSON object {vars, secret}";
    }
    if (!isRecord(parsed) || (parsed.vars !== undefined && !isRecord(parsed.vars))) return "the --before hook's stdout must be {vars: {...}, secret?: [...]}";
    const secret = Array.isArray(parsed.secret) ? parsed.secret.filter((s): s is string => typeof s === "string") : [];
    for (const [name, v] of Object.entries((parsed.vars ?? {}) as Record<string, unknown>)) {
      if (!OUTPUT_NAME.test(name)) return `the --before hook var ${JSON.stringify(name)} is not an identifier`;
      if (typeof v !== "string" && typeof v !== "number" && typeof v !== "boolean") return `the --before hook var ${name} is not a scalar`;
      this.#values[name] = String(v);
      if (secret.includes(name)) this.#secretNames.add(name);
    }
    return undefined;
  }

  /** Runs one HTTP step; returns the failure detail (redacted), or null. */
  async #runHttp(step: FixtureHttpStep, phase: "setup" | "restore", i: number): Promise<string | null> {
    const started = Date.now();
    const name = step.name ?? `${phase}[${i}]`;
    const log = (entry: Omit<FixtureStepLog, "phase" | "kind" | "name" | "durationMs" | "method">): void => {
      this.#log.push({ phase, kind: "http", name, method: step.method, durationMs: Date.now() - started, ...entry });
    };
    let url: string;
    let body: string | undefined;
    let headers: Record<string, string>;
    try {
      const b = this.bindings();
      url = new URL(substituteSetupRefs(step.url, b, { allowSecret: true, where: name }), this.#opts.baseUrl).href;
      // Re-check the substituted URL: a bound value never widens the allowlist.
      assertStepUrl(url, this.#opts, name);
      headers = { ...(substituteDeep(step.headers ?? {}, b) as Record<string, string>) };
      if (step.json !== undefined) {
        body = JSON.stringify(substituteDeep(step.json, b));
        headers["content-type"] ??= "application/json";
      } else if (step.body !== undefined) {
        body = substituteSetupRefs(step.body, b, { allowSecret: true, where: name });
      }
      if (step.auth !== undefined) Object.assign(headers, authHeaders(step.auth, url, this.#opts.auth));
    } catch (e) {
      const detail = `${name}: ${this.#redact(firstLine(e))}`;
      log({ ok: false, url: this.#redact(step.url), detail });
      return detail;
    }
    const shownUrl = this.#redact(url);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), step.timeoutMs ?? DEFAULT_STEP_TIMEOUT_MS);
    try {
      const res = await (this.#opts.fetchImpl ?? fetch)(url, {
        method: step.method,
        headers,
        ...(body === undefined ? {} : { body }),
        // Never follow a redirect: it could leave the allowlist.
        redirect: "manual",
        signal: controller.signal,
      });
      const accepted = step.expectStatus !== undefined ? step.expectStatus.includes(res.status) : res.status >= 200 && res.status < 300;
      if (!accepted) {
        const detail = `${name}: ${step.method} ${shownUrl} answered ${res.status}`;
        log({ ok: false, url: shownUrl, status: res.status, detail });
        return detail;
      }
      if (step.outputs !== undefined) {
        const text = await res.text();
        let doc: unknown;
        const needsJson = Object.values(step.outputs).some((p) => p.startsWith("$"));
        if (needsJson) {
          try {
            doc = JSON.parse(text);
          } catch {
            const detail = `${name}: the response is not JSON, so its outputs cannot be read`;
            log({ ok: false, url: shownUrl, status: res.status, detail });
            return detail;
          }
        }
        for (const [out, path] of Object.entries(step.outputs)) {
          const v = path.startsWith("header:") ? (res.headers.get(path.slice("header:".length)) ?? undefined) : selectJsonPath(doc, path);
          if (v === undefined || v === "") {
            const detail = `${name}: output ${out} (${path}) is missing from the response`;
            log({ ok: false, url: shownUrl, status: res.status, detail });
            return detail;
          }
          this.#values[out] = v;
          if (step.secretOutputs?.includes(out) === true) this.#secretNames.add(out);
        }
      } else {
        await res.body?.cancel().catch(() => undefined);
      }
      log({ ok: true, url: this.#redact(url), status: res.status });
      return null;
    } catch (e) {
      const detail = `${name}: ${step.method} ${shownUrl} failed: ${controller.signal.aborted ? "timed out" : this.#redact(firstLine(e))}`;
      log({ ok: false, url: shownUrl, detail });
      return detail;
    } finally {
      clearTimeout(timer);
    }
  }
}

/**
 * A replay session re-uses the Recording of the ORIGINAL run, whose navigations carry the values
 * that run's setup bound (e.g. `/items/<old id>`). After a fresh setup, the same navigation must go
 * to the NEW value: this rewrites each recorded value to its current one in every `page.goto` of the
 * replay's own page (non-secret outputs of 4+ characters only — shorter ones are too ambiguous to
 * rewrite blindly).
 */
export function rebindReplayNavigation(
  page: { goto: (url: string, ...rest: never[]) => Promise<unknown> },
  recorded: Readonly<Record<string, string>>,
  current: Readonly<Record<string, string>>,
): void {
  const pairs = Object.entries(recorded)
    .map(([k, from]) => [from, current[k]] as const)
    .filter((p): p is readonly [string, string] => p[1] !== undefined && p[0] !== p[1] && p[0].length >= 4);
  if (pairs.length === 0) return;
  const original = page.goto.bind(page);
  page.goto = ((url: string, ...rest: never[]) => {
    let next = url;
    for (const [from, to] of pairs) {
      next = next.split(from).join(to).split(encodeURIComponent(from)).join(encodeURIComponent(to));
    }
    return original(next, ...rest);
  }) as typeof page.goto;
}

/** The fixture identity carried on a Recording (non-secret outputs only). */
export function recordingFixture(r: FixtureRecord): { identity: string; specHash: string; outputs: Record<string, string> } {
  return { identity: r.identity, specHash: r.specHash, outputs: { ...r.outputs } };
}


/** What a mission result carries: the record (log, identity, outputs) plus what a replay needs to restore the same state. */
export type MissionFixtureResult = FixtureRecord & Pick<PersistedFixtures, "spec" | "hooks">;

/**
 * Wraps a replay-session opener (hang reproduction, `verify-fix`, regression capture) so EVERY
 * replay starts from the fixture's state: restore whatever is active, set up afresh (a failure
 * throws, so the replay is "could not open a session" — inconclusive, never evidence), then rebind
 * the Recording's values (`recorded`, from the run the Recording came from) to the new outputs.
 */
export function fixtureReplayOpener<S extends { readonly page: { goto: (url: string, ...rest: never[]) => Promise<unknown> } }>(
  open: () => Promise<S>,
  fx: MissionFixtures,
  recorded: Readonly<Record<string, string>>,
): () => Promise<S> {
  return async () => {
    await fx.reset();
    const session = await open();
    rebindReplayNavigation(session.page, recorded, fx.publicOutputs());
    return session;
  };
}
