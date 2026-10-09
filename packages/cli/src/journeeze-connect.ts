import { execFile } from "node:child_process";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve as resolvePath } from "node:path";
import { redactText } from "@jevitate/ai-core";
import { clock } from "@jevitate/domain";
import { inMcpInvocation } from "./approval-provenance.js";
import { resolveDataDir } from "./data-dir.js";
import { readMaskedLine } from "./masked-input.js";
import { secretCommandRunner } from "./secret-command.js";

/**
 * #464 — the Journeeze connection: which hosts an upload key may go to, how the key is found, and
 * what `jevitate connect journeeze` saves (journeeze-saas `docs/contract/catalog-bundle-upload-v1.md`).
 *
 * The key itself is NEVER saved by jevitate. `connect` saves a REFERENCE to where the person keeps it
 * (an environment variable, a command that prints it, or a password-manager entry), bound to the
 * Journeeze origin it was verified against, in `~/.jevitate/journeeze.json` (outside the repo, 0600).
 * The reference is shaped like `@jevitate/secrets`' `SecretRef` (`{manager, key, origin, field}`):
 * jevitate delegates to the external source on every use and never implements a vault.
 */

/** The upload key's format (contract §3): `jzu_` + 40 lowercase base32 characters. */
export const JOURNEEZE_KEY_RE = /^jzu_[a-z2-7]{40}$/;
/** Anything that looks like (part of) a key — refused wherever only a reference belongs. */
const KEY_LIKE_RE = /jzu_[a-z2-7]{8,}/i;
/** The CI env var (contract §9); read through ai-core's `CredentialStore` (never its plaintext file). */
export const JOURNEEZE_KEY_ENV = "JOURNEEZE_UPLOAD_KEY";
/** Optional base URL for CI (`publish` only); pinned like `--url`. */
export const JOURNEEZE_URL_ENV = "JOURNEEZE_URL";
export const JOURNEEZE_API_PREFIX = "/api/upload/v1";

/** Contract §2: the only hosts an upload key is ever sent to (plus loopback, only with `JEVITATE_JOURNEEZE_DEV=1`). */
export const JOURNEEZE_PINNED_ORIGINS: readonly string[] = ["https://app.journeeze.dev", "https://app.staging.journeeze.dev"];
/** `JEVITATE_JOURNEEZE_DEV=1` allows a loopback Journeeze (local development of Journeeze itself). */
export const JOURNEEZE_DEV_ENV = "JEVITATE_JOURNEEZE_DEV";
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** A Journeeze-specific refusal. `code` is stable; the message never carries a key. */
export class JourneezeError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "JourneezeError";
  }
}

/**
 * The Journeeze origin for a base URL, or a `JourneezeError`: HTTPS on a pinned host, or — only when
 * `JEVITATE_JOURNEEZE_DEV=1` is set — http(s) on a loopback host (local development, contract §2;
 * otherwise an upload key would go over plain HTTP to whatever listens on that port). No path,
 * credentials, query or fragment.
 */
export function pinnedJourneezeOrigin(baseUrl: string, env: Readonly<Record<string, string | undefined>> = process.env): string {
  let u: URL;
  try {
    u = new URL(baseUrl);
  } catch {
    throw new JourneezeError("E_JOURNEEZE_URL", `not a URL: ${JSON.stringify(baseUrl)}`);
  }
  const bare = u.username === "" && u.password === "" && u.search === "" && u.hash === "" && (u.pathname === "/" || u.pathname === "");
  if (!bare) throw new JourneezeError("E_JOURNEEZE_URL", `the Journeeze URL must be a bare origin (got ${JSON.stringify(baseUrl)})`);
  if (LOOPBACK_HOSTS.has(u.hostname) && (u.protocol === "http:" || u.protocol === "https:")) {
    if (env[JOURNEEZE_DEV_ENV]?.trim() === "1") return u.origin;
    throw new JourneezeError("E_JOURNEEZE_URL", `refusing ${u.origin}: a loopback Journeeze is for local development only — set ${JOURNEEZE_DEV_ENV}=1 to send an upload key there`);
  }
  if (u.protocol === "https:" && JOURNEEZE_PINNED_ORIGINS.includes(u.origin)) return u.origin;
  throw new JourneezeError(
    "E_JOURNEEZE_URL",
    `an upload key is only ever sent to ${JOURNEEZE_PINNED_ORIGINS.join(" or ")} (or a loopback host with ${JOURNEEZE_DEV_ENV}=1) — refusing ${u.origin}`,
  );
}

// ── HTTP port ────────────────────────────────────────────────────────────────────────────────

