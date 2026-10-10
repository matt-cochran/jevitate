import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExportCatalogBundleRequest, ExportCatalogBundleResult } from "./catalog-bundle-api.js";
import { runAsMcpInvocation } from "./approval-provenance.js";
import { connectJourneeze, publishToJourneeze, type PublishDeps, type PublishJourneezeResult } from "./journeeze-api.js";
import {
  connectionsPath,
  loadConnection,
  pinnedJourneezeOrigin,
  saveConnection,
  type ConnectTerminal,
  type JourneezeHttp,
  type JourneezeHttpRequest,
  type KeySources,
} from "./journeeze-connect.js";

/**
 * #464 — `connect journeeze` / `publish journeeze` with a protected upload key. Every test runs
 * against a fake HTTP port (no network), a scripted terminal and a temp HOME; the key must never
 * reach a result, an error, or a file jevitate writes.
 */

const KEY = "jzu_abcdefghijklmnopqrstuvwxyz234567abcdefgh";
const OTHER_KEY = "jzu_zyxwvutsrqponmlkjihgfedcba765432hgfedcba";
const PROD = "https://app.journeeze.dev";
const PRODUCT = { id: "0190f3c2-0000-7000-8000-000000000001", name: "Ledgerly" };
const WHOAMI = { keyId: "key_01J9Z6Q8W4R2", keyPrefix: "jzu_abcd", tenant: { name: "Ledgerly Inc." }, product: PRODUCT, scopes: ["upload"], expiresAt: null };
const ACCEPTED = { uploadId: "upl_01J9Z7B3X5K8", status: "queued", statusUrl: "/api/upload/v1/bundles/upl_01J9Z7B3X5K8", receivedAt: "2026-10-09T18:00:00Z" };
const IMPORTED = {
  uploadId: "upl_01J9Z7B3X5K8",
  status: "imported",
  summary: { catalogRevision: 7, jobs: { created: 0, changed: 2 } },
  findings: [{ severity: "warning", kind: "anchor_not_measurable", ids: ["invite-teammate"] }],
  errors: [],
};

interface Reply {
  readonly status: number;
  readonly body?: unknown;
  readonly headers?: Record<string, string>;
}

/** A fake Journeeze: replies are taken in order per `METHOD path`; every request is recorded. */
function fakeJourneeze(routes: Record<string, Reply[]>): { http: JourneezeHttp; requests: JourneezeHttpRequest[] } {
  const requests: JourneezeHttpRequest[] = [];
  const http: JourneezeHttp = async (req) => {
    requests.push(req);
    const queue = routes[`${req.method} ${new URL(req.url).pathname}`] ?? [];
    const reply = queue.length > 1 ? queue.shift()! : (queue[0] ?? { status: 404, body: { code: "not_found" } });
    const headers = new Map(Object.entries(reply.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
    return { status: reply.status, headers: { get: (n: string) => headers.get(n.toLowerCase()) ?? null }, text: async () => JSON.stringify(reply.body ?? {}) };
  };
  return { http, requests };
}

const OK_ROUTES = (): Record<string, Reply[]> => ({
  "GET /api/upload/v1/whoami": [{ status: 200, body: WHOAMI }],
  "POST /api/upload/v1/bundles": [{ status: 202, body: ACCEPTED }],
  "GET /api/upload/v1/bundles/upl_01J9Z7B3X5K8": [{ status: 200, body: { ...ACCEPTED, status: "validating" } }, { status: 200, body: IMPORTED }],
});

/** A scripted terminal: visible answers in order, hidden answers in order; everything said is kept. */
function terminal(answers: string[], hidden: string[] = [], isTTY = true): ConnectTerminal & { said: string[] } {
  const said: string[] = [];
  return {
    isTTY,
    said,
    ask: async (q) => {
      said.push(q);
      return answers.shift() ?? "";
    },
    askHidden: async (q) => {
      said.push(q);
      return hidden.shift() ?? "";
    },
    say: (line) => void said.push(line),
  };
}

const sources = (env: Record<string, string>): KeySources => ({
  env,
  runCommand: async () => KEY,
  exec: async () => `${KEY}\n`,
});

const BUNDLE = JSON.stringify({ kind: "journeeze.catalog-bundle", version: 1, minor: 0, producer: { tool: "jevitate", version: "0.10.0" }, catalog: { personas: [], jobs: [], journeys: [] }, files: [] });

/** The injected bundle producer (the real builder is a separate deliverable). */
async function fakeExport(req: ExportCatalogBundleRequest): Promise<ExportCatalogBundleResult> {
  mkdirSync(req.outDir, { recursive: true });
  const bundlePath = join(req.outDir, "bundle.json");
  writeFileSync(bundlePath, BUNDLE);
  return { format: "journeeze-bundle", bundlePath, digest: "", counts: { personas: 0, jobs: 0, journeys: 0, checks: 0, findings: 0, demos: 0, media: 0 }, warnings: [] };
}

let home: string;
let project: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "jev-journeeze-home-"));
  project = join(home, "repo", ".jevitate");
  mkdirSync(project, { recursive: true });
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

