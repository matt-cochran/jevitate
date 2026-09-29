import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProfileManager } from "@jevitate/daemon";
import { FakeGenerationGateway, type Answer, type JudgmentPort } from "@jevitate/ai-core";
import { PlaywrightBrowserPort } from "@jevitate/playwright";
import { TENANCY_SESSIONS, startServer, type TenancyOptions } from "@jevitate/example-site";
import { buildProgram } from "./program.js";
import { runVerifyFix } from "./verify-fix-api.js";

/**
 * #147 acceptance — a multi-actor goal run against the two-tenant `/tenancy/*` fixture. Tenant a
 * (the primary, the only actor the model drives) creates an item; tenant b (an observer in its OWN
 * fresh context) runs the declared cross-actor checks: the item is not in b's JSON list, and b is
 * denied the item page. In leaky mode both are hard defects (and verify-fix re-checks them); in the
 * default mode the run is clean; a logged-out observer leaves them undecided (never clean). No
 * storageState content — and none of the observer's own page text — reaches `--out`.
 */

const tenancy: { leaky: boolean; log: NonNullable<TenancyOptions["log"]> } = { leaky: false, log: [] };
let site: { url: string; close(): Promise<void> };
let dir: string;
let stateA: string;
let stateB: string;
let loggedOut: string;
let invariantsFile: string;

