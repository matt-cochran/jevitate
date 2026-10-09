import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProfileManager } from "@jevitate/daemon";
import { FakeClock, installClock, resetClock } from "@jevitate/domain";
import { FsJourneyStore, type Journey } from "@jevitate/journey";
import { buildProgram } from "./program.js";
import { buildMcpTools, type McpApiDeps } from "./mcp-api.js";
import { makeInProcessCliRunner } from "./mcp-cli-runner.js";
import { journeyContentHash } from "./journey-annotate-api.js";
import { journeyReviewHash } from "./journey-review.js";
import { runCheck } from "./check-api.js";
import { loadCatalog } from "./catalog-api.js";
import {
  ApprovalNeedsHumanError,
  ApprovalNotConfirmedError,
  approvalsReport,
  detectAgentSignals,
  makeApprovalConfirm,
  runAsMcpInvocation,
  type ApprovalDeps,
  type ApprovalRequest,
} from "./approval-provenance.js";
import { CODEOWNERS_BLOCK_BEGIN, CodeownersArgsError, installCodeowners } from "./init-codeowners.js";
import type { CliDeps } from "./cli-shared.js";

/** #437 — approval provenance, the typed confirmation on a TTY, and enforcement (check --require-approvals, CODEOWNERS). No browser. */

function journey(id: string, overrides: Partial<Journey["metadata"]> = {}): Journey {
  return {
    metadata: {
      id,
      name: `Journey ${id}`,
      promoted: false,
      params: [],
      createdAtIso: "2026-09-19T00:00:00Z",
      endState: [{ kind: "reloadThen", assertion: { kind: "textIncludes", target: { testId: "live" }, text: "published" } }],
      ...overrides,
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

/** A weak Journey: one click, nothing asserted (`--accept-weak` needed). */
function weak(id: string): Journey {
  return { metadata: { id, name: id, promoted: false, params: [], createdAtIso: "2026-09-19T00:00:00Z" }, recording: { version: "1.0.0", site: "https://example.test", pages: [{ url: "/", steps: [{ step: { kind: "click", target: { testId: "go" }, expect: { kind: "visible", target: { testId: "go" } } } }] }] } };
}

let root: string;
let catalogDir: string;
let journeysDir: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "jev-437-"));
  catalogDir = join(root, ".jevitate");
  journeysDir = join(catalogDir, "journeys");
  await mkdir(catalogDir, { recursive: true });
  await writeFile(join(catalogDir, "personas.json"), JSON.stringify([{ id: "editor", description: "writes posts", role: "editor" }]));
  await writeFile(join(catalogDir, "jobs.json"), JSON.stringify([{ id: "publish-post", trigger: "a draft is ready", motivation: "publish it", outcome: "readers see it", personas: ["editor"] }]));
  const store = new FsJourneyStore(journeysDir);
  await store.put(journey("loose"));
  await store.put(weak("weak"));
  installClock(new FakeClock({ startMs: Date.parse("2026-10-08T12:00:00.000Z") }));
});

afterEach(() => {
  resetClock();
  process.exitCode = undefined;
});

/** No terminal: how a coding agent's shell (or CI) runs the CLI. */
const NO_TTY: ApprovalDeps = { env: {}, stdinIsTTY: () => false, stdoutIsTTY: () => false, user: () => "tester" };

/** A person at a terminal who types `answers` in order. */
function person(answers: string[], env: Record<string, string> = {}): ApprovalDeps & { asked: string[] } {
  const asked: string[] = [];
  return {
    env,
    stdinIsTTY: () => true,
    stdoutIsTTY: () => true,
    user: () => "alice",
    asked,
    prompt: (q: string) => {
      asked.push(q);
      return Promise.resolve(answers.shift() ?? "");
    },
  };
}

function deps(approval: ApprovalDeps = NO_TTY, extra: Partial<CliDeps> = {}): CliDeps {
  return { profiles: new ProfileManager(join(root, "profiles")), journeysDir, catalogDir, dbPath: join(root, "site.sqlite"), explore: { targetsConfigPath: join(root, "no-targets.json") }, approval, ...extra };
}