/** Every file under the temp HOME, as text. */
function allWrittenText(): string {
  const out: string[] = [];
  const walk = (d: string): void => {
    for (const e of readdirSync(d)) {
      const p = join(d, e);
      if (statSync(p).isDirectory()) walk(p);
      else out.push(readFileSync(p, "utf8"));
    }
  };
  walk(home);
  return out.join("\n");
}

const homedir = () => home;
const errorOf = async (p: Promise<unknown>): Promise<Error & { code?: string }> => {
  try {
    await p;
  } catch (e) {
    return e as Error & { code?: string };
  }
  throw new Error("expected a refusal");
};

describe("connect journeeze", () => {
  const connect = (term: ConnectTerminal, http: JourneezeHttp, env: Record<string, string> = { MY_JZ_KEY: KEY }) =>
    connectJourneeze({ baseUrl: PROD, projectDir: project }, { homedir, terminal: term, http, sources: sources(env) });

  it("verifies the key with whoami before saving: a refused key saves nothing", async () => {
    const { http } = fakeJourneeze({ "GET /api/upload/v1/whoami": [{ status: 401, body: { code: "key_revoked" } }] });
    await errorOf(connect(terminal(["env:MY_JZ_KEY", "y"]), http));
    expect(existsSync(connectionsPath({ homedir }))).toBe(false);
  });

  it("sends the key only to the pinned whoami endpoint, as a Bearer header", async () => {
    const { http, requests } = fakeJourneeze(OK_ROUTES());
    await connect(terminal(["env:MY_JZ_KEY", "y"]), http);
    expect(requests.map((r) => [r.method, r.url, r.headers.Authorization])).toEqual([["GET", `${PROD}/api/upload/v1/whoami`, `Bearer ${KEY}`]]);
  });

  it("saves only the reference, bound to the Journeeze origin", async () => {
    const { http } = fakeJourneeze(OK_ROUTES());
    await connect(terminal(["env:MY_JZ_KEY", "y"]), http);
    const saved = JSON.parse(readFileSync(connectionsPath({ homedir }), "utf8")) as { connections: Record<string, { keyRef: unknown }> };
    expect(Object.values(saved.connections).map((c) => c.keyRef)).toEqual([{ manager: "env", key: "MY_JZ_KEY", origin: PROD, field: "journeeze-upload-key" }]);
  });

  it("saves the connection file owner-only (0600)", async () => {
    const { http } = fakeJourneeze(OK_ROUTES());
    await connect(terminal(["env:MY_JZ_KEY", "y"]), http);
    expect(statSync(connectionsPath({ homedir })).mode & 0o777).toBe(0o600);
  });

  it("a typed (hidden) key never lands in any file written under HOME", async () => {
    const { http } = fakeJourneeze(OK_ROUTES());
    await connect(terminal(["", "env:MY_JZ_KEY", "y"], [KEY]), http);
    expect(allWrittenText()).not.toContain(KEY.slice(4));
  });

  it("the result (the --json payload) never contains the key", async () => {
    const { http } = fakeJourneeze(OK_ROUTES());
    const result = await connect(terminal(["", "env:MY_JZ_KEY", "y"], [KEY]), http);
    expect(JSON.stringify(result)).not.toContain(KEY.slice(4));
  });

  it("nothing said at the terminal contains the key", async () => {
    const { http } = fakeJourneeze(OK_ROUTES());
    const term = terminal(["", "env:MY_JZ_KEY", "y"], [KEY]);
    await connect(term, http);
    expect(term.said.join("\n")).not.toContain(KEY.slice(4));
  });

  it("a reference holding a different key than the one typed is refused without naming either key", async () => {
    const { http } = fakeJourneeze(OK_ROUTES());
    const err = await errorOf(connect(terminal(["", "env:MY_JZ_KEY", "y"], [OTHER_KEY]), http));
    expect([err.message.includes(KEY.slice(4)) || err.message.includes(OTHER_KEY.slice(4)), existsSync(connectionsPath({ homedir }))]).toEqual([false, false]);
  });

  it("pasting the key at the reference prompt is refused (it would be saved in plain text)", async () => {
    const { http } = fakeJourneeze(OK_ROUTES());
    const err = await errorOf(connect(terminal([`cmd:echo ${KEY}`, "y"]), http));
    expect([err.code, err.message.includes(KEY.slice(4))]).toEqual(["E_JOURNEEZE_REF", false]);
  });

  it("declining the product saves nothing", async () => {
    const { http } = fakeJourneeze(OK_ROUTES());
    await errorOf(connect(terminal(["env:MY_JZ_KEY", "n"]), http));
    expect(existsSync(connectionsPath({ homedir }))).toBe(false);
  });

  it("refuses without a terminal (CI uses JOURNEEZE_UPLOAD_KEY)", async () => {
    const { http, requests } = fakeJourneeze(OK_ROUTES());
    await errorOf(connect(terminal(["env:MY_JZ_KEY", "y"], [], false), http));
    expect(requests).toEqual([]);
  });

  it("a whoami redirect is never followed with the key", async () => {
    const { http, requests } = fakeJourneeze({ "GET /api/upload/v1/whoami": [{ status: 302, headers: { Location: "https://evil.example/steal" } }] });
    await errorOf(connect(terminal(["env:MY_JZ_KEY", "y"]), http));
    expect(requests.map((r) => new URL(r.url).origin)).toEqual([PROD]);
  });
});