class ScriptedJudge implements JudgmentPort {
  #i = 0;
  constructor(private readonly seq: ReadonlyArray<{ op: string; target?: string }>) {}
  async systemOne(): Promise<Record<string, Answer>> {
    const cur = this.seq[Math.min(this.#i, this.seq.length - 1)];
    this.#i += 1;
    if (cur === undefined) throw new Error("ScriptedJudge: empty script");
    return { action: { kind: "choice", value: cur.target !== undefined ? `${cur.op}:${cur.target}` : cur.op, confidence: 0.9 } };
  }
}

/** Logs in through the fixture's own login route and saves the context's storageState. */
async function saveState(tenant: "a" | "b", path: string): Promise<void> {
  const session = await new PlaywrightBrowserPort().open({ headless: true, allowedOrigins: [site.url], baseUrl: site.url });
  try {
    await session.page.goto(`${site.url}/tenancy/login?as=${tenant}`);
    await session.saveStorageState(path);
  } finally {
    await session.close();
  }
}

beforeAll(async () => {
  site = await startServer(0, { tenancy });
  dir = await mkdtemp(join(tmpdir(), "jevitate-multi-actor-"));
  stateA = join(dir, "a.json");
  stateB = join(dir, "b.json");
  loggedOut = join(dir, "b-expired.json");
  await saveState("a", stateA);
  await saveState("b", stateB);
  await writeFile(loggedOut, JSON.stringify({ cookies: [], origins: [] }));
  invariantsFile = join(dir, "tenancy.invariants.json");
  await writeFile(
    invariantsFile,
    JSON.stringify({
      capture: {
        itemId: { network: { url: "**/tenancy/items", method: "POST", json: "$.id" } },
        itemUrl: { url: { after: { control: { name: "/Create/i" } }, route: "/tenancy/items/*" } },
      },
      observe: {
        intruderList: { probe: { as: "b", get: "/tenancy/api/items", json: "$.items[*].id" } },
      },
      invariants: [
        { id: "not-listed-cross-tenant", when: { after: "capture.itemId" }, require: "!contains(intruderList, itemId)" },
        {
          id: "not-openable-cross-tenant",
          when: { after: "capture.itemUrl" },
          deniedAs: { actor: "b", open: "${capture.itemUrl}", expect: { documentStatus: [403, 404], orVisible: "/not found/i" } },
        },
      ],
    }),
  );
});

afterAll(async () => {
  await site.close();
});

interface RunData {
  outcome: string;
  reason?: string;
  resultPath: string;
  defects: Array<{ fingerprint: string; invariant: { id: string; kind: string; crossActor?: { owner: string; observer: string; capture: string } } }>;
  invariants: Array<{ id: string; checked: number; held: number; violated: number; unknown: number; observer?: string; undecided?: string }>;
  target: { actors?: Array<{ name: string; role: string }> };
}

async function explore(actors: readonly string[], out: string): Promise<RunData> {
  const lines: string[] = [];
  const program = buildProgram({
    profiles: new ProfileManager("/unused"),
    explore: {
      judge: new ScriptedJudge([{ op: "type", target: "0" }, { op: "click", target: "1" }, { op: "done" }]),
      gen: new FakeGenerationGateway({ "form.value": { text: "Quarterly plan" } }),
    },
  });
  program.configureOutput({ writeOut: (s) => lines.push(s) });
  program.exitOverride();
  await program.parseAsync(
    [
      "explore",
      "--url",
      `${site.url}/tenancy/items`,
      "--goal",
      "create an item",
      "--success",
      "urlIncludes:/tenancy/items/item-",
      "--allow",
      site.url,
      ...actors.flatMap((a) => ["--actor", a]),
      "--invariants",
      invariantsFile,
      "--out",
      out,
      "--json",
    ],
    { from: "user" },
  );
  const parsed = JSON.parse(lines.join("")) as { ok: boolean; data: RunData; error?: unknown };
  expect(parsed.ok, JSON.stringify(parsed.error)).toBe(true);
  return parsed.data;
}

/** Every file under `root`, as text. */
async function allText(root: string): Promise<string> {
  let text = "";
  for (const entry of await readdir(root)) {
    const p = join(root, entry);
    text += (await stat(p)).isDirectory() ? await allText(p) : await readFile(p, "utf8");
  }
  return text;
}

/** The observer's own requests: tenant b's session (and nothing it could have typed or clicked). */
function observerRequests(from: number): Array<{ method: string; path: string }> {
  return tenancy.log.slice(from).filter((r) => r.tenant === "b");
}

describe("multi-actor missions: cross-tenant isolation (#147)", () => {
  it(
    "leaky mode: both cross-actor invariants are hard defects; the observer only navigates and GETs; verify-fix re-checks them",
    async () => {
      tenancy.leaky = true;
      const out = await mkdtemp(join(dir, "leaky-"));
      const from = tenancy.log.length;
      const data = await explore([`a=${stateA}`, `b=${stateB}`], out);

      expect(data.outcome).toBe("defects-found");
      expect(data.defects.map((d) => d.invariant.id).sort()).toEqual(["not-listed-cross-tenant", "not-openable-cross-tenant"]);
      for (const d of data.defects) expect(d.invariant.crossActor).toMatchObject({ owner: "a", observer: "b" });
      expect(data.target.actors?.map((a) => `${a.name}:${a.role}`)).toEqual(["a:primary", "b:observer"]);

      // Observers are never driven: tenant b made only GET navigations/probes, each check once.
      const observed = observerRequests(from);
      expect(observed.length).toBeGreaterThan(0);
      expect(observed.every((r) => r.method === "GET" || r.method === "HEAD")).toBe(true);
      expect(observed.filter((r) => r.path === "/tenancy/api/items")).toHaveLength(1);
      expect(observed.filter((r) => /^\/tenancy\/items\/item-\d+$/.test(r.path))).toHaveLength(1);

      // No storageState content, and none of the observer's page text, reaches an artifact.
      const artifacts = await allText(out);
      for (const token of Object.values(TENANCY_SESSIONS)) expect(artifacts).not.toContain(token);
      expect(artifacts).not.toContain("Viewing as tenant b");

      // verify-fix re-checks the cross-actor defect from a FRESH observer context: still there while
      // leaky, fixed once the app isolates tenants again.
      const openable = data.defects.find((d) => d.invariant.id === "not-openable-cross-tenant");
      expect(openable).toBeDefined();
      const still = await runVerifyFix({ resultPath: data.resultPath, fingerprint: openable?.fingerprint ?? "", replays: 1 });
      expect(still.verdict, still.reason).toBe("still-reproduces");
      tenancy.leaky = false;
      const fixed = await runVerifyFix({ resultPath: data.resultPath, fingerprint: openable?.fingerprint ?? "", replays: 1 });
      expect(fixed.verdict, fixed.reason).toBe("fixed");
    },
    240_000,
  );

  it(
    "default (isolated) mode: the same run is clean — both invariants held from the observer's own session",
    async () => {
      tenancy.leaky = false;
      const out = await mkdtemp(join(dir, "clean-"));
      const data = await explore([`a=${stateA}`, `b=${stateB}`], out);
      expect(data.outcome, data.reason).toBe("succeeded");
      expect(data.defects).toEqual([]);
      for (const r of data.invariants) expect(r).toMatchObject({ checked: 1, held: 1, violated: 0, observer: "b" });
      const artifacts = await allText(out);
      for (const token of Object.values(TENANCY_SESSIONS)) expect(artifacts).not.toContain(token);
    },
    120_000,
  );

  it(
    "a logged-out observer leaves the cross-actor invariants undecided, and the run is never clean",
    async () => {
      tenancy.leaky = false;
      const out = await mkdtemp(join(dir, "expired-"));
      const data = await explore([`a=${stateA}`, `b=${loggedOut}`], out);
      expect(data.outcome).toBe("inconclusive");
      expect(data.reason).toMatch(/cross-actor invariant\(s\) undecided/);
      const byId = Object.fromEntries(data.invariants.map((r) => [r.id, r]));
      expect(byId["not-openable-cross-tenant"]?.undecided).toMatch(/session was lost/);
      expect(byId["not-listed-cross-tenant"]?.undecided).toMatch(/could not be read/);
      expect(data.defects).toEqual([]);
    },
    120_000,
  );

  it("refuses --actor with --storage-state, an unregistered observer, and non-goal strategies — before any browser", async () => {
    const run = async (args: string[]): Promise<{ ok: boolean; error?: { code: string; message: string } }> => {
      const lines: string[] = [];
      const program = buildProgram({ profiles: new ProfileManager("/unused") });
      program.configureOutput({ writeOut: (s) => lines.push(s) });
      program.exitOverride();
      await program.parseAsync(["explore", "--url", `${site.url}/tenancy/items`, "--allow", site.url, "--json", ...args], { from: "user" });
      return JSON.parse(lines.join("")) as { ok: boolean; error?: { code: string; message: string } };
    };
    const both = await run(["--goal", "g", "--actor", `a=${stateA}`, "--storage-state", stateA]);
    expect(both.error?.message).toMatch(/--storage-state cannot be combined with --actor/);
    const unregistered = await run(["--goal", "g", "--actor", `a=${stateA}`, "--actor", `c=${stateB}`, "--invariants", invariantsFile]);
    expect(unregistered.error?.message).toMatch(/actor "b" is not a registered observer/);
    const coverage = await run(["--strategy", "coverage", "--actor", `a=${stateA}`, "--actor", `b=${stateB}`]);
    expect(coverage.error?.message).toMatch(/--actor is supported only with --strategy goal/);
    const dup = await run(["--goal", "g", "--actor", `a=${stateA}`, "--actor", `a=${stateB}`]);
    expect(dup.error?.message).toMatch(/actor a is declared twice/);
  });
});
