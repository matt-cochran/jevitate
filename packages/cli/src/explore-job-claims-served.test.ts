import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FakeGenerationGateway, type Answer, type JudgmentPort } from "@jevitate/ai-core";
import { ProfileManager } from "@jevitate/daemon";
import { PlaywrightBrowserPort } from "@jevitate/playwright";
import { jobContentHash } from "./catalog.js";
import { callMcpTool } from "./mcp-cli-bridge.js";
import { buildProgram } from "./program.js";
import { useSkippingTime } from "../../explore/src/testkit.js";

// #304: Node and page time skip idle waits; assertions unchanged.
useSkippingTime({ per: "all" });

/**
 * Run-result contract v1, served end to end in real Chromium: after `explore --job <id> --job-context`
 * the claim verdicts are in the `--json` envelope AND in the saved `<recording>.result.json` (the same
 * fields, from one builder), which MCP `get_mission_result` returns and which the published
 * saved-result schema accepts. Without `--job-context` the saved result carries neither field.
 */

const CONTRACT = fileURLToPath(new URL("../contracts/jevitate-run-result/v1", import.meta.url));

/** Always answers `done` for the run; any other question gets no usable answer. */
class DoneJudge implements JudgmentPort {
  async systemOne(): Promise<Record<string, Answer>> {
    return { action: { kind: "choice", value: "done", confidence: 0.9 } };
  }
}

const STORY = { trigger: "a new colleague joins my team", motivation: "invite them by email", outcome: "work together from their first day" };
const CLAIMS = [
  { id: "invite-pending", statement: "a new invite shows as Pending", check: { version: 1, at: "/", check: "textIncludes:testId=status|Pending" } },
  { id: "invite-accepted", statement: "a new invite shows as Accepted", check: { version: 1, at: "/", check: "textIncludes:testId=status|Accepted" } },
  { id: "one-seat", statement: "an invite uses one free seat" },
];
const approved = (job: Record<string, unknown>) => ({ ...job, approval: { contentHash: jobContentHash(job as never), at: "2026-11-18T00:00:00.000Z" } });

let server: Server;
let origin: string;
let root: string;

interface Run {
  readonly data: any;
  readonly saved: any;
  readonly savedText: string;
  readonly mcp: { isError: boolean; body: any };
}
const runs: Record<"claims" | "noClaims" | "noContext", Run> = {} as never;

async function explore(name: string, jobId: string, extra: readonly string[]): Promise<Run> {
  const out = join(root, name);
  const lines: string[] = [];
  const program = buildProgram({
    profiles: new ProfileManager("/unused"),
    journeysDir: join(root, "journeys"),
    catalogDir: root,
    explore: { judge: new DoneJudge(), gen: new FakeGenerationGateway(), browserPortFactory: () => new PlaywrightBrowserPort(), targetsConfigPath: join(root, "no-targets.json") },
  });
  program.configureOutput({ writeOut: (s) => lines.push(s), writeErr: () => undefined });
  program.exitOverride();
  await program.parseAsync(
    ["explore", "--url", `${origin}/`, "--goal", "see the invite", "--success", "textIncludes:testId=status|Pending", "--job", jobId, ...extra, "--out", out, "--json"],
    { from: "user" },
  );
  process.exitCode = undefined;
  const data = JSON.parse(lines.join("")).data;
  const savedText = readFileSync(data.resultPath, "utf8");
  const mcp = await callMcpTool({ journeysDir: join(root, "journeys"), recordingsDir: out }, "get_mission_result", { id: basename(data.resultPath).slice(0, -".result.json".length) });
  return { data, saved: JSON.parse(savedText), savedText, mcp };
}

beforeAll(async () => {
  server = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/html" }).end(`<!doctype html><html><body><h1>Team</h1><p data-testid="status">Pending</p></body></html>`);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  root = mkdtempSync(join(tmpdir(), "jev-claims-served-"));
  writeFileSync(join(root, "personas.json"), JSON.stringify([{ id: "admin", description: "Runs the team", role: "admin" }]));
  writeFileSync(
    join(root, "jobs.json"),
    JSON.stringify([
      approved({ id: "invite", ...STORY, personas: ["admin"], guidance: { claims: CLAIMS } }),
      approved({ id: "invite-plain", ...STORY, personas: ["admin"] }),
    ]),
  );
  runs.claims = await explore("claims", "invite", ["--job-context"]);
  runs.noClaims = await explore("no-claims", "invite-plain", ["--job-context"]);
  runs.noContext = await explore("no-context", "invite", []);
}, 180_000);
afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  rmSync(root, { recursive: true, force: true });
});

const savedValidator = () => {
  const Ajv = Ajv2020 as unknown as typeof Ajv2020.default;
  return new Ajv({ allErrors: true, strict: false, validateFormats: false }).compile(JSON.parse(readFileSync(join(CONTRACT, "schemas/saved-result.schema.json"), "utf8")));
};

describe("run-result contract v1: claim verdicts in the saved result (served, real Chromium)", () => {
  it("the envelope carries one verdict per claim, decided as the contract says", () => {
    expect(runs.claims.data.claims.map((c: { id: string; verdict: string; basis: string }) => [c.id, c.verdict, c.basis])).toEqual([
      ["invite-pending", "confirmed", "check"],
      ["invite-accepted", "contradicted", "check"],
      ["one-seat", "not_observed", "model"],
    ]);
  });

  it("the saved result has the same claims as the envelope", () => {
    expect(runs.claims.saved.result.claims).toEqual(runs.claims.data.claims);
  });

  it("the saved result has the same jobContext as the envelope", () => {
    expect(runs.claims.saved.result.jobContext).toEqual(runs.claims.data.jobContext);
  });

  it("the saved result's jobContext names the job", () => {
    expect(runs.claims.saved.result.jobContext.job).toBe("invite");
  });

  it("the real saved result validates against the published saved-result schema", () => {
    expect(savedValidator()(runs.claims.saved)).toBe(true);
  });

  it("MCP get_mission_result returns the claims", () => {
    expect(runs.claims.mcp.body.result.claims).toEqual(runs.claims.data.claims);
  });

  it("MCP get_mission_result returns the jobContext", () => {
    expect(runs.claims.mcp.body.result.jobContext).toEqual(runs.claims.data.jobContext);
  });

  it("a job without claims: the saved result has the jobContext", () => {
    expect(runs.noClaims.saved.result.jobContext).toEqual(runs.noClaims.data.jobContext);
  });

  it("a job without claims: the saved result has no claims, as in the envelope", () => {
    expect(["claims" in runs.noClaims.saved.result, "claims" in runs.noClaims.data]).toEqual([false, false]);
  });

  it("a job without claims: the real saved result validates against the published saved-result schema", () => {
    expect(savedValidator()(runs.noClaims.saved)).toBe(true);
  });

  it("without --job-context the saved result has neither field", () => {
    expect(["jobContext" in runs.noContext.saved.result, "claims" in runs.noContext.saved.result]).toEqual([false, false]);
  });

  it("without --job-context the saved file is never rewritten (it is the journal's single write)", () => {
    expect(runs.noContext.savedText).not.toMatch(/"jobContext"|"claims"/);
  });
});
