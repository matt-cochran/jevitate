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
import { journeyProofHashForContext } from "./journey-proof-context.js";
import { readVerifyRecord } from "./journey-review-store.js";
import { useSkippingTime } from "../../explore/src/testkit.js";

// #304: Node and page time skip idle waits; assertions unchanged.
useSkippingTime({ per: "all" });

/**
 * #329 — "near me": a page that reads `navigator.geolocation`. `--geolocation <lat>,<lng>` places the
 * browser there and grants the permission to the run's allowed origins; without it the page gets no
 * position (the permission is never granted), exactly as before.
 */
const NEAR = `<!doctype html><html><head><title>Near me</title></head><body><main>
  <h1>Businesses near me</h1><button type="button">Use my location</button><p id="out">not located</p>
  <script>
    document.querySelector("button").addEventListener("click", async () => {
      try {
        const response = await fetch("/locate", { method: "POST" });
        if (!response.ok) return;
        navigator.geolocation.getCurrentPosition(
          (p) => { const e = document.getElementById("out"); e.dataset.testid = "pos"; e.textContent = "at " + p.coords.latitude + "," + p.coords.longitude; },
          (err) => { document.getElementById("out").textContent = "no position: " + err.message; },
          { timeout: 2000 },
        );
      } catch { /* a blocked write must not reach geolocation */ }
    });
  </script></main></body></html>`;

let server: Server;
let origin: string;
let dir: string;
let journey: Journey;
beforeAll(async () => {
  server = createServer((req, res) => {
    if (req.method === "POST" && req.url === "/locate") res.writeHead(204).end();
    else res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(NEAR);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  dir = await mkdtemp(join(tmpdir(), "jevitate-geo-"));
  journey = {
    metadata: {
      id: "near",
      name: "Near me",
      promoted: false,
      params: [],
      createdAtIso: "2026-10-03T00:00:00.000Z",
      mutationPairs: [
        { check: "step:3", mustFailWhen: "skip:2" },
        { check: "step:3", mustFailWhen: "block-write:2" },
      ],
    },
    recording: {
      version: "1",
      site: origin,
      pages: [
        {
          url: "/near",
          steps: [
            { step: { kind: "navigate", url: "/near", expect: { kind: "visible", target: { role: "heading", name: "Businesses near me" } } } },
            {
              step: { kind: "click", target: { role: "button", name: "Use my location" }, expect: { kind: "count", target: { css: "body" }, min: 0 } },
              delta: { verdict: "relevant-change", why: "location requested", changes: [], requests: ["POST /locate → 204"], overheadMs: 1 },
            },
            { step: { kind: "assert", check: { kind: "textIncludes", target: { testId: "pos" }, text: "at 41.6376,-70.9036" } } },
          ],
        },
      ],
    },
  };
  await new FsJourneyStore(join(dir, "journeys")).put(journey);
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

  it("journey verify applies the same geolocation to its baseline and mutation replays", async () => {
    const r = await cli(["journey", "verify", "near", "--mutate", "--geolocation", "41.6376,-70.9036", "--json"]);
    const report = (JSON.parse(r.out) as { data: { base: { outcome: string }; verdict: string; mutations: { outcome: string }[] } }).data;
    expect(report.base.outcome, r.out).toBe("ok");
    expect(report.mutations.length, r.out).toBeGreaterThan(0);
    expect(report.mutations.every((mutation) => mutation.outcome !== "error"), r.out).toBe(true);
    expect(report.verdict, r.out).toBe("proven");

    const receipt = await readVerifyRecord(join(dir, "journeys"), "near");
    const stored = await new FsJourneyStore(join(dir, "journeys")).get("near");
    expect(stored).not.toBeNull();
    expect(receipt?.proofContext).toEqual({ emulation: { geolocation: { latitude: 41.6376, longitude: -70.9036 } } });
    expect(receipt?.proofHash).toBe(journeyProofHashForContext(stored!, receipt?.proofContext));
    expect(receipt?.proofHash).not.toBe(
      journeyProofHashForContext(stored!, { emulation: { geolocation: { latitude: 40.7128, longitude: -74.006 } } }),
    );
  }, 120_000);

  it("without it the page gets no position (unchanged)", async () => {
    const r = await cli(["journey", "run", "near", "--json"]);
    expect((JSON.parse(r.out) as { data: { outcome: string } }).data.outcome).toBe("quarantined");
  }, 120_000);

  it("a malformed value is refused before any browser opens", async () => {
    const r = await cli(["journey", "run", "near", "--geolocation", "north", "--json"]);
    expect(JSON.parse(r.out)).toMatchObject({ ok: false, error: { message: expect.stringMatching(/--geolocation expects <lat>,<lng>/) } });
    const verify = await cli(["journey", "verify", "near", "--mutate", "--geolocation", "north", "--json"]);
    expect(JSON.parse(verify.out)).toMatchObject({ ok: false, error: { code: "E_JOURNEY_VERIFY_ARGS", message: expect.stringMatching(/--geolocation expects <lat>,<lng>/) } });
    const conflict = await cli(["journey", "verify", "near", "--mutate", "--viewport", "375x812", "--device", "iPhone 13", "--json"]);
    expect(JSON.parse(conflict.out)).toMatchObject({ ok: false, error: { code: "E_JOURNEY_VERIFY_ARGS", message: expect.stringMatching(/mutually exclusive/) } });
    expect(() => parseGeolocation("91,0")).toThrow(/latitude must be within -90..90/);
    expect(() => parseGeolocation("0,181")).toThrow(/longitude must be within -180..180/);
    expect(parseGeolocation("41.6376, -70.9036, 25")).toEqual({ latitude: 41.6376, longitude: -70.9036, accuracy: 25 });
  });
});
