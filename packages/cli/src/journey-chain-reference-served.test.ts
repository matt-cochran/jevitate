import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
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
 * #624 (3) end to end — the issue's minimal two-Journey localhost fixture (`discover-reference` →
 * `prepare-reference`) through `journey chain`, linked readiness `replay` and linked readiness
 * `prove`, against a served copy of the issue's `web/index.html`. The browser origin is only the
 * served loopback origin; the external `https://example.com/reference/1` is reference DATA.
 *
 * Case A declares the data origin on the producer's `referenceUrl` field (`origins`), so the record
 * validates and the prepare-only consumer actually runs — the composer is filled with the exact
 * reply and nothing is sent. Case B is the issue's original fixture (no `origins`): the record is
 * rejected as malformed, the chain fails closed, and both readiness diagnostics name that rejection.
 */

const PRODUCER = "discover-reference";
const CONSUMER = "prepare-reference";
const CONTRACT = "reference-record@1";
const REPLY = "Fictional approved reply.";

const PAGE = `<!doctype html><h1>Local reference handoff</h1>
<div data-testid="record" data-recordid="example-001" data-referenceurl="https://example.com/reference/1">Fictional record</div>
<textarea data-testid="composer"></textarea><button data-testid="send-reply" disabled>Send disabled</button>
<span data-testid="submitted" data-count="0">0</span>`;

/** The issue's `discover-reference.json` verbatim, with the served origin and (Case A) data origins. */
function producer(referenceOrigins?: readonly string[]): Journey {
  return {
    metadata: {
      id: PRODUCER,
      name: PRODUCER,
      goal: "Pass a URL as data while browsing only localhost",
      params: [],
      promoted: false,
      authoredBy: "jev-driven",
      createdAtIso: "2026-10-22T17:00:00Z",
      outputs: {
        contract: CONTRACT,
        key: ["recordId"],
        fields: {
          recordId: { type: "id" },
          referenceUrl: referenceOrigins === undefined ? { type: "url" } : { type: "url", origins: [...referenceOrigins] },
        },
      },
    },
    recording: {
      version: "1.0.0",
      site: origin,
      intent: "Local reference URL handoff",
      pages: [
        {
          url: "/",
          steps: [
            {
              step: { kind: "navigate", url: "/", expect: { kind: "textIncludes", target: { role: "heading", name: "Local reference handoff" }, text: "Local reference handoff" } },
              objective: "Open the fictional local page",
              expectedResult: "Open the fictional local page.",
              stepId: "prepare-reference-1",
            },
            {
              step: { kind: "extract", target: { testId: "record" }, as: "recordId", attr: "data-recordid", expect: { kind: "attr", target: { testId: "record" }, name: "data-recordid" } },
              objective: "Read the fictional ID",
              expectedResult: "Read the fictional ID.",
              stepId: "discover-reference-2",
            },
            {
              step: { kind: "extract", target: { testId: "record" }, as: "referenceUrl", attr: "data-referenceurl", expect: { kind: "attr", target: { testId: "record" }, name: "data-referenceurl" } },
              objective: "Read the external reference as data only",
              expectedResult: "Read the external reference as data only.",
              stepId: "discover-reference-3",
            },
          ],
        },
      ],
    },
  };
}