describe("pinned Journeeze hosts (contract §2)", () => {
  it.each([
    ["https://app.journeeze.dev", "https://app.journeeze.dev"],
    ["https://app.staging.journeeze.dev/", "https://app.staging.journeeze.dev"],
  ])("%s is allowed", (url, origin) => {
    expect(pinnedJourneezeOrigin(url, {})).toBe(origin);
  });

  it.each([
    ["http://localhost:8080", "http://localhost:8080"],
    ["http://127.0.0.1:3999", "http://127.0.0.1:3999"],
    ["https://[::1]:8443", "https://[::1]:8443"],
  ])("%s is allowed with JEVITATE_JOURNEEZE_DEV=1", (url, origin) => {
    expect(pinnedJourneezeOrigin(url, { JEVITATE_JOURNEEZE_DEV: "1" })).toBe(origin);
  });

  it.each(["http://localhost:8080", "http://127.0.0.1:3999", "https://[::1]:8443"])("%s is refused without JEVITATE_JOURNEEZE_DEV=1", (url) => {
    expect(() => pinnedJourneezeOrigin(url, {})).toThrow(/JEVITATE_JOURNEEZE_DEV=1/);
  });

  it.each(["http://app.journeeze.dev", "https://evil.example", "https://app.journeeze.dev.evil.example", "https://u:p@app.journeeze.dev", "https://app.journeeze.dev/x"])(
    "%s is refused",
    (url) => {
      expect(() => pinnedJourneezeOrigin(url, { JEVITATE_JOURNEEZE_DEV: "1" })).toThrow(/E_JOURNEEZE_URL|only ever sent|bare origin/);
    },
  );
});