export interface JourneezeHttpRequest {
  readonly method: "GET" | "POST";
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body?: Uint8Array;
}
export interface JourneezeHttpResponse {
  readonly status: number;
  readonly headers: { get(name: string): string | null };
  text(): Promise<string>;
}
/** The one way jevitate talks to Journeeze; tests inject a fake. Redirects are never followed. */
export type JourneezeHttp = (req: JourneezeHttpRequest) => Promise<JourneezeHttpResponse>;

export const fetchJourneezeHttp: JourneezeHttp = async (req) => {
  const headers = { ...req.headers };
  // undici sets Content-Length itself for a byte body (a forbidden request header to set by hand).
  delete headers["Content-Length"];
  return fetch(req.url, {
    method: req.method,
    headers,
    redirect: "manual",
    ...(req.body === undefined ? {} : { body: Buffer.from(req.body) }),
  });
};

/** Sends `req`, refusing any response that is a redirect (the key never follows one to another origin). */
export async function sendPinned(http: JourneezeHttp, origin: string, req: JourneezeHttpRequest): Promise<JourneezeHttpResponse> {
  if (new URL(req.url).origin !== origin) {
    throw new JourneezeError("E_JOURNEEZE_ORIGIN", `refusing to send the upload key to ${new URL(req.url).origin}: it is bound to ${origin}`);
  }
  const res = await http(req);
  if (res.status === 0 || (res.status >= 300 && res.status < 400)) {
    const to = res.headers.get("location");
    throw new JourneezeError(
      "E_JOURNEEZE_REDIRECT",
      `Journeeze answered ${req.method} ${new URL(req.url).pathname} with a redirect${to ? ` to ${safeLocation(to, req.url)}` : ""} — redirects are never followed with an upload key`,
    );
  }
  return res;
}

function safeLocation(location: string, base: string): string {
  try {
    return new URL(location, base).origin;
  } catch {
    return "an invalid location";
  }
}

