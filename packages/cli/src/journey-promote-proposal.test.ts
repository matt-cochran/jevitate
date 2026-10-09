import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProfileManager } from "@jevitate/daemon";
import { FakeClock, installClock, resetClock } from "@jevitate/domain";
import { FsJourneyStore, JourneyReviewSchema, type Journey } from "@jevitate/journey";
import type { RecordedStep } from "@jevitate/recording";
import type { ProposedRevisionDraft } from "@jevitate/runtime";
import { buildProgram } from "./program.js";
import { buildMcpTools, type McpApiDeps } from "./mcp-api.js";
import { makeInProcessCliRunner } from "./mcp-cli-runner.js";
import { approvedSnapshotPath } from "./journey-review-store.js";
import { proposalPath, rejectedProposalPath, writeJourneyProposal } from "./journey-proposal-store.js";
import type { CliDeps } from "./cli-shared.js";

/** #453 — `journey review` shows a proposed self-heal revision; `journey promote --proposal` accepts it, `--reject-proposal` rejects it. No browser. */

function strongJourney(): Journey {
  return {
    metadata: {
      id: "strong",
      name: "Publish",
      promoted: false,
      params: [],
      createdAtIso: "2026-09-19T00:00:00Z",
      endState: [{ kind: "reloadThen", assertion: { kind: "textIncludes", target: { testId: "live" }, text: "published" } }],
    },
    recording: {
      version: "1.0.0",
      site: "https://example.test",
      pages: [
        {
          url: "/editor",
          steps: [
            {
              step: { kind: "click", target: { testId: "publish" }, expect: { kind: "textIncludes", target: { role: "status" }, text: "Published" } },
              expectRequests: [{ kind: "responseStatus", method: "POST", pathGlob: "/api/publish", status: { class: 2 } }],
            },
          ],
        },
      ],
    },
  };
}

let root: string;
let journeysDir: string;
let store: FsJourneyStore;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "jev-453c-promote-"));
  journeysDir = join(root, "journeys");
  store = new FsJourneyStore(journeysDir);
  await store.put(strongJourney());
  installClock(new FakeClock({ startMs: Date.parse("2026-10-09T12:00:00.000Z") }));
});

afterEach(() => {
  resetClock();
  process.exitCode = undefined;
});

function deps(): CliDeps {
  return {
    profiles: new ProfileManager(join(root, "profiles")),
    journeysDir,
    explore: { targetsConfigPath: join(root, "no-targets.json") },
    approval: { env: {}, stdinIsTTY: () => false, stdoutIsTTY: () => false, user: () => "tester" },
  };
}

async function cli(argv: readonly string[]): Promise<{ out: string; json: any }> {
  const lines: string[] = [];
  const program = buildProgram(deps());
  program.configureOutput({ writeOut: (s) => lines.push(s), writeErr: () => {} });
  program.exitOverride();
  await program.parseAsync([...argv], { from: "user" });
  const out = lines.join("");
  let json: any;
  try {
    json = JSON.parse(out);
  } catch {
    json = undefined;
  }
  return { out, json };
}

/** Writes the proposal a self-heal would: the click retargeted to `publish-now`, `tweak` applied to the proposed step. */
async function propose(tweak: (r: RecordedStep) => RecordedStep = (r) => r): Promise<{ proposalId: string; path: string }> {
  const base = (await store.get("strong"))!;
  const page = base.recording.pages[0]!;
  const before = page.steps[0]!;
  const after = tweak({ ...before, step: { ...before.step, target: { testId: "publish-now" } } as RecordedStep["step"] });
  const draft: ProposedRevisionDraft = {
    recording: { ...base.recording, pages: [{ ...page, steps: [after] }] },
    steps: [
      {
        index: 0,
        before: before.step,
        after: after.step,
        attempt: 1,
        hypothesis: "test id 'publish' → 'publish-now' (src/ui/Toolbar.tsx:42)",
        evidence: [{ id: "e1", kind: "test-id", before: "publish", after: "publish-now", file: "src/ui/Toolbar.tsx", line: 42 }],
      },
    ],
  };
  // Written through the store's own gate when the revision is honest; the tamper cases are forged on disk below.
  return writeJourneyProposal(journeysDir, { journeyId: "strong", base, draft, attempts: [], changes: { range: "main..HEAD", notes: [] } });
}

const promote = (...args: string[]) => cli(["journey", "promote", "strong", "--json", "--non-interactive-approval", "test", ...args]);

