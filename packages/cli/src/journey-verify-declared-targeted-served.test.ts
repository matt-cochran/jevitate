import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Command } from "commander";
import { ProfileManager } from "@jevitate/daemon";
import { FsJourneyStore, type Journey, type JourneyTargetedProofPlan } from "@jevitate/journey";
import { PlaywrightBrowserPort } from "@jevitate/playwright";
import { buildProgram } from "./program.js";
import { verifyExitCode } from "./journey-verify.js";
import { useSkippingTime } from "../../explore/src/testkit.js";

// #304: Node and page time skip idle waits; assertions unchanged.
useSkippingTime({ per: "all" });

/**
 * #616 part B — a DECLARED targeted-proof plan lifts the automatic #609 relaxation bound so a late
 * end-state check sitting behind five earlier paired thread defenses can still be proven, as long as
 * a human reviewed the earlier relaxations. Without a plan the automatic proof stops at the bound
 * (`relaxation bound 4 reached`) and the report suggests exactly the plan to declare.
 */

const page = `<!doctype html><html><head><title>Threads</title></head><body><main>
  <h1>Threads</h1>
  <label>Thread <select aria-label="Thread">
    <option value="thread-001">thread-001</option>
    <option value="thread-002">thread-002</option>
    <option value="thread-003">thread-003</option>
  </select></label>
  <p id="status">thread-001</p>
  <div id="view" data-threadid="">none</div>
  <script>
    const sel = document.querySelector("select");
    sel.addEventListener("change", () => { document.getElementById("status").textContent = sel.value; });
  </script>
</main></body></html>`;

let server: Server;
let origin: string;
let dir: string;
let submissions = 0;

/** Five earlier paired defenses after the select (steps 3..7), then the late end-state (end-state:0). */
function threadJourney(id: string, targetedProofs?: readonly JourneyTargetedProofPlan[]): Journey {
  return {
    metadata: {
      id,
      name: "Open a thread",
      promoted: false,
      params: ["threadId"],
      ...(targetedProofs === undefined ? {} : { targetedProofs: [...targetedProofs] }),
      createdAtIso: "2026-10-19T00:00:00.000Z",
      endState: [{ kind: "page", assertion: { kind: "valueEquals", target: { label: "Thread" }, value: { var: "threadId" } } }],
    },
    recording: {
      version: "1",
      site: origin,
      pages: [
        {
          url: "/threads",
          steps: [
            { step: { kind: "navigate", url: "/threads", expect: { kind: "visible", target: { role: "heading", name: "Threads" } } } },
            {
              variableName: "threadId",
              step: { kind: "select", target: { label: "Thread" }, value: { var: "threadId" }, expect: { kind: "valueEquals", target: { label: "Thread" }, value: { var: "threadId" } } },
            },
            ...[3, 4, 5, 6, 7].map(() => ({ step: { kind: "assert" as const, check: { kind: "textIncludes" as const, target: { css: "#status" }, text: "${threadId}" } } })),
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

interface Assertion {
  site: string;
  verdict: string;
  provedBy?: string;
  declaredProof?: true;
  relaxedSites?: string[];
  targetedRefusal?: string;
}

interface Suggestion {
  check: string;
  mustFailWhen: string;
  relax: string[];
}

interface Report {
  verdict: string;
  assertions: Assertion[];
  suggestedTargetedProofs?: Suggestion[];
  summary: Record<string, number>;
}

async function verify(j: Journey): Promise<{ out: string; exitCode: number | undefined; report: Report }> {
  const journeysDir = join(dir, j.metadata.id);
  await new FsJourneyStore(journeysDir).put(j);
  const r = await cli(journeysDir, ["journey", "verify", j.metadata.id, "--mutate", "--param", "threadId=thread-001", "--json"]);
  return { out: r.out, exitCode: r.exitCode, report: (JSON.parse(r.out) as { data: Report }).data };
}

const assertion = (r: Report, site: string): Assertion | undefined => r.assertions.find((a) => a.site === site);

const FULL_RELAX = ["step:3", "step:4", "step:5", "step:6", "step:7"] as const;

let bound: { out: string; exitCode: number | undefined; report: Report };
let declared: { out: string; exitCode: number | undefined; report: Report };
let omitted: { out: string; exitCode: number | undefined; report: Report };

beforeAll(async () => {
  server = createServer((req, res) => {
    if (req.method === "POST") submissions += 1;
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(page);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  dir = await mkdtemp(join(tmpdir(), "jevitate-verify-declared-targeted-"));
  bound = await verify(threadJourney("bound"));
  declared = await verify(threadJourney("declared", [{ check: "end-state:0", mustFailWhen: "swap-param:threadId", relax: [...FULL_RELAX] }]));
  omitted = await verify(threadJourney("omitted", [{ check: "end-state:0", mustFailWhen: "swap-param:threadId", relax: ["step:3", "step:4", "step:5", "step:6"] }]));
}, 600_000);

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await rm(dir, { recursive: true, force: true });
});

describe("journey verify --mutate declared targeted proof (#616, served)", () => {
  it("without a plan, the late end-state stays a cascade at the relaxation bound", () => {
    expect(assertion(bound.report, "end-state:0")?.targetedRefusal).toBe("relaxation bound 4 reached");
  });

  it("without a plan, the report suggests the declared plan that would reach the end-state", () => {
    expect(bound.report.suggestedTargetedProofs).toEqual([{ check: "end-state:0", mustFailWhen: "swap-param:threadId", relax: [...FULL_RELAX] }]);
  });

  it("with that plan declared, the end-state assertion is proven sensitive", () => {
    expect(assertion(declared.report, "end-state:0")?.verdict).toBe("sensitive");
  });

  it("with that plan declared, the proving proof is marked declared", () => {
    expect(assertion(declared.report, "end-state:0")?.declaredProof).toBe(true);
  });

  it("with that plan declared, the end-state names the declared relax list", () => {
    expect(assertion(declared.report, "end-state:0")?.relaxedSites).toEqual([...FULL_RELAX]);
  });

  it("with that plan declared, the proof verdict is proven (exit code 0)", () => {
    expect(declared.exitCode).toBe(verifyExitCode("proven"));
  });

  it("a declared plan that omits a blocking defense stays a cascade naming the omitted site", () => {
    expect(assertion(omitted.report, "end-state:0")?.targetedRefusal).toBe("step:7 blocked the declared proof (not in relax)");
  });

  it("no mutated, targeted or control replay sends a submission the fixture counts", () => {
    expect(submissions).toBe(0);
  });
});