/** The JSON body of a response, or `{}` when it is not JSON (unknown fields are ignored, contract §8). */
export async function jsonBody(res: JourneezeHttpResponse): Promise<Record<string, unknown>> {
  try {
    const parsed: unknown = JSON.parse(await res.text());
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** `code (requestId)` of an error response (contract §5), for messages. Never echoes the request. */
export function describeError(res: JourneezeHttpResponse, body: Record<string, unknown>): string {
  const code = typeof body.code === "string" ? body.code : "unknown";
  const message = typeof body.message === "string" ? `: ${body.message.slice(0, 300)}` : "";
  const requestId = res.headers.get("journeeze-request-id") ?? (typeof body.requestId === "string" ? body.requestId : undefined);
  return `${res.status} ${code}${message}${requestId ? ` (request ${requestId})` : ""}`;
}

// ── Key references ────────────────────────────────────────────────────────────────────────────

/** The managers a reference can name: `env` (a variable), `cmd` (a shell command), or a password manager CLI. */
export type JourneezeKeyManager = "env" | "cmd" | "op" | "bw" | "pass";

/** What `connect` saves: where the key lives (never the key), bound to the origin it was verified on. */
export interface JourneezeKeyRef {
  readonly manager: JourneezeKeyManager;
  /** The variable name, the command, or the manager's entry (`op://…`, a `bw` item, a `pass` path). */
  readonly key: string;
  readonly origin: string;
  readonly field: "journeeze-upload-key";
}

/**
 * Parses what the person typed at the reference prompt: `env:<VAR>`, `cmd:<command>`, `op://…`,
 * `bw:<item>` or `pass:<path>`. Anything that looks like a key itself is refused (without echoing it).
 */
export function parseKeyRef(text: string, origin: string): JourneezeKeyRef {
  const t = text.trim();
  if (KEY_LIKE_RE.test(t)) {
    throw new JourneezeError("E_JOURNEEZE_REF", "that looks like the upload key itself — jevitate saves only WHERE the key is kept, never the key");
  }
  const ref = (manager: JourneezeKeyManager, key: string): JourneezeKeyRef => {
    if (key.trim() === "") throw new JourneezeError("E_JOURNEEZE_REF", `the ${manager} reference is empty`);
    return { manager, key: key.trim(), origin, field: "journeeze-upload-key" };
  };
  if (t.startsWith("env:")) {
    const name = t.slice(4).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new JourneezeError("E_JOURNEEZE_REF", `not an environment variable name: ${JSON.stringify(name)}`);
    return ref("env", name);
  }
  if (t.startsWith("cmd:")) return ref("cmd", t.slice(4));
  if (t.startsWith("op://")) return ref("op", t);
  if (t.startsWith("bw:")) return ref("bw", t.slice(3));
  if (t.startsWith("pass:")) return ref("pass", t.slice(5));
  throw new JourneezeError("E_JOURNEEZE_REF", "expected env:<VAR>, cmd:<command>, op://…, bw:<item> or pass:<path>");
}

/** How a reference is resolved; tests inject fakes. Nothing resolved is cached or persisted. */
export interface KeySources {
  readonly env: Readonly<Record<string, string | undefined>>;
  /** Runs a shell command (a `cmd:` reference); resolves its stdout. */
  readonly runCommand: (command: string) => Promise<string>;
  /** Runs a password manager's CLI without a shell; resolves its stdout. */
  readonly exec: (cmd: string, args: readonly string[]) => Promise<string>;
}

export function defaultKeySources(env: Readonly<Record<string, string | undefined>> = process.env): KeySources {
  return {
    env,
    runCommand: secretCommandRunner(),
    exec: (cmd, args) =>
      new Promise((resolveOut, reject) => {
        execFile(cmd, [...args], { timeout: 60_000, maxBuffer: 64 * 1024 }, (err, stdout) => (err ? reject(err) : resolveOut(String(stdout))));
      }),
  };
}

const MANAGER_COMMANDS: Readonly<Record<"op" | "bw" | "pass", (key: string) => readonly [string, readonly string[]]>> = {
  op: (key) => ["op", ["read", key]],
  bw: (key) => ["bw", ["get", "password", key]],
  pass: (key) => ["pass", ["show", key]],
};

/**
 * The key a reference points to, or a `JourneezeError` that names the reference — never the source's
 * output (a misconfigured source may print the secret on failure). The value is checked for the key
 * format; the caller uses it only for the `Authorization` header.
 */
export async function resolveKeyRef(ref: JourneezeKeyRef, sources: KeySources): Promise<string> {
  let raw: string | undefined;
  try {
    if (ref.manager === "env") raw = sources.env[ref.key];
    else if (ref.manager === "cmd") raw = await sources.runCommand(ref.key);
    else {
      const [cmd, args] = MANAGER_COMMANDS[ref.manager](ref.key);
      raw = await sources.exec(cmd, args);
    }
  } catch (err) {
    const code = (err as { code?: unknown } | null)?.code;
    throw new JourneezeError(
      "E_JOURNEEZE_KEY_UNRESOLVABLE",
      `could not read the upload key from ${describeRef(ref)}${typeof code === "number" || typeof code === "string" ? ` (exit code ${String(code)})` : ""}`,
    );
  }
  // `pass show` prints the secret on its first line; the others print it alone.
  const value = (raw ?? "").split(/\r?\n/).map((l) => l.trim()).find((l) => l !== "") ?? "";
  if (value === "") throw new JourneezeError("E_JOURNEEZE_KEY_UNRESOLVABLE", `${describeRef(ref)} is empty or unset`);
  if (!JOURNEEZE_KEY_RE.test(value)) {
    throw new JourneezeError("E_JOURNEEZE_KEY_FORMAT", `the value from ${describeRef(ref)} is not a Journeeze upload key (jzu_ followed by 40 characters)`);
  }
  return value;
}

/** A display form of a reference (never a value). */
export function describeRef(ref: JourneezeKeyRef): string {
  switch (ref.manager) {
    case "env":
      return `environment variable ${ref.key}`;
    case "cmd":
      return "the saved key command";
    default:
      return `${ref.manager} entry ${ref.key}`;
  }
}

// ── The saved connection (~/.jevitate/journeeze.json) ──────────────────────────────────────────

export interface JourneezeConnection {
  readonly baseUrl: string;
  readonly product: { readonly id: string; readonly name: string };
  readonly keyPrefix: string;
  readonly keyRef: JourneezeKeyRef;
  readonly connectedAt: string;
}

interface ConnectionsFile {
  readonly version: 1;
  readonly connections: Record<string, JourneezeConnection>;
}

export interface ConnectionStoreDeps {
  readonly homedir?: () => string;
}

export function connectionsPath(deps: ConnectionStoreDeps = {}): string {
  return resolveDataDir(["journeeze.json"], deps.homedir ? { homedir: deps.homedir } : {});
}

/** The connection's lookup key: the project data dir (absolute), or `*` outside a project. */
export function projectKey(projectDir: string | null): string {
  return projectDir === null ? "*" : resolvePath(projectDir);
}

async function readConnections(deps: ConnectionStoreDeps): Promise<ConnectionsFile> {
  const path = connectionsPath(deps);
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (err) {
    if ((err as { code?: unknown } | null)?.code === "ENOENT") return { version: 1, connections: {} };
    throw new JourneezeError("E_JOURNEEZE_CONFIG", `cannot read ${path}`);
  }
  try {
    const parsed = JSON.parse(raw) as ConnectionsFile;
    if (parsed.version !== 1 || typeof parsed.connections !== "object" || parsed.connections === null) throw new Error("shape");
    return parsed;
  } catch {
    throw new JourneezeError("E_JOURNEEZE_CONFIG", `${path} is not a jevitate Journeeze connections file — fix or delete it, then run \`jevitate connect journeeze\``);
  }
}

/**
 * The saved connection for a project: ONLY that project's own (a connection made in one project, or
 * outside any, never uploads another project's catalog). The `*` connection (made outside any
 * project) applies only outside a project, and never inside an MCP call. A project without its own
 * connection is not connected: a person runs `jevitate connect journeeze` in that project.
 */
export async function loadConnection(projectDir: string | null, deps: ConnectionStoreDeps = {}): Promise<JourneezeConnection | undefined> {
  if (projectDir === null && inMcpInvocation()) return undefined;
  const file = await readConnections(deps);
  const key = projectKey(projectDir);
  return Object.prototype.hasOwnProperty.call(file.connections, key) ? file.connections[key] : undefined;
}

/** Saves a connection (a reference, never a key) — refuses anything that looks like a key. */
export async function saveConnection(projectDir: string | null, conn: JourneezeConnection, deps: ConnectionStoreDeps = {}): Promise<string> {
  const file = await readConnections(deps);
  const next: ConnectionsFile = { version: 1, connections: { ...file.connections, [projectKey(projectDir)]: conn } };
  const text = `${JSON.stringify(next, null, 2)}\n`;
  if (KEY_LIKE_RE.test(text.replace(/"keyPrefix": "jzu_[a-z2-7]{4}"/g, ""))) {
    throw new JourneezeError("E_JOURNEEZE_CONFIG", "refusing to save: the connection would hold an upload key in plain text");
  }
  const path = connectionsPath(deps);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.tmp`;
  await writeFile(tmp, text, { mode: 0o600 });
  await chmod(tmp, 0o600);
  await rename(tmp, path);
  return path;
}

// ── whoami (contract §4.1) ────────────────────────────────────────────────────────────────────

export interface Whoami {
  readonly product: { readonly id: string; readonly name: string };
  readonly tenant: string;
  readonly keyPrefix: string;
}

/** Verifies a key with `GET /whoami` — the only call `connect` makes with it. */
export async function whoami(http: JourneezeHttp, origin: string, key: string): Promise<Whoami> {
  const res = await sendPinned(http, origin, {
    method: "GET",
    url: `${origin}${JOURNEEZE_API_PREFIX}/whoami`,
    headers: { Authorization: `Bearer ${key}`, Accept: "application/json" },
  });
  const body = await jsonBody(res);
  if (res.status !== 200) {
    const reconnect = res.status === 401 ? " — check the key (create a new one on the Journeeze board if it was revoked or expired)" : "";
    throw new JourneezeError(res.status === 401 ? "E_JOURNEEZE_KEY_REFUSED" : "E_JOURNEEZE_HTTP", `Journeeze refused the key check: ${describeError(res, body)}${reconnect}`);
  }
  const product = body.product as { id?: unknown; name?: unknown } | undefined;
  if (typeof product?.id !== "string" || typeof product.name !== "string") {
    throw new JourneezeError("E_JOURNEEZE_HTTP", "Journeeze's key check returned no product");
  }
  const tenant = (body.tenant as { name?: unknown } | undefined)?.name;
  const prefix = typeof body.keyPrefix === "string" && /^jzu_[a-z2-7]{4}$/.test(body.keyPrefix) ? body.keyPrefix : key.slice(0, 8);
  return { product: { id: product.id, name: product.name }, tenant: typeof tenant === "string" ? tenant : "", keyPrefix: prefix };
}

// ── The interactive connect flow ───────────────────────────────────────────────────────────────

/** The terminal `connect` talks to; tests inject a scripted one. Prompts go to stderr (stdout is the result). */
export interface ConnectTerminal {
  readonly isTTY: boolean;
  /** A visible answer (the reference, the confirmation). */
  ask(question: string): Promise<string>;
  /** A hidden answer (the key): never echoed. */
  askHidden(question: string): Promise<string>;
  say(line: string): void;
}

export function processTerminal(): ConnectTerminal {
  return {
    isTTY: process.stdin.isTTY === true && process.stderr.isTTY === true,
    async ask(question) {
      const { createInterface } = await import("node:readline/promises");
      const rl = createInterface({ input: process.stdin, output: process.stderr });
      try {
        return await rl.question(`${question} `);
      } finally {
        rl.close();
      }
    },
    askHidden: (question) => readMaskedLine(process.stdin, process.stderr, question),
    say: (line) => void process.stderr.write(`${line}\n`),
  };
}

export interface ConnectDeps extends ConnectionStoreDeps {
  readonly http?: JourneezeHttp;
  readonly terminal?: ConnectTerminal;
  readonly sources?: KeySources;
}

export interface ConnectOutcome {
  readonly baseUrl: string;
  readonly product: { readonly id: string; readonly name: string };
  readonly keyPrefix: string;
  readonly stored: boolean;
}

const REF_PROMPT = [
  "Where do you keep this product's Journeeze upload key? jevitate saves only this reference, never the key:",
  "  env:<VAR>                           an environment variable",
  "  cmd:<command>                       a command that prints it",
  "  op://…  |  bw:<item>  |  pass:<path>  a password manager entry",
].join("\n");

/**
 * `jevitate connect journeeze`: the person names where the key is kept (or types the key, hidden, to
 * check it first — then names where it is kept, which must hold the same key); the key is verified
 * with `whoami`; the person confirms the product; only the reference is saved.
 */
export async function runConnect(baseUrl: string, projectDir: string | null, deps: ConnectDeps = {}): Promise<ConnectOutcome> {
  const origin = pinnedJourneezeOrigin(baseUrl);
  const term = deps.terminal ?? processTerminal();
  if (!term.isTTY) {
    throw new JourneezeError("E_CONNECT_NEEDS_TTY", "connect journeeze needs a person at a terminal (it asks for the upload key); in CI set JOURNEEZE_UPLOAD_KEY instead");
  }
  const http = deps.http ?? fetchJourneezeHttp;
  const sources = deps.sources ?? defaultKeySources();
  let typed: string | undefined;
  const seen: string[] = [];
  try {
    term.say(REF_PROMPT);
    let answer = (await term.ask("Reference (leave empty to type the key itself and check it first):")).trim();
    if (answer === "") {
      typed = (await term.askHidden("Journeeze upload key (jzu_…; hidden):")).trim();
      seen.push(typed);
      if (!JOURNEEZE_KEY_RE.test(typed)) throw new JourneezeError("E_JOURNEEZE_KEY_FORMAT", "that is not a Journeeze upload key (jzu_ followed by 40 characters)");
      const who = await whoami(http, origin, typed);
      term.say(`The key is valid for '${who.product.name}'${who.tenant ? ` (${who.tenant})` : ""}. Now say where it is kept.`);
      answer = (await term.ask("Reference:")).trim();
    }
    const ref = parseKeyRef(answer, origin);
    const key = await resolveKeyRef(ref, sources);
    seen.push(key);
    if (typed !== undefined && key !== typed) {
      throw new JourneezeError("E_JOURNEEZE_REF", `${describeRef(ref)} holds a different key than the one you typed — nothing was saved`);
    }
    const who = await whoami(http, origin, key);
    const yes = (await term.ask(`Connect this project to Journeeze product '${who.product.name}'${who.tenant ? ` (${who.tenant})` : ""} at ${origin}? [y/N]`)).trim().toLowerCase();
    if (yes !== "y" && yes !== "yes") {
      throw new JourneezeError("E_CONNECT_DECLINED", "not connected — nothing was saved");
    }
    await saveConnection(projectDir, { baseUrl: origin, product: who.product, keyPrefix: who.keyPrefix, keyRef: ref, connectedAt: new Date(clock.now()).toISOString() }, deps);
    return { baseUrl: origin, product: who.product, keyPrefix: who.keyPrefix, stored: true };
  } catch (err) {
    throw scrubError(err, seen, "E_CONNECT");
  }
}

/** Re-throws `err` as a `JourneezeError` whose message has every given secret removed. */
export function scrubError(err: unknown, secrets: readonly string[], fallbackCode: string): JourneezeError {
  const code = err instanceof JourneezeError ? err.code : fallbackCode;
  const message = err instanceof Error ? err.message : String(err);
  return new JourneezeError(code, redactText(message, secrets));
}

/** Sleeps on jevitate's clock (tests inject their own). */
export function clockSleep(ms: number): Promise<void> {
  return new Promise((r) => clock.setTimeout(r, ms));
}
