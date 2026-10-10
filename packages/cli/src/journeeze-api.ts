import { createHash } from "node:crypto";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, isAbsolute, sep } from "node:path";
import { zipStore, type ZipEntry } from "./zip-store.js";
import { envCredentialStore, redactText } from "@jevitate/ai-core";
import { exportCatalogBundle, type ExportCatalogBundleRequest, type ExportCatalogBundleResult } from "./catalog-bundle-api.js";
import { loadLocalCredentials } from "./credentials-file.js";
import { readCliVersion } from "./version.js";
import {
  JOURNEEZE_API_PREFIX,
  JOURNEEZE_KEY_ENV,
  JOURNEEZE_KEY_RE,
  JOURNEEZE_URL_ENV,
  JourneezeError,
  clockSleep,
  defaultKeySources,
  describeError,
  describeRef,
  fetchJourneezeHttp,
  jsonBody,
  loadConnection,
  pinnedJourneezeOrigin,
  resolveKeyRef,
  runConnect,
  scrubError,
  sendPinned,
  type ConnectDeps,
  type JourneezeHttp,
  type JourneezeHttpResponse,
  type KeySources,
} from "./journeeze-connect.js";

/**
 * #464 — the Journeeze upload (journeeze-saas `docs/contract/catalog-bundle-upload-v1.md` §9).
 *
 * - `jevitate connect journeeze [--url <base>]` — CLI ONLY, never an MCP tool (journeeze-connect.ts):
 *   the person names where the per-product upload key (`jzu_…`) is kept — an env var, a command, or a
 *   password-manager entry — or types it hidden to check it first; the key is verified with
 *   `GET /api/upload/v1/whoami`, the person confirms the product, and ONLY the reference is saved
 *   (`~/.jevitate/journeeze.json`, bound to the Journeeze origin). The key is never saved by jevitate.
 * - `jevitate publish journeeze [--dry-run]` / MCP `publish_to_journeeze`: exports the bundle
 *   (catalog-bundle-api.ts), `POST /api/upload/v1/bundles` — bundle.json as `application/json` when
 *   it lists no media, else (#471) a ZIP (`application/zip`, contract §4.2) of bundle.json and every
 *   listed media file, each re-checked against its listed sha256 and size before it is packed — with
 *   `Idempotency-Key = sha256-<hex of bundle.json>`, polls `statusUrl` to
 *   `imported`/`refused`, and reports summary, warnings and errors. The key is resolved by jevitate
 *   itself: `JOURNEEZE_UPLOAD_KEY` (CI; never the plaintext credentials file), else the saved
 *   reference. It is never an argument, never in a result, never in an error — the model never sees
 *   it. Hosts are pinned (contract §2) and redirects are never followed. Publishing never approves.
 */

export const JOURNEEZE_DEFAULT_URL = "https://app.journeeze.dev";

export interface ConnectJourneezeRequest {
  /** `--url` (http(s), validated by the command), default JOURNEEZE_DEFAULT_URL. */
  readonly baseUrl: string;
  /** The project data dir the connection is saved under; null outside a project. */
  readonly projectDir: string | null;
}

export interface ConnectJourneezeResult {
  readonly baseUrl: string;
  readonly product: { readonly id: string; readonly name: string };
  /** The key's public prefix (`whoami.keyPrefix`) — the only form of the key ever shown. */
  readonly keyPrefix: string;
  readonly stored: boolean;
}

/** Interactive: needs a person at a terminal (refuses without a TTY). The key is read here, never passed in. */
export async function connectJourneeze(req: ConnectJourneezeRequest, deps: ConnectDeps = {}): Promise<ConnectJourneezeResult> {
  return runConnect(req.baseUrl, req.projectDir, deps);
}

export interface PublishJourneezeRequest {
  /** The project data dir (`--dir`, else the repo's `.jevitate/`); null outside a project. */
  readonly catalogDir: string | null;
  readonly journeysDir: string;
  /** `--dry-run`: export and validate the bundle, resolve the connection, send nothing. */
  readonly dryRun: boolean;
}