describe("#453 journey review shows the proposal", () => {
  it("--json carries a schema-checked proposal section", async () => {
    await propose();
    const { json } = await cli(["journey", "review", "strong", "--json"]);
    expect(JourneyReviewSchema.safeParse(json.data).success && json.data.proposal !== undefined).toBe(true);
  });

  it("lists the step before and after", async () => {
    await propose();
    const { json } = await cli(["journey", "review", "strong", "--json"]);
    expect(json.data.proposal.steps[0]).toMatchObject({ number: 1, before: expect.stringContaining("publish"), after: expect.stringContaining("publish-now") });
  });

  it("cites the evidence file and line", async () => {
    await propose();
    const { json } = await cli(["journey", "review", "strong", "--json"]);
    expect(json.data.proposal.steps[0].evidence[0]).toContain("src/ui/Toolbar.tsx:42");
  });

  it("the human sheet has the Proposed revision section", async () => {
    await propose();
    expect((await cli(["journey", "review", "strong"])).out).toContain("PROPOSED REVISION (SELF-HEAL)");
  });

  it("--markdown renders the section heading", async () => {
    await propose();
    expect((await cli(["journey", "review", "strong", "--markdown"])).out).toContain("## Proposed revision (self-heal)");
  });

  it("marks the proposal stale once the Journey changed", async () => {
    await propose();
    await store.put({ ...strongJourney(), metadata: { ...strongJourney().metadata, description: "edited" } });
    const { json } = await cli(["journey", "review", "strong", "--json"]);
    expect(json.data.proposal.stale).toBe(true);
  });

  it("has no proposal section when none is pending", async () => {
    expect((await cli(["journey", "review", "strong", "--json"])).json.data.proposal).toBeUndefined();
  });
});

describe("#453 journey promote --proposal", () => {
  it("writes the proposed recording to the store", async () => {
    const { proposalId } = await propose();
    await promote("--proposal", proposalId);
    expect(JSON.stringify((await store.get("strong"))?.recording)).toContain("publish-now");
  });

  it("leaves the stored Journey byte-identical until it is accepted", async () => {
    const file = join(journeysDir, "strong.json");
    const before = await readFile(file, "utf8");
    await propose();
    await cli(["journey", "review", "strong", "--json"]);
    expect(await readFile(file, "utf8")).toBe(before);
  });

  it("binds the approval to the proposed hash and records approval.proposal", async () => {
    const { proposalId } = await propose();
    const proposedHash = (await cli(["journey", "review", "strong", "--json"])).json.data.proposal.proposedHash as string;
    const approval = (await promote("--proposal", proposalId, "--reviewed-hash", proposedHash)).json.data.approval;
    expect([approval.contentHash, approval.proposal.id, approval.proposal.steps, approval.provenance.channel]).toEqual([proposedHash, proposalId, [0], "non-interactive"]);
  });

  it("keeps the .approved snapshot of the accepted revision", async () => {
    const { proposalId } = await propose();
    await promote("--proposal", proposalId);
    expect(JSON.stringify(JSON.parse(await readFile(approvedSnapshotPath(journeysDir, "strong"), "utf8")).recording)).toContain("publish-now");
  });

  it("deletes the sidecar once accepted", async () => {
    const { proposalId } = await propose();
    await promote("--proposal", proposalId);
    expect(existsSync(proposalPath(journeysDir, "strong"))).toBe(false);
  });

  it("refuses a stale proposal (E_JOURNEY_PROPOSAL_STALE)", async () => {
    const { proposalId } = await propose();
    await store.put({ ...strongJourney(), metadata: { ...strongJourney().metadata, description: "edited" } });
    expect((await promote("--proposal", proposalId)).json.error.code).toBe("E_JOURNEY_PROPOSAL_STALE");
  });

  it("a stale proposal changes nothing", async () => {
    const { proposalId } = await propose();
    await store.put({ ...strongJourney(), metadata: { ...strongJourney().metadata, description: "edited" } });
    await promote("--proposal", proposalId);
    expect(JSON.stringify((await store.get("strong"))?.recording)).not.toContain("publish-now");
  });

  it("refuses an unknown proposal (E_JOURNEY_PROPOSAL_NOT_FOUND)", async () => {
    expect((await promote("--proposal", "aaaaaaaaaaaa")).json.error.code).toBe("E_JOURNEY_PROPOSAL_NOT_FOUND");
  });

  it("refuses a reviewed hash other than the proposedHash", async () => {
    const { proposalId } = await propose();
    const storedHash = (await cli(["journey", "review", "strong", "--json"])).json.data.contentHash as string;
    expect((await promote("--proposal", proposalId, "--reviewed-hash", storedHash)).json.error.code).toBe("E_JOURNEY_REVIEW_STALE");
  });

  it("refuses a tampered proposal that changes an assertion", async () => {
    const { proposalId, path } = await propose();
    const file = JSON.parse(await readFile(path, "utf8"));
    file.recording.pages[0].steps[0].step.expect.text = "Anything";
    await writeFile(path, JSON.stringify(file));
    expect((await promote("--proposal", proposalId)).json.error.code).toBe("E_JOURNEY_PROPOSAL_PROOF");
  });

  it("a tampered proposal changes nothing", async () => {
    const { proposalId, path } = await propose();
    const file = JSON.parse(await readFile(path, "utf8"));
    file.recording.pages[0].steps[0].step.expect.text = "Anything";
    await writeFile(path, JSON.stringify(file));
    await promote("--proposal", proposalId);
    expect((await store.get("strong"))?.metadata.promoted).toBe(false);
  });

  it("needs a person: no terminal and no escape hatch is refused", async () => {
    const { proposalId } = await propose();
    const r = await cli(["journey", "promote", "strong", "--json", "--proposal", proposalId]);
    expect(r.json.error.code).toBe("E_APPROVAL_NEEDS_HUMAN");
  });
});

