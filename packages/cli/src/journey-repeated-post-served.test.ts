import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Command } from "commander";
import { ProfileManager } from "@jevitate/daemon";
import { FsJourneyStore, type Journey, type JourneyNetworkCheck } from "@jevitate/journey";
import type { RecordedStep } from "@jevitate/recording";
import { PlaywrightBrowserPort } from "@jevitate/playwright";
import { buildProgram } from "./program.js";

/**
 * #526 — a step's `responseStatus` check is judged on the requests THAT step sent, and their
 * responses: a later step writing the same endpoint (a cross-origin API, CORS) or navigating never
 * changes it. Before the fix the step's request window stayed open for the whole replay (a later
 * Save's response was counted for an earlier Save), and the replay moved on before the step's write
 * was answered, so a following navigation abandoned it: "still awaiting a response" after a fast 2xx.
 *
 * Real clock: the API answers after a short real delay (a server holding a request), which is
 * what lets the next step overtake the write.
 */

const API_DELAY_MS = 90;

let app: Server;
let api: Server;
let appOrigin: string;
let apiOrigin: string;
let dir: string;
/** Names the API answers 500 for (the default is 200). */
const failFor = new Set<string>();

const page = (apiAt: string): string => `<!doctype html><html><head><title>Profile</title></head><body><main>
  <h1>Profile</h1>
  <label>Name <input id="name"></label>
  <button type="button" onclick="fetch('${apiAt}/api/x', {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({name: document.getElementById('name').value})})">Save</button>
</main></body></html>`;

beforeAll(async () => {
  api = createServer((req, res) => {
    const cors = {
      "access-control-allow-origin": appOrigin,
      "access-control-allow-methods": "POST, OPTIONS",
      "access-control-allow-headers": "content-type",
    };
    if (req.method === "OPTIONS") return void res.writeHead(204, cors).end();
    let body = "";
    req.on("data", (c: Buffer) => (body += c.toString()));
    req.on("end", () => {
      const name = (JSON.parse(body || "{}") as { name?: string }).name ?? "";
      const status = failFor.has(name) ? 500 : 200;
      setTimeout(() => res.writeHead(status, { ...cors, "content-type": "application/json" }).end('{"ok":true}'), API_DELAY_MS);
    });
  });
  await new Promise<void>((resolve) => api.listen(0, "127.0.0.1", resolve));
  // A different origin from the app (localhost vs 127.0.0.1): the POST is cross-origin, with a preflight.
  apiOrigin = `http://localhost:${(api.address() as AddressInfo).port}`;
  app = createServer((_req, res) => res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(page(apiOrigin)));
  await new Promise<void>((resolve) => app.listen(0, "127.0.0.1", resolve));
  appOrigin = `http://127.0.0.1:${(app.address() as AddressInfo).port}`;
  dir = await mkdtemp(join(tmpdir(), "jevitate-526-"));
});
afterAll(async () => {
  await new Promise<void>((resolve) => app.close(() => resolve()));
  await new Promise<void>((resolve) => api.close(() => resolve()));
  await rm(dir, { recursive: true, force: true });
});

const SAVE_2XX: JourneyNetworkCheck[] = [{ kind: "responseStatus", method: "POST", pathGlob: "/api/x", status: { class: 2 } }];
const nav: RecordedStep = { step: { kind: "navigate", url: "/profile", expect: { kind: "visible", target: { role: "heading", name: "Profile" } } } };
const fill = (value: string): RecordedStep => ({
  step: { kind: "fill", target: { label: "Name" }, value: { redacted: false, value }, expect: { kind: "visible", target: { label: "Name" } } },
});
// The Save's postcondition holds at once (the button stays): the next step starts while the POST is in flight.
const click: RecordedStep = { step: { kind: "click", target: { role: "button", name: "Save" }, expect: { kind: "visible", target: { role: "button", name: "Save" } } } };
const save: RecordedStep = { ...click, expectRequests: SAVE_2XX };

function journey(id: string, steps: RecordedStep[]): Journey {
  return {
    metadata: { id, name: "Save profile", promoted: false, params: [], createdAtIso: "2026-10-15T00:00:00.000Z" },
    recording: { version: "1", site: appOrigin, pages: [{ url: "/profile", steps }] },
  };
}

async function run(id: string, steps: RecordedStep[]): Promise<{ exitCode: number | undefined; data: { outcome: string; reason?: string } }> {
  const journeysDir = join(dir, id);
  await new FsJourneyStore(journeysDir).put(journey(id, steps));
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
  await program.parseAsync(["journey", "run", id, "--json"], { from: "user" });
  const exitCode = process.exitCode;
  process.exitCode = undefined;
  return { exitCode, data: (JSON.parse(out.join("")) as { data: { outcome: string; reason?: string } }).data };
}

describe("[realtime] #526: every matching response is attributed to the step that sent it (cross-origin API, served)", () => {
  it("two Saves to the same cross-origin endpoint on one page: both steps' 2xx checks pass", async () => {
    const r = await run("two-saves", [nav, fill("Ada"), save, fill("Grace"), save]);
    expect(r.data.reason).toBeUndefined();
    expect(r.data.outcome).toBe("ok");
    expect(r.exitCode ?? 0).toBe(0);
  }, 120_000);

  it("Save, then a same-URL navigate: the Save's 2xx is not lost to the navigation", async () => {
    const r = await run("save-nav", [nav, fill("Ada"), save, nav]);
    expect(r.data.reason).toBeUndefined();
    expect(r.data.outcome).toBe("ok");
  }, 120_000);

  it("Save, a same-URL navigate, then Save again: both steps' 2xx checks pass", async () => {
    const r = await run("save-nav-save", [nav, fill("Ada"), save, nav, fill("Grace"), save]);
    expect(r.data.reason).toBeUndefined();
    expect(r.data.outcome).toBe("ok");
  }, 120_000);

  it("a later step's request to the same endpoint is never counted for an earlier step", async () => {
    failFor.add("Linus");
    try {
      // The first Save (2xx) expects 2xx; the later, unchecked Save gets a 500 — it is not the first step's.
      const r = await run("later-write-not-counted", [nav, fill("Ada"), save, fill("Linus"), click]);
      expect(r.data.reason).toBeUndefined();
      expect(r.data.outcome).toBe("ok");
      // The same 500 on a CHECKED Save fails that step, and only that step.
      const bad = await run("later-write-fails-its-own-step", [nav, fill("Ada"), save, fill("Linus"), save]);
      expect(bad.data.outcome).toBe("quarantined");
      expect(bad.data.reason).toMatch(/step 5 \(click button "Save"\): responseStatus:POST \/api\/x=2xx — expected 2xx, got 500 for 1 matching request\(s\)$/);
      expect(bad.data.reason).not.toMatch(/step 3/);
    } finally {
      failFor.delete("Linus");
    }
  }, 120_000);
});
