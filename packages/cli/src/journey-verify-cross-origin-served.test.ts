import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Command } from "commander";
import { ProfileManager } from "@jevitate/daemon";
import { FsJourneyStore, type Journey } from "@jevitate/journey";
import { PlaywrightBrowserPort } from "@jevitate/playwright";
import { buildProgram } from "./program.js";
import { useSkippingTime } from "../../explore/src/testkit.js";

useSkippingTime({ per: "all" });

/**
 * #542 — `journey verify --mutate` on a split-origin app: the UI is served from one origin and its
 * Save POSTs to ANOTHER (the API). block-write can only abort that write when the API's origin is in
 * the replay's allowlist: via `--allow`, or via the Journey's `metadata.allowedOrigins`.
 */

let ui: Server;
let api: Server;
let uiOrigin: string;
let apiOrigin: string;
let dir: string;

// The split-origin shape of the issue: UI on `localhost`, API on `127.0.0.1` (different hosts AND ports).
const listen = async (server: Server, host: string): Promise<string> => {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://${host}:${(server.address() as AddressInfo).port}`;
};

beforeAll(async () => {
  api = createServer((req, res) => {
    // text/plain keeps the cross-origin POST a simple request (no preflight).
    res.writeHead(200, { "access-control-allow-origin": "*", "content-type": "application/json" }).end(req.method === "POST" ? "{}" : "{}");
  });
  apiOrigin = await listen(api, "127.0.0.1");
  ui = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(`<!doctype html><html><head><title>Editor</title></head><body><main>
  <h1>Editor</h1>
  <label for="t">Text</label> <input id="t">
  <button type="button" id="save">Save</button>
  <script>
    document.getElementById("save").addEventListener("click", async () => {
      try { await fetch(${JSON.stringify(`${apiOrigin}/api/save`)}, { method: "POST", headers: { "content-type": "text/plain" }, body: document.getElementById("t").value }); } catch { /* aborted */ }
    });
  </script>
</main></body></html>`);
  });
  uiOrigin = await listen(ui, "localhost");
  dir = await mkdtemp(join(tmpdir(), "jevitate-verify-xo-"));
});
afterAll(async () => {
  await new Promise<void>((resolve) => ui.close(() => resolve()));
  await new Promise<void>((resolve) => api.close(() => resolve()));
  await rm(dir, { recursive: true, force: true });
});

const saveButton = { role: "button" as const, name: "Save" };

function splitOriginJourney(id: string, allowedOrigins?: string[]): Journey {
  return {
    metadata: { id, name: "Save text", promoted: false, params: [], createdAtIso: "2026-10-15T00:00:00.000Z", ...(allowedOrigins === undefined ? {} : { allowedOrigins }) },
    recording: {
      version: "1",
      site: uiOrigin,
      pages: [
        {
          url: "/editor",
          steps: [
            { step: { kind: "navigate", url: "/editor", expect: { kind: "visible", target: { role: "heading", name: "Editor" } } } },
            { step: { kind: "fill", target: { label: "Text" }, value: { redacted: false, value: "hello" }, expect: { kind: "visible", target: { label: "Text" } } } },
            {
              step: { kind: "click", target: saveButton, expect: { kind: "visible", target: saveButton } },
              delta: { verdict: "relevant-change", why: "saved", changes: [], requests: ["POST /api/save → 200"], overheadMs: 1 },
            },
          ],
        },
      ],
    },
  };
}

async function verify(j: Journey, extra: string[] = []): Promise<{ id: string; outcome: string; blocked: string[] | undefined; reason?: string }> {
  const journeysDir = join(dir, j.metadata.id);
  await new FsJourneyStore(journeysDir).put(j);
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
  await program.parseAsync(["journey", "verify", j.metadata.id, "--mutate", "--json", ...extra], { from: "user" });
  process.exitCode = undefined;
  const report = (JSON.parse(out.join("")) as { data: { mutations: { id: string; outcome: string; blockedWrites?: string[]; reason?: string }[] } }).data;
  const m = report.mutations.find((x) => x.id === "block-write:3")!;
  return { id: m.id, outcome: m.outcome, blocked: m.blockedWrites, ...(m.reason === undefined ? {} : { reason: m.reason }) };
}

describe("journey verify --mutate on a split-origin app (#542, served)", () => {
  it("without the API origin allowed, block-write is not-applied", async () => {
    expect((await verify(splitOriginJourney("xo-none"))).outcome).toBe("not-applied");
  }, 180_000);

  it("--allow <api origin> lets block-write abort the step's cross-origin write", async () => {
    expect((await verify(splitOriginJourney("xo-flag"), ["--allow", apiOrigin])).blocked).toEqual(["POST /api/save"]);
  }, 180_000);

  it("--allow <api origin> makes block-write apply (not not-applied)", async () => {
    expect((await verify(splitOriginJourney("xo-flag-applied"), ["--allow", apiOrigin])).outcome).not.toBe("not-applied");
  }, 180_000);

  it("metadata.allowedOrigins lets block-write abort the step's cross-origin write without a flag", async () => {
    expect((await verify(splitOriginJourney("xo-meta", [uiOrigin, apiOrigin]))).blocked).toEqual(["POST /api/save"]);
  }, 180_000);
});