describe("#453 journey promote --reject-proposal", () => {
  it("moves the proposal to .rejected", async () => {
    const { proposalId } = await propose();
    await cli(["journey", "promote", "strong", "--json", "--reject-proposal", proposalId, "--reason", "wrong button"]);
    expect([existsSync(proposalPath(journeysDir, "strong")), existsSync(rejectedProposalPath(journeysDir, "strong", proposalId))]).toEqual([false, true]);
  });

  it("records the reason and the provenance", async () => {
    const { proposalId } = await propose();
    await cli(["journey", "promote", "strong", "--json", "--reject-proposal", proposalId, "--reason", "wrong button"]);
    const rec = JSON.parse(await readFile(rejectedProposalPath(journeysDir, "strong", proposalId), "utf8"));
    expect([rec.reason, rec.provenance.channel, rec.provenance.user]).toEqual(["wrong button", "non-interactive", "tester"]);
  });

  it("leaves the stored Journey byte-identical", async () => {
    const file = join(journeysDir, "strong.json");
    const before = await readFile(file, "utf8");
    const { proposalId } = await propose();
    await cli(["journey", "promote", "strong", "--json", "--reject-proposal", proposalId, "--reason", "no"]);
    expect(await readFile(file, "utf8")).toBe(before);
  });

  it("needs a reason", async () => {
    const { proposalId } = await propose();
    expect((await cli(["journey", "promote", "strong", "--json", "--reject-proposal", proposalId])).json.error.code).toBe("E_JOURNEY_PROPOSAL_ARGS");
  });

  it("refuses an unknown proposal id", async () => {
    expect((await cli(["journey", "promote", "strong", "--json", "--reject-proposal", "aaaaaaaaaaaa", "--reason", "x"])).json.error.code).toBe("E_JOURNEY_PROPOSAL_NOT_FOUND");
  });
});

describe("#453 MCP promote_journey with a proposal", () => {
  function tool(name: string): (args: Record<string, unknown>) => Promise<{ isError: boolean; body: any }> {
    const mcpDeps: McpApiDeps = { journeysDir, pathRoots: [root], runCli: makeInProcessCliRunner(() => buildProgram(deps())) };
    const t = buildMcpTools(mcpDeps).find((x) => x.name === name)!;
    return async (args) => {
      const r = await t.handler(args);
      return { isError: r.isError === true, body: JSON.parse(r.content[0]!.text) };
    };
  }

  it("accepts the proposal as an agent approval on the mcp channel", async () => {
    const { proposalId } = await propose();
    const r = await tool("promote_journey")({ id: "strong", proposal: proposalId });
    expect(r.body.data.approval.provenance.channel).toBe("mcp");
  });

  it("rejects the proposal with a reason", async () => {
    const { proposalId } = await propose();
    await tool("promote_journey")({ id: "strong", rejectProposal: proposalId, reason: "not this one" });
    expect(existsSync(rejectedProposalPath(journeysDir, "strong", proposalId))).toBe(true);
  });

  it("review_journey shows the pending proposal", async () => {
    await propose();
    expect((await tool("review_journey")({ id: "strong" })).body.data.proposal.steps).toHaveLength(1);
  });
});
