import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeClock, installClock, resetClock } from "@jevitate/domain";
import { JobSchema, type PrReview } from "@jevitate/journey";
import { jobContentHash } from "./catalog.js";
import {
  catalogItemEntry,
  forgeContextFromEnv,
  GITHUB_API_BASE,
  GitHubForge,
  PrReviewCache,
  reverifyPrReview,
  reverifyPrReviewCached,
  verifyPrReviewForApproval,
  type FetchFn,
  type ForgePort,
  type ForgePull,
  type ForgeCommitPeople,
  type ForgeReview,
  type PrReviewEntry,
} from "./forge-verify.js";
import { codeownersOf, parseCodeownersFile } from "./init-codeowners.js";
import { ProfileManager } from "@jevitate/daemon";
import { FsJourneyStore } from "@jevitate/journey";
import { buildProgram } from "./program.js";
import { buildMcpTools, type McpApiDeps } from "./mcp-api.js";
import { makeInProcessCliRunner } from "./mcp-cli-runner.js";
import { runCheck } from "./check-api.js";
import type { ApprovalDeps } from "./approval-provenance.js";
import type { CliDeps } from "./cli-shared.js";

/** #469 — the pr-review channel's forge verification, against an in-memory forge. No network. */

const TOKEN = "ghs_0123456789abcdefTOKENVALUE";
const JOBS = ".jevitate/jobs.json";
const sha = (c: string): string => c.repeat(40);
const C1 = sha("1"); // root: the job's first version (pushed directly)
const C2 = sha("2"); // PR #7 by alice: changes the job
const C3 = sha("3"); // a later commit that does not touch jobs.json
const HEAD7 = sha("9"); // PR #7's head commit
const OFF = sha("8"); // a commit not on main

function jobsFile(outcome: string): string {
  return JSON.stringify([{ id: "checkout", trigger: "a cart is full", motivation: "pay", outcome, personas: ["shopper"] }]);
}
const hashOf = (outcome: string): string => jobContentHash(JobSchema.parse(JSON.parse(jobsFile(outcome))[0]));

interface FakeCommit {
  readonly parents: string[];
  readonly files: Record<string, string>;
}

/** An in-memory GitHub: commits, the main line, pull requests, reviews, permissions, teams. */
class FakeForge implements ForgePort {
  calls = 0;
  branch = "main";
  commits = new Map<string, FakeCommit>([
    [C1, { parents: [], files: { [JOBS]: jobsFile("v0") } }],
    [C2, { parents: [C1], files: { [JOBS]: jobsFile("v1") } }],
    [C3, { parents: [C2], files: { [JOBS]: jobsFile("v1"), "README.md": "hi" } }],
    [OFF, { parents: [C3], files: { [JOBS]: jobsFile("v1") } }],
  ]);
  main = [C3, C2, C1];
  pulls: Record<string, ForgePull[]> = { [C2]: [{ number: 7, url: "https://github.com/acme/shop/pull/7", mergedAt: "2026-10-01T00:00:00Z", baseRef: "main", headSha: HEAD7, author: "alice" }] };
  reviewList: Record<number, ForgeReview[]> = { 7: [{ login: "bob", isBot: false, state: "APPROVED", commitId: HEAD7, submittedAt: "2026-09-30T00:00:00Z" }] };
  prCommits: Record<number, ForgeCommitPeople[]> = { 7: [{ authorLogin: "alice", authorId: 1, committerLogin: "web-flow", committerId: 19864447 }] };
  perms: Record<string, string> = { bob: "write", alice: "admin", carol: "write" };
  teams: Record<string, string[]> = {};
  async defaultBranch(): Promise<string> {
    this.calls++;
    return this.branch;
  }
  async commitsTouching(path: string, _ref: string, limit: number): Promise<string[]> {
    this.calls++;
    return this.main.filter((s) => {
      const c = this.commits.get(s) as FakeCommit;
      const parent = c.parents[0] === undefined ? undefined : this.commits.get(c.parents[0]);
      return c.files[path] !== parent?.files[path];
    }).slice(0, limit);
  }
  async commitParents(s: string): Promise<string[]> {
    this.calls++;
    return this.commits.get(s)?.parents ?? [];
  }
  async fileAt(path: string, ref: string): Promise<string | null> {
    this.calls++;
    const s = ref === this.branch ? this.main[0] : ref;
    return this.commits.get(s as string)?.files[path] ?? null;
  }
  async isAncestor(s: string): Promise<boolean> {
    this.calls++;
    return this.main.includes(s);
  }
  async pullsForCommit(s: string): Promise<ForgePull[]> {
    this.calls++;
    return this.pulls[s] ?? [];
  }
  async reviews(n: number): Promise<ForgeReview[]> {
    this.calls++;
    return this.reviewList[n] ?? [];
  }
  async pullCommits(n: number): Promise<ForgeCommitPeople[]> {
    this.calls++;
    return this.prCommits[n] ?? [];
  }
  async permission(login: string): Promise<string> {
    this.calls++;
    return this.perms[login] ?? "none";
  }
  async teamMember(org: string, team: string, login: string): Promise<boolean> {
    this.calls++;
    return (this.teams[`${org}/${team}`] ?? []).includes(login);
  }
}

