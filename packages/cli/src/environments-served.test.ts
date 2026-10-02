import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ProfileManager } from "@jevitate/daemon";
import { FsJourneyStore, JourneyRegistry } from "@jevitate/journey";
import { PlaywrightBrowserPort } from "@jevitate/playwright";
import { buildProgram } from "./program.js";
import { useSkippingTime } from "../../explore/src/testkit.js";

// #304: Node and page time skip idle waits (settle windows, hang ceilings, polls); assertions unchanged.
useSkippingTime({ per: "all" });

/**
 * #247 — the SAME Journey file runs against two served apps chosen by `--env`, in real Chromium.
 * The Journey was recorded on a third origin (dead: nothing listens there); its steps are an
 * app-relative navigate, a click, and one absolute navigate on the recorded origin — all of which
 * must land on the chosen environment.
 */

interface App {
  readonly server: Server;
  readonly origin: string;
  readonly hits: string[];
}

async function serve(name: string): Promise<App> {
  const hits: string[] = [];
  const server = createServer((req, res) => {
    const path = (req.url ?? "").split("?")[0] ?? "";
    hits.push(req.url ?? "");
    const html = (body: string) => res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(`<!doctype html><html><body>${body}</body></html>`);
    if (path === "/hello") return html(`<h1>${name}</h1><a data-testid="go" href="/done">Go</a>`);
    if (path === "/done") return html(`<p data-testid="done">done on ${name}</p>`);
    res.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { server, origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, hits };
}

const RECORDED = "http://127.0.0.1:9";

let a: App;
let b: App;
let root: string;
let journeysDir: string;
let environmentsFile: string;

beforeAll(async () => {
  a = await serve("app-a");
  b = await serve("app-b");
  root = mkdtempSync(join(tmpdir(), "jev-env-served-"));
  journeysDir = join(root, "journeys");
  environmentsFile = join(root, "environments.json");
  writeFileSync(environmentsFile, JSON.stringify({ a: { baseUrl: a.origin }, b: { baseUrl: b.origin } }));
  await new JourneyRegistry(new FsJourneyStore(journeysDir)).put({
    metadata: { id: "hello", name: "hello", promoted: true, params: [], createdAtIso: "2026-09-28T00:00:00Z" },
    recording: {
      version: "1",
      site: RECORDED,
      pages: [
        {
          url: "/hello",
          steps: [
            { step: { kind: "navigate", url: "/hello", expect: { kind: "urlIncludes", text: "/hello" } } },
            { step: { kind: "click", target: { testId: "go" }, expect: { kind: "visible", target: { testId: "done" } } } },
          ],
        },
        {
          url: `${RECORDED}/hello?again=1`,
          steps: [{ step: { kind: "navigate", url: `${RECORDED}/hello?again=1`, expect: { kind: "urlIncludes", text: `${RECORDED}/hello?again=1` } } }],
        },
      ],
    },
  });
});

afterAll(async () => {
  await Promise.all([a, b].map((x) => new Promise<void>((resolve) => x.server.close(() => resolve()))));
  rmSync(root, { recursive: true, force: true });
});

async function run(argv: string[]): Promise<{ out: { ok: boolean; data?: { outcome?: string; reason?: string } }; code: number | undefined }> {
  const lines: string[] = [];
  const program = buildProgram({
    profiles: new ProfileManager("/unused"),
    dbPath: join(root, "db.sqlite"),
    environmentsFile,
    explore: { browserPortFactory: () => new PlaywrightBrowserPort(), targetsConfigPath: join(root, "targets.json") },
  });
  program.configureOutput({ writeOut: (s) => lines.push(s), writeErr: () => {} });
  program.exitOverride();
  process.exitCode = undefined;
  await program.parseAsync(argv, { from: "user" });
  const code = process.exitCode === undefined ? undefined : Number(process.exitCode);
  process.exitCode = undefined;
  return { out: JSON.parse(lines.join("")), code };
}

describe("one Journey, two environments (--env), real Chromium", () => {
  it("runs the same Journey file against app A, then app B", async () => {
    const ra = await run(["journey", "run", "hello", "--dir", journeysDir, "--env", "a", "--json"]);
    expect(ra.out.data, JSON.stringify(ra.out)).toMatchObject({ outcome: "ok" });
    expect(ra.code).toBe(0);
    expect(a.hits).toEqual(expect.arrayContaining(["/hello", "/done", "/hello?again=1"]));
    expect(b.hits).toEqual([]);

    const rb = await run(["journey", "run", "hello", "--dir", journeysDir, "--env", "b", "--json"]);
    expect(rb.out.data, JSON.stringify(rb.out)).toMatchObject({ outcome: "ok" });
    expect(rb.code).toBe(0);
    expect(b.hits).toEqual(expect.arrayContaining(["/hello", "/done", "/hello?again=1"]));
  });

  it("--base-url chooses an ad-hoc environment the same way", async () => {
    const before = b.hits.length;
    const r = await run(["journey", "run", "hello", "--dir", journeysDir, "--base-url", b.origin, "--json"]);
    expect(r.out.data, JSON.stringify(r.out)).toMatchObject({ outcome: "ok" });
    expect(b.hits.slice(before)).toEqual(expect.arrayContaining(["/hello", "/done"]));
  });

  it("without --env it replays on the recorded site, exactly as before (which is down here: quarantined, not moved)", async () => {
    const before = [a.hits.length, b.hits.length];
    const r = await run(["journey", "run", "hello", "--dir", journeysDir, "--json"]);
    expect(r.out.data).toMatchObject({ outcome: "quarantined" });
    expect([a.hits.length, b.hits.length]).toEqual(before);
  });
});