export interface PublishJourneezeResult {
  readonly dryRun: boolean;
  readonly baseUrl: string;
  /** `sha256-<hex of bundle.json>`. */
  readonly idempotencyKey: string;
  readonly uploadId?: string;
  /** Where the upload's status can be read (set once sent). */
  readonly statusUrl?: string;
  /**
   * The final upload status: `dry-run` when nothing was sent; `processing` when Journeeze had not
   * finished within the polling window (contract §4.3 — check `statusUrl` later).
   */
  readonly status: "dry-run" | "imported" | "refused" | "processing";
  readonly summary?: Readonly<Record<string, number>>;
  readonly warnings: readonly string[];
  readonly errors: readonly string[];
}

export interface PublishDeps extends ConnectDeps {
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly exportBundle?: (req: ExportCatalogBundleRequest) => Promise<ExportCatalogBundleResult>;
  readonly sleep?: (ms: number) => Promise<void>;
  /** The polling window (contract §4.3: 10 minutes). */
  readonly pollBudgetMs?: number;
}

/** Contract §4.2/§6: the body limit, and bundle.json's own (the JSON body IS bundle.json). */
const MAX_BUNDLE_JSON_BYTES = 16 * 1024 * 1024;
const POLL_START_MS = 1_000;
const POLL_CAP_MS = 15_000;
const POLL_BUDGET_MS = 10 * 60_000;
/** Attempts for a retryable failure (429/503/network) — always with the same Idempotency-Key. */
const MAX_ATTEMPTS = 3;
const MAX_RETRY_AFTER_MS = 60_000;

interface ResolvedKey {
  readonly key: string;
  readonly origin: string;
}

/**
 * The key and origin to publish with: `JOURNEEZE_UPLOAD_KEY` (through ai-core's CredentialStore,
 * whose plaintext-file fallback is disabled for it) at `JOURNEEZE_URL` / the saved origin / the
 * default; else the saved reference, at the origin it is bound to.
 */
async function resolvePublishKey(req: PublishJourneezeRequest, deps: PublishDeps): Promise<ResolvedKey> {
  const env = deps.env ?? process.env;
  let local: ReturnType<typeof loadLocalCredentials> = {};
  try {
    local = loadLocalCredentials(deps.homedir ? { homedir: deps.homedir } : {});
  } catch {
    local = {}; // an unreadable credentials file never supplies this key anyway
  }
  const fromEnv = envCredentialStore(env, local).read(JOURNEEZE_KEY_ENV);
  const saved = await loadConnection(req.catalogDir, deps);
  const envUrl = env[JOURNEEZE_URL_ENV]?.trim();
  if (fromEnv !== undefined) {
    if (!JOURNEEZE_KEY_RE.test(fromEnv)) {
      throw new JourneezeError("E_JOURNEEZE_KEY_FORMAT", `${JOURNEEZE_KEY_ENV} is not a Journeeze upload key (jzu_ followed by 40 characters)`);
    }
    return { key: fromEnv, origin: pinnedJourneezeOrigin(envUrl || saved?.baseUrl || JOURNEEZE_DEFAULT_URL) };
  }
  if (saved === undefined) {
    throw new JourneezeError(
      "E_JOURNEEZE_NOT_CONNECTED",
      `this project is not connected to Journeeze: a person runs \`jevitate connect journeeze\` at their terminal (or CI sets ${JOURNEEZE_KEY_ENV})`,
    );
  }
  const origin = pinnedJourneezeOrigin(saved.baseUrl);
  if (pinnedJourneezeOrigin(saved.keyRef.origin) !== origin || (envUrl && pinnedJourneezeOrigin(envUrl) !== origin)) {
    throw new JourneezeError("E_JOURNEEZE_ORIGIN", `the saved key reference is bound to ${saved.keyRef.origin} — refusing to use it for another origin; run \`jevitate connect journeeze\` again`);
  }
  const sources: KeySources = deps.sources ?? defaultKeySources(env);
  try {
    return { key: await resolveKeyRef(saved.keyRef, sources), origin };
  } catch (err) {
    if (err instanceof JourneezeError) {
      throw new JourneezeError(err.code, `${err.message} — fix ${describeRef(saved.keyRef)} or run \`jevitate connect journeeze\` again`);
    }
    throw err;
  }
}

