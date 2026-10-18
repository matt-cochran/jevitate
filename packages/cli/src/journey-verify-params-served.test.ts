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

// #304: Node and page time skip idle waits; assertions unchanged.
useSkippingTime({ per: "all" });

/**
 * #565 — `journey verify --mutate --param` proves PARAMETER-RELATIVE checks: the composer must hold
 * exactly the supplied reply (`valueEquals { var: reply }`) and the preview must show it
 * (`textIncludes "Reply: ${reply}"`). On a page that echoes the reply, a swapped or truncated reply
 * breaks both (proven); on a page that always previews a constant, the end state still passes
 * (insensitive). The preview also shows the secret API token: the proof never carries it.
 */

const TOKEN = "tok-SEKRET-565";
const CONSTANT = "Fixed reply";

const page = (echo: boolean): string => `<!doctype html><html><head><title>Compose</title></head><body><main>
  <h1>Compose</h1>
  <label>API token <input type="password" aria-label="API token"></label>
  <label>Reply <input aria-label="Reply"></label>
  <button type="button" id="preview">Preview</button>
  <p class="preview" data-testid="preview"></p>
  <script>
    document.getElementById("preview").onclick = () => {
      const reply = ${echo ? 'document.querySelector("[aria-label=Reply]").value' : JSON.stringify(CONSTANT)};
      const token = document.querySelector("[aria-label='API token']").value;
      document.querySelector("[data-testid=preview]").textContent = "Reply: " + reply + " · by " + token;
    };
  </script>
</main></body></html>`;

let server: Server;
let origin: string;
let dir: string;

function composeJourney(id: string, path: "/echo" | "/constant"): Journey {
  return {
    metadata: {
      id,
      name: "Compose a reply",
      promoted: false,
      params: ["reply", "apiToken"],
      parameters: [{ name: "apiToken", secret: true }],
      createdAtIso: "2026-10-17T00:00:00.000Z",
      endState: [{ kind: "page", assertion: { kind: "textIncludes", target: { testId: "preview" }, text: "Reply: ${reply}" } }],
    },
    recording: {
      version: "1",
      site: origin,
      pages: [
        {
          url: path,
          steps: [
            { step: { kind: "navigate", url: path, expect: { kind: "visible", target: { role: "heading", name: "Compose" } } } },
            {
              variableName: "apiToken",
              step: { kind: "fill", target: { label: "API token" }, value: { var: "apiToken" }, expect: { kind: "count", target: { label: "API token" }, min: 0 } },
            },
            {
              variableName: "reply",
              step: { kind: "fill", target: { label: "Reply" }, value: { var: "reply" }, expect: { kind: "valueEquals", target: { label: "Reply" }, value: { var: "reply" } } },
            },
            { step: { kind: "click", target: { role: "button", name: "Preview" }, expect: { kind: "count", target: { css: "p.preview" }, min: 1 } } },
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

interface Report {
  verdict: string;
  mutations: { id: string; outcome: string; relaxed?: { failedSites: unknown[] } }[];
  assertions: { site: string; verdict: string }[];
}

async function verify(j: Journey, reply: string): Promise<{ out: string; report: Report }> {
  const journeysDir = join(dir, j.metadata.id);
  await new FsJourneyStore(journeysDir).put(j);
  const r = await cli(journeysDir, ["journey", "verify", j.metadata.id, "--mutate", "--param", `reply=${reply}`, "--param", `apiToken=${TOKEN}`, "--json"]);
  return { out: r.out, report: (JSON.parse(r.out) as { data: Report }).data };
}

let echo: { out: string; report: Report };
let constant: { out: string; report: Report };

beforeAll(async () => {
  server = createServer((req, res) => {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(page(req.url !== "/constant"));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  dir = await mkdtemp(join(tmpdir(), "jevitate-verify-params-"));
  echo = await verify(composeJourney("echo", "/echo"), "Thanks, see you Monday");
  constant = await verify(composeJourney("constant", "/constant"), CONSTANT);
}, 600_000);

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await rm(dir, { recursive: true, force: true });
});

const siteVerdict = (r: Report, site: string): string | undefined => r.assertions.find((a) => a.site === site)?.verdict;
const relaxedSites = (r: Report, id: string): unknown[] => r.mutations.find((m) => m.id === id)?.relaxed?.failedSites ?? [];

describe("journey verify --mutate proves parameter-relative checks (#565, served)", () => {
  it("on a page that echoes the reply, the proof is proven", () => {
    expect(echo.report.verdict).toBe("proven");
  });

  it("on a page that echoes the reply, a swapped reply breaks the preview check", () => {
    expect(relaxedSites(echo.report, "swap-param:reply")).toContainEqual({ where: "end-state", index: 0 });
  });

  it("on a page that echoes the reply, a truncated reply breaks the preview check", () => {
    expect(relaxedSites(echo.report, "truncate-param:reply")).toContainEqual({ where: "end-state", index: 0 });
  });

  it("on a page that echoes the reply, the composer's exact-text check is sensitive", () => {
    expect(siteVerdict(echo.report, "step:3")).toBe("sensitive");
  });

  it("on a page that previews a constant, the preview check is insensitive", () => {
    expect(siteVerdict(constant.report, "end-state:0")).toBe("insensitive");
  });

  it("on a page that previews a constant, the proof is not proven", () => {
    expect(constant.report.verdict).toBe("insensitive");
  });

  it("the proof never carries the secret parameter's value", () => {
    expect(`${echo.out}\n${constant.out}`).not.toContain(TOKEN);
  });
});
