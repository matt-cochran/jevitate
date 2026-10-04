import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Command } from "commander";
import { ProfileManager } from "@jevitate/daemon";
import { FsJourneyStore, JourneySchema, type Journey, type JourneyNetworkCheck } from "@jevitate/journey";
import { PlaywrightBrowserPort } from "@jevitate/playwright";
import { buildProgram } from "./program.js";
import { useSkippingTime } from "../../explore/src/testkit.js";

// #304: Node and page time skip idle waits; assertions unchanged.
useSkippingTime({ per: "all" });

/**
 * #322 — a Journey authored from a network success check (`requestMade` / `responseStatus`) keeps
 * it as `metadata.networkChecks`; `journey run` evaluates it over the requests the replay itself
 * sent. Every step passing is not enough: the expected request must have gone out.
 */

const APP = `<!doctype html><html><head><title>Settings</title></head><body><main>
  <h1>Settings</h1>
  <button type="button" onclick="fetch('/api/save', {method: 'POST'})">Save</button>
</main></body></html>`;

let server: Server;
let origin: string;
let dir: string;
beforeAll(async () => {
  server = createServer((req, res) => {
    if (req.method === "POST") return void res.writeHead(204).end();
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(APP);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  dir = await mkdtemp(join(tmpdir(), "jevitate-netchecks-"));
});
afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await rm(dir, { recursive: true, force: true });
});

function journey(id: string, networkChecks: JourneyNetworkCheck[]): Journey {
  return {
    metadata: { id, name: "Save settings", promoted: false, params: [], createdAtIso: "2026-10-03T00:00:00.000Z", networkChecks },
    recording: {
      version: "1",
      site: origin,
      pages: [
        {
          url: "/app",
          steps: [
            { step: { kind: "navigate", url: "/app", expect: { kind: "visible", target: { role: "heading", name: "Settings" } } } },
            { step: { kind: "click", target: { role: "button", name: "Save" }, expect: { kind: "visible", target: { role: "button", name: "Save" } } } },
          ],
        },
      ],
    },
  };
}

async function cli(journeysDir: string, args: string[]): Promise<{ out: string; exitCode: number | undefined }> {
  const out: string[] = [];
  const program = buildProgram({
    profiles: new ProfileManager("/unused"),
    journeysDir,
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

async function run(id: string, checks: JourneyNetworkCheck[]): Promise<{ exitCode: number | undefined; data: { outcome: string; reason?: string } }> {
  const journeysDir = join(dir, id);
  await new FsJourneyStore(journeysDir).put(journey(id, checks));
  const r = await cli(journeysDir, ["journey", "run", id, "--json"]);
  return { exitCode: r.exitCode, data: (JSON.parse(r.out) as { data: { outcome: string; reason?: string } }).data };
}

describe("journey run evaluates the Journey's network checks over its replay (#322, served)", () => {
  it("the request went out with the expected status: ok", async () => {
    const r = await run("saved", [
      { kind: "requestMade", method: "POST", pathGlob: "/api/save" },
      { kind: "responseStatus", method: "POST", pathGlob: "/api/save", status: { class: 2 } },
    ]);
    expect(r.data.outcome).toBe("ok");
    expect(r.exitCode ?? 0).toBe(0);
  }, 120_000);

  it("every step passed but the expected request never went out: the run fails, naming the check", async () => {
    const r = await run("not-sent", [{ kind: "requestMade", method: "POST", pathGlob: "/api/publish" }]);
    expect(r.data.outcome).toBe("quarantined");
    expect(r.data.reason).toMatch(/success check not met after the last step: requestMade:POST \/api\/publish/);
    expect(r.exitCode).not.toBe(0);
  }, 120_000);

  it("the wrong status fails the run", async () => {
    const r = await run("wrong-status", [{ kind: "responseStatus", method: "POST", pathGlob: "/api/save", status: { class: 4 } }]);
    expect(r.data.outcome).toBe("quarantined");
    expect(r.data.reason).toMatch(/responseStatus:POST \/api\/save=4xx/);
  }, 120_000);

  it("the schema validates network checks and refuses a malformed one", () => {
    expect(JourneySchema.safeParse(journey("ok", [{ kind: "requestMade", method: "POST", pathGlob: "/api/save" }])).success).toBe(true);
    const bad = journey("bad", []);
    (bad.metadata as unknown as { networkChecks: unknown[] }).networkChecks = [{ kind: "requestMade", method: "POST" }];
    expect(JourneySchema.safeParse(bad).success).toBe(false);
  });
});