interface BuiltBundle {
  readonly body: Uint8Array;
  readonly idempotencyKey: string;
  /** `application/json` (no media) or `application/zip` (#471: bundle.json + media). */
  readonly contentType: "application/json" | "application/zip";
}

/** Contract §4.2: the upload body limit (`whoami.limits.maxUploadBytes`). */
const MAX_UPLOAD_BYTES = 256 * 1024 * 1024;
/** Contract §2: the media paths a bundle may list. */
const MEDIA_PATH_RE = /^media\/(?:[A-Za-z0-9][A-Za-z0-9._-]{0,63}\/(?:step-[0-9]{2,3}\.(?:png|webp)|demo\.webm|demo\.vtt)|findings\/[0-9a-f]{16}\.(?:png|webp))$/u;

async function filesUnder(dir: string, base: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (err) {
    if ((err as { code?: unknown }).code === "ENOENT") return [];
    throw err;
  }
  const out: string[] = [];
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...(await filesUnder(p, base)));
    else out.push(relative(base, p).split(sep).join("/"));
  }
  return out;
}

/**
 * #471: the ZIP body of a bundle that lists media — every listed file re-read from the export and
 * checked against its listed size and sha256 (listed ⇔ present, nothing else in the folder), packed
 * after bundle.json in listed order.
 */
async function zipBundle(outDir: string, bundleJson: Uint8Array, files: readonly unknown[], key: string): Promise<Uint8Array> {
  const entries: ZipEntry[] = [{ name: "bundle.json", data: bundleJson }];
  const listed = new Set<string>();
  for (const f of files) {
    const { path, sha256, bytes } = (f ?? {}) as { path?: unknown; sha256?: unknown; bytes?: unknown };
    if (typeof path !== "string" || !MEDIA_PATH_RE.test(path) || listed.has(path)) throw new JourneezeError("E_JOURNEEZE_BUNDLE", `the bundle lists an unsafe or duplicate media path ${JSON.stringify(path)}`);
    listed.add(path);
    let data: Buffer;
    try {
      data = await readFile(join(outDir, ...path.split("/")));
    } catch {
      throw new JourneezeError("E_JOURNEEZE_BUNDLE", `the bundle lists ${path}, which the export did not write`);
    }
    if (data.byteLength !== bytes || createHash("sha256").update(data).digest("hex") !== sha256) {
      throw new JourneezeError("E_JOURNEEZE_BUNDLE", `${path} does not match its listed size and sha256 — refusing to send it`);
    }
    if (data.includes(key)) throw new JourneezeError("E_JOURNEEZE_BUNDLE", `${path} contains the upload key — refusing to send it`);
    entries.push({ name: path, data });
  }
  const unlisted = (await filesUnder(join(outDir, "media"), outDir)).filter((p) => !listed.has(p));
  if (unlisted.length > 0) throw new JourneezeError("E_JOURNEEZE_BUNDLE", `the export wrote media the bundle does not list (${unlisted.slice(0, 3).join(", ")}) — refusing to send it`);
  const body = zipStore(entries);
  if (body.byteLength > MAX_UPLOAD_BYTES) {
    throw new JourneezeError("E_JOURNEEZE_BUNDLE", `the bundle with its media is ${body.byteLength} bytes — over Journeeze's ${MAX_UPLOAD_BYTES}-byte upload limit`);
  }
  return new Uint8Array(body.buffer, body.byteOffset, body.byteLength);
}