async function cli(argv: readonly string[], approval: ApprovalDeps = NO_TTY, extra: Partial<CliDeps> = {}): Promise<{ out: string; json: any; code: number | undefined }> {
  const lines: string[] = [];
  const program = buildProgram(deps(approval, extra));
  program.configureOutput({ writeOut: (s) => lines.push(s), writeErr: () => {} });
  program.exitOverride();
  process.exitCode = undefined;
  await program.parseAsync([...argv], { from: "user" });
  const out = lines.join("");
  let json: any;
  try {
    json = JSON.parse(out);
  } catch {
    json = undefined;
  }
  return { out, json, code: process.exitCode === undefined ? undefined : Number(process.exitCode) };
}

const stored = async (id: string): Promise<Journey | null> => new FsJourneyStore(journeysDir).get(id);

describe("#437 agent markers: names only", () => {
  const env = { CLAUDECODE: "1", CLAUDE_CODE_ENTRYPOINT: "cli", CODEX_SANDBOX: "seatbelt", CURSOR_AGENT: "1", AIDER_MODEL: "gpt", GEMINI_CLI: "1", GITHUB_ACTIONS: "true", HOME: "/home/x", PATH: "/bin" };

  it("detects the known agent and CI markers by name, then the non-TTY streams", () => {
    expect(detectAgentSignals(env, { stdin: false, stdout: true })).toEqual([
      "AIDER_MODEL",
      "CLAUDECODE",
      "CLAUDE_CODE_ENTRYPOINT",
      "CODEX_SANDBOX",
      "CURSOR_AGENT",
      "GEMINI_CLI",
      "GITHUB_ACTIONS",
      "stdin-not-tty",
    ]);
  });

  it("never records a marker's value", () => {
    expect(JSON.stringify(detectAgentSignals(env, { stdin: true, stdout: true }))).not.toMatch(/seatbelt|gpt|cli"|true/);
  });

  it("an empty, 0 or false marker is not a signal", () => {
    expect(detectAgentSignals({ CLAUDECODE: "0", CI: "false", CODEX_SANDBOX: "" }, { stdin: true, stdout: true })).toEqual([]);
  });
});

describe("#437 the confirmation", () => {
  const req: ApprovalRequest = { kind: "journey", id: "loose", contentHash: "ab12cd34".padEnd(64, "0"), waivers: [] };

  it("refuses without a TTY (E_APPROVAL_NEEDS_HUMAN)", async () => {
    await expect(makeApprovalConfirm(NO_TTY)(req)).rejects.toBeInstanceOf(ApprovalNeedsHumanError);
  });

  it("refuses a typed confirmation that does not match", async () => {
    await expect(makeApprovalConfirm(person(["yes"]))(req)).rejects.toBeInstanceOf(ApprovalNotConfirmedError);
  });

  it("accepts the first 8 characters of the content hash", async () => {
    expect((await makeApprovalConfirm(person(["AB12CD34"]))(req)).channel).toBe("tty");
  });

  it("a waiver needs its own confirmation", async () => {
    await expect(makeApprovalConfirm(person(["loose", "no"]))({ ...req, waivers: [{ flag: "--accept-weak", reason: "demo" }] })).rejects.toBeInstanceOf(ApprovalNotConfirmedError);
  });

  it("the escape hatch under a CI marker is recorded as ci, with the reason", async () => {
    expect(await makeApprovalConfirm({ ...NO_TTY, env: { GITHUB_ACTIONS: "true" } }, { nonInteractiveReason: "seed fixtures" })(req)).toEqual({
      channel: "ci",
      agentSignals: ["GITHUB_ACTIONS", "stdin-not-tty", "stdout-not-tty"],
      user: "tester",
      reason: "seed fixtures",
    });
  });

  it("inside an MCP tool call it never prompts and is recorded as mcp", async () => {
    expect((await runAsMcpInvocation(() => makeApprovalConfirm(person([]))(req))).channel).toBe("mcp");
  });
});

describe("#437 every CLI approval path refuses without a TTY", () => {
  it("journey promote → E_APPROVAL_NEEDS_HUMAN, exit 64", async () => {
    const r = await cli(["journey", "promote", "loose", "--json"]);
    expect([r.json.error.code, r.code]).toEqual(["E_APPROVAL_NEEDS_HUMAN", 64]);
  });

  it("journey promote refused: nothing is promoted", async () => {
    await cli(["journey", "promote", "loose", "--json"]);
    expect((await stored("loose"))?.metadata.promoted).toBe(false);
  });

  it("the refusal says how a person approves", async () => {
    expect((await cli(["journey", "promote", "loose", "--json"])).json.error.message).toContain("A person approves by running `jevitate journey promote loose`");
  });

  it("persona approve → E_APPROVAL_NEEDS_HUMAN", async () => {
    expect((await cli(["persona", "approve", "editor", "--json"])).json.error.code).toBe("E_APPROVAL_NEEDS_HUMAN");
  });

  it("job approve → E_APPROVAL_NEEDS_HUMAN", async () => {
    expect((await cli(["job", "approve", "publish-post", "--json"])).json.error.code).toBe("E_APPROVAL_NEEDS_HUMAN");
  });

  it("demo approve → E_APPROVAL_NEEDS_HUMAN, before anything renders or is promoted", async () => {
    const j = journey("demo-x");
    await new FsJourneyStore(journeysDir).put(j);
    await mkdir(join(journeysDir, ".drafts"), { recursive: true });
    const hash = journeyContentHash((await new FsJourneyStore(journeysDir).get("demo-x"))!); // #467: as stored (put mints step ids)
    await writeFile(
      join(journeysDir, ".drafts", "demo-x.annotations.json"),
      JSON.stringify({ kind: "jevitate.journey-annotations.draft", version: 1, journeyId: "demo-x", journeyHash: hash, createdAtIso: "2026-10-08T00:00:00Z", provenance: { adapter: "fake", model: "fake", promptVersion: "1" }, replay: { outcome: "completed", reachedSteps: 1, totalSteps: 1 }, steps: [] }),
    );
    await writeFile(
      join(journeysDir, ".drafts", "demo-x.demo.json"),
      JSON.stringify({ kind: "jevitate.demo.draft", version: 1, id: "demo-x", aspect: "publish a post", env: "staging", journeyHash: hash, createdAtIso: "2026-10-08T00:00:00Z", draft: {} }),
    );
    const environmentsFile = join(root, "environments.json");
    await writeFile(environmentsFile, JSON.stringify({ staging: { baseUrl: "https://example.test" } }));
    const r = await cli(["demo", "approve", "demo-x", "--out", join(root, "final"), "--json"], NO_TTY, { environmentsFile });
    expect([r.json.error.code, (await stored("demo-x"))?.metadata.promoted, existsSync(join(root, "final"))]).toEqual(["E_APPROVAL_NEEDS_HUMAN", false, false]);
  });
});

describe("#437 provenance is recorded per channel", () => {
  it("tty: a person typed the id", async () => {
    await cli(["journey", "promote", "loose", "--json"], person(["loose"]));
    expect((await stored("loose"))?.metadata.approval?.provenance).toEqual({ channel: "tty", agentSignals: [], user: "alice" });
  });

  it("a mistyped confirmation promotes nothing (E_APPROVAL_NOT_CONFIRMED)", async () => {
    const r = await cli(["journey", "promote", "loose", "--json"], person(["lose"]));
    expect([r.json.error.code, (await stored("loose"))?.metadata.promoted]).toEqual(["E_APPROVAL_NOT_CONFIRMED", false]);
  });

  it("each waiver is confirmed and carries the provenance", async () => {
    await cli(["journey", "promote", "weak", "--accept-weak", "smoke only", "--json"], person(["weak", "weak"]));
    expect((await stored("weak"))?.metadata.approval?.acceptedWeak?.provenance?.channel).toBe("tty");
  });

  it("non-interactive: the escape hatch's reason, and the agent markers", async () => {
    await cli(["journey", "promote", "loose", "--non-interactive-approval", "seeding", "--json"], { ...NO_TTY, env: { CLAUDECODE: "1" } });
    expect((await stored("loose"))?.metadata.approval?.provenance).toEqual({ channel: "non-interactive", agentSignals: ["CLAUDECODE", "stdin-not-tty", "stdout-not-tty"], user: "tester", reason: "seeding" });
  });

  it("an empty escape-hatch reason is refused (E_APPROVAL_ARGS, exit 64)", async () => {
    const r = await cli(["journey", "promote", "loose", "--non-interactive-approval", " ", "--json"]);
    expect([r.json.error.code, r.code]).toEqual(["E_APPROVAL_ARGS", 64]);
  });

  it("persona approve records it with the approval", async () => {
    await cli(["persona", "approve", "editor", "--json"], person(["editor"]));
    expect(JSON.parse(await readFile(join(catalogDir, "personas.json"), "utf8"))[0].approval.provenance.channel).toBe("tty");
  });

  it("journey list says how a Journey was approved", async () => {
    await cli(["journey", "promote", "loose", "--non-interactive-approval", "seeding", "--json"], { ...NO_TTY, env: { CLAUDECODE: "1" } });
    expect((await cli(["journey", "list"])).out).toContain("approved non-interactively (likely an agent: CLAUDECODE)");
  });

  it("the review sheet says how it was approved", async () => {
    await cli(["journey", "promote", "loose", "--json"], person(["loose"]));
    expect((await cli(["journey", "review", "loose"])).out).toContain("approved at a terminal by alice (typed confirmation)");
  });

  it("MCP promote_journey is recorded as mcp", async () => {
    const mcpDeps: McpApiDeps = { journeysDir, pathRoots: [root], runCli: makeInProcessCliRunner(() => buildProgram(deps(person([])))) };
    const tool = buildMcpTools(mcpDeps).find((t) => t.name === "promote_journey");
    await tool!.handler({ id: "loose" });
    expect((await stored("loose"))?.metadata.approval?.provenance?.channel).toBe("mcp");
  });
});

describe("#437 --require-approvals", () => {
  const suite = () => ({ version: 1 as const, name: "approvals", budget: {}, gateAdvisory: false, targets: [], path: join(root, "suite.json") });
  const check = () => runCheck({ suite: suite(), outDir: join(root, "out"), journeysDir, requireApprovals: { allowedChannels: ["tty"], catalogDir } });

  it("check fails an mcp approval (exit 1)", async () => {
    const mcpDeps: McpApiDeps = { journeysDir, pathRoots: [root], runCli: makeInProcessCliRunner(() => buildProgram(deps())) };
    await buildMcpTools(mcpDeps).find((t) => t.name === "promote_journey")!.handler({ id: "loose" });
    expect((await check()).exitCode).toBe(1);
  });

  it("check fails a non-interactive approval, as an approval finding in SARIF", async () => {
    await cli(["journey", "promote", "loose", "--non-interactive-approval", "seed", "--json"]);
    const r = await check();
    expect(JSON.parse(await readFile(r.sarifPath, "utf8")).runs[0].results.map((x: { ruleId: string }) => x.ruleId)).toEqual(["jevitate/approval/approval-channel"]);
  });

  it("…and in JUnit", async () => {
    await cli(["journey", "promote", "loose", "--non-interactive-approval", "seed", "--json"]);
    expect(await readFile((await check()).junitPath, "utf8")).toContain('classname="jevitate.approvals.approvals"');
  });

  it("check passes a tty approval", async () => {
    await cli(["journey", "promote", "loose", "--json"], person(["loose"]));
    expect((await check()).exitCode).toBe(0);
  });

  it("a stale approval fails", async () => {
    await cli(["journey", "promote", "loose", "--json"], person(["loose"]));
    const j = (await stored("loose"))!;
    await new FsJourneyStore(journeysDir).put({ ...j, metadata: { ...j.metadata, name: "renamed" } });
    expect(approvalsReport([await loadCatalog(catalogDir, journeysDir)], ["tty"]).requirement?.violations.map((v) => v.problem)).toEqual(["stale"]);
  });

  it("a promoted Journey with no approval fails", async () => {
    await new FsJourneyStore(journeysDir).put({ ...journey("old"), metadata: { ...journey("old").metadata, promoted: true } });
    expect(approvalsReport([await loadCatalog(catalogDir, journeysDir)], ["tty"]).requirement?.violations.map((v) => v.problem)).toEqual(["missing"]);
  });

  it("--allow-channels lets a non-interactive approval pass", async () => {
    await cli(["journey", "promote", "loose", "--non-interactive-approval", "seed", "--json"]);
    expect((await runCheck({ suite: suite(), outDir: join(root, "out"), journeysDir, requireApprovals: { allowedChannels: ["tty", "non-interactive"], catalogDir } })).exitCode).toBe(0);
  });

  it("catalog status --require-approvals exits 1 on a non-interactive approval", async () => {
    await cli(["persona", "approve", "editor", "--non-interactive-approval", "seed", "--json"]);
    expect((await cli(["catalog", "status", "--require-approvals", "--json"])).code).toBe(1);
  });

  it("catalog status lists how each approval was made", async () => {
    await cli(["persona", "approve", "editor", "--non-interactive-approval", "seed", "--json"], { ...NO_TTY, env: { CLAUDECODE: "1" } });
    expect((await cli(["catalog", "status"])).out).toContain("persona editor: approved non-interactively (likely an agent: CLAUDECODE)");
  });

  it("an unknown channel is refused (exit 64)", async () => {
    expect((await cli(["catalog", "status", "--require-approvals", "--allow-channels", "email", "--json"])).code).toBe(64);
  });

  it("the review hash is unchanged by the provenance", async () => {
    const before = journeyReviewHash((await stored("loose"))!);
    await cli(["journey", "promote", "loose", "--json"], person(["loose"]));
    expect(journeyReviewHash((await stored("loose"))!)).toBe(before);
  });
});

describe("#437 init --codeowners", () => {
  async function repo(): Promise<string> {
    const r = join(root, "repo");
    await mkdir(join(r, ".git"), { recursive: true });
    return r;
  }

  it("the CODEOWNERS block is idempotent", async () => {
    const r = await repo();
    await installCodeowners(r, "@acme/qa");
    const first = await readFile(join(r, ".github", "CODEOWNERS"), "utf8");
    const again = await installCodeowners(r, "@acme/qa");
    expect([again.action, await readFile(join(r, ".github", "CODEOWNERS"), "utf8")]).toEqual(["unchanged", first]);
  });

  it("merges into an existing root CODEOWNERS, keeping its rules", async () => {
    const r = await repo();
    await writeFile(join(r, "CODEOWNERS"), "* @acme/dev\n");
    await installCodeowners(r, "@acme/qa @alice");
    expect(await readFile(join(r, "CODEOWNERS"), "utf8")).toBe(
      `* @acme/dev\n\n${CODEOWNERS_BLOCK_BEGIN}\n# jevitate approvals (#437): promoted Journeys, catalog personas and jobs, and their approval\n# records need a code owner's review. Enable branch protection with "Require review from Code\n# Owners" on the forge, or this block is advisory. Later rules in this file override these.\n/.jevitate/journeys/ @acme/qa @alice\n/.jevitate/personas.json @acme/qa @alice\n/.jevitate/jobs.json @acme/qa @alice\n# END JEVITATE CODEOWNERS v1\n`,
    );
  });

  it("refuses malformed markers", async () => {
    const r = await repo();
    await writeFile(join(r, "CODEOWNERS"), `${CODEOWNERS_BLOCK_BEGIN}\n/x @a\n`);
    await expect(installCodeowners(r, "@acme/qa")).rejects.toBeInstanceOf(CodeownersArgsError);
  });

  it("refuses a malformed owner", async () => {
    await expect(installCodeowners(await repo(), "acme qa")).rejects.toBeInstanceOf(CodeownersArgsError);
  });

  it("init --codeowners prints the branch-protection note", async () => {
    const r = await repo();
    const out = await cli(["init", "--skip-keys", "--skip-skills", "--skip-mcp", "--codeowners", "@acme/qa"], NO_TTY, { init: { detection: { cwd: () => r } } });
    expect(out.out).toContain("Require review from Code Owners");
  });
});