describe("publish journeeze", () => {
  const publish = (http: JourneezeHttp, env: Record<string, string> = { JOURNEEZE_UPLOAD_KEY: KEY }, extra: Partial<PublishDeps> = {}, dryRun = false): Promise<PublishJourneezeResult> =>
    publishToJourneeze(
      { catalogDir: project, journeysDir: join(project, "journeys"), dryRun, productName: "Ledgerly" },
      { homedir, env, http, exportBundle: fakeExport, sleep: async () => {}, sources: sources(env), ...extra },
    );
  const digestHex = createHash("sha256").update(BUNDLE).digest("hex");

  it("POSTs the bundle to the pinned upload endpoint", async () => {
    const { http, requests } = fakeJourneeze(OK_ROUTES());
    await publish(http);
    expect(requests[0]!.url).toBe(`${PROD}/api/upload/v1/bundles`);
  });

  it("sends the contract's headers: Bearer key, JSON body, digest and idempotency key", async () => {
    const { http, requests } = fakeJourneeze(OK_ROUTES());
    await publish(http);
    const h = requests[0]!.headers;
    expect([h.Authorization, h["Content-Type"], h["Content-Length"], h["Content-Digest"], h["Idempotency-Key"]]).toEqual([
      `Bearer ${KEY}`,
      "application/json",
      String(Buffer.byteLength(BUNDLE)),
      `sha-256=:${createHash("sha256").update(BUNDLE).digest("base64")}:`,
      `sha256-${digestHex}`,
    ]);
  });

  it("the key travels only in the Authorization header (never the URL or the body)", async () => {
    const { http, requests } = fakeJourneeze(OK_ROUTES());
    await publish(http);
    expect(requests.some((r) => r.url.includes(KEY) || Buffer.from(r.body ?? new Uint8Array()).toString("utf8").includes(KEY))).toBe(false);
  });

  it("polls the status until imported and reports the summary and warnings", async () => {
    const { http } = fakeJourneeze(OK_ROUTES());
    const r = await publish(http);
    expect([r.status, r.uploadId, r.summary, r.warnings]).toEqual([
      "imported",
      "upl_01J9Z7B3X5K8",
      { catalogRevision: 7, "jobs.created": 0, "jobs.changed": 2 },
      ["warning anchor_not_measurable: invite-teammate"],
    ]);
  });

  it("the result never contains the key", async () => {
    const { http } = fakeJourneeze(OK_ROUTES());
    expect(JSON.stringify(await publish(http))).not.toContain(KEY.slice(4));
  });

  it("dry-run builds the bundle and makes no upload request", async () => {
    const { http, requests } = fakeJourneeze(OK_ROUTES());
    const r = await publish(http, undefined, {}, true);
    expect([r.status, r.idempotencyKey, requests.filter((q) => q.method === "POST").length]).toEqual(["dry-run", `sha256-${digestHex}`, 0]);
  });

  it.each([
    [401, "key_revoked", "E_JOURNEEZE_KEY_REFUSED"],
    [401, "key_expired", "E_JOURNEEZE_KEY_REFUSED"],
    [400, "key_in_url", "E_JOURNEEZE_KEY_REVOKED"],
    [403, "forbidden", "E_JOURNEEZE_FORBIDDEN"],
    [409, "idempotency_conflict", "E_JOURNEEZE_CONFLICT"],
    [415, "unsupported_media_type", "E_JOURNEEZE_HTTP"],
    [503, "unavailable", "E_JOURNEEZE_UNAVAILABLE"],
    [429, "rate_limited", "E_JOURNEEZE_UNAVAILABLE"],
  ])("%i %s → %s", async (status, code, expected) => {
    const { http } = fakeJourneeze({ "POST /api/upload/v1/bundles": [{ status, body: { code, message: "no", requestId: "req_1" } }] });
    expect((await errorOf(publish(http))).code).toBe(expected);
  });

  it.each([
    [422, "invalid_bundle"],
    [413, "payload_too_large"],
  ])("%i %s → a refused upload carrying the server's reason", async (status, code) => {
    const { http } = fakeJourneeze({ "POST /api/upload/v1/bundles": [{ status, body: { code, message: "bad" } }] });
    const r = await publish(http);
    expect([r.status, r.errors]).toEqual(["refused", [`${status} ${code}: bad`]]);
  });

  it("a status of refused is reported with the server's errors", async () => {
    const { http } = fakeJourneeze({
      "POST /api/upload/v1/bundles": [{ status: 202, body: ACCEPTED }],
      "GET /api/upload/v1/bundles/upl_01J9Z7B3X5K8": [{ status: 200, body: { status: "refused", errors: [{ code: "privacy", message: "typed value", path: "/catalog" }] } }],
    });
    expect((await publish(http)).errors).toEqual(["privacy: typed value (at /catalog)"]);
  });

  it("429 is retried after Retry-After with the same Idempotency-Key", async () => {
    const { http, requests } = fakeJourneeze({ ...OK_ROUTES(), "POST /api/upload/v1/bundles": [{ status: 429, headers: { "Retry-After": "2" }, body: { code: "rate_limited" } }, { status: 202, body: ACCEPTED }] });
    await publish(http);
    const posts = requests.filter((r) => r.method === "POST").map((r) => r.headers["Idempotency-Key"]);
    expect(posts).toEqual([`sha256-${digestHex}`, `sha256-${digestHex}`]);
  });

  it("a redirect to another origin is refused and the key is not sent there", async () => {
    const { http, requests } = fakeJourneeze({ "POST /api/upload/v1/bundles": [{ status: 307, headers: { Location: "https://evil.example/api/upload/v1/bundles" } }] });
    const err = await errorOf(publish(http));
    expect([err.code, requests.map((r) => new URL(r.url).origin)]).toEqual(["E_JOURNEEZE_REDIRECT", [PROD]]);
  });

  it("a statusUrl on another origin is never polled with the key", async () => {
    const { http, requests } = fakeJourneeze({ "POST /api/upload/v1/bundles": [{ status: 202, body: { ...ACCEPTED, statusUrl: "https://evil.example/s" } }] });
    await errorOf(publish(http));
    expect(requests.every((r) => new URL(r.url).origin === PROD)).toBe(true);
  });

  it("a server error that echoes the key is scrubbed before it leaves", async () => {
    const { http } = fakeJourneeze({ "POST /api/upload/v1/bundles": [{ status: 400, body: { code: "bad_request", message: `bad header Bearer ${KEY}` } }] });
    expect((await errorOf(publish(http))).message).not.toContain(KEY.slice(4));
  });

  it("uses the saved reference when JOURNEEZE_UPLOAD_KEY is unset", async () => {
    await saveConnection(project, { baseUrl: PROD, product: PRODUCT, keyPrefix: "jzu_abcd", keyRef: { manager: "env", key: "MY_JZ_KEY", origin: PROD, field: "journeeze-upload-key" }, connectedAt: "2026-10-09T00:00:00Z" }, { homedir });
    const { http, requests } = fakeJourneeze(OK_ROUTES());
    await publish(http, { MY_JZ_KEY: KEY });
    expect(requests[0]!.headers.Authorization).toBe(`Bearer ${KEY}`);
  });

  it("a saved reference is never used for another origin (JOURNEEZE_URL differs)", async () => {
    await saveConnection(project, { baseUrl: PROD, product: PRODUCT, keyPrefix: "jzu_abcd", keyRef: { manager: "env", key: "MY_JZ_KEY", origin: PROD, field: "journeeze-upload-key" }, connectedAt: "2026-10-09T00:00:00Z" }, { homedir });
    const { http, requests } = fakeJourneeze(OK_ROUTES());
    await errorOf(publish(http, { MY_JZ_KEY: KEY, JOURNEEZE_URL: "https://app.staging.journeeze.dev" }));
    expect(requests).toEqual([]);
  });

  it("JOURNEEZE_URL on an unpinned host is refused before anything is sent", async () => {
    const { http, requests } = fakeJourneeze(OK_ROUTES());
    await errorOf(publish(http, { JOURNEEZE_UPLOAD_KEY: KEY, JOURNEEZE_URL: "https://evil.example" }));
    expect(requests).toEqual([]);
  });

  it("a project without its own connection never uploads with the global (*) one", async () => {
    await saveConnection(null, { baseUrl: PROD, product: PRODUCT, keyPrefix: "jzu_abcd", keyRef: { manager: "env", key: "MY_JZ_KEY", origin: PROD, field: "journeeze-upload-key" }, connectedAt: "2026-10-09T00:00:00Z" }, { homedir });
    const { http } = fakeJourneeze(OK_ROUTES());
    const err = await errorOf(publish(http, { MY_JZ_KEY: KEY }));
    expect([err.code, /this project is not connected.*jevitate connect journeeze/.test(err.message)]).toEqual(["E_JOURNEEZE_NOT_CONNECTED", true]);
  });

  it("a project never uploads with another project's connection", async () => {
    await saveConnection(join(home, "other", ".jevitate"), { baseUrl: PROD, product: PRODUCT, keyPrefix: "jzu_abcd", keyRef: { manager: "env", key: "MY_JZ_KEY", origin: PROD, field: "journeeze-upload-key" }, connectedAt: "2026-10-09T00:00:00Z" }, { homedir });
    const { http, requests } = fakeJourneeze(OK_ROUTES());
    await errorOf(publish(http, { MY_JZ_KEY: KEY }));
    expect(requests).toEqual([]);
  });

  it("outside a project the global (*) connection is used", async () => {
    await saveConnection(null, { baseUrl: PROD, product: PRODUCT, keyPrefix: "jzu_abcd", keyRef: { manager: "env", key: "MY_JZ_KEY", origin: PROD, field: "journeeze-upload-key" }, connectedAt: "2026-10-09T00:00:00Z" }, { homedir });
    const { http, requests } = fakeJourneeze(OK_ROUTES());
    const env = { MY_JZ_KEY: KEY };
    await publishToJourneeze({ catalogDir: null, journeysDir: join(home, "journeys"), dryRun: false }, { homedir, env, http, exportBundle: fakeExport, sleep: async () => {}, sources: sources(env) });
    expect(requests[0]!.headers.Authorization).toBe(`Bearer ${KEY}`);
  });

  it("an MCP call never uses the global (*) connection, even outside a project", async () => {
    await saveConnection(null, { baseUrl: PROD, product: PRODUCT, keyPrefix: "jzu_abcd", keyRef: { manager: "env", key: "MY_JZ_KEY", origin: PROD, field: "journeeze-upload-key" }, connectedAt: "2026-10-09T00:00:00Z" }, { homedir });
    expect(await runAsMcpInvocation(() => loadConnection(null, { homedir }))).toBeUndefined();
  });

  it("not connected: a clear refusal telling a person to run connect", async () => {
    const { http } = fakeJourneeze(OK_ROUTES());
    const err = await errorOf(publish(http, {}));
    expect([err.code, /jevitate connect journeeze/.test(err.message)]).toEqual(["E_JOURNEEZE_NOT_CONNECTED", true]);
  });

  it("a key in the plaintext credentials file is never used (no plaintext fallback)", async () => {
    mkdirSync(join(home, ".jevitate"), { recursive: true });
    writeFileSync(join(home, ".jevitate", "credentials.json"), JSON.stringify({ JOURNEEZE_UPLOAD_KEY: KEY }));
    const { http } = fakeJourneeze(OK_ROUTES());
    expect((await errorOf(publish(http, {}))).code).toBe("E_JOURNEEZE_NOT_CONNECTED");
  });

  it("a bundle that contains the key is never sent", async () => {
    const leaky = async (req: ExportCatalogBundleRequest): Promise<ExportCatalogBundleResult> => {
      const r = await fakeExport(req);
      writeFileSync(r.bundlePath, BUNDLE.replace('"minor":0', `"minor":0,"note":"${KEY}"`));
      return r;
    };
    const { http, requests } = fakeJourneeze(OK_ROUTES());
    await errorOf(publish(http, undefined, { exportBundle: leaky }));
    expect(requests).toEqual([]);
  });
});

