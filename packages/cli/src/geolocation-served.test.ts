import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Command } from "commander";
import { ProfileManager } from "@jevitate/daemon";
import { FsJourneyStore, type Journey } from "@jevitate/journey";
import { PlaywrightBrowserPort, parseGeolocation } from "@jevitate/playwright";
import { buildProgram } from "./program.js";
import { useSkippingTime } from "../../explore/src/testkit.js";

// #304: Node and page time skip idle waits; assertions unchanged.
useSkippingTime({ per: "all" });

/**
 * #329 — "near me": a page that reads `navigator.geolocation`. `--geolocation <lat>,<lng>` places the
 * browser there and grants the permission to the run's allowed origins; without it the page gets no
 * position (the permission is never granted), exactly as before.
 */
const NEAR = `<!doctype html><html><head><title>Near me</title></head><body><main>
  <h1>Businesses near me</h1><p id="out">locating…</p>
  <script>
    navigator.geolocation.getCurrentPosition(
      (p) => { const e = document.getElementById("out"); e.dataset.testid = "pos"; e.textContent = "at " + p.coords.latitude + "," + p.coords.longitude; },
      (err) => { document.getElementById("out").textContent = "no position: " + err.message; },
      { timeout: 2000 },
    );
  </script></main></body></html>`;

let server: Server;
let origin: string;
let dir: string;
beforeAll(async () => {
  server = createServer((_req, res) => res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(NEAR));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  dir = await mkdtemp(join(tmpdir(), "jevitate-geo-"));
  const j: Journey = {
    metadata: { id: "near", name: "Near me", promoted: false, params: [], createdAtIso: "2026-10-03T00:00:00.000Z" },
    recording: {
      version: "1",
      site: origin,
      pages: [
        {
          url: "/near",
          steps: [
            { step: { kind: "navigate", url: "/near", expect: { kind: "visible", target: { role: "heading", name: "Businesses near me" } } } },
            { step: { kind: "assert", check: { kind: "textIncludes", target: { testId: "pos" }, text: "at 41.6376,-70.9036" } } },
          ],
        },
      ],
    },
  };
  await new FsJourneyStore(join(dir, "journeys")).put(j);
});
afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await rm(dir, { recursive: true, force: true });
});

async function cli(args: string[]): Promise<{ out: string; exitCode: number | undefined }> {
  const out: string[] = [];
  const program = buildProgram({
    profiles: new ProfileManager("/unused"),
    journeysDir: join(dir, "journeys"),
    dbPath: join(dir, "no-site-policy.sqlite"),
    explore: { browserPortFactory: () => new PlaywrightBrowserPort() },
  });
  program.configureOutput({ writeOut: (s) => out.push(s), writeErr: () => undefined });
  const override = (c: Command): void => {
    c.exitOverride();
    c.commands.forEach(override);
  };
  override(program);
  process.exitCode = undefined;
  await program.parseAsync(args, { from: "user" });
  const exitCode = process.exitCode;
  process.exitCode = undefined;
  return { out: out.join(""), exitCode };
}

describe("--geolocation (#329, served)", () => {
  it("journey run --geolocation places the browser there (the page reads the position)", async () => {
    const r = await cli(["journey", "run", "near", "--geolocation", "41.6376,-70.9036", "--json"]);
    expect((JSON.parse(r.out) as { data: { outcome: string } }).data.outcome, r.out).toBe("ok");
  }, 120_000);

  it("without it the page gets no position (unchanged)", async () => {
    const r = await cli(["journey", "run", "near", "--json"]);
    expect((JSON.parse(r.out) as { data: { outcome: string } }).data.outcome).toBe("quarantined");
  }, 120_000);

  it("a malformed value is refused before any browser opens", async () => {
    const r = await cli(["journey", "run", "near", "--geolocation", "north", "--json"]);
    expect(JSON.parse(r.out)).toMatchObject({ ok: false, error: { message: expect.stringMatching(/--geolocation expects <lat>,<lng>/) } });
    expect(() => parseGeolocation("91,0")).toThrow(/latitude must be within -90..90/);
    expect(() => parseGeolocation("0,181")).toThrow(/longitude must be within -180..180/);
    expect(parseGeolocation("41.6376, -70.9036, 25")).toEqual({ latitude: 41.6376, longitude: -70.9036, accuracy: 25 });
  });
});
