import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { existsSync } from "node:fs";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Command, CommanderError } from "commander";
import { ProfileManager } from "@jevitate/daemon";
import { FsJourneyStore, JourneyRegistry, flatJourneySteps } from "@jevitate/journey";
import { PlaywrightBrowserPort } from "@jevitate/playwright";
import { COMMENT_BY_ID, SEED_COMMENTS } from "../../../test/fixtures/bizops-community/data.js";
import { startBizopsCommunity } from "../../../test/fixtures/bizops-community/server.js";
import { useSkippingTime } from "../../explore/src/testkit.js";
import type { ResolvedJourneyEnvironment } from "./environments.js";
import { buildProgram } from "./program.js";
import { BundleStaleError, buildJourneyBundle, checkJourneyBundle } from "./journey-bundle.js";
import { runJourneyReadiness, type ReadinessCheck, type ReadinessReceipt } from "./journey-readiness.js";
import { runJourneyChain, type JourneyChainResult } from "./journey-chain.js";
import { runJourneyProgrammatically } from "./journey-api.js";

// #304: Node and page time skip idle waits; the real Chromium assertions are unchanged.
useSkippingTime({ per: "all" });

/**
 * #0.18.0 served ergonomics acceptance: the #581 readiness, #582 handoff, #583 handback, #584 bundle
 * and #585 layout surfaces, end to end in real Chromium against the offline Bizops fixture. The
 * fixture server starts once per file; every test drives the public API (`runJourneyReadiness`,
 * `runJourneyChain`, `runJourneyProgrammatically`, `buildJourneyBundle`/`checkJourneyBundle`,
 * `resolveLayout` through `buildProgram`) over a temp copy of the fixture's `.jevitate/`, so the
 * repo is never written to. One behavioural assertion per test.
 */

const FIXTURE_JEVIATE = fileURLToPath(new URL("../../../test/fixtures/bizops-community/.jevitate", import.meta.url));

/** A temp copy of the fixture project: `<root>/project/.jevitate` holds the catalog and Journeys. */
interface TempProject {
  readonly root: string;
  readonly project: string;
  readonly projectDir: string;
  readonly journeysDir: string;
  readonly catalogDir: string;
}

async function copyFixtureProject(prefix: string): Promise<TempProject> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  const project = join(root, "project");
  const projectDir = join(project, ".jevitate");
  await cp(FIXTURE_JEVIATE, projectDir, { recursive: true });
  return { root, project, projectDir, journeysDir: join(projectDir, "journeys"), catalogDir: projectDir };
}

let app: Awaited<ReturnType<typeof startBizopsCommunity>>;
let served: TempProject;

beforeAll(async () => {
  app = await startBizopsCommunity();
  served = await copyFixtureProject("jev-ergonomics-served-");
});

afterAll(async () => {
  await app.close();
  await rm(served.root, { recursive: true, force: true });
});

/** The live fixture origin, and nothing else (as `bizops-workflow-served`). */
function environment(): ResolvedJourneyEnvironment {
  return { baseUrl: app.url, allowedOrigins: [app.url], source: "bizops-community fixture" };
}

/** Real Chromium, with the testkit's skipping clock already wrapping the port. */
const browserPort = (): PlaywrightBrowserPort => new PlaywrightBrowserPort();

/** The three approved requests: three different replies, one multiline, across three records. */
const VALID_REQUESTS = [
  { commentId: "c-2041", account: "mcpl", replyText: "The crew can still start on the ninth; we will confirm the freight lift." },
  { commentId: "c-1007", account: "personal", replyText: "Tuesday works for the panels.\nWe will book the lift for the ninth." },
  { commentId: "c-4520", account: "personal", replyText: "Yes — the season pass covers the Fictional Forge workshop." },
] as const;

const validLines = `${VALID_REQUESTS.map((r) => JSON.stringify(r)).join("\n")}\n`;

/** Two matched requests, one missing its replyText, and one matching no record. */
const MIXED_LINES = `${[
  VALID_REQUESTS[0],
  VALID_REQUESTS[1],
  { commentId: "c-4520", account: "personal" },
  { commentId: "c-9999", account: "personal", replyText: "No such record." },
]
  .map((r) => JSON.stringify(r))
  .join("\n")}\n`;