// ── #471: a bundle with demo media is uploaded as a ZIP (upload contract §4.2) ─────────────────

const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");
const SHOT = "media/demo-x/step-01.png";
const sha = (b: Uint8Array | string): string => createHash("sha256").update(b).digest("hex");
const MEDIA_BUNDLE = JSON.stringify({
  kind: "journeeze.catalog-bundle",
  version: 1,
  minor: 0,
  producer: { tool: "jevitate", version: "0.11.0" },
  catalog: { personas: [], jobs: [], journeys: [] },
  files: [{ path: SHOT, sha256: sha(PNG), bytes: PNG.byteLength, type: "image/png" }],
});

/** An export that writes bundle.json and its media; `edit` may then change the folder. */
const mediaExport =
  (edit: (outDir: string) => void = () => {}) =>
  async (req: ExportCatalogBundleRequest): Promise<ExportCatalogBundleResult> => {
    mkdirSync(join(req.outDir, "media", "demo-x"), { recursive: true });
    writeFileSync(join(req.outDir, "media", "demo-x", "step-01.png"), PNG);
    const bundlePath = join(req.outDir, "bundle.json");
    writeFileSync(bundlePath, MEDIA_BUNDLE);
    edit(req.outDir);
    return { format: "journeeze-bundle", bundlePath, digest: "", counts: { personas: 0, jobs: 0, journeys: 0, checks: 0, findings: 0, demos: 1, media: 1 }, warnings: [] };
  };