const CI_ENV = { GITHUB_ACTIONS: "true", CI: "true", GITHUB_REPOSITORY: "acme/shop", GITHUB_TOKEN: TOKEN, GITHUB_EVENT_NAME: "push", GITHUB_REF: "refs/heads/main" };
const RECORDED: PrReview = { forge: "github", number: 7, mergedSha: C2, author: "alice", reviewer: "bob" };

let root: string;
let forge: FakeForge;
let entry: PrReviewEntry;
const approve = (env: Record<string, string | undefined> = CI_ENV, e: PrReviewEntry = entry) => verifyPrReviewForApproval(e, env, () => forge, { requireCodeOwner: env.JEVITATE_PR_REVIEW_REQUIRE_CODEOWNER === "1" });
const reverify = (pr: PrReview = RECORDED) => reverifyPrReview(entry, pr, CI_ENV, () => forge, {});

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "jev-469-"));
  await mkdir(join(root, ".git"));
  forge = new FakeForge();
  entry = catalogItemEntry("job", join(root, ".jevitate", "jobs.json"), "checkout", hashOf("v1"));
  installClock(new FakeClock({ startMs: Date.parse("2026-10-09T12:00:00.000Z") }));
});

afterEach(() => resetClock());

describe("#469 the CI context", () => {
  it("is refused outside GitHub Actions", () => {
    expect(forgeContextFromEnv({ CI: "true", GITHUB_TOKEN: TOKEN }).ok).toBe(false);
  });

  it("refuses GitHub Enterprise (the API base is pinned)", () => {
    expect(forgeContextFromEnv({ ...CI_ENV, GITHUB_API_URL: "https://ghe.example.com/api/v3" })).toMatchObject({ code: "not-github" });
  });

  it("needs GITHUB_TOKEN from the CI environment", () => {
    expect(forgeContextFromEnv({ ...CI_ENV, GITHUB_TOKEN: undefined })).toMatchObject({ code: "no-token" });
  });
});

