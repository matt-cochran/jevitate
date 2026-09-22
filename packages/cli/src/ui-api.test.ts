import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request as httpRequest } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { FsInboxStore, type InboxItem } from "@jevitate/inbox";
import { startUiServer, type UiServerHandle } from "./ui-api.js";

/** `fetch` (undici) always sends the real connection Host and ignores an
 *  attempt to override it via the `headers` option — so a bad-Host test must
 *  go through the lower-level `node:http` client instead, which honors an
 *  explicit `Host` header override. */
function requestWithHost(port: number, path: string, hostHeader: string): Promise<{ status: number }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      { host: "127.0.0.1", port, path, method: "GET", headers: { Host: hostHeader } },
      (res) => {
        res.resume();
        res.on("end", () => resolve({ status: res.statusCode ?? 0 }));
      },
    );
    req.on("error", reject);
    req.end();
  });
}

/** Sends a RAW, un-normalized path (`node:http`'s client does not collapse
 *  `//` or touch `%`-encoding, unlike `fetch`/`URL`) — needed to reproduce
 *  the gate/router path-parsing mismatch (security review round 1). */
function rawRequest(
  port: number,
  method: string,
  path: string,
  headers: Record<string, string> = {},
): Promise<{ status: number }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: "127.0.0.1", port, path, method, headers }, (res) => {
      res.resume();
      res.on("end", () => resolve({ status: res.statusCode ?? 0 }));
    });
    req.on("error", reject);
    req.end();
  });
}

async function tmpDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "jevitate-ui-api-"));
}

function baseItem(overrides: Partial<InboxItem> = {}): InboxItem {
  return {
    id: "item-1",
    kind: "approval",
    status: "pending",
    run: "r1",
    journey: "j1",
    step: "s1",
    reason: "please approve",
    agent: "claude-code",
    hasScreenshot: false,
    thread: [],
    createdAt: new Date().toISOString(),
    ttlSec: 3600,
    ...overrides,
  } as InboxItem;
}

// A minimal, valid 1x1 PNG (transparent pixel) — enough to prove the
// screenshot route serves real bytes without pulling in an image library.
const TINY_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);

const servers: UiServerHandle[] = [];
async function start(deps: Parameters<typeof startUiServer>[0]): Promise<UiServerHandle> {
  const handle = await startUiServer({ open: false, ...deps });
  servers.push(handle);
  return handle;
}

afterEach(async () => {
  while (servers.length > 0) {
    const s = servers.pop()!;
    await s.close();
  }
});

describe("startUiServer — bind + token", () => {
  it("binds 127.0.0.1 and returns a url + token + port", async () => {
    const inboxDir = await tmpDir();
    const handle = await start({ inboxDir });
    expect(handle.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/\?t=[0-9a-f]{64}$/);
    expect(handle.token).toMatch(/^[0-9a-f]{64}$/);
    expect(handle.port).toBeGreaterThan(0);
  });

  it("rejects when an explicit --port is already taken (no port drift)", async () => {
    const inboxDir1 = await tmpDir();
    const inboxDir2 = await tmpDir();
    const first = await start({ inboxDir: inboxDir1, port: 48213 });
    expect(first.port).toBe(48213);
    await expect(startUiServer({ inboxDir: inboxDir2, port: 48213, open: false })).rejects.toThrow();
  });
});

describe("startUiServer — Host-header + token middleware", () => {
  it("rejects a bad Host header with 403", async () => {
    const inboxDir = await tmpDir();
    const handle = await start({ inboxDir });
    const res = await requestWithHost(handle.port, "/", "evil.example.com");
    expect(res.status).toBe(403);
  });

  it("returns 401 on /api/* with no token", async () => {
    const inboxDir = await tmpDir();
    const handle = await start({ inboxDir });
    const res = await fetch(`http://127.0.0.1:${handle.port}/api/inbox`);
    expect(res.status).toBe(401);
  });

  it("accepts the token via header", async () => {
    const inboxDir = await tmpDir();
    const handle = await start({ inboxDir });
    const res = await fetch(`http://127.0.0.1:${handle.port}/api/inbox`, {
      headers: { "x-jevitate-token": handle.token },
    });
    expect(res.status).toBe(200);
  });

  // Regression (security review round 1, Critical): the token gate and the
  // router used to parse the path DIFFERENTLY — the gate read the raw,
  // still-encoded pathname while the router matched on decoded segments —
  // so a shaped path could read `isApi === false` at the gate while still
  // routing to an /api handler, skipping the 401 check entirely. The gate
  // and router now derive `isApi`/routing from the SAME decoded segments;
  // every one of these must still 401 without a token.
  it("still 401s on /api/* with no token when the path is %-encoded (gate/router must parse identically)", async () => {
    const inboxDir = await tmpDir();
    const handle = await start({ inboxDir });
    const res = await rawRequest(handle.port, "GET", "/%61pi/inbox");
    expect(res.status).toBe(401);
  });

  it("never routes a doubled-leading-slash path to /api without a token (no data leak)", async () => {
    // NOTE: `new URL("//api/inbox", base)` is WHATWG-parsed as protocol-relative
    // — "api" becomes the URL's HOST, not a path segment — so `.pathname` comes
    // out as "/inbox", not "/api/inbox". Both the gate and the router (which now
    // share that same decoded-segments derivation) correctly see this as a plain
    // unknown route, not an /api one, and it 404s WITHOUT ever reaching the inbox
    // handler or leaking data — confirmed by never invoking the store below.
    const inboxDir = await tmpDir();
    const store = new FsInboxStore(inboxDir);
    await store.enqueue(baseItem({ id: "leak-check" }));
    const handle = await start({ inboxDir });
    const res = await rawRequest(handle.port, "GET", "//api/inbox");
    expect(res.status).toBe(404);
    // Still present/untouched — proves no unauthenticated read occurred.
    expect((await store.get("leak-check"))?.status).toBe("pending");
  });

  it("still 401s a state-changing POST with no token when the path is %-encoded", async () => {
    const inboxDir = await tmpDir();
    const store = new FsInboxStore(inboxDir);
    await store.enqueue(baseItem({ id: "some-id", kind: "approval" }));
    const handle = await start({ inboxDir });
    const res = await rawRequest(handle.port, "POST", "/%61pi/inbox/some-id/approve");
    expect(res.status).toBe(401);
    // And the item must NOT have been resolved by the unauthenticated attempt.
    const after = await store.get("some-id");
    expect(after?.status).toBe("pending");
  });
});