/** The entries of a STORED zip, by walking its local headers. */
function zipEntries(body: Uint8Array): Map<string, Buffer> {
  const b = Buffer.from(body);
  const out = new Map<string, Buffer>();
  let at = 0;
  while (b.readUInt32LE(at) === 0x04034b50) {
    const size = b.readUInt32LE(at + 18);
    const nameLen = b.readUInt16LE(at + 26);
    const extra = b.readUInt16LE(at + 28);
    const name = b.toString("utf8", at + 30, at + 30 + nameLen);
    const start = at + 30 + nameLen + extra;
    out.set(name, b.subarray(start, start + size));
    at = start + size;
  }
  return out;
}

describe("publish journeeze with demo media (#471)", () => {
  const publish = (http: JourneezeHttp, exportBundle = mediaExport()): Promise<PublishJourneezeResult> =>
    publishToJourneeze(
      { catalogDir: project, journeysDir: join(project, "journeys"), dryRun: false },
      { homedir, env: { JOURNEEZE_UPLOAD_KEY: KEY }, http, exportBundle, sleep: async () => {}, sources: sources({ JOURNEEZE_UPLOAD_KEY: KEY }) },
    );

  it("sends a bundle that lists media as application/zip", async () => {
    const { http, requests } = fakeJourneeze(OK_ROUTES());
    await publish(http);
    expect(requests[0]!.headers["Content-Type"]).toBe("application/zip");
  });

  it("the ZIP holds bundle.json and every listed media file, nothing else", async () => {
    const { http, requests } = fakeJourneeze(OK_ROUTES());
    await publish(http);
    expect([...zipEntries(requests[0]!.body!).keys()]).toEqual(["bundle.json", SHOT]);
  });

  it("the media in the ZIP is byte-identical to the export", async () => {
    const { http, requests } = fakeJourneeze(OK_ROUTES());
    await publish(http);
    expect(zipEntries(requests[0]!.body!).get(SHOT)!.equals(PNG)).toBe(true);
  });

  it("the Idempotency-Key stays the sha256 of bundle.json", async () => {
    const { http, requests } = fakeJourneeze(OK_ROUTES());
    await publish(http);
    expect(requests[0]!.headers["Idempotency-Key"]).toBe(`sha256-${sha(MEDIA_BUNDLE)}`);
  });

  it("the Content-Digest covers the ZIP body", async () => {
    const { http, requests } = fakeJourneeze(OK_ROUTES());
    await publish(http);
    expect(requests[0]!.headers["Content-Digest"]).toBe(`sha-256=:${createHash("sha256").update(requests[0]!.body!).digest("base64")}:`);
  });

  it("the same bundle gives the same ZIP bytes (a re-publish dedupes)", async () => {
    const a = fakeJourneeze(OK_ROUTES());
    const b = fakeJourneeze(OK_ROUTES());
    await publish(a.http);
    await publish(b.http);
    expect(sha(a.requests[0]!.body!)).toBe(sha(b.requests[0]!.body!));
  });

  it("a media file that differs from its listed sha256 is never sent", async () => {
    const { http, requests } = fakeJourneeze(OK_ROUTES());
    await errorOf(publish(http, mediaExport((out) => writeFileSync(join(out, "media", "demo-x", "step-01.png"), Buffer.concat([PNG, Buffer.from([1])])))));
    expect(requests).toEqual([]);
  });

  it("a media file the bundle does not list is never sent", async () => {
    const { http, requests } = fakeJourneeze(OK_ROUTES());
    await errorOf(publish(http, mediaExport((out) => writeFileSync(join(out, "media", "demo-x", "step-02.png"), PNG))));
    expect(requests).toEqual([]);
  });
});

