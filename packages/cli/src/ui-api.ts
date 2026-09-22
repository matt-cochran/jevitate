import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomBytes } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join, sep } from "node:path";
import { spawn } from "node:child_process";
import {
  FsInboxStore,
  InboxItemNotFoundError,
  InboxItemAlreadyResolvedError,
  IllegalTransitionError,
  SAFE_INBOX_ID_RE,
  type Action,
} from "@jevitate/inbox";

/**
 * The `jevitate ui` local HTTP server — the human-facing side of the HITL
 * inbox. SM4 (loopback is NOT a trust boundary) is load-bearing here:
 *  - bind 127.0.0.1 ONLY, on every path including the port-retry;
 *  - every request is Host-checked (S-A), then every `/api/*` request is
 *    capability-token-gated (S-B), before any routing happens;
 *  - `GET /` sets a strict CSP (`default-src 'self'`) so the SPA MUST load
 *    its JS from a same-origin `<script src="/app.js">` — no inline script;
 *  - never logs `req.url` (it carries `?t=<token>`), request bodies, or
 *    query strings — only `method <pathname> status`.
 */

export interface StartUiServerDeps {
  /** Inbox store directory (`~/.jevitate/inbox` in production). Screenshots
   *  are read from `<inboxDir>/screenshots/<id>.png`. */
  inboxDir: string;
  /** Accepted but ignored for the actual bind (SM4: 127.0.0.1 ONLY on every
   *  path); kept in the signature for forward compatibility. */
  host?: string;
  /** Explicit port. When set, `EADDRINUSE` REJECTS the promise (no drift).
   *  When unset, defaults to 4180 and retries the next port on conflict. */
  port?: number;
  /** Open the URL in the default browser once bound. Defaults to `true`.
   *  Tests should always pass `false`. Fire-and-forget: a failed opener
   *  (e.g. no `xdg-open` under WSL) never rejects `startUiServer`. */
  open?: boolean;
  /** Structured log sink: `method <pathname> status` lines only. */
  logger?: (line: string) => void;
}

export interface UiServerHandle {
  url: string;
  token: string;
  port: number;
  close: () => Promise<void>;
}

const DEFAULT_PORT = 4180;
const MAX_PORT_ATTEMPTS = 20;
const MAX_BODY_BYTES = 1_000_000; // 1 MB cap — plenty for a human-typed input string.
const TOKEN_COOKIE = "jevitate_ui_token";
const SWEEP_INTERVAL_MS = 60_000;
const RESOLVE_ACTIONS = new Set(["approve", "reject", "resume"]);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isAddrInUse(err: unknown): boolean {
  return typeof err === "object" && err !== null && "code" in err && (err as { code?: unknown }).code === "EADDRINUSE";
}

function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx === -1) continue;
    const key = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    if (key) out[key] = decodeURIComponent(value);
  }
  return out;
}

/** Reads the request body up to `limit` bytes and JSON-parses it. An empty
 *  body parses to `undefined` (not an error — some actions take no body).
 *  Over-limit or malformed JSON both resolve `{ ok: false }`; the caller
 *  maps that to 400, never throws it up as an unhandled rejection. */
