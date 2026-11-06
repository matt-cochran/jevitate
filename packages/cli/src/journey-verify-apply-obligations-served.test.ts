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

const REPLY = "Improved reply";
let server: Server;
let origin: string;
let dir: string;

function applyJourney(id: string): Journey {
  const check = { kind: "valueEquals" as const, target: { label: "Applied" }, value: { var: "reply" } };
  return {
    metadata: {
      id, name: "Apply a reply", promoted: false, params: ["reply"], createdAtIso: "2026-11-06T00:00:00Z",
      endState: [{ kind: "page", assertion: check }],
    },
    recording: { version: "1", site: origin, pages: [{ url: `/${id}`, steps: [
      { step: { kind: "navigate", url: `/${id}`, expect: { kind: "visible", target: { role: "heading", name: "Apply" } } } },
      { step: { kind: "fill", target: { label: "Reply" }, value: { var: "reply" }, expect: { kind: "valueEquals", target: { label: "Reply" }, value: { var: "reply" } } } },
      { step: { kind: "click", target: { role: "button", name: "Apply" }, expect: check } },
    ] }] },
  };
}

interface Obligation {
  kind: string;
  verdict: string;
  provedBy?: string;
  relaxedSites?: string[];
}
interface Report {
  verdict: string;
  assertions: { site: string; verdict: string; obligations?: Obligation[] }[];
  mutations: { id: string; outcome: string; targeted?: { site: string; relaxedSites: string[]; control?: string; refused?: string }[] }[];
}

async function verify(id: string): Promise<Report> {
  const journeysDir = join(dir, id);
  await new FsJourneyStore(journeysDir).put(applyJourney(id));
  const out: string[] = [];
  const program = buildProgram({
    profiles: new ProfileManager("/unused"), journeysDir, dbPath: join(dir, "unused.sqlite"),
    explore: { browserPortFactory: () => new PlaywrightBrowserPort() },
  });
  program.configureOutput({ writeOut: (s) => out.push(s), writeErr: () => undefined });
  const override = (c: Command): void => { c.exitOverride(); c.commands.forEach(override); };
  override(program);
  process.exitCode = undefined;
  await program.parseAsync(["journey", "verify", id, "--mutate", "--param", `reply=${REPLY}`, "--json"], { from: "user" });
  process.exitCode = undefined;
  return (JSON.parse(out.join("")) as { data: Report }).data;
}

let echo: Report;
let constant: Report;
beforeAll(async () => {
  server = createServer((req, res) => {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(`<!doctype html><html><body>
      <h1>Apply</h1><label>Reply <input aria-label="Reply"></label>
      <div role="dialog"><button type="button">Apply</button></div><label>Applied <input aria-label="Applied" readonly></label>
      <script>document.querySelector('button').onclick = () => {
        document.querySelector('[aria-label="Applied"]').value = ${req.url === "/constant" ? JSON.stringify(REPLY) : "document.querySelector('[aria-label=Reply]').value"};
        document.querySelector('[role=dialog]').remove();
      };</script></body></html>`);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  dir = await mkdtemp(join(tmpdir(), "jevitate-apply-obligations-"));
  echo = await verify("echo");
  constant = await verify("constant");
}, 600_000);
afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await rm(dir, { recursive: true, force: true });
});

describe("Apply closes its own dialog and requires both data and action sensitivity (served)", () => {
  it("proves an honest Apply through independent data and action witnesses", () => {
    expect(echo.verdict).toBe("proven");
    for (const site of ["step:3", "end-state:0"]) {
      expect(echo.assertions.find((a) => a.site === site)?.obligations).toEqual([
        expect.objectContaining({ kind: "data", verdict: "sensitive" }),
        { kind: "action", verdict: "sensitive", provedBy: "skip:3" },
      ]);
    }
    expect(echo.mutations.some((m) => m.id.startsWith("block-write:"))).toBe(false);
    // The final data proof must pass the removed Apply control with its original own check
    // waived, then fail the still-exact final value check with a passing unmutated control.
    for (const id of ["stale-value:2", "swap-param:reply", "truncate-param:reply"]) {
      expect(echo.mutations.find((m) => m.id === id)?.targeted?.find((t) => t.site === "end-state:0")).toEqual(expect.objectContaining({
        relaxedSites: ["step:3"], outcome: "failed", control: "passed",
      }));
    }
  });

  it("rejects a constant Apply despite a sensitive skip and identical own/final param checks", () => {
    expect(constant.verdict).toBe("insensitive");
    for (const site of ["step:3", "end-state:0"]) {
      expect(constant.assertions.find((a) => a.site === site)).toEqual(expect.objectContaining({
        verdict: "insensitive", obligations: [
          { kind: "data", verdict: "insensitive" },
          { kind: "action", verdict: "sensitive", provedBy: "skip:3" },
        ],
      }));
    }
  });
});
