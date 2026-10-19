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
 * #609 part B — a targeted proof reaches an assertion that only looks like a `cascade` because an
 * EARLIER intentional defense caught the paired option-swap first. On this page the select feeds a
 * `<div data-threadid>` through an Open click: the click's own `attr` check catches the swapped
 * option, hiding the end-state `valueEquals`; the targeted proof relaxes that click postcondition to
 * prove the end-state too. When the blocking check is a static assert NOT paired with the mutation,
 * no relaxation is defensible and the end-state keeps a refusal.
 */

const page = `<!doctype html><html><head><title>Threads</title></head><body><main>
  <h1>Threads</h1>
  <label>Thread <select aria-label="Thread">
    <option value="thread-001">thread-001</option>
    <option value="thread-002">thread-002</option>
    <option value="thread-003">thread-003</option>
  </select></label>
  <button type="button" id="open">Open</button>
  <div id="view" data-threadid="">none</div>
  <p id="status">thread-001</p>
  <script>
    const sel = document.querySelector("select");
    sel.addEventListener("change", () => { document.getElementById("status").textContent = sel.value; });
    document.getElementById("open").addEventListener("click", () => { document.getElementById("view").setAttribute("data-threadid", sel.value); });
  </script>
</main></body></html>`;

let server: Server;
let origin: string;
let dir: string;

function threadJourney(id: string, opts: { readonly staticGuard?: boolean; readonly contextCheck?: boolean; readonly site?: string } = {}): Journey {
  return {
    metadata: {
      id,
      name: "Open a thread",
      promoted: false,
      params: opts.contextCheck === true ? ["threadId", "expected_threadid"] : ["threadId"],
      // The context check guards against a wrong thread too: declared, so a targeted proof may relax it.
      ...(opts.contextCheck === true ? { mutationPairs: [{ check: "step:4", mustFailWhen: "swap-param:threadId" }] } : {}),
      createdAtIso: "2026-10-19T00:00:00.000Z",
      endState: [{ kind: "page", assertion: { kind: "valueEquals", target: { label: "Thread" }, value: { var: "threadId" } } }],
    },
    recording: {
      version: "1",
      site: opts.site ?? origin,
      pages: [
        {
          url: "/threads",
          steps: [
            { step: { kind: "navigate", url: "/threads", expect: { kind: "visible", target: { role: "heading", name: "Threads" } } } },
            {
              variableName: "threadId",
              step: { kind: "select", target: { label: "Thread" }, value: { var: "threadId" }, expect: { kind: "valueEquals", target: { label: "Thread" }, value: { var: "threadId" } } },
            },
            ...(opts.staticGuard === true ? [{ step: { kind: "assert" as const, check: { kind: "textIncludes" as const, target: { css: "#status" }, text: "thread-001" } } }] : []),
            { step: { kind: "click", target: { role: "button" as const, name: "Open" }, expect: { kind: "attr", target: { css: "#view" }, name: "data-threadid", value: { var: "threadId" } } } },
            ...(opts.contextCheck === true ? [{ step: { kind: "assert" as const, check: { kind: "attr" as const, target: { css: "#view" }, name: "data-threadid", value: { var: "expected_threadid" } } } }] : []),
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
  relaxedSites?: string[];
  targetedRefusal?: string;
}

interface Report {
  verdict: string;
  mutations: { id: string; outcome: string; failedSites: unknown[]; relaxed?: { outcome: string; failedSites: unknown[] } }[];
  assertions: Assertion[];
  summary: Record<string, number>;
}

async function verify(j: Journey, extra: readonly string[] = []): Promise<{ out: string; report: Report }> {
  const journeysDir = join(dir, j.metadata.id);
  await new FsJourneyStore(journeysDir).put(j);
  const r = await cli(journeysDir, ["journey", "verify", j.metadata.id, "--mutate", "--param", "threadId=thread-001", ...extra, "--json"]);
  return { out: r.out, report: (JSON.parse(r.out) as { data: Report }).data };
}

const assertion = (r: Report, site: string): Assertion | undefined => r.assertions.find((a) => a.site === site);

let proven: { out: string; report: Report };
let refused: { out: string; report: Report };
let onEnv: { out: string; report: Report };
let context: { out: string; report: Report };

beforeAll(async () => {
  server = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(page);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  dir = await mkdtemp(join(tmpdir(), "jevitate-verify-targeted-"));
  proven = await verify(threadJourney("proven"));
  refused = await verify(threadJourney("refused", { staticGuard: true }));
  // #609 review: recorded on an origin nothing serves, replayed on --base-url — every mutated and
  // targeted copy must follow the environment, never the recorded site.
  onEnv = await verify(threadJourney("on-env", { site: "http://127.0.0.1:9" }), ["--base-url", origin]);
  context = await verify(threadJourney("context", { contextCheck: true }), ["--param", "expected_threadid=thread-001"]);
}, 600_000);

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await rm(dir, { recursive: true, force: true });
});

describe("journey verify --mutate targeted proof (#609, served)", () => {
  it("a blocking click check no longer hides the end state: the proof is proven", () => {
    expect(proven.report.verdict).toBe("proven");
  });

  it("the end-state assertion is proven sensitive by the swap-param mutation", () => {
    expect(assertion(proven.report, "end-state:0")?.provedBy).toBe("swap-param:threadId");
  });

  it("the end-state assertion names the click postcondition a targeted proof relaxed", () => {
    expect(assertion(proven.report, "end-state:0")?.relaxedSites).toEqual(["step:3"]);
  });

  it("the click step's own assertion stays sensitive (the earlier check still fires)", () => {
    expect(assertion(proven.report, "step:3")?.verdict).toBe("sensitive");
  });

  it("the summary counts the assertion proven through a relaxation", () => {
    expect(proven.report.summary.targeted).toBe(1);
  });

  it("when the blocking check is not paired with the mutation, the end-state assertion keeps a targeted refusal", () => {
    expect(assertion(refused.report, "end-state:0")?.targetedRefusal).toMatch(/step:3 is not paired with swap-param:threadId/);
  });

  it("mutated and targeted replays follow --base-url, so the proof on the environment is proven", () => {
    expect(onEnv.report.verdict).toBe("proven");
  });

  it("when the blocking check is not paired, the proof is inconclusive", () => {
    expect(refused.report.verdict).toBe("inconclusive");
  });

  // The relaxed copy no longer names `expected_threadid` (its only check was relaxed); the replay
  // must still run, with the params the copy reads, instead of erroring on an unknown param.
  it("relaxing a declared context check that alone names a param still reaches the end state", () => {
    expect(assertion(context.report, "end-state:0")?.relaxedSites).toEqual(["step:3", "step:4"]);
  });

  it("with a declared context check relaxed in turn, the proof is proven", () => {
    expect(context.report.verdict).toBe("proven");
  });
});