/** Exports the bundle into a temp dir and checks what the contract checks before `202` (§4.2). */
async function buildBundle(req: PublishJourneezeRequest, deps: PublishDeps, key: string): Promise<BuiltBundle> {
  const outDir = await mkdtemp(join(tmpdir(), "jev-journeeze-"));
  try {
    const exported = await (deps.exportBundle ?? exportCatalogBundle)({ format: "journeeze-bundle", catalogDir: req.catalogDir, journeysDir: req.journeysDir, outDir });
    const rel = relative(outDir, exported.bundlePath);
    if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) throw new JourneezeError("E_JOURNEEZE_BUNDLE", "the exported bundle is not where it was asked to be written");
    const body = new Uint8Array(await readFile(exported.bundlePath));
    if (body.byteLength > MAX_BUNDLE_JSON_BYTES) {
      throw new JourneezeError("E_JOURNEEZE_BUNDLE", `bundle.json is ${body.byteLength} bytes — over Journeeze's ${MAX_BUNDLE_JSON_BYTES}-byte limit`);
    }
    const text = Buffer.from(body).toString("utf8");
    if (text.includes(key)) throw new JourneezeError("E_JOURNEEZE_BUNDLE", "the bundle contains the upload key — refusing to send it");
    let bundle: { kind?: unknown; version?: unknown; files?: unknown };
    try {
      bundle = JSON.parse(text) as typeof bundle;
    } catch {
      throw new JourneezeError("E_JOURNEEZE_BUNDLE", "the exported bundle.json is not JSON");
    }
    if (bundle.kind !== "journeeze.catalog-bundle" || bundle.version !== 1) {
      throw new JourneezeError("E_JOURNEEZE_BUNDLE", 'the exported bundle is not a v1 catalog bundle (kind "journeeze.catalog-bundle", version 1)');
    }
    const hex = createHash("sha256").update(body).digest("hex");
    // Contract §4.2: bundle.json alone as JSON only with no media; with media, a ZIP.
    if (Array.isArray(bundle.files) && bundle.files.length > 0) {
      return { body: await zipBundle(outDir, body, bundle.files, key), idempotencyKey: `sha256-${hex}`, contentType: "application/zip" };
    }
    return { body, idempotencyKey: `sha256-${hex}`, contentType: "application/json" };
  } finally {
    await rm(outDir, { recursive: true, force: true });
  }
}

const RETRYABLE = new Set([429, 503]);

function retryAfterMs(res: JourneezeHttpResponse, attempt: number): number {
  const header = res.headers.get("retry-after");
  const seconds = header === null ? NaN : Number(header);
  const ms = Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : POLL_START_MS * 2 ** attempt;
  return Math.min(ms, MAX_RETRY_AFTER_MS);
}

/** Contract §5: what the person does about a non-2xx, by code. */
function errorFor(res: JourneezeHttpResponse, body: Record<string, unknown>): JourneezeError {
  const what = describeError(res, body);
  const code = typeof body.code === "string" ? body.code : "";
  if (res.status === 401) return new JourneezeError("E_JOURNEEZE_KEY_REFUSED", `Journeeze refused the upload key (${what}) — a person runs \`jevitate connect journeeze\` with a valid key`);
  if (code === "key_in_url") return new JourneezeError("E_JOURNEEZE_KEY_REVOKED", `Journeeze revoked the key because it appeared in a URL (${what}) — create a new key and reconnect`);
  if (res.status === 403) return new JourneezeError("E_JOURNEEZE_FORBIDDEN", `Journeeze refused the upload (${what}) — the key lacks the upload scope or the product is suspended`);
  if (res.status === 409) return new JourneezeError("E_JOURNEEZE_CONFLICT", `Journeeze refused the upload (${what})`);
  if (RETRYABLE.has(res.status)) return new JourneezeError("E_JOURNEEZE_UNAVAILABLE", `Journeeze is busy or unavailable (${what}) — retry later; the same bundle reuses its Idempotency-Key`);
  return new JourneezeError("E_JOURNEEZE_HTTP", `Journeeze refused the upload (${what})`);
}

