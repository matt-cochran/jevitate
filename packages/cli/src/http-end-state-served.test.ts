import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Command } from "commander";
import { ProfileManager } from "@jevitate/daemon";
import { FsJourneyStore, lintJourney, type Journey } from "@jevitate/journey";
import { PlaywrightBrowserPort } from "@jevitate/playwright";
import { buildProgram } from "./program.js";
import { useSkippingTime } from "../../explore/src/testkit.js";

useSkippingTime({ per: "all" });

/**
 * #543, end to end on a split-origin app: the UI (localhost) POSTs a password-reset request to its
 * API (127.0.0.1, another port), which "sends" the mail by POSTing it to a dev outbox on a THIRD
 * origin. The page says "Request sent" whatever happens (the optimistic UI that makes a page check
 * useless). The Journey proves the write with an `http` end-state check over the outbox, and its
 * recorded fixtures empty the outbox before every replay — so `journey run` passes and
 * `journey verify --mutate` shows skipping or blocking the write breaks exactly that check.
 */

let ui: Server;
let api: Server;
let outbox: Server;
let uiOrigin: string;
let apiOrigin: string;
let outboxOrigin: string;
let dir: string;
let mail: string[] = [];
let clears = 0;

const listen = async (server: Server, host: string): Promise<string> => {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://${host}:${(server.address() as AddressInfo).port}`;
};

const readBody = (req: import("node:http").IncomingMessage): Promise<string> =>
  new Promise((resolve) => {
    let b = "";
    req.on("data", (c: Buffer) => (b += c.toString("utf8")));
    req.on("end", () => resolve(b));
  });

let runReport: { exitCode: number | undefined; data: { outcome: string } };
let verifyReport: {
  exitCode: number | undefined;
  data: { verdict: string; mutations: { id: string; outcome: string }[]; assertions: { site: string; check: string; verdict: string }[] };
};