describe("#469 verifying an approval in CI", () => {
  it("grants pr-review for a merged PR approved on its head by another person with write access", async () => {
    expect(await approve()).toEqual({ ok: true, pr: { forge: "github", number: 7, url: "https://github.com/acme/shop/pull/7", mergedSha: C2, author: "alice", reviewer: "bob", reviewedAt: "2026-09-30T00:00:00Z" } });
  });

  it("refuses on a pull_request event", async () => {
    expect(await approve({ ...CI_ENV, GITHUB_EVENT_NAME: "pull_request" })).toMatchObject({ code: "pull-request-event" });
  });

  it("refuses off the default branch", async () => {
    expect(await approve({ ...CI_ENV, GITHUB_REF: "refs/heads/feature" })).toMatchObject({ code: "not-default-branch" });
  });

  it("refuses when the default branch holds other content than the one approved", async () => {
    expect(await approve(CI_ENV, catalogItemEntry("job", entry.file, "checkout", hashOf("v2")))).toMatchObject({ code: "content-mismatch" });
  });

  it("refuses a change pushed without a pull request", async () => {
    forge.pulls = {};
    expect(await approve()).toMatchObject({ code: "no-merged-pr" });
  });

  it("refuses a pull request that was not merged", async () => {
    forge.pulls[C2] = [{ ...(forge.pulls[C2]?.[0] as ForgePull), mergedAt: null }];
    expect(await approve()).toMatchObject({ code: "no-merged-pr" });
  });

  it("refuses a pull request merged into another branch", async () => {
    forge.pulls[C2] = [{ ...(forge.pulls[C2]?.[0] as ForgePull), baseRef: "release" }];
    expect(await approve()).toMatchObject({ code: "no-merged-pr" });
  });

  it("refuses the author's own approval", async () => {
    forge.reviewList[7] = [{ login: "alice", isBot: false, state: "APPROVED", commitId: HEAD7 }];
    expect(await approve()).toMatchObject({ code: "no-approving-review" });
  });

  it("refuses an approval of an earlier commit than the PR's head", async () => {
    forge.reviewList[7] = [{ login: "bob", isBot: false, state: "APPROVED", commitId: C1 }];
    expect(await approve()).toMatchObject({ code: "no-approving-review" });
  });

  it("refuses a bot's approval", async () => {
    forge.reviewList[7] = [{ login: "helper[bot]", isBot: true, state: "APPROVED", commitId: HEAD7 }];
    expect(await approve()).toMatchObject({ code: "no-approving-review" });
  });

  it("refuses a reviewer who committed to the PR", async () => {
    forge.prCommits[7] = [...(forge.prCommits[7] ?? []), { authorLogin: "alice", committerLogin: "bob" }];
    expect(await approve()).toMatchObject({ code: "reviewer-contributed" });
  });

  it("refuses a reviewer who authored a PR commit, matched by user id", async () => {
    forge.reviewList[7] = [{ login: "bob", userId: 42, isBot: false, state: "APPROVED", commitId: HEAD7 }];
    forge.prCommits[7] = [{ authorId: 42 }];
    expect(await approve()).toMatchObject({ code: "reviewer-contributed" });
  });

  it("grants a reviewer who only reviewed, beside commits with no linked GitHub user", async () => {
    forge.prCommits[7] = [{ authorLogin: "alice" }, {}];
    expect((await approve()).ok).toBe(true);
  });

  it("refuses a reviewer without write access", async () => {
    forge.perms.bob = "read";
    expect(await approve()).toMatchObject({ code: "no-approving-review" });
  });

  it("refuses an approval the reviewer later replaced with requested changes", async () => {
    forge.reviewList[7] = [...(forge.reviewList[7] ?? []), { login: "bob", isBot: false, state: "CHANGES_REQUESTED", commitId: HEAD7 }];
    expect(await approve()).toMatchObject({ code: "no-approving-review" });
  });

  it("with the CODEOWNER requirement, refuses a reviewer who is not a code owner", async () => {
    forge.commits.get(C3)!.files[".github/CODEOWNERS"] = "/.jevitate/jobs.json @carol\n";
    expect(await approve({ ...CI_ENV, JEVITATE_PR_REVIEW_REQUIRE_CODEOWNER: "1" })).toMatchObject({ code: "not-code-owner" });
  });

  it("with the CODEOWNER requirement, grants a reviewer who owns the path through a team", async () => {
    forge.commits.get(C3)!.files[".github/CODEOWNERS"] = "* @acme/other\n/.jevitate/ @acme/qa\n";
    forge.teams["acme/qa"] = ["bob"];
    expect(await approve({ ...CI_ENV, JEVITATE_PR_REVIEW_REQUIRE_CODEOWNER: "1" })).toMatchObject({ ok: true, pr: { codeOwner: true } });
  });
});

describe("#469 re-verifying a recorded pr-review", () => {
  it("confirms the recorded PR, merged sha and reviewer", async () => {
    expect((await reverify()).ok).toBe(true);
  });

  it("refuses a reviewer who did not approve the PR", async () => {
    expect(await reverify({ ...RECORDED, reviewer: "carol" })).toMatchObject({ code: "no-approving-review" });
  });

  it("refuses a recorded commit that did not change the entry", async () => {
    forge.pulls[C3] = forge.pulls[C2] ?? [];
    expect(await reverify({ ...RECORDED, mergedSha: C3 })).toMatchObject({ code: "not-changed-here" });
  });

  it("refuses a recorded reviewer who committed to the PR", async () => {
    forge.prCommits[7] = [{ committerLogin: "Bob" }];
    expect(await reverify()).toMatchObject({ code: "reviewer-contributed" });
  });

  it("refuses a PR number the commit did not come from", async () => {
    expect(await reverify({ ...RECORDED, number: 8 })).toMatchObject({ code: "pr-mismatch" });
  });

  it("refuses a recorded commit that is not on the default branch", async () => {
    expect(await reverify({ ...RECORDED, mergedSha: OFF })).toMatchObject({ code: "not-on-default-branch" });
  });

  it("refuses when the forge cannot be asked (no token): never a pass", async () => {
    expect(await reverifyPrReview(entry, RECORDED, { ...CI_ENV, GITHUB_TOKEN: "" }, () => forge)).toMatchObject({ ok: false, code: "no-token" });
  });
});