interface UploadStatus {
  readonly uploadId?: string;
  readonly status?: string;
  readonly statusUrl?: string;
  readonly body: Record<string, unknown>;
}

const TERMINAL = new Set(["imported", "refused"]);

/**
 * Builds the result from a status body (contract §4.3). The nested summary is flattened to
 * `section.counter` numbers; findings become warnings; errors keep their code and path.
 */
function fromStatus(base: Pick<PublishJourneezeResult, "baseUrl" | "idempotencyKey">, s: UploadStatus, statusUrl: string): PublishJourneezeResult {
  const summary: Record<string, number> = {};
  const raw = s.body.summary;
  if (typeof raw === "object" && raw !== null) {
    for (const [k, v] of Object.entries(raw)) {
      if (typeof v === "number") summary[k] = v;
      else if (typeof v === "object" && v !== null) for (const [k2, n] of Object.entries(v)) if (typeof n === "number") summary[`${k}.${k2}`] = n;
    }
  }
  const list = (v: unknown): Array<Record<string, unknown>> => (Array.isArray(v) ? v.filter((x): x is Record<string, unknown> => typeof x === "object" && x !== null) : []);
  const warnings = list(s.body.findings).map((f) => `${String(f.severity ?? "warning")} ${String(f.kind ?? "finding")}${Array.isArray(f.ids) ? `: ${f.ids.join(", ")}` : ""}`);
  const errors = list(s.body.errors).map((e) => `${String(e.code ?? "error")}: ${String(e.message ?? "")}${typeof e.path === "string" ? ` (at ${e.path})` : ""}`);
  const status = s.status === "imported" || s.status === "refused" ? s.status : "processing";
  return {
    dryRun: false,
    ...base,
    ...(s.uploadId === undefined ? {} : { uploadId: s.uploadId }),
    statusUrl,
    status,
    ...(Object.keys(summary).length > 0 ? { summary } : {}),
    warnings: status === "processing" ? [...warnings, `Journeeze is still processing the upload — check ${statusUrl} later`] : warnings,
    errors,
  };
}

function parseStatus(body: Record<string, unknown>): UploadStatus {
  return {
    ...(typeof body.uploadId === "string" ? { uploadId: body.uploadId } : {}),
    ...(typeof body.status === "string" ? { status: body.status } : {}),
    ...(typeof body.statusUrl === "string" ? { statusUrl: body.statusUrl } : {}),
    body,
  };
}