function resetJourney(fixtures: { file: string; specHash: string }): Journey {
  return {
    metadata: {
      id: "reset-mail",
      name: "Send a password reset email",
      promoted: false,
      params: [],
      createdAtIso: "2026-10-15T00:00:00.000Z",
      allowedOrigins: [uiOrigin, apiOrigin, outboxOrigin],
      fixtures,
      endState: [
        {
          kind: "http",
          method: "GET",
          url: `${outboxOrigin}/api/v1/messages`,
          json: [{ path: "$.messages[*].Subject", op: "includes", value: "Reset your password" }],
          withinMs: 2_000,
        },
      ],
    },
    recording: {
      version: "1",
      site: uiOrigin,
      pages: [
        {
          url: "/forgot",
          steps: [
            { step: { kind: "navigate", url: "/forgot", expect: { kind: "visible", target: { role: "heading", name: "Forgot password" } } } },
            {
              // An explicit "no claim" expect: the page shows "Request sent" either way.
              step: { kind: "click", target: { role: "button", name: "Send reset link" }, expect: { kind: "count", target: { css: "body" }, min: 0 } },
              delta: { verdict: "relevant-change", why: "sent", changes: [], requests: ["POST /api/reset → 202"], overheadMs: 1 },
            },
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

let journey: Journey;

beforeAll(async () => {
  outbox = createServer((req, res) => {
    const path = (req.url ?? "").split("?")[0];
    if (req.method === "POST" && path === "/api/v1/clear") {
      clears += 1;
      mail = [];
      res.writeHead(200, { "content-type": "application/json" }).end("{}");
    } else if (req.method === "POST" && path === "/api/v1/send") {
      void readBody(req).then((subject) => {
        mail.push(subject);
        res.writeHead(201, { "content-type": "application/json" }).end("{}");
      });
    } else if (req.method === "GET" && path === "/api/v1/messages") {
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ total: mail.length, messages: mail.map((Subject) => ({ Subject })) }));
    } else {
      res.writeHead(404).end();
    }
  });
  outboxOrigin = await listen(outbox, "127.0.0.1");
  api = createServer((req, res) => {
    if (req.method === "POST" && req.url === "/api/reset") {
      // The API "sends" the email: it lands in the dev outbox on another origin.
      void fetch(`${outboxOrigin}/api/v1/send`, { method: "POST", body: "Reset your password" }).then(() => {
        res.writeHead(202, { "access-control-allow-origin": "*", "content-type": "application/json" }).end("{}");
      });
      return;
    }
    res.writeHead(404, { "access-control-allow-origin": "*" }).end();
  });
  apiOrigin = await listen(api, "127.0.0.1");
  ui = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(`<!doctype html><html><head><title>Forgot</title></head><body><main>
  <h1>Forgot password</h1>
  <p role="status" id="s"></p>
  <button type="button" id="send">Send reset link</button>
  <script>
    document.getElementById("send").addEventListener("click", async () => {
      document.getElementById("s").textContent = "Request sent";
      try { await fetch(${JSON.stringify(`${apiOrigin}/api/reset`)}, { method: "POST", headers: { "content-type": "text/plain" }, body: "user@example.test" }); } catch { /* aborted */ }
    });
  </script>
</main></body></html>`);
  });
  uiOrigin = await listen(ui, "localhost");
  dir = await mkdtemp(join(tmpdir(), "jev-http-end-state-"));

  const fixturesFile = join(dir, "reset-outbox.json");
  await writeFile(fixturesFile, JSON.stringify({ setup: [{ method: "POST", url: `${outboxOrigin}/api/v1/clear` }] }));
  const { currentSpecHash } = await import("./journey-fixtures.js");
  journey = resetJourney({ file: fixturesFile, specHash: currentSpecHash(fixturesFile, { allowlist: [uiOrigin, apiOrigin, outboxOrigin], baseUrl: uiOrigin }) });
  const journeysDir = join(dir, "journeys");
  await new FsJourneyStore(journeysDir).put(journey);

  // A mail left over from an earlier run: the recorded fixtures must clear it before every replay.
  mail = ["Reset your password"];
  const run = await cli(journeysDir, ["journey", "run", "reset-mail", "--json"]);
  runReport = { exitCode: run.exitCode, data: (JSON.parse(run.out) as { data: { outcome: string } }).data };
  clears = 0;
  mail = ["Reset your password"];
  const verify = await cli(journeysDir, ["journey", "verify", "reset-mail", "--mutate", "--json"]);
  verifyReport = { exitCode: verify.exitCode, data: (JSON.parse(verify.out) as { data: typeof verifyReport.data }).data };
}, 300_000);

afterAll(async () => {
  for (const s of [ui, api, outbox]) await new Promise<void>((resolve) => s.close(() => resolve()));
  await rm(dir, { recursive: true, force: true });
});

describe("#543 http end-state check on a split-origin app (served)", () => {
  it("lints with no error and no no-persistence-check (promotable without --accept-weak)", () => {
    expect(lintJourney(journey).filter((f) => f.level === "error" || f.rule === "no-persistence-check")).toEqual([]);
  });

  it("journey run passes", () => {
    expect(runReport.data.outcome).toBe("ok");
  });

  it("verify --mutate proves the Journey (exit 0)", () => {
    expect(verifyReport.exitCode ?? 0).toBe(0);
  });

  it("verify --mutate's verdict is proven", () => {
    expect(verifyReport.data.verdict).toBe("proven");
  });

  it("the http end-state check is sensitive", () => {
    expect(verifyReport.data.assertions.find((a) => a.site === "end-state:0")?.verdict).toBe("sensitive");
  });

  it("skipping the write fails the replay", () => {
    expect(verifyReport.data.mutations.find((m) => m.id === "skip:2")?.outcome).toBe("failed");
  });

  it("blocking the write fails the replay", () => {
    expect(verifyReport.data.mutations.find((m) => m.id === "block-write:2")?.outcome).toBe("failed");
  });

  it("resets the outbox before every replay (the base and each mutation)", () => {
    expect(clears).toBe(1 + verifyReport.data.mutations.length);
  });
});
