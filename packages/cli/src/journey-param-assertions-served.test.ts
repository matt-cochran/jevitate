import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Command } from "commander";
import { ProfileManager } from "@jevitate/daemon";
import { FsJourneyStore, type Journey } from "@jevitate/journey";
import type { RecordedStep } from "@jevitate/recording";
import { PlaywrightBrowserPort } from "@jevitate/playwright";
import { buildProgram } from "./program.js";
import { useSkippingTime } from "../../explore/src/testkit.js";

// #304: Node and page time skip idle waits; assertions unchanged.
useSkippingTime({ per: "all" });

/**
 * #562/#565 — an assertion's expected text or value may name a run binding: a `--param` (in a step's
 * `expect` and in a page end-state check) or an earlier `extract` step's output. Judged on a real
 * served page by `journey run`.
 */

/** When set, the page lists this address instead of the one typed (the end state must notice). */
let shownInstead: string | undefined;
/** A fresh invite code per page load: no literal in a Journey could know it. */
let codes = 0;

const page = (): string => `<!doctype html><html><head><title>Invite</title></head><body><main>
  <h1>Invite</h1>
  <label>Email <input aria-label="Email" value=""></label>
  <button type="button" id="invite">Invite</button>
  <ul data-testid="list"></ul>
  <p>Code: <span data-testid="code">INV-${(codes += 1)}-QX</span></p>
  <button type="button" id="copy">Copy code</button>
  <label>Confirm <input aria-label="Confirm" value=""></label>
  <script>
    const shownInstead = ${JSON.stringify(shownInstead ?? null)};
    document.getElementById('invite').onclick = () => {
      const li = document.createElement('li');
      li.textContent = 'Invited ' + (shownInstead ?? document.querySelector('[aria-label=Email]').value);
      document.querySelector('[data-testid=list]').appendChild(li);
    };
    document.getElementById('copy').onclick = () => {
      document.querySelector('[aria-label=Confirm]').value = document.querySelector('[data-testid=code]').textContent;
    };
  </script>
</main></body></html>`;

let server: Server;
let origin: string;
let dir: string;
beforeAll(async () => {
  server = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(page());
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  dir = await mkdtemp(join(tmpdir(), "jevitate-param-assert-"));
});
afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await rm(dir, { recursive: true, force: true });
});

const open: RecordedStep = { step: { kind: "navigate", url: "/invite", expect: { kind: "visible", target: { role: "heading", name: "Invite" } } } };

/** Fills Email from `--param email`, checks the field holds exactly it, invites, and lists it. */
function inviteJourney(id: string): Journey {
  return {
    metadata: {
      id,
      name: "Invite by email",
      promoted: false,
      params: ["email"],
      createdAtIso: "2026-10-17T00:00:00.000Z",
      endState: [{ kind: "page", assertion: { kind: "textIncludes", target: { testId: "list" }, text: "Invited ${email}" } }],
    },
    recording: {
      version: "1",
      site: origin,
      pages: [
        {
          url: "/invite",
          steps: [
            open,
            {
              variableName: "email",
              step: { kind: "fill", target: { label: "Email" }, value: { var: "email" }, expect: { kind: "valueEquals", target: { label: "Email" }, value: { var: "email" } } },
            },
            { step: { kind: "click", target: { role: "button", name: "Invite" }, expect: { kind: "count", target: { css: "li" }, min: 1 } } },
          ],
        },
      ],
    },
  };
}

/** Extracts the page's invite code, copies it, and expects the Confirm field to hold exactly it. */
function codeJourney(id: string): Journey {
  return {
    metadata: { id, name: "Copy the invite code", promoted: false, params: [], createdAtIso: "2026-10-17T00:00:00.000Z" },
    recording: {
      version: "1",
      site: origin,
      pages: [
        {
          url: "/invite",
          steps: [
            open,
            { step: { kind: "extract", target: { testId: "code" }, as: "code", expect: { kind: "visible", target: { testId: "code" } } } },
            { step: { kind: "click", target: { role: "button", name: "Copy code" }, expect: { kind: "valueEquals", target: { label: "Confirm" }, value: { var: "code" } } } },
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

async function run(j: Journey, params: string[] = []): Promise<{ outcome: string; reason?: string }> {
  const journeysDir = join(dir, j.metadata.id);
  await new FsJourneyStore(journeysDir).put(j);
  const r = await cli(journeysDir, ["journey", "run", j.metadata.id, ...params.flatMap((p) => ["--param", p]), "--json"]);
  return (JSON.parse(r.out) as { data: { outcome: string; reason?: string } }).data;
}

describe("journey run resolves parameter-relative assertions (#562/#565, served)", () => {
  it("a param-bound step expect and end-state text hold for the supplied value", async () => {
    shownInstead = undefined;
    const r = await run(inviteJourney("param-holds"), ["email=a@example.test"]);
    expect(r.outcome).toBe("ok");
  }, 120_000);

  it("an end state naming the param fails when the page shows a different value", async () => {
    shownInstead = "someone-else@example.test";
    const r = await run(inviteJourney("param-differs"), ["email=a@example.test"]);
    shownInstead = undefined;
    expect(r.outcome).toBe("quarantined");
  }, 120_000);

  it("an extract output used in a later step's expect holds", async () => {
    const r = await run(codeJourney("extract-ref"));
    expect(r.outcome).toBe("ok");
  }, 120_000);
});