/** A correct record's §3 params, read from the seeded fixture data (never hard-coded). */
function recordParams(commentId: string, replyText: string, overrides: Readonly<Record<string, string>> = {}): Record<string, string> {
  const seed = COMMENT_BY_ID.get(commentId);
  if (seed === undefined) throw new Error(`no seeded comment ${commentId}`);
  return {
    commentId,
    replyIdentity: seed.comment.account,
    threadId: seed.thread.id,
    expected_commentid: commentId,
    expected_account: seed.comment.account,
    expected_sourcetext: seed.comment.text,
    replyText,
    ...overrides,
  };
}

/** A prepare-reply step's number as a person counts it (1-based, matching `handback.evidence.failedAt`). */
async function stepNumber(journeysDir: string, stepId: string): Promise<number> {
  const journey = await new JourneyRegistry(new FsJourneyStore(journeysDir)).get("prepare-reply");
  if (journey === null) throw new Error("prepare-reply is not in the fixture journeys");
  const step = flatJourneySteps(journey).find((s) => s.recorded.stepId === stepId);
  if (step === undefined) throw new Error(`prepare-reply has no ${stepId} step`);
  return step.index + 1;
}

function checkOf(receipt: ReadinessReceipt, check: string, id: string): ReadinessCheck | undefined {
  return receipt.checks.find((c) => c.check === check && c.journey === id);
}

// ── #583 prepare-only handback ────────────────────────────────────────────────────────────────────

describe("#583 prepare-reply ends at a prepared handback (served)", () => {
  let correct: Awaited<ReturnType<typeof runJourneyProgrammatically>>;
  let wrong: Awaited<ReturnType<typeof runJourneyProgrammatically>>;
  let commentCheckStep = 0;

  beforeAll(async () => {
    commentCheckStep = await stepNumber(served.journeysDir, "s-source-comment");
    correct = await runJourneyProgrammatically({
      dir: served.journeysDir,
      id: "prepare-reply",
      params: recordParams("c-2041", "An approved reply for the pier thread."),
      environment: environment(),
      browserPortFactory: browserPort,
    });
    wrong = await runJourneyProgrammatically({
      dir: served.journeysDir,
      id: "prepare-reply",
      params: recordParams("c-2041", "An approved reply for the pier thread.", { expected_commentid: "c-4520" }),
      environment: environment(),
      browserPortFactory: browserPort,
    });
  });

  it("classifies a correct record as prepared", () => {
    expect(correct.handback?.state).toBe("prepared");
  });

  it("shows the boundary's human next step when prepared", () => {
    expect(correct.handback?.nextStep).toBe("Read the prepared reply in Community, then click Send yourself.");
  });

  it("sends zero writes when prepared", () => {
    expect(correct.handback?.evidence.writes).toBe(0);
  });

  it("classifies a wrong expected_commentid as verification-failed", () => {
    expect(wrong.handback?.state).toBe("verification-failed");
  });

  it("names the comment-id check as the failed step, before the reply-text fill", () => {
    expect(wrong.handback?.evidence.failedAt).toBe(commentCheckStep);
  });

  it("submits nothing to the community site throughout", () => {
    expect(app.submissions()).toBe(0);
  });
});

// ── #582 typed handoff ────────────────────────────────────────────────────────────────────────────

describe("#582 the committed handoff chain (served)", () => {
  let result: JourneyChainResult;

  beforeAll(async () => {
    result = await runJourneyChain({
      from: "discover-conversations",
      to: "prepare-reply",
      requests: MIXED_LINES,
      dir: served.journeysDir,
      environment: environment(),
      browserPortFactory: browserPort,
    });
  });

  it("runs every matched request to ok", () => {
    expect(result.runs.map((r) => r.outcome)).toEqual(["ok", "ok"]);
  });

  it("stamps every run with the accepted contract", () => {
    expect(result.runs.map((r) => r.contract)).toEqual(["community-conversation@1", "community-conversation@1"]);
  });

  it("fingerprints every run with a sha256 digest", () => {
    expect(result.runs.every((r) => /^sha256:[0-9a-f]{64}$/.test(r.fingerprint ?? ""))).toBe(true);
  });

  it("stamps every run with a UTC capture time", () => {
    expect(result.runs.every((r) => (r.capturedAt ?? "").endsWith("Z"))).toBe(true);
  });

  it("rejects a request missing replyText as invalid-request with its field error", () => {
    expect(result.rejected).toContainEqual({ key: "c-4520\u0000personal", reason: "invalid-request", errors: [{ field: "replyText", code: "missing" }] });
  });

  it("lists a request whose key matches no record as unmatched", () => {
    expect(result.unmatched).toEqual([{ commentId: "c-9999", account: "personal" }]);
  });

  it("runs prepare-reply for none of the unmatched requests", () => {
    expect(result.runs.some((r) => r.commentId === "c-9999")).toBe(false);
  });

  it("echoes no reply text or seeded source text in its JSON", () => {
    const json = JSON.stringify(result);
    const texts = [...VALID_REQUESTS.map((r) => r.replyText), "No such record.", ...SEED_COMMENTS.map((s) => s.comment.text)];
    const leaked = texts.some((t) => [t, JSON.stringify(t).slice(1, -1)].some((form) => json.includes(form)));
    expect(leaked).toBe(false);
  });
});

