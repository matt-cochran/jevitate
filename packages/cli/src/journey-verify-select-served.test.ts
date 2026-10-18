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
 * #579 — `journey verify --mutate --param` proves a parameter a `<select>` reads: a swap-param picks
 * a DIFFERENT enabled live option (never a generated value Playwright would stall on), so a
 * `valueEquals { var: who }` check that cannot tell the options apart is shown vacuous. When every
 * other option is disabled the swap is not applied (`no-alternative`), and a reviewed
 * `mutationValues` entry is the wrong value before any live option.
 */

const page = (onlySuppliedEnabled: boolean): string => `<!doctype html><html><head><title>Pick</title></head><body><main>
  <h1>Pick a team</h1>
  <label>Who <select aria-label="Who">
    <option value="mcpl">mcpl</option>
    <option value="personal"${onlySuppliedEnabled ? " disabled" : ""}>personal</option>
    <option value="ops"${onlySuppliedEnabled ? " disabled" : ""}>ops</option>
  </select></label>
</main></body></html>`;

let server: Server;
let origin: string;
let dir: string;

function pickJourney(id: string, path: "/pick" | "/only", reviewed = false): Journey {
  return {
    metadata: {
      id,
      name: "Pick a team",
      promoted: false,
      params: ["who"],
      ...(reviewed ? { parameters: [{ name: "who", mutationValues: ["ops"] }] } : {}),
      createdAtIso: "2026-10-18T00:00:00.000Z",
    },
    recording: {
      version: "1",
      site: origin,
      pages: [
        {
          url: path,
          steps: [
            { step: { kind: "navigate", url: path, expect: { kind: "visible", target: { role: "heading", name: "Pick a team" } } } },
            {
              variableName: "who",
              step: { kind: "select", target: { label: "Who" }, value: { var: "who" }, expect: { kind: "valueEquals", target: { label: "Who" }, value: { var: "who" } } },
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

interface Report {
  verdict: string;
  mutations: { id: string; outcome: string; source?: string; reason?: string; failedSites: unknown[] }[];
  assertions: { site: string; verdict: string }[];
}

async function verify(j: Journey): Promise<{ out: string; report: Report }> {
  const journeysDir = join(dir, j.metadata.id);
  await new FsJourneyStore(journeysDir).put(j);
  const r = await cli(journeysDir, ["journey", "verify", j.metadata.id, "--mutate", "--param", "who=mcpl", "--json"]);
  return { out: r.out, report: (JSON.parse(r.out) as { data: Report }).data };
}

let pick: { out: string; report: Report };
let only: { out: string; report: Report };
let reviewed: { out: string; report: Report };

beforeAll(async () => {
  server = createServer((req, res) => {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(page(req.url === "/only"));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  dir = await mkdtemp(join(tmpdir(), "jevitate-verify-select-"));
  pick = await verify(pickJourney("pick", "/pick"));
  only = await verify(pickJourney("only", "/only"));
  reviewed = await verify(pickJourney("reviewed", "/pick", true));
}, 600_000);

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await rm(dir, { recursive: true, force: true });
});

const siteVerdict = (r: Report, site: string): string | undefined => r.assertions.find((a) => a.site === site)?.verdict;
const mutation = (r: Report, id: string) => r.mutations.find((m) => m.id === id);

describe("journey verify --mutate proves a select-fed parameter (#579, served)", () => {
  it("on a select with an enabled alternative, the swap proves the check sensitive", () => {
    expect(siteVerdict(pick.report, "step:2")).toBe("sensitive");
  });

  it("on a select with an enabled alternative, the swap fails at the select's own postcondition (never a stall)", () => {
    expect(mutation(pick.report, "swap-param:who")?.failedSites).toContainEqual({ where: "step", step: 2, postcondition: true });
  });

  it("on a select with an enabled alternative, the swap names a live option as its source", () => {
    expect(mutation(pick.report, "swap-param:who")?.source).toBe("option");
  });

  it("plans no truncation for a parameter a select reads", () => {
    expect(pick.report.mutations.map((m) => m.id)).not.toContain("truncate-param:who");
  });

  it("on a select with no enabled alternative, the swap is not applied", () => {
    expect(mutation(only.report, "swap-param:who")?.outcome).toBe("not-applied");
  });

  it("on a select with no enabled alternative, the swap says why (no-alternative)", () => {
    expect(mutation(only.report, "swap-param:who")?.reason).toContain("no-alternative");
  });

  it("on a select with no enabled alternative, the proof is not proven", () => {
    expect(only.report.verdict).not.toBe("proven");
  });

  it("a reviewed mutationValues entry is the swap's source", () => {
    expect(mutation(reviewed.report, "swap-param:who")?.source).toBe("reviewed");
  });

  it("a reviewed swap proves the select check sensitive", () => {
    expect(siteVerdict(reviewed.report, "step:2")).toBe("sensitive");
  });
});
