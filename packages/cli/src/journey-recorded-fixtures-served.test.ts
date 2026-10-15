import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProfileManager } from "@jevitate/daemon";
import { FsJourneyStore, type Journey } from "@jevitate/journey";
import { PlaywrightBrowserPort } from "@jevitate/playwright";
import { buildProgram } from "./program.js";
import { useSkippingTime } from "../../explore/src/testkit.js";

useSkippingTime({ per: "all" });

/**
 * #544 part B, served: `journey run` with no --fixtures uses the fixtures file recorded on the Journey
 * (precedence: flag > recorded), refuses a missing recorded file before any browser, and warns (never
 * blocks) when the file's spec hash differs from the recorded one.
 */

const log: string[] = [];
let server: Server;
let origin: string;
let dir: string;
let recordedFile: string;
let otherFile: string;

beforeAll(async () => {
  server = createServer((req, res) => {
    if (req.method === "POST" && req.url?.startsWith("/fx/")) {
      log.push(req.url.slice(4));
      res.writeHead(200, { "content-type": "application/json" }).end("{}");
      return;
    }
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end("<!doctype html><html><head><title>Hi</title></head><body><main><h1>Hello</h1></main></body></html>");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  dir = await mkdtemp(join(tmpdir(), "jev-recorded-fx-"));
  const spec = (name: string): string => JSON.stringify({ setup: [{ method: "POST", url: `${origin}/fx/${name}-setup` }], restore: [{ method: "POST", url: `${origin}/fx/${name}-restore` }] });
  recordedFile = join(dir, "recorded.json");
  otherFile = join(dir, "other.json");
  await writeFile(recordedFile, spec("recorded"));
  await writeFile(otherFile, spec("other"));
});
afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await rm(dir, { recursive: true, force: true });
});
beforeEach(() => {
  log.length = 0;
});

function journey(id: string, fixtures?: { file: string; specHash: string }): Journey {
  return {
    metadata: { id, name: "Hello", promoted: false, params: [], createdAtIso: "2026-10-15T00:00:00.000Z", ...(fixtures === undefined ? {} : { fixtures }) },
    recording: {
      version: "1",
      site: origin,
      pages: [{ url: "/", steps: [{ step: { kind: "navigate", url: "/", expect: { kind: "visible", target: { role: "heading", name: "Hello" } } } }] }],
    },
  };
}

async function run(j: Journey, extra: string[] = [], browserPortFactory: () => PlaywrightBrowserPort = () => new PlaywrightBrowserPort()): Promise<{ out: string; err: string; exitCode: number | undefined }> {
  const journeysDir = join(dir, j.metadata.id);
  await new FsJourneyStore(journeysDir).put(j);
  const out: string[] = [];
  const err: string[] = [];
  const program = buildProgram({
    profiles: new ProfileManager("/unused"),
    journeysDir,
    dbPath: join(dir, "no-site-policy.sqlite"),
    explore: { browserPortFactory },
  });
  program.configureOutput({ writeOut: (s) => out.push(s), writeErr: (s) => err.push(s) });
  program.exitOverride();
  process.exitCode = undefined;
  await program.parseAsync(["journey", "run", j.metadata.id, ...extra], { from: "user" });
  const exitCode = process.exitCode;
  process.exitCode = undefined;
  return { out: out.join(""), err: err.join(""), exitCode };
}

async function currentHash(): Promise<string> {
  const { currentSpecHash } = await import("./journey-fixtures.js");
  return currentSpecHash(recordedFile, { allowlist: [origin], baseUrl: origin });
}

describe("journey run with recorded fixtures (#544, served)", () => {
  it("runs the recorded fixtures' setup and restore when no --fixtures flag is given", async () => {
    await run(journey("rec-run", { file: recordedFile, specHash: await currentHash() }), ["--json"]);
    expect(log).toEqual(["recorded-setup", "recorded-restore"]);
  }, 120_000);

  it("lets --fixtures override the recorded file", async () => {
    await run(journey("rec-override", { file: recordedFile, specHash: await currentHash() }), ["--fixtures", otherFile, "--json"]);
    expect(log).toEqual(["other-setup", "other-restore"]);
  }, 120_000);

  it("refuses a missing recorded file with the fixture spec code", async () => {
    const r = await run(journey("rec-missing", { file: join(dir, "gone.json"), specHash: "0000000000000000" }), ["--json"]);
    expect(r.out).toContain("E_FIXTURE_SPEC");
  });

  it("opens no browser for a missing recorded file", async () => {
    const factory = vi.fn(() => new PlaywrightBrowserPort());
    await run(journey("rec-missing-nobrowser", { file: join(dir, "gone.json"), specHash: "0000000000000000" }), ["--json"], factory);
    expect(factory).not.toHaveBeenCalled();
  });

  it("names the recorded file and the --fixtures override in the refusal", async () => {
    const r = await run(journey("rec-missing-msg", { file: join(dir, "gone.json"), specHash: "0000000000000000" }), ["--json"]);
    expect(r.out).toMatch(/gone\.json.*--fixtures|--fixtures.*gone\.json/);
  });

  it("still runs the Journey when the recorded spec hash drifted", async () => {
    const r = await run(journey("rec-drift-runs", { file: recordedFile, specHash: "0000000000000000" }), ["--json"]);
    expect((JSON.parse(r.out) as { data: { outcome: string } }).data.outcome).toBe("ok");
  }, 120_000);

  it("reports fixtureDrift in the JSON when the recorded spec hash drifted", async () => {
    const r = await run(journey("rec-drift-json", { file: recordedFile, specHash: "0000000000000000" }), ["--json"]);
    expect((JSON.parse(r.out) as { data: { fixtureDrift?: { recordedSpecHash: string } } }).data.fixtureDrift?.recordedSpecHash).toBe("0000000000000000");
  }, 120_000);

  it("warns in human output when the recorded spec hash drifted", async () => {
    const r = await run(journey("rec-drift-human", { file: recordedFile, specHash: "0000000000000000" }));
    expect(r.err).toContain("warning: fixtures");
  }, 120_000);

  it("reports no fixtureDrift when the hash still matches", async () => {
    const r = await run(journey("rec-nodrift", { file: recordedFile, specHash: await currentHash() }), ["--json"]);
    expect((JSON.parse(r.out) as { data: { fixtureDrift?: unknown } }).data.fixtureDrift).toBeUndefined();
  }, 120_000);
});