describe("#469 the re-verification cache", () => {
  const cacheDir = () => join(root, ".jevitate", "cache", "pr-review");

  it("a second re-verification of the same record asks the forge nothing", async () => {
    const cache = new PrReviewCache(cacheDir(), async () => false);
    await reverifyPrReviewCached(entry, RECORDED, CI_ENV, cache, () => forge);
    forge.calls = 0;
    await reverifyPrReviewCached(entry, RECORDED, CI_ENV, new PrReviewCache(cacheDir(), async () => false), () => forge);
    expect(forge.calls).toBe(0);
  });

  it("is not trusted when git tracks a file in it", async () => {
    await reverifyPrReviewCached(entry, RECORDED, CI_ENV, new PrReviewCache(cacheDir(), async () => false), () => forge);
    forge.calls = 0;
    await reverifyPrReviewCached(entry, RECORDED, CI_ENV, new PrReviewCache(cacheDir(), async () => true), () => forge);
    expect(forge.calls).toBeGreaterThan(0);
  });

  it("is never written on a pull_request event", async () => {
    await reverifyPrReviewCached(entry, RECORDED, { ...CI_ENV, GITHUB_EVENT_NAME: "pull_request" }, new PrReviewCache(cacheDir(), async () => false), () => forge);
    expect(await readdir(cacheDir()).catch(() => [])).toEqual([]);
  });

  it("does not cache a refusal", async () => {
    forge.reviewList[7] = [];
    await reverifyPrReviewCached(entry, RECORDED, CI_ENV, new PrReviewCache(cacheDir(), async () => false), () => forge);
    expect(await readdir(cacheDir()).catch(() => [])).toEqual([]);
  });
});

describe("#469 the GitHub forge", () => {
  const recordingFetch = (urls: string[], status = 200, body = '{"default_branch":"main"}'): FetchFn => async (url) => {
    urls.push(url);
    return { status, text: async () => body };
  };

  it("talks to https://api.github.com only", async () => {
    const urls: string[] = [];
    await new GitHubForge("acme/shop", TOKEN, recordingFetch(urls)).defaultBranch();
    expect(urls.every((u) => u.startsWith(`${GITHUB_API_BASE}/`))).toBe(true);
  });

  it("scrubs the token from a failure's reason", async () => {
    const failing: FetchFn = async () => {
      throw new Error(`connect failed for Bearer ${TOKEN}`);
    };
    const v = await verifyPrReviewForApproval(entry, CI_ENV, (ctx) => new GitHubForge(ctx.repo, ctx.token, failing));
    expect(!v.ok && v.code === "forge-error" && !v.reason.includes(TOKEN)).toBe(true);
  });

  it("refuses a repository name that is not owner/repo", () => {
    expect(() => new GitHubForge("acme/shop/../x", TOKEN)).toThrow(/not a GitHub repository/);
  });
});

describe("#469 reading CODEOWNERS", () => {
  const rules = parseCodeownersFile("# owners\n* @acme/all\n/.jevitate/ @acme/qa  # the catalog\ndocs/*.md @writer\n");

  it("the last matching rule wins", () => {
    expect(codeownersOf(rules, ".jevitate/jobs.json")).toEqual(["@acme/qa"]);
  });

  it("an anchored directory does not match the same name deeper", () => {
    expect(codeownersOf(rules, "pkg/.jevitate/jobs.json")).toEqual(["@acme/all"]);
  });

  it("a single star stays within one segment", () => {
    expect(codeownersOf(rules, "docs/api/x.md")).toEqual(["@acme/all"]);
  });
});

// ── Through the CLI: job approve in CI, catalog status / check --require-approvals, MCP ─────────

