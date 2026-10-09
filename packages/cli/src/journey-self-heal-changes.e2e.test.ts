import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Command } from "commander";
import { ProfileManager } from "@jevitate/daemon";
import type { Journey } from "@jevitate/journey";
import { PlaywrightBrowserPort } from "@jevitate/playwright";
import { buildProgram } from "./program.js";
import { useSkippingTime } from "../../explore/src/testkit.js";

useSkippingTime({ per: "all" });

/**
 * #453 end to end: a change-aware self-heal of a renamed button.
 *
 * v1 has a "Create New" button that shows "Created!" (no request); v2 renames it "Create" — the
 * rename is the last commit of a tmp git repo. `journey run --self-heal hybrid --changes HEAD~1..HEAD
 * --fake-ai` against v2 retargets the click one-for-one (exit 5, healed-pending-review) and leaves
 * the stored Journey file byte-identical. v3 keeps "Create New" but drops its handler, and the last
 * commit touches nothing related: the break is unexplained → quarantined (exit 1), naming the step.
 */

type Version = "v1" | "v2" | "v3" | "v4" | "v5";
/** Every non-GET request the server received (v5: a heal probe must never send one). */
const writes: string[] = [];
let version: Version = "v1";

const page = (v: Version): string => {
  const label = v === "v2" || v === "v5" ? "Create" : v === "v4" ? "Make It" : "Create New";
  const handler =
    v === "v3"
      ? ""
      : v === "v5"
        ? `document.getElementById("b").addEventListener("click", () => { fetch("/api/token", { method: "POST" }).then(() => { document.getElementById("out").textContent = "Created!"; }); });`
        : `document.getElementById("b").addEventListener("click", () => { document.getElementById("out").textContent = "Created!"; });`;
  return `<!doctype html><html><head><title>Items</title></head><body><main>
  <h1>Items</h1>
  <button type="button" id="b">${label}</button>
  <p id="out"></p>
  <script>${handler}</script>
</main></body></html>`;
};

let server: Server;
let origin: string;
let root: string;
beforeAll(async () => {
  server = createServer((req, res) => {
    if (req.method !== "GET") {
      writes.push(`${req.method} ${req.url}`);
      return void res.writeHead(204).end();
    }
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(page(version));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  root = await mkdtemp(join(tmpdir(), "jevitate-heal-changes-"));
});
afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await rm(root, { recursive: true, force: true });
});

function git(repo: string, ...args: string[]): void {
  execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.test", "-c", "commit.gpgsign=false", ...args], { cwd: repo, stdio: "ignore" });
}

/** A tmp repo whose last commit is `second` over `first` (each: path → content). */
async function repoWith(name: string, first: Record<string, string>, second: Record<string, string>): Promise<string> {
  const repo = join(root, name);
  await mkdir(repo, { recursive: true });
  git(repo, "init", "-q");
  for (const [commit, files] of [["v1", first], ["v2", second]] as const) {
    for (const [path, content] of Object.entries(files)) {
      await mkdir(join(repo, path, ".."), { recursive: true });
      await writeFile(join(repo, path), content);
    }
    git(repo, "add", "-A");
    git(repo, "commit", "-q", "-m", commit);
  }
  return repo;
}

const toolbar = (label: string): string => `<main>\n  <h1>Items</h1>\n  <button type="button" id="b">${label}</button>\n</main>\n`;

function journey(): Journey {
  return {
    metadata: { id: "create-item", name: "Create an item", promoted: true, params: [], createdAtIso: "2026-10-09T00:00:00.000Z" },
    recording: {
      version: "1",
      site: origin,
      pages: [
        {
          url: "/items",
          steps: [
            { step: { kind: "navigate", url: "/items", expect: { kind: "visible", target: { role: "heading", name: "Items" } } } },
            { step: { kind: "click", target: { role: "button", name: "Create New" }, expect: { kind: "visible", target: { text: "Created!" } } } },
          ],
        },
      ],
    },
  };
}

/** Stores the Journey under the repo's `.jevitate/journeys` (untracked) and returns that dir. */
async function seed(repo: string): Promise<{ journeysDir: string; file: string }> {
  const journeysDir = join(repo, ".jevitate", "journeys");
  await mkdir(journeysDir, { recursive: true });
  const file = join(journeysDir, "create-item.json");
  await writeFile(file, `${JSON.stringify(journey(), null, 2)}\n`);
  return { journeysDir, file };
}

async function cli(journeysDir: string, args: string[]): Promise<{ out: string; err: string; exitCode: number | undefined }> {
  const out: string[] = [];
  const err: string[] = [];
  const program = buildProgram({
    profiles: new ProfileManager("/unused"),
    journeysDir,
    dbPath: join(root, "no-site-policy.sqlite"),
    explore: { browserPortFactory: () => new PlaywrightBrowserPort() },
  });
  program.configureOutput({ writeOut: (s) => out.push(s), writeErr: (s) => err.push(s) });
  const override = (c: Command): void => {
    c.exitOverride();
    c.commands.forEach(override);
  };
  override(program);
  process.exitCode = undefined;
  await program.parseAsync(args, { from: "user" });
  const exitCode = process.exitCode;
  process.exitCode = undefined;
  return { out: out.join(""), err: err.join(""), exitCode };
}