function readJsonBody(
  req: IncomingMessage,
  limit = MAX_BODY_BYTES,
): Promise<{ ok: true; data: unknown } | { ok: false }> {
  return new Promise((resolve) => {
    let total = 0;
    const chunks: Buffer[] = [];
    let settled = false;
    const finish = (result: { ok: true; data: unknown } | { ok: false }) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    req.on("data", (chunk: Buffer) => {
      total += chunk.length;
      if (total > limit) {
        finish({ ok: false });
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8").trim();
      if (raw.length === 0) {
        finish({ ok: true, data: undefined });
        return;
      }
      try {
        finish({ ok: true, data: JSON.parse(raw) });
      } catch {
        finish({ ok: false });
      }
    });
    req.on("error", () => finish({ ok: false }));
  });
}

function listenOnce(server: ReturnType<typeof createServer>, host: string, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (err: unknown) => {
      server.removeListener("listening", onListening);
      reject(err);
    };
    const onListening = () => {
      server.removeListener("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, host);
  });
}

/** Fire-and-forget browser open (S-D). A failed spawn (missing `xdg-open`
 *  under WSL, etc.) is swallowed — it must NEVER reject `startUiServer` or
 *  throw an unhandled rejection. */
function openInBrowser(url: string): void {
  try {
    const platform = process.platform;
    let cmd: string;
    let args: string[];
    if (platform === "darwin") {
      cmd = "open";
      args = [url];
    } else if (platform === "win32") {
      cmd = "cmd";
      args = ["/c", "start", "", url];
    } else {
      cmd = "xdg-open";
      args = [url];
    }
    const child = spawn(cmd, args, { stdio: "ignore", detached: true });
    child.on("error", () => {
      // swallow — a failed opener must never surface (S-D)
    });
    child.unref();
  } catch {
    // swallow — same guarantee, for a synchronous spawn failure
  }
}

export async function startUiServer(deps: StartUiServerDeps): Promise<UiServerHandle> {
  const store = new FsInboxStore(deps.inboxDir);
  const token = randomBytes(32).toString("hex");
  const logger = deps.logger ?? (() => {});
  const shouldOpen = deps.open ?? true;

  // Sibling of dist/ — same convention build.mjs uses for `skills`. NOT
  // copied into dist; `ui/` ships via package.json "files" (Task 10).
  const indexHtmlPath = fileURLToPath(new URL("../ui/index.html", import.meta.url));
  const appJsPath = fileURLToPath(new URL("../ui/app.js", import.meta.url));
  const screenshotsDir = join(deps.inboxDir, "screenshots");

  const server = createServer();
  let boundPort = 0;

  function send(res: ServerResponse, status: number, body?: unknown, headers: Record<string, string> = {}): number {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    res.writeHead(status, { "Content-Type": "application/json", ...headers });
    res.end(payload);
    return status;
  }

  async function serveIndex(req: IncomingMessage, res: ServerResponse): Promise<number> {
    const reqUrl = new URL(req.url ?? "/", `http://127.0.0.1:${boundPort}`);
    const t = reqUrl.searchParams.get("t");
    const html = await readFile(indexHtmlPath, "utf8");
    const headers: Record<string, string> = {
      "Content-Type": "text/html; charset=utf-8",
      "Content-Security-Policy": "default-src 'self'; img-src 'self'; style-src 'self' 'unsafe-inline'",
    };
    if (t) {
      headers["Set-Cookie"] = `${TOKEN_COOKIE}=${encodeURIComponent(t)}; Path=/; HttpOnly; SameSite=Strict`;
    }
    res.writeHead(200, headers);
    res.end(html);
    return 200;
  }

  async function serveAppJs(res: ServerResponse): Promise<number> {
    const js = await readFile(appJsPath, "utf8");
    res.writeHead(200, { "Content-Type": "text/javascript" });
    res.end(js);
    return 200;
  }

  /** `<inboxDir>/screenshots/<id>.png` only — never built from any item
   *  field, only from the URL id. Rejects an unsafe id BEFORE touching the
   *  filesystem, then re-checks the RESOLVED realpath is inside the
   *  screenshots dir via a trailing-separator prefix check (N-c). */
  async function serveScreenshot(id: string, res: ServerResponse): Promise<number> {
    if (!SAFE_INBOX_ID_RE.test(id)) return send(res, 404, { error: "not_found" });
    let resolvedDir: string;
    try {
      resolvedDir = await realpath(screenshotsDir);
    } catch {
      return send(res, 404, { error: "not_found" });
    }
    const candidate = join(screenshotsDir, `${id}.png`);
    let resolved: string;
    try {
      resolved = await realpath(candidate);
    } catch {
      return send(res, 404, { error: "not_found" });
    }
    if (!(resolved === resolvedDir || resolved.startsWith(resolvedDir + sep))) {
      return send(res, 404, { error: "not_found" });
    }
    try {
      const data = await readFile(resolved);
      res.writeHead(200, { "Content-Type": "image/png" });
      res.end(data);
      return 200;
    } catch {
      return send(res, 404, { error: "not_found" });
    }
  }

  async function handleAction(
    id: string,
    action: "approve" | "reject" | "resume" | "input",
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<number> {
    if (!SAFE_INBOX_ID_RE.test(id)) return send(res, 400, { error: "invalid_id" });
    const bodyResult = await readJsonBody(req);
    if (!bodyResult.ok) return send(res, 400, { error: "invalid_body" });
    const body = isPlainObject(bodyResult.data) ? bodyResult.data : {};
    const input = typeof body.input === "string" ? body.input : undefined;

    try {
      let item;
      if (action === "input") {
        if (input === undefined) return send(res, 400, { error: "invalid_body", message: "'input' must be a string" });
        item = await store.appendThread(id, { author: "human", text: input, at: new Date().toISOString() });
      } else {
        const resolveAction = action as Exclude<Action, "input">;
        item = await store.resolve(id, {
          channel: "human",
          action: resolveAction,
          ...(input !== undefined ? { input } : {}),
        });
      }
      return send(res, 200, item);
    } catch (err) {
      if (err instanceof InboxItemNotFoundError) return send(res, 404, { error: "not_found" });
      if (err instanceof InboxItemAlreadyResolvedError) return send(res, 409, { error: "already_resolved" });
      if (err instanceof IllegalTransitionError) return send(res, 409, { error: "illegal_transition" });
      return send(res, 500, { error: "internal" });
    }
  }

  async function route(req: IncomingMessage, res: ServerResponse, pathname: string): Promise<number> {
    // (1) Host-header check — every path, before anything else.
    const host = req.headers.host;
    if (host !== `127.0.0.1:${boundPort}` && host !== `localhost:${boundPort}`) {
      return send(res, 403, { error: "forbidden_host" });
    }

    // (2) Capability-token check — every /api/* path.
    const isApi = pathname === "/api" || pathname.startsWith("/api/");
    if (isApi) {
      const headerTokenRaw = req.headers["x-jevitate-token"];
      const headerToken = Array.isArray(headerTokenRaw) ? headerTokenRaw[0] : headerTokenRaw;
      const cookieToken = parseCookies(req.headers.cookie)[TOKEN_COOKIE];
      const supplied = headerToken ?? cookieToken;
      if (supplied !== token) return send(res, 401, { error: "unauthorized" });
    }

    // (3) Route.
    const method = req.method ?? "GET";
    const segments = pathname.split("/").filter(Boolean).map((s) => decodeURIComponent(s));

    if (method === "GET" && segments.length === 0) return serveIndex(req, res);
    if (method === "GET" && segments.length === 1 && segments[0] === "app.js") return serveAppJs(res);

    if (method === "GET" && segments.length === 2 && segments[0] === "api" && segments[1] === "inbox") {
      const items = await store.getSummaries();
      return send(res, 200, { items });
    }
    if (method === "GET" && segments.length === 2 && segments[0] === "api" && segments[1] === "health") {
      const health = await store.health();
      return send(res, 200, health);
    }

    if (segments.length === 3 && segments[0] === "api" && segments[1] === "inbox") {
      const id = segments[2];
      if (method === "GET") {
        if (!SAFE_INBOX_ID_RE.test(id)) return send(res, 404, { error: "not_found" });
        const item = await store.get(id);
        if (!item) return send(res, 404, { error: "not_found" });
        return send(res, 200, item);
      }
    }

    if (segments.length === 4 && segments[0] === "api" && segments[1] === "inbox") {
      const id = segments[2];
      const sub = segments[3];
      if (method === "GET" && sub === "screenshot") return serveScreenshot(id, res);
      if (method === "POST" && (RESOLVE_ACTIONS.has(sub) || sub === "input")) {
        return handleAction(id, sub as "approve" | "reject" | "resume" | "input", req, res);
      }
    }

    return send(res, 404, { error: "not_found" });
  }

  async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const pathname = new URL(req.url ?? "/", `http://127.0.0.1:${boundPort}`).pathname;
    let status = 500;
    try {
      status = await route(req, res, pathname);
    } catch {
      status = res.headersSent ? res.statusCode : send(res, 500, { error: "internal" });
    } finally {
      // NEVER log req.url (carries `?t=<token>`) or the body/query string —
      // only the derived pathname + status (S-C/N4).
      logger(`${req.method ?? "GET"} ${pathname} ${status}`);
    }
  }

  server.on("request", (req, res) => {
    void handleRequest(req, res);
  });

  async function bind(): Promise<number> {
    if (deps.port !== undefined) {
      try {
        await listenOnce(server, "127.0.0.1", deps.port);
      } catch (err) {
        if (isAddrInUse(err)) {
          throw new Error(`jevitate ui: port ${deps.port} is already in use`);
        }
        throw err;
      }
      return deps.port;
    }

    let port = DEFAULT_PORT;
    for (let attempt = 0; attempt < MAX_PORT_ATTEMPTS; attempt++) {
      try {
        await listenOnce(server, "127.0.0.1", port);
        return port;
      } catch (err) {
        if (isAddrInUse(err) && attempt < MAX_PORT_ATTEMPTS - 1) {
          port++;
          continue;
        }
        throw err;
      }
    }
    /* istanbul ignore next -- unreachable: loop always returns or throws */
    throw new Error("jevitate ui: failed to bind after 20 attempts");
  }

  boundPort = await bind();

  const sweepTimer = setInterval(() => {
    void store.sweepExpired().catch(() => {
      // best-effort background sweep; a failure here must not crash the server
    });
  }, SWEEP_INTERVAL_MS);
  sweepTimer.unref();

  const url = `http://127.0.0.1:${boundPort}/?t=${token}`;
  if (shouldOpen) openInBrowser(url);

  async function close(): Promise<void> {
    clearInterval(sweepTimer);
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  }

  return { url, token, port: boundPort, close };
}