/**
 * #477 — the bundle's product.name comes from the Journeeze product, not package.json. The saved
 * connection's product wins, else whoami's (CI key); an explicit --product-name overrides; a dry run
 * verifies the key with whoami and refuses a mismatch before exporting.
 */
describe("publish journeeze product name (#477)", () => {
  const SAVED_PRODUCT = { id: PRODUCT.id, name: "Ledgerly web" };
  const withSaved = (product: { id: string; name: string }) =>
    saveConnection(project, { baseUrl: PROD, product, keyPrefix: "jzu_abcd", keyRef: { manager: "env", key: "MY_JZ_KEY", origin: PROD, field: "journeeze-upload-key" }, connectedAt: "2026-10-09T00:00:00Z" }, { homedir });

  const recording = (): { seen: { productName?: string }; exportBundle: (req: ExportCatalogBundleRequest) => Promise<ExportCatalogBundleResult> } => {
    const seen: { productName?: string } = {};
    const exportBundle = async (req: ExportCatalogBundleRequest): Promise<ExportCatalogBundleResult> => {
      seen.productName = req.productName;
      return fakeExport(req);
    };
    return { seen, exportBundle };
  };

  const run = (
    http: JourneezeHttp,
    exportBundle: PublishDeps["exportBundle"],
    env: Record<string, string>,
    req: { dryRun?: boolean; productName?: string } = {},
  ): Promise<PublishJourneezeResult> =>
    publishToJourneeze(
      { catalogDir: project, journeysDir: join(project, "journeys"), dryRun: req.dryRun ?? false, ...(req.productName === undefined ? {} : { productName: req.productName }) },
      { homedir, env, http, exportBundle, sleep: async () => {}, sources: sources(env) },
    );

  it("sends the saved connection's product name in the bundle", async () => {
    await withSaved(SAVED_PRODUCT);
    const { http } = fakeJourneeze(OK_ROUTES());
    const { seen, exportBundle } = recording();
    await run(http, exportBundle, { MY_JZ_KEY: KEY });
    expect(seen.productName).toBe("Ledgerly web");
  });

  it("sends whoami's product name in the bundle when the key comes from the environment", async () => {
    const { http } = fakeJourneeze(OK_ROUTES());
    const { seen, exportBundle } = recording();
    await run(http, exportBundle, { JOURNEEZE_UPLOAD_KEY: KEY });
    expect(seen.productName).toBe("Ledgerly");
  });

  it("checks whoami with the environment key when resolving the product name", async () => {
    const { http, requests } = fakeJourneeze(OK_ROUTES());
    await run(http, recording().exportBundle, { JOURNEEZE_UPLOAD_KEY: KEY });
    const who = requests.find((r) => new URL(r.url).pathname.endsWith("/whoami"));
    expect(who?.headers.Authorization).toBe(`Bearer ${KEY}`);
  });

  it("an explicit product name wins over the saved connection's name", async () => {
    await withSaved(SAVED_PRODUCT);
    const { http } = fakeJourneeze(OK_ROUTES());
    const { seen, exportBundle } = recording();
    await run(http, exportBundle, { MY_JZ_KEY: KEY }, { productName: "Explicit product" });
    expect(seen.productName).toBe("Explicit product");
  });

  it("does not check whoami when the key comes from the saved connection", async () => {
    await withSaved(SAVED_PRODUCT);
    const { http, requests } = fakeJourneeze(OK_ROUTES());
    await run(http, recording().exportBundle, { MY_JZ_KEY: KEY });
    expect(requests.some((r) => new URL(r.url).pathname.endsWith("/whoami"))).toBe(false);
  });

  it("a dry run with a saved connection verifies the key with whoami once and sends no bundle", async () => {
    await withSaved(PRODUCT);
    const { http, requests } = fakeJourneeze(OK_ROUTES());
    await run(http, recording().exportBundle, { MY_JZ_KEY: KEY }, { dryRun: true });
    expect([requests.filter((r) => new URL(r.url).pathname.endsWith("/whoami")).length, requests.some((r) => r.method === "POST")]).toEqual([1, false]);
  });

  it("a dry run refuses when whoami's product name differs from the explicit product name", async () => {
    const { http } = fakeJourneeze(OK_ROUTES());
    const err = await errorOf(run(http, recording().exportBundle, { JOURNEEZE_UPLOAD_KEY: KEY }, { dryRun: true, productName: "Other product" }));
    expect(err.code).toBe("E_JOURNEEZE_PRODUCT_MISMATCH");
  });

  it("a dry run refuses when whoami's product name differs from the saved product name", async () => {
    await withSaved(SAVED_PRODUCT);
    const { http } = fakeJourneeze(OK_ROUTES());
    const err = await errorOf(run(http, recording().exportBundle, { MY_JZ_KEY: KEY }, { dryRun: true }));
    expect(err.code).toBe("E_JOURNEEZE_PRODUCT_MISMATCH");
  });

  it("the product-name mismatch names both products and how to fix it", async () => {
    const { http } = fakeJourneeze(OK_ROUTES());
    const err = await errorOf(run(http, recording().exportBundle, { JOURNEEZE_UPLOAD_KEY: KEY }, { dryRun: true, productName: "Other product" }));
    expect([err.message.includes("Other product"), err.message.includes("Ledgerly"), /--product-name|connect journeeze/.test(err.message)]).toEqual([true, true, true]);
  });

  it("a dry run whose whoami returns 401 reports E_JOURNEEZE_KEY_REFUSED without the key", async () => {
    const { http } = fakeJourneeze({ "GET /api/upload/v1/whoami": [{ status: 401, body: { code: "key_revoked" } }] });
    const err = await errorOf(run(http, recording().exportBundle, { JOURNEEZE_UPLOAD_KEY: KEY }, { dryRun: true }));
    expect([err.code, err.message.includes(KEY.slice(4))]).toEqual(["E_JOURNEEZE_KEY_REFUSED", false]);
  });

  it("returns the product name sent in the bundle", async () => {
    const { http } = fakeJourneeze(OK_ROUTES());
    const { seen, exportBundle } = recording();
    const r = await run(http, exportBundle, { JOURNEEZE_UPLOAD_KEY: KEY }, { dryRun: true });
    expect(r.productName).toBe(seen.productName);
  });
});