async function upload(origin: string, key: string, bundle: BuiltBundle, deps: PublishDeps): Promise<PublishJourneezeResult> {
  const http: JourneezeHttp = deps.http ?? fetchJourneezeHttp;
  const sleep = deps.sleep ?? clockSleep;
  const auth = `Bearer ${key}`;
  const base = { baseUrl: origin, idempotencyKey: bundle.idempotencyKey };
  const digest = `sha-256=:${createHash("sha256").update(bundle.body).digest("base64")}:`;

  let accepted: UploadStatus | undefined;
  let digestRetried = false;
  for (let attempt = 0; accepted === undefined; attempt++) {
    let res: JourneezeHttpResponse;
    try {
      res = await sendPinned(http, origin, {
        method: "POST",
        url: `${origin}${JOURNEEZE_API_PREFIX}/bundles`,
        headers: {
          Authorization: auth,
          "Content-Type": bundle.contentType,
          "Content-Length": String(bundle.body.byteLength),
          "Content-Digest": digest,
          "Idempotency-Key": bundle.idempotencyKey,
          "Journeeze-Producer": `jevitate/${readCliVersion()}`,
          Accept: "application/json",
        },
        body: bundle.body,
      });
    } catch (err) {
      if (err instanceof JourneezeError || attempt + 1 >= MAX_ATTEMPTS) throw err;
      await sleep(POLL_START_MS * 2 ** attempt); // a network failure: retry, same Idempotency-Key
      continue;
    }
    const body = await jsonBody(res);
    if (res.status === 202 || res.status === 200) {
      accepted = parseStatus(body);
      break;
    }
    if (RETRYABLE.has(res.status) && attempt + 1 < MAX_ATTEMPTS) {
      await sleep(retryAfterMs(res, attempt));
      continue;
    }
    if (res.status === 400 && body.code === "digest_mismatch" && !digestRetried) {
      digestRetried = true; // contract §5: retry once, then stop
      continue;
    }
    if (res.status === 413 || res.status === 422) {
      // The bundle itself was refused before processing: a refused upload, not a transport failure.
      return { dryRun: false, ...base, status: "refused", warnings: [], errors: [describeError(res, body)] };
    }
    throw errorFor(res, body);
  }

  const statusPath = accepted.statusUrl ?? (accepted.uploadId ? `${JOURNEEZE_API_PREFIX}/bundles/${encodeURIComponent(accepted.uploadId)}` : undefined);
  if (statusPath === undefined) throw new JourneezeError("E_JOURNEEZE_HTTP", "Journeeze accepted the upload but returned no upload id");
  const statusUrl = new URL(statusPath, origin);
  if (statusUrl.origin !== origin) throw new JourneezeError("E_JOURNEEZE_ORIGIN", `Journeeze's statusUrl points to ${statusUrl.origin} — the key is never sent to another origin`);

  let current = accepted;
  let waited = 0;
  let delay = POLL_START_MS;
  const budget = deps.pollBudgetMs ?? POLL_BUDGET_MS;
  while (!TERMINAL.has(current.status ?? "") && waited < budget) {
    await sleep(delay);
    waited += delay;
    delay = Math.min(delay * 2, POLL_CAP_MS);
    let res: JourneezeHttpResponse;
    try {
      res = await sendPinned(http, origin, { method: "GET", url: statusUrl.href, headers: { Authorization: auth, Accept: "application/json" } });
    } catch (err) {
      if (err instanceof JourneezeError) throw err;
      continue; // a network blip while polling: keep polling within the window
    }
    const body = await jsonBody(res);
    if (res.status === 200) {
      const next = parseStatus(body);
      current = next.uploadId === undefined && current.uploadId !== undefined ? { ...next, uploadId: current.uploadId } : next;
    } else if (!RETRYABLE.has(res.status)) throw errorFor(res, body);
  }
  return fromStatus(base, current, statusUrl.href);
}

export async function publishToJourneeze(req: PublishJourneezeRequest, deps: PublishDeps = {}): Promise<PublishJourneezeResult> {
  let key: string | undefined;
  try {
    const resolved = await resolvePublishKey(req, deps);
    key = resolved.key;
    const bundle = await buildBundle(req, deps, key);
    const result: PublishJourneezeResult = req.dryRun
      ? { dryRun: true, baseUrl: resolved.origin, idempotencyKey: bundle.idempotencyKey, status: "dry-run", warnings: [], errors: [] }
      : await upload(resolved.origin, key, bundle, deps);
    // Belt and braces: whatever Journeeze echoed, the key never leaves in a result.
    const text = JSON.stringify(result);
    return text.includes(key) ? (JSON.parse(redactText(text, [key])) as PublishJourneezeResult) : result;
  } catch (err) {
    throw scrubError(err, key === undefined ? [] : [key], "E_PUBLISH_JOURNEEZE");
  }
}

/** The human rendering (no `--json`). */
export function renderPublishJourneeze(r: PublishJourneezeResult): string {
  const summary = r.summary === undefined ? "" : `${Object.entries(r.summary).map(([k, v]) => `  ${k}: ${v}`).join("\n")}\n`;
  return `${r.dryRun ? "dry run: nothing sent" : `upload ${r.uploadId ?? "?"}: ${r.status}`} (${r.idempotencyKey}) → ${r.baseUrl}\n${summary}${r.warnings.map((w) => `warning: ${w}\n`).join("")}${r.errors.map((e) => `error: ${e}\n`).join("")}`;
}