/** The issue's `prepare-reference.json` verbatim, with the served origin. */
function consumer(): Journey {
  return {
    metadata: {
      id: CONSUMER,
      name: CONSUMER,
      goal: "Pass a URL as data while browsing only localhost",
      params: ["recordId", "expected_referenceUrl", "approvedReplyText"],
      promoted: false,
      authoredBy: "jev-driven",
      createdAtIso: "2026-10-22T17:00:00Z",
      inputs: {
        accepts: CONTRACT,
        request: { key: ["recordId"], fields: { recordId: { type: "id" }, replyText: { type: "text" } } },
        bindings: {
          recordId: { record: "recordId" },
          expected_referenceUrl: { record: "referenceUrl" },
          approvedReplyText: { request: "replyText" },
        },
      },
      boundary: {
        kind: "prepare-only",
        stopBefore: { target: { testId: "send-reply" }, label: "Send disabled" },
        blockWrites: true,
        nextStep: "Review prepared text; do not send.",
      },
      endState: [{ kind: "page", assertion: { kind: "attr", target: { testId: "submitted" }, name: "data-count", value: "0" } }],
    },
    recording: {
      version: "1.0.0",
      site: origin,
      intent: "Local reference URL handoff",
      pages: [
        {
          url: "/",
          steps: [
            {
              step: { kind: "navigate", url: "/", expect: { kind: "textIncludes", target: { role: "heading", name: "Local reference handoff" }, text: "Local reference handoff" } },
              objective: "Open the fictional local page",
              expectedResult: "Open the fictional local page.",
              stepId: "prepare-reference-1",
            },
            {
              step: { kind: "assert", check: { kind: "attr", target: { testId: "record" }, name: "data-recordid", value: { var: "recordId" } } },
              objective: "Verify exact ID",
              expectedResult: "Verify exact ID.",
              stepId: "prepare-reference-2",
            },
            {
              step: { kind: "assert", check: { kind: "attr", target: { testId: "record" }, name: "data-referenceurl", value: { var: "expected_referenceUrl" } } },
              objective: "Verify the URL data without navigating",
              expectedResult: "Verify the URL data without navigating.",
              stepId: "prepare-reference-3",
            },
            {
              step: { kind: "fill", target: { testId: "composer" }, value: { var: "approvedReplyText" }, expect: { kind: "valueEquals", target: { testId: "composer" }, value: { var: "approvedReplyText" } } },
              objective: "Prepare exact text without sending",
              expectedResult: "Prepare exact text without sending.",
              stepId: "prepare-reference-4",
            },
          ],
        },
      ],
    },
  };
}

let server: Server;
let origin: string;
let root: string;
/** Every request the app received, in order. */
const requests: { method: string; path: string }[] = [];

interface Project {
  readonly dir: string;
  readonly catalogDir: string;
  readonly journeysDir: string;
}

async function makeProject(name: string): Promise<Project> {
  const dir = join(root, name);
  const catalogDir = join(dir, ".jevitate");
  const journeysDir = join(catalogDir, "journeys");
  await mkdir(journeysDir, { recursive: true });
  // Draft (unapproved) catalog entries: approval stays a person's call.
  await writeFile(join(catalogDir, "personas.json"), JSON.stringify([]));
  await writeFile(join(catalogDir, "jobs.json"), JSON.stringify([]));
  return { dir, catalogDir, journeysDir };
}