interface RunData {
  outcome: string;
  reason?: string;
  revision?: { recording: Journey["recording"]; steps: { index: number; before: unknown; after: unknown; evidence: { file?: string; line?: number }[] }[] };
  heal?: { verdict: string; attempts: unknown[] };
  proposal?: { id: string; path: string; steps: unknown[]; reviewCommand: string; acceptCommand: string };
  resultPath?: string;
}

/** Runs `fn` with the working directory at `repo`, so the run's logs land in `<repo>/.jevitate/logs` (never ~/.jevitate). */
async function inRepo<T>(repo: string, fn: () => Promise<T>): Promise<T> {
  const spy = vi.spyOn(process, "cwd").mockReturnValue(repo);
  try {
    return await fn();
  } finally {
    spy.mockRestore();
  }
}

describe("#453 journey run --self-heal hybrid --changes (served, real browser)", () => {
  it("v1: the recorded Journey passes as recorded (exit 0)", async () => {
    version = "v1";
    const repo = await repoWith("v1", { "src/Toolbar.html": toolbar("Create New") }, { "README.md": "items\n" });
    const { journeysDir } = await seed(repo);
    const r = await cli(journeysDir, ["journey", "run", "create-item", "--dir", journeysDir, "--json"]);
    const data = (JSON.parse(r.out) as { data: RunData }).data;
    expect(data.reason).toBeUndefined();
    expect(data.outcome).toBe("ok");
    expect(r.exitCode ?? 0).toBe(0);
  }, 120_000);

  it("v2: a renamed button the change explains is retargeted one-for-one → healed-pending-review (exit 5), the store untouched", async () => {
    version = "v2";
    const repo = await repoWith("v2", { "src/Toolbar.html": toolbar("Create New") }, { "src/Toolbar.html": toolbar("Create") });
    const { journeysDir, file } = await seed(repo);
    const storedBytes = await readFile(file);
    const r = await inRepo(repo, () => cli(journeysDir, ["journey", "run", "create-item", "--dir", journeysDir, "--self-heal", "hybrid", "--changes", "HEAD~1..HEAD", "--fake-ai", "--json"]));
    const data = (JSON.parse(r.out) as { data: RunData }).data;
    expect(data.reason).toBeUndefined();
    expect(data.outcome).toBe("healed-pending-review");
    expect(r.exitCode).toBe(5);
    // The revision's only change is the click's target name.
    const expected = journey().recording;
    const click = expected.pages[0]!.steps[1]!;
    expected.pages[0]!.steps[1] = { ...click, step: { ...click.step, target: { role: "button", name: "Create" } } as typeof click.step };
    expect(data.revision!.recording).toEqual(expected);
    expect(data.revision!.steps).toHaveLength(1);
    expect(data.revision!.steps[0]).toMatchObject({ index: 1, after: { kind: "click", target: { role: "button", name: "Create" } } });
    expect(data.revision!.steps[0]!.evidence).toContainEqual(expect.objectContaining({ file: "src/Toolbar.html", line: 3 }));
    // Runs never write the stored Journey.
    expect((await readFile(file)).equals(storedBytes)).toBe(true);
  }, 120_000);

  it("v2: the proposal is written beside the Journey and the result carries its id and the review/accept commands", async () => {
    version = "v2";
    const repo = await repoWith("v2-proposal", { "src/Toolbar.html": toolbar("Create New") }, { "src/Toolbar.html": toolbar("Create") });
    const { journeysDir, file } = await seed(repo);
    const storedBytes = await readFile(file);
    const r = await inRepo(repo, () => cli(journeysDir, ["journey", "run", "create-item", "--dir", journeysDir, "--self-heal", "hybrid", "--changes", "HEAD~1..HEAD", "--fake-ai"]));
    const data = JSON.parse(r.out) as RunData;
    const proposal = data.proposal!;
    expect(proposal.id).toMatch(/^[0-9a-f]{12}$/);
    expect(proposal.path).toBe(join(journeysDir, ".proposals", "create-item.json"));
    expect(JSON.parse(await readFile(proposal.path, "utf8"))).toMatchObject({ proposalId: proposal.id, journeyId: "create-item" });
    expect(proposal.acceptCommand).toBe(`jevitate journey promote create-item --proposal ${proposal.id}`);
    expect(r.err).toContain(`next: jevitate journey promote create-item --proposal ${proposal.id}`);
    // The stored Journey is byte-identical: only `journey promote --proposal` replaces it.
    expect((await readFile(file)).equals(storedBytes)).toBe(true);
  }, 120_000);

  it("v2: a self-heal run persists journey-<id>-<stamp>.result.json with its heal attempts and proposal", async () => {
    version = "v2";
    const repo = await repoWith("v2-result", { "src/Toolbar.html": toolbar("Create New") }, { "src/Toolbar.html": toolbar("Create") });
    const { journeysDir } = await seed(repo);
    const r = await inRepo(repo, () => cli(journeysDir, ["journey", "run", "create-item", "--dir", journeysDir, "--self-heal", "hybrid", "--changes", "HEAD~1..HEAD", "--fake-ai", "--json"]));
    const data = (JSON.parse(r.out) as { data: RunData }).data;
    expect(data.resultPath).toMatch(/\.jevitate[\\/]logs[\\/].*journey-create-item-.*\.result\.json$/);
    const saved = JSON.parse(await readFile(data.resultPath!, "utf8")) as { exitCode: number; result: RunData };
    expect(saved.exitCode).toBe(5);
    expect(saved.result.heal!.attempts).toHaveLength(1);
    expect(saved.result.proposal!.id).toBe(data.proposal!.id);
  }, 120_000);

  it("v4: --heal-max-attempts 2 with a diff naming the old label but a page showing a third → heal-exhausted after exactly 2 attempts, in result.json and in the report", async () => {
    version = "v4";
    const repo = await repoWith("v4", { "src/Toolbar.html": toolbar("Create New") }, { "src/Toolbar.html": toolbar("Create") });
    const { journeysDir } = await seed(repo);
    const args = ["journey", "run", "create-item", "--dir", journeysDir, "--self-heal", "hybrid", "--changes", "HEAD~1..HEAD", "--change-note", 'renamed "Create New" to "Add"', "--heal-max-attempts", "2", "--fake-ai", "--json"];
    const { r, report } = await inRepo(repo, async () => ({
      r: await cli(journeysDir, args),
      report: await cli(journeysDir, ["report", "--json"]),
    }));
    const data = (JSON.parse(r.out) as { data: RunData }).data;
    expect(data.outcome).toBe("heal-exhausted");
    expect(r.exitCode).toBe(1);
    const saved = JSON.parse(await readFile(data.resultPath!, "utf8")) as { result: RunData };
    expect(saved.result.heal!.attempts).toHaveLength(2);
    const defects = (JSON.parse(report.out) as { data: { defects: { title: string; evidence: { healAttempts?: unknown[] }[] }[] } }).data.defects;
    expect(defects[0]!.title).toMatch(/heal exhausted after 2 attempts$/);
    expect(defects[0]!.evidence[0]!.healAttempts).toHaveLength(2);
  }, 120_000);

  it("v5: a renamed button whose click POSTs to a /token path is never healed — the probe's write is blocked (write-attempted) and never reaches the server", async () => {
    version = "v5";
    writes.length = 0;
    const repo = await repoWith("v5", { "src/Toolbar.html": toolbar("Create New") }, { "src/Toolbar.html": toolbar("Create") });
    const { journeysDir } = await seed(repo);
    const r = await inRepo(repo, () => cli(journeysDir, ["journey", "run", "create-item", "--dir", journeysDir, "--self-heal", "hybrid", "--changes", "HEAD~1..HEAD", "--fake-ai", "--json"]));
    const data = (JSON.parse(r.out) as { data: RunData & { heal?: { attempts: { rejection?: { code: string } }[] } } }).data;
    expect({ outcome: data.outcome, rejection: data.heal?.attempts[0]?.rejection?.code, writes: [...writes] }).toEqual({ outcome: "quarantined", rejection: "write-attempted", writes: [] });
  }, 120_000);

  it("v3: a break no change explains (the handler is gone, the diff is unrelated) stays quarantined (exit 1), naming the step", async () => {
    version = "v3";
    const repo = await repoWith("v3", { "src/Toolbar.html": toolbar("Create New") }, { "README.md": "items, now documented\n" });
    const { journeysDir, file } = await seed(repo);
    const storedBytes = await readFile(file);
    const r = await cli(journeysDir, ["journey", "run", "create-item", "--dir", journeysDir, "--self-heal", "hybrid", "--changes", "HEAD~1..HEAD", "--fake-ai"]);
    const data = JSON.parse(r.out) as RunData;
    expect(data.outcome).toBe("quarantined");
    expect(data.heal?.verdict).toBe("unexplained");
    expect(data.reason).toMatch(/step 2 "?.*\(click\) is not explained by the change/);
    expect(r.exitCode).toBe(1);
    // The human summary (stderr) names the outcome and the step.
    expect(r.err).toMatch(/journey create-item: quarantined — step 2/);
    expect((await readFile(file)).equals(storedBytes)).toBe(true);
  }, 120_000);
});