// ── #581 readiness ────────────────────────────────────────────────────────────────────────────────

describe("#581 readiness report over the committed pair (served)", () => {
  let receipt: ReadinessReceipt;
  const chain = vi.fn(async () => ({ runs: [], unmatched: [] }) as JourneyChainResult);

  beforeAll(async () => {
    receipt = await runJourneyReadiness(
      { id: "discover-conversations", with: "prepare-reply", mode: "report", journeysDir: served.journeysDir, catalogDir: served.catalogDir, projectDir: served.projectDir },
      { chain: chain as unknown as NonNullable<Parameters<typeof runJourneyReadiness>[1]>["chain"] },
    );
  });

  it("reports the pair's handoff check pass", () => {
    expect(checkOf(receipt, "handoff", "discover-conversations")?.state).toBe("pass");
  });

  it("reports the consumer's prepare-only boundary check pass", () => {
    expect(checkOf(receipt, "boundary", "prepare-reply")?.state).toBe("pass");
  });

  it("lists the draft persona under awaitingHuman", () => {
    expect(receipt.awaitingHuman.some((a) => a.item === "persona:bizops-operator (draft)")).toBe(true);
  });

  it("lists the draft job under awaitingHuman", () => {
    expect(receipt.awaitingHuman.some((a) => a.item === "job:answer-community-comments (draft)")).toBe(true);
  });

  it("opens no browser in report mode", () => {
    expect(chain).not.toHaveBeenCalled();
  });
});

describe("#581 readiness replay over the committed pair (served)", () => {
  let receipt: ReadinessReceipt;

  beforeAll(async () => {
    receipt = await runJourneyReadiness({
      id: "discover-conversations",
      with: "prepare-reply",
      mode: "replay",
      baseUrl: app.url,
      requests: validLines,
      journeysDir: served.journeysDir,
      catalogDir: served.catalogDir,
      projectDir: served.projectDir,
    });
  });

  it("returns a passing replay check for the pair", () => {
    expect(checkOf(receipt, "replay", "discover-conversations")?.state).toBe("pass");
  });
});

describe("#581 readiness refuses a production target (served)", () => {
  let environmentsFile: string;

  beforeAll(async () => {
    environmentsFile = join(served.root, "environments.json");
    await writeFile(environmentsFile, JSON.stringify({ prod: { baseUrl: "https://prod.example.test", production: true } }));
  });

  it("refuses a production environment with E_READINESS_PRODUCTION", async () => {
    await expect(
      runJourneyReadiness(
        { id: "discover-conversations", with: "prepare-reply", mode: "replay", env: "prod", requests: validLines, journeysDir: served.journeysDir, catalogDir: served.catalogDir },
        { environmentsFile },
      ),
    ).rejects.toMatchObject({ code: "E_READINESS_PRODUCTION" });
  });

  it("starts no chain before refusing", async () => {
    const chain = vi.fn(async () => ({ runs: [], unmatched: [] }) as JourneyChainResult);
    await runJourneyReadiness(
      { id: "discover-conversations", with: "prepare-reply", mode: "replay", env: "prod", requests: validLines, journeysDir: served.journeysDir, catalogDir: served.catalogDir },
      { environmentsFile, chain: chain as unknown as NonNullable<Parameters<typeof runJourneyReadiness>[1]>["chain"] },
    ).catch(() => undefined);
    expect(chain).not.toHaveBeenCalled();
  });
});

// ── #584 review bundle ────────────────────────────────────────────────────────────────────────────