async function cli(project: Project, args: string[]): Promise<{ out: string; exitCode: number | undefined }> {
  const out: string[] = [];
  const program = buildProgram({
    profiles: new ProfileManager(join(project.dir, "profiles")),
    journeysDir: project.journeysDir,
    catalogDir: project.catalogDir,
    dbPath: join(project.dir, "no-site-policy.sqlite"),
    environmentsFile: join(project.dir, "no-environments.json"),
    explore: { browserPortFactory: () => new PlaywrightBrowserPort(), targetsConfigPath: join(project.dir, "no-targets.json") },
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

type Envelope = { ok?: boolean; data?: any; error?: { code: string; message: string } };
const envelope = (out: string): Envelope => JSON.parse(out.trim().split("\n").pop() ?? "{}") as Envelope;

const checkOf = (receipt: Envelope, check: string, journey: string): any => receipt.data?.checks?.find((c: { check: string; journey: string }) => c.check === check && c.journey === journey);

interface CaseResult {
  readonly chain: Envelope;
  readonly chainExitCode: number | undefined;
  readonly replay: Envelope;
  readonly prove: Envelope;
}

let caseA: CaseResult;
let caseB: CaseResult;

async function runCase(referenceOrigins: readonly string[] | undefined): Promise<CaseResult> {
  const project = await makeProject(referenceOrigins === undefined ? "case-b" : "case-a");
  const store = new FsJourneyStore(project.journeysDir);
  await store.put(producer(referenceOrigins));
  await store.put(consumer());
  const requestFile = join(project.dir, "requests.jsonl");
  await writeFile(requestFile, `${JSON.stringify({ recordId: "example-001", replyText: REPLY })}\n`);

  const chained = await cli(project, ["journey", "chain", "--from", PRODUCER, "--to", CONSUMER, "--requests", requestFile, "--allow-draft", "--json"]);
  const readinessArgs = (mode: string): string[] => ["journey", "readiness", PRODUCER, "--with", CONSUMER, "--mode", mode, "--base-url", origin, "--requests", requestFile, "--json"];
  const replay = envelope((await cli(project, readinessArgs("replay"))).out);
  const prove = envelope((await cli(project, readinessArgs("prove"))).out);
  return { chain: envelope(chained.out), chainExitCode: chained.exitCode, replay, prove };
}

beforeAll(async () => {
  server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://local");
    requests.push({ method: req.method ?? "GET", path: url.pathname });
    if (url.pathname === "/") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(PAGE);
      return;
    }
    res.writeHead(404, { "content-type": "text/plain" }).end("not found");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  root = await mkdtemp(join(tmpdir(), "jevitate-reference-"));

  caseB = await runCase(undefined);
  caseA = await runCase(["https://example.com"]);
}, 1_800_000);

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await rm(root, { recursive: true, force: true });
});

describe("reference URL as data through chain and linked readiness (#624, served)", () => {
  it("Case A: journey chain exits 0", () => {
    expect(caseA.chainExitCode ?? 0).toBe(0);
  });

  it("Case A: journey chain ran the one matched request", () => {
    expect(caseA.chain.data?.requests).toEqual({ total: 1, ran: 1 });
  });

  it("Case A: the consumer prepared the exact reply and stopped at its boundary (run ok)", () => {
    expect(caseA.chain.data?.runs?.map((r: { outcome: string }) => r.outcome)).toEqual(["ok"]);
  });

  it("Case A: linked readiness replay passes the pair's replay check", () => {
    expect(checkOf(caseA.replay, "replay", PRODUCER)?.state).toBe("pass");
  });

  it("Case A: linked readiness prove runs the consumer proof with the chain-bound params", () => {
    expect(checkOf(caseA.prove, "proof", CONSUMER)?.state).toBe("pass");
  });

  it("Case B: journey chain exits 1", () => {
    expect(caseB.chainExitCode).toBe(1);
  });

  it("Case B: journey chain reports the rejected record's field-specific error", () => {
    expect(caseB.chain.data?.rejected?.[0]).toMatchObject({ key: "example-001", errors: [{ field: "referenceUrl", code: "malformed" }] });
  });

  it("Case B: journey chain ran zero consumer runs", () => {
    expect(caseB.chain.data?.requests?.ran).toBe(0);
  });

  it("Case B: linked readiness replay fails the pair's replay check", () => {
    expect(checkOf(caseB.replay, "replay", PRODUCER)?.state).toBe("fail");
  });

  it("Case B: linked readiness replay names the first rejection", () => {
    expect(checkOf(caseB.replay, "replay", PRODUCER)?.detail).toContain("example-001: referenceUrl malformed");
  });

  it("Case B: linked readiness prove's consumer hint names the same rejection", () => {
    expect(checkOf(caseB.prove, "proof", CONSUMER)?.detail).toContain("example-001: referenceUrl malformed");
  });

  it("no run in any case sent a write to the app (zero sends)", () => {
    expect(requests.filter((r) => r.method !== "GET")).toEqual([]);
  });

  it("the served localhost fixture received the runs' page loads", () => {
    expect(requests.length).toBeGreaterThan(0);
  });
});