describe("startUiServer — GET / and GET /app.js", () => {
  it("serves index.html with the CSP header, a same-origin script tag, and no CDN substrings", async () => {
    const inboxDir = await tmpDir();
    const handle = await start({ inboxDir });
    const res = await fetch(handle.url);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-security-policy")).toBe(
      "default-src 'self'; img-src 'self'; style-src 'self' 'unsafe-inline'",
    );
    const body = await res.text();
    expect(body).toContain('<script src="/app.js">');
    expect(body).not.toContain("cdn.tailwindcss");
    expect(body).not.toContain("iconify");
  });

  it("sets the token cookie from ?t= on GET /", async () => {
    const inboxDir = await tmpDir();
    const handle = await start({ inboxDir });
    const res = await fetch(handle.url);
    const setCookie = res.headers.get("set-cookie");
    expect(setCookie).toBeTruthy();
    expect(setCookie).toContain(handle.token);
  });

  it("serves /app.js as text/javascript with real SPA content (non-trivial, no inline-handler smells)", async () => {
    const inboxDir = await tmpDir();
    const handle = await start({ inboxDir });
    const res = await fetch(`http://127.0.0.1:${handle.port}/app.js`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/javascript");
    const body = await res.text();
    expect(body.length).toBeGreaterThan(500);
    expect(body).toContain("addEventListener");
    expect(body).toContain("/api/inbox");
  });
});

describe("startUiServer — /api/inbox", () => {
  it("GET /api/inbox is empty on a fresh store", async () => {
    const inboxDir = await tmpDir();
    const handle = await start({ inboxDir });
    const res = await fetch(`http://127.0.0.1:${handle.port}/api/inbox`, {
      headers: { "x-jevitate-token": handle.token },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ items: [] });
  });

  it("shows an enqueued item's summary", async () => {
    const inboxDir = await tmpDir();
    const store = new FsInboxStore(inboxDir);
    await store.enqueue(baseItem({ id: "abc-1" }));
    const handle = await start({ inboxDir });
    const res = await fetch(`http://127.0.0.1:${handle.port}/api/inbox`, {
      headers: { "x-jevitate-token": handle.token },
    });
    const body = (await res.json()) as {
      items: Array<{ id: string; kind: string; status: string; run: string; journey: string; step: string; agent: string; hasScreenshot: boolean }>;
    };
    expect(body.items).toHaveLength(1);
    expect(body.items[0]).toMatchObject({
      id: "abc-1",
      kind: "approval",
      status: "pending",
      run: "r1",
      journey: "j1",
      step: "s1",
      agent: "claude-code",
      hasScreenshot: false,
    });
  });

  it("GET /api/inbox/:id returns the full item; 404 for unknown", async () => {
    const inboxDir = await tmpDir();
    const store = new FsInboxStore(inboxDir);
    await store.enqueue(baseItem({ id: "abc-2" }));
    const handle = await start({ inboxDir });
    const ok = await fetch(`http://127.0.0.1:${handle.port}/api/inbox/abc-2`, {
      headers: { "x-jevitate-token": handle.token },
    });
    expect(ok.status).toBe(200);
    const item = await ok.json();
    expect(item.id).toBe("abc-2");

    const missing = await fetch(`http://127.0.0.1:${handle.port}/api/inbox/nope`, {
      headers: { "x-jevitate-token": handle.token },
    });
    expect(missing.status).toBe(404);
  });
});