describe("#469 the CLI", () => {
  let catalogDir: string;
  let notices: string[];

  const ci = (env: Record<string, string | undefined> = CI_ENV): ApprovalDeps => ({
    env,
    stdinIsTTY: () => false,
    stdoutIsTTY: () => false,
    user: () => "runner",
    forge: () => forge,
    notice: (l) => notices.push(l),
    gitTracked: async () => false,
  });

  function cliDeps(approval: ApprovalDeps): CliDeps {
    return { profiles: new ProfileManager(join(root, "profiles")), journeysDir: join(catalogDir, "journeys"), catalogDir, dbPath: join(root, "site.sqlite"), explore: { targetsConfigPath: join(root, "no-targets.json") }, approval };
  }

  async function cli(argv: readonly string[], approval: ApprovalDeps = ci()): Promise<{ json: any; code: number | undefined }> {
    const lines: string[] = [];
    const program = buildProgram(cliDeps(approval));
    program.configureOutput({ writeOut: (x) => lines.push(x), writeErr: () => {} });
    program.exitOverride();
    process.exitCode = undefined;
    await program.parseAsync([...argv], { from: "user" });
    let json: any;
    try {
      json = JSON.parse(lines.join(""));
    } catch {
      json = undefined;
    }
    return { json, code: process.exitCode === undefined ? undefined : Number(process.exitCode) };
  }

  const approvedJob = async (): Promise<any> => JSON.parse(await readFile(join(catalogDir, "jobs.json"), "utf8"))[0].approval;

  /** A jobs.json whose approval record CLAIMS a pr-review — written by hand, not by jevitate. */
  async function handWritten(pr: PrReview = RECORDED): Promise<void> {
    const job = JSON.parse(jobsFile("v1"))[0];
    await writeFile(join(catalogDir, "jobs.json"), JSON.stringify([{ ...job, approval: { contentHash: hashOf("v1"), at: "2026-10-01T00:00:00Z", provenance: { channel: "pr-review", agentSignals: [], pr } } }]));
  }

  beforeEach(async () => {
    notices = [];
    catalogDir = join(root, ".jevitate");
    await mkdir(catalogDir, { recursive: true });
    await writeFile(join(catalogDir, "personas.json"), JSON.stringify([{ id: "shopper", description: "buys things", role: "customer" }]));
    await writeFile(join(catalogDir, "jobs.json"), jobsFile("v1"));
  });

  afterEach(() => {
    process.exitCode = undefined;
  });

  it("job approve in CI records pr-review with the verified PR and reviewer", async () => {
    await cli(["job", "approve", "checkout", "--json"]);
    expect((await approvedJob()).provenance).toMatchObject({ channel: "pr-review", pr: { number: 7, reviewer: "bob", mergedSha: C2 } });
  });

  it("when verification fails, the escape hatch records ci as before", async () => {
    forge.pulls = {};
    await cli(["job", "approve", "checkout", "--non-interactive-approval", "seed", "--json"]);
    expect((await approvedJob()).provenance.channel).toBe("ci");
  });

  it("…and says why pr-review was not granted", async () => {
    forge.pulls = {};
    await cli(["job", "approve", "checkout", "--non-interactive-approval", "seed", "--json"]);
    expect(notices.join("\n")).toContain("pr-review not granted for job 'checkout'");
  });

  it("without the escape hatch it is refused for a person, with the reason", async () => {
    forge.pulls = {};
    expect((await cli(["job", "approve", "checkout", "--json"])).json.error.message).toContain("did not come from a pull request merged into main");
  });

  it("an MCP approval never asks the forge (it stays an agent's approval)", async () => {
    await new FsJourneyStore(join(catalogDir, "journeys")).put({
      metadata: { id: "pay", name: "Pay", promoted: false, params: [], createdAtIso: "2026-09-19T00:00:00Z", endState: [{ kind: "reloadThen", assertion: { kind: "textIncludes", target: { testId: "live" }, text: "paid" } }] },
      recording: { version: "1.0.0", site: "https://example.test", pages: [{ url: "/cart", steps: [{ step: { kind: "click", target: { testId: "pay" }, expect: { kind: "textIncludes", target: { role: "status" }, text: "Paid" } }, expectRequests: [{ kind: "responseStatus", method: "POST", pathGlob: "/api/pay", status: { class: 2 } }] }] }] },
    });
    const mcpDeps: McpApiDeps = { journeysDir: join(catalogDir, "journeys"), pathRoots: [root], runCli: makeInProcessCliRunner(() => buildProgram(cliDeps(ci()))) };
    forge.calls = 0;
    await buildMcpTools(mcpDeps).find((t) => t.name === "promote_journey")!.handler({ id: "pay" });
    expect(forge.calls).toBe(0);
  });

  it("MCP has no tool that approves a persona or a job", () => {
    const mcpDeps: McpApiDeps = { journeysDir: join(catalogDir, "journeys"), pathRoots: [root], runCli: makeInProcessCliRunner(() => buildProgram(cliDeps(ci()))) };
    expect(buildMcpTools(mcpDeps).map((t) => t.name).filter((n) => /approve_(job|persona)/.test(n))).toEqual([]);
  });

  it("no approve option sets a channel or a pull request", () => {
    const program = buildProgram(cliDeps(ci()));
    const longs = ["job", "persona"].flatMap((g) => program.commands.find((c) => c.name() === g)!.commands.find((c) => c.name() === "approve")!.options.map((o) => o.long ?? ""));
    expect(longs.filter((l) => /channel|^--pr\b|^--pr-|forge|reviewer|merged/.test(l))).toEqual([]);
  });

  it("catalog status honours a pr-review the forge confirms", async () => {
    await handWritten();
    expect((await cli(["catalog", "status", "--require-approvals", "--allow-channels", "pr-review", "--json"])).code).toBe(0);
  });

  it("a hand-written pr-review the forge does not confirm is unverified, even with pr-review allowed", async () => {
    await handWritten({ ...RECORDED, reviewer: "carol" });
    expect((await cli(["catalog", "status", "--require-approvals", "--allow-channels", "pr-review", "--json"])).json.data.approvals.requirement.violations.map((v: { problem: string }) => v.problem)).toEqual(["unverified"]);
  });

  it("with no forge to ask (outside CI) a pr-review is unverified, never a pass", async () => {
    await handWritten();
    expect((await cli(["catalog", "status", "--require-approvals", "--allow-channels", "pr-review", "--json"], ci({}))).code).toBe(1);
  });

  it("check --require-approvals fails a pr-review it cannot re-verify", async () => {
    await handWritten();
    const suite = { version: 1 as const, name: "approvals", budget: {}, gateAdvisory: false, targets: [], path: join(root, "suite.json") };
    expect((await runCheck({ suite, outDir: join(root, "out"), journeysDir: join(catalogDir, "journeys"), requireApprovals: { allowedChannels: ["pr-review"], catalogDir } })).exitCode).toBe(1);
  });

  describe("check --require-approvals through an injected forge", () => {
    const suite = () => ({ version: 1 as const, name: "approvals", budget: {}, gateAdvisory: false, targets: [], path: join(root, "suite.json") });
    const check = () =>
      runCheck({
        suite: suite(),
        outDir: join(root, "out"),
        journeysDir: join(catalogDir, "journeys"),
        requireApprovals: { allowedChannels: ["pr-review"], catalogDir },
        approvalVerification: { env: CI_ENV, forge: () => forge, gitTracked: async () => false },
      });

    it("honours a pr-review the forge confirms (exit 0)", async () => {
      await handWritten();
      expect((await check()).exitCode).toBe(0);
    });

    it("a pr-review the forge does not confirm is an approval-unverified finding in check.json", async () => {
      await handWritten({ ...RECORDED, reviewer: "carol" });
      const json = JSON.parse(await readFile((await check()).jsonPath, "utf8"));
      expect(json.data.findings.map((f: { identity: { signal: string }; gating: boolean }) => [f.identity.signal, f.gating])).toEqual([["approval-unverified", true]]);
    });

    it("…an approval-unverified SARIF error", async () => {
      await handWritten({ ...RECORDED, reviewer: "carol" });
      const sarif = JSON.parse(await readFile((await check()).sarifPath, "utf8"));
      expect(sarif.runs[0].results.map((r: { ruleId: string; level: string }) => `${r.ruleId} ${r.level}`)).toEqual(["jevitate/approval/approval-unverified error"]);
    });

    it("…and a JUnit failure on the approvals item", async () => {
      await handWritten({ ...RECORDED, reviewer: "carol" });
      expect(await readFile((await check()).junitPath, "utf8")).toMatch(/<failure message="1 gating finding\(s\): job &apos;checkout&apos;[^"]*not confirmed by the forge[^"]*" type="approval">/);
    });
  });
});
