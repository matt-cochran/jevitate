import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Journey } from "@jevitate/journey";
import { withCommandSecretParams } from "./secret-params.js";
import { runAsMcpInvocation } from "./approval-provenance.js";
import { journeyReviewHash } from "./journey-review.js";
import type { ResolvedJourneyEnvironment } from "./environments.js";

/**
 * 0.30.0 §5.3 at the shared binding step of shorten, verify, demo, readiness, chain, explore
 * --from-journey and load (`withCommandSecretParams`): over MCP the operator's targets.json
 * `secretFields` reach only a Journey the run-mode rules let read them (planSecretRun, testModeSecrets).
 * A draft never does, whatever the target's trust. Reproduces the independent check's draft-secret-mcp.mjs.
 */

const SITE = "http://127.0.0.1:3001";
const MARK = "MARKER_S_9Zq";
const VAR = "JEV_IC_SECRET";
let root: string;
let dir: string;
let environmentsFile: string;
let targetsFile: string;

function journey(id: string, approval?: "tty" | "mcp"): Journey {
  const j = {
    metadata: { id, name: id, promoted: approval !== undefined, params: ["pw"], parameters: [{ name: "pw", secret: true }], createdAtIso: "2026-11-09T00:00:00.000Z" },
    recording: {
      version: "1",
      site: SITE,
      pages: [{ url: "/", steps: [{ step: { kind: "navigate", url: "/", expect: { kind: "visible", target: { testId: "q" } } } }, { step: { kind: "fill", target: { label: "Search" }, value: { var: "pw" }, expect: { kind: "visible", target: { testId: "q" } } } }] }],
    },
  } as unknown as Journey;
  if (approval !== undefined) j.metadata.approval = { contentHash: journeyReviewHash(j), at: "2026-11-09T00:00:00.000Z", provenance: { channel: approval, agentSignals: [] } } as never;
  return j;
}

/** H7: a person's (or an agent's) approval, then the content edited afterwards: the approval is stale. */
function stale(id: string, approval: "tty" | "mcp"): Journey {
  const j = journey(id, approval);
  (j.recording.pages[0]!.steps as unknown[]).push({ step: { kind: "fill", target: { testId: "who" }, value: { var: "pw" }, expect: { kind: "visible", target: { testId: "q" } } } });
  return j;
}

/** An environment as `environmentFromFlags` resolves it, with targets.json's binding for its origin. */
function environment(name: "auto" | "test"): ResolvedJourneyEnvironment {
  return { name, baseUrl: SITE, allowedOrigins: [SITE], secretFields: [`param=pw=env:${VAR}`], source: `${environmentsFile}[${name}]` };
}

const bind = (id: string, env: ResolvedJourneyEnvironment, mcp: boolean) => {
  const go = () => withCommandSecretParams({ dir, ids: [id], params: {}, flags: [], environment: env, env: { [VAR]: MARK }, seams: { environmentsFile, targetsFile, journeysDir: dir, catalogDir: null } });
  return mcp ? runAsMcpInvocation(go) : go();
};

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "jev-h1-"));
  dir = join(root, "journeys");
  mkdirSync(dir);
  environmentsFile = join(root, "environments.json");
  targetsFile = join(root, "targets.json");
  writeFileSync(environmentsFile, JSON.stringify({ auto: { baseUrl: SITE }, test: { baseUrl: SITE, trust: "test" } }));
  writeFileSync(targetsFile, JSON.stringify({ [SITE]: { secretFields: [`param=pw=env:${VAR}`] } }));
  for (const j of [journey("draft"), journey("person", "tty"), journey("agent", "mcp"), stale("stale-person", "tty"), stale("stale-agent", "mcp")]) writeFileSync(join(dir, `${j.metadata.id}.json`), JSON.stringify(j));
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("H1: over MCP a draft Journey never gets the operator's targets.json secret", () => {
  it.each(["auto", "test"] as const)("a draft on the %s target: nothing is filled or bound", async (name) => {
    const r = await bind("draft", environment(name), true);
    expect(r.params["pw"]).toBeUndefined();
    expect(r.bound).toBeUndefined();
    expect(JSON.stringify(r)).not.toContain(MARK);
  });

  it("an agent's promotion on an automation-mode target: not filled (owner decision 5)", async () => {
    const r = await bind("agent", environment("auto"), true);
    expect(r.params["pw"]).toBeUndefined();
  });

  it("an agent's promotion on a test-mode target: filled from the test target's own binding (§5.3)", async () => {
    const r = await bind("agent", environment("test"), true);
    expect(r.params["pw"]).toBe(MARK);
    expect(r.bound).toEqual({ pw: [SITE] });
  });

  it("a person's approval on an automation-mode target: filled, bound to the origin", async () => {
    const r = await bind("person", environment("auto"), true);
    expect(r.params["pw"]).toBe(MARK);
    expect(r.bound).toEqual({ pw: [SITE] });
  });

  it("on the CLI (a person at a terminal) the binding applies to a draft as before", async () => {
    const r = await bind("draft", environment("auto"), false);
    expect(r.params["pw"]).toBe(MARK);
  });
});

describe("H7: over MCP a promoted Journey whose approval is stale never gets the operator's targets.json secret", () => {
  it.each([
    ["stale-person", "auto"],
    ["stale-person", "test"],
    ["stale-agent", "test"],
  ] as const)("%s on the %s target: nothing is filled or bound (as run_journey refuses)", async (id, name) => {
    const r = await bind(id, environment(name), true);
    expect(r.params["pw"]).toBeUndefined();
    expect(r.bound).toBeUndefined();
    expect(JSON.stringify(r)).not.toContain(MARK);
  });
});