describe("startUiServer — approve/resume actions", () => {
  it("POST .../approve resolves an approval; a second POST 409s", async () => {
    const inboxDir = await tmpDir();
    const store = new FsInboxStore(inboxDir);
    await store.enqueue(baseItem({ id: "app-1", kind: "approval" }));
    const handle = await start({ inboxDir });
    const first = await fetch(`http://127.0.0.1:${handle.port}/api/inbox/app-1/approve`, {
      method: "POST",
      headers: { "x-jevitate-token": handle.token, "Content-Type": "application/json" },
      body: "{}",
    });
    expect(first.status).toBe(200);
    const item = await first.json();
    expect(item.status).toBe("approved");

    const second = await fetch(`http://127.0.0.1:${handle.port}/api/inbox/app-1/approve`, {
      method: "POST",
      headers: { "x-jevitate-token": handle.token, "Content-Type": "application/json" },
      body: "{}",
    });
    expect(second.status).toBe(409);
  });

  it("POST .../resume {input} resolves a handback and getForAgent returns the input once", async () => {
    const inboxDir = await tmpDir();
    const store = new FsInboxStore(inboxDir);
    await store.enqueue(baseItem({ id: "hb-1", kind: "handback" }));
    const handle = await start({ inboxDir });
    const res = await fetch(`http://127.0.0.1:${handle.port}/api/inbox/hb-1/resume`, {
      method: "POST",
      headers: { "x-jevitate-token": handle.token, "Content-Type": "application/json" },
      body: JSON.stringify({ input: "the otp is 123456" }),
    });
    expect(res.status).toBe(200);
    const item = await res.json();
    expect(item.status).toBe("resolved");

    const forAgent = await store.getForAgent("hb-1");
    expect(forAgent?.humanInput).toBe("the otp is 123456");
    const again = await store.getForAgent("hb-1");
    expect(again?.humanInput).toBeUndefined(); // burn-after-read
  });

  it("malformed JSON body returns 400", async () => {
    const inboxDir = await tmpDir();
    const store = new FsInboxStore(inboxDir);
    await store.enqueue(baseItem({ id: "app-2", kind: "approval" }));
    const handle = await start({ inboxDir });
    const res = await fetch(`http://127.0.0.1:${handle.port}/api/inbox/app-2/approve`, {
      method: "POST",
      headers: { "x-jevitate-token": handle.token, "Content-Type": "application/json" },
      body: "{not json",
    });
    expect(res.status).toBe(400);
  });
});

describe("startUiServer — screenshots", () => {
  it("rejects a traversal id carrying an encoded separator with 400 (raw-path defense-in-depth)", async () => {
    const inboxDir = await tmpDir();
    const handle = await start({ inboxDir });
    const res = await fetch(`http://127.0.0.1:${handle.port}/api/inbox/..%2F..%2Fetc%2Fpasswd/screenshot`, {
      headers: { "x-jevitate-token": handle.token },
    });
    // The raw pathname contains `%2F` — rejected up front (400), before the id
    // is even decoded/regex-checked. See the token-gate-bypass fix (security
    // review round 1): a `%2f`/`%5c` in the raw path is refused outright so a
    // segment can never smuggle a separator past `decodeURIComponent`.
    expect(res.status).toBe(400);
  });

  it("serves a real png placed at screenshots/<id>.png", async () => {
    const inboxDir = await tmpDir();
    const screenshotsDir = join(inboxDir, "screenshots");
    await mkdir(screenshotsDir, { recursive: true });
    await writeFile(join(screenshotsDir, "shot-1.png"), TINY_PNG);
    const handle = await start({ inboxDir });
    const res = await fetch(`http://127.0.0.1:${handle.port}/api/inbox/shot-1/screenshot`, {
      headers: { "x-jevitate-token": handle.token },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    const buf = Buffer.from(await res.arrayBuffer());
    expect(buf.equals(TINY_PNG)).toBe(true);
  });

  it("404s for a missing screenshot", async () => {
    const inboxDir = await tmpDir();
    const handle = await start({ inboxDir });
    const res = await fetch(`http://127.0.0.1:${handle.port}/api/inbox/no-such-id/screenshot`, {
      headers: { "x-jevitate-token": handle.token },
    });
    expect(res.status).toBe(404);
  });
});

describe("startUiServer — health", () => {
  it("GET /api/health reports store health", async () => {
    const inboxDir = await tmpDir();
    const handle = await start({ inboxDir });
    const res = await fetch(`http://127.0.0.1:${handle.port}/api/health`, {
      headers: { "x-jevitate-token": handle.token },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ ok: true, pending: 0 });
  });
});

describe("startUiServer — logging never leaks the token", () => {
  it("logs only 'method pathname status', never req.url/body/query", async () => {
    const inboxDir = await tmpDir();
    const lines: string[] = [];
    const handle = await start({ inboxDir, logger: (line) => lines.push(line) });

    // GET / carries ?t=<token> in its real URL.
    await fetch(handle.url);
    // An authenticated /api call carries the token in a header, not logged either way.
    await fetch(`http://127.0.0.1:${handle.port}/api/inbox`, {
      headers: { "x-jevitate-token": handle.token },
    });

    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      expect(line).not.toContain(handle.token);
      expect(line).not.toContain("t=");
      expect(line.split(" ").length).toBe(3); // "METHOD /pathname STATUS"
    }
  });
});