describe("#584 the local review bundle over the committed pair (served)", () => {
  let bundleRoot: TempProject;
  let outDir: string;
  let md: string;

  beforeAll(async () => {
    bundleRoot = await copyFixtureProject("jev-ergonomics-bundle-");
    outDir = join(bundleRoot.root, "bundle");
    await buildJourneyBundle({ id: "discover-conversations", with: "prepare-reply", out: outDir, journeysDir: bundleRoot.journeysDir, catalogDir: bundleRoot.catalogDir, projectDir: bundleRoot.projectDir });
    md = await readFile(join(outDir, "bundle.md"), "utf8");
  });

  afterAll(async () => {
    await rm(bundleRoot.root, { recursive: true, force: true });
  });

  it("writes bundle.md", () => {
    expect(existsSync(join(outDir, "bundle.md"))).toBe(true);
  });

  it("writes manifest.json", () => {
    expect(existsSync(join(outDir, "manifest.json"))).toBe(true);
  });

  it("lists the promote commands after the blockers under the blockers heading", () => {
    const after = md.slice(md.indexOf("## After the blockers are fixed"));
    expect(after).toContain("- jevitate journey promote discover-conversations\n");
  });

  it("omits a reviewed hash from the blocked promote commands", () => {
    const after = md.slice(md.indexOf("## After the blockers are fixed"));
    expect(after).not.toContain("--reviewed-hash");
  });

  it("passes on the freshly built bundle", async () => {
    expect(await checkJourneyBundle(outDir, { journeysDir: bundleRoot.journeysDir, catalogDir: bundleRoot.catalogDir })).toEqual({ stale: false });
  });

  it("reports E_BUNDLE_STALE after a Journey description edit", async () => {
    const file = join(bundleRoot.journeysDir, "discover-conversations.json");
    const journey = JSON.parse(await readFile(file, "utf8"));
    journey.metadata.goal = `${journey.metadata.goal} (edited)`;
    await writeFile(file, JSON.stringify(journey, null, 2));
    await expect(checkJourneyBundle(outDir, { journeysDir: bundleRoot.journeysDir, catalogDir: bundleRoot.catalogDir })).rejects.toBeInstanceOf(BundleStaleError);
  });
});

// ── #585 project layout through the CLI ───────────────────────────────────────────────────────────

interface Run {
  readonly code: number | undefined;
  readonly out: string;
  readonly err: string;
}

/**
 * The program's stdout/stderr and exit code for one invocation, run from `cwd`. The vitest browser
 * project runs on worker threads, where `process.chdir` is unsupported, so the working directory is
 * presented through `process.cwd` — the one seam `resolveLayout` (and `findProjectDir`) reads.
 */
async function runFrom(profilesRoot: string, cwd: string, argv: readonly string[]): Promise<Run> {
  const savedCwd = process.cwd;
  process.cwd = () => cwd;
  const stdout: string[] = [];
  const stderr: string[] = [];
  const program = buildProgram({ profiles: new ProfileManager(join(profilesRoot, "profiles")) });
  program.configureOutput({ writeOut: (s) => stdout.push(s), writeErr: (s) => stderr.push(s) });
  const override = (command: Command): void => {
    command.exitOverride();
    command.commands.forEach(override);
  };
  override(program);
  let code: number | undefined;
  try {
    await program.parseAsync([...argv], { from: "user" });
  } catch (err) {
    if (!(err instanceof CommanderError)) throw err;
    code = err.exitCode;
  } finally {
    process.cwd = savedCwd;
  }
  return { code, out: stdout.join(""), err: stderr.join("") };
}

describe("#585 project layout resolves the committed pair (served)", () => {
  let layoutRoot: TempProject;

  beforeAll(async () => {
    layoutRoot = await copyFixtureProject("jev-ergonomics-layout-");
  });

  afterAll(async () => {
    await rm(layoutRoot.root, { recursive: true, force: true });
  });

  it("journey list --project from an unrelated cwd lists both Journeys", async () => {
    const { out } = await runFrom(layoutRoot.root, layoutRoot.root, ["journey", "list", "--project", layoutRoot.project, "--json"]);
    expect(JSON.parse(out).data.map((m: { id: string }) => m.id).sort()).toEqual(["discover-conversations", "prepare-reply"]);
  });

  it("journey review content hash is identical from the project dir and an unrelated cwd", async () => {
    const discovered = await runFrom(layoutRoot.root, layoutRoot.project, ["journey", "review", "prepare-reply", "--json"]);
    const viaFlag = await runFrom(layoutRoot.root, layoutRoot.root, ["journey", "review", "prepare-reply", "--project", layoutRoot.project, "--json"]);
    expect(JSON.parse(discovered.out).data.contentHash).toBe(JSON.parse(viaFlag.out).data.contentHash);
  });
});
