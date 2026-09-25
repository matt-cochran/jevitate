import { describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProfileManager } from "@jevitate/daemon";
import { FsJourneyStore, JourneyRegistry } from "@jevitate/journey";
import type { BrowserPort, OpenOptions } from "@jevitate/playwright";
import { buildProgram } from "./program.js";
import { buildMcpTools } from "./mcp-api.js";

/**
 * Surface-wiring audit (recovered from the removed ActionRunner): a site policy set with
 * `jevitate site policy set <origin>` governs Journey runs on that origin — `journey run` and MCP
 * `run_journey` are refused (before any browser opens) inside quiet hours or once the run budget is
 * spent, with when to retry.
 */
const ORIGIN = "https://shop.example.test";

async function seed(dir: string): Promise<void> {
  await new JourneyRegistry(new FsJourneyStore(dir)).put({
    metadata: { id: "browse", name: "browse", promoted: true, params: [], createdAtIso: "2026-09-25T00:00:00Z" },
    recording: { version: "1", site: ORIGIN, pages: [] },
  } as never);
}

function harness(dbPath: string) {
  const opens: OpenOptions[] = [];
  const port: BrowserPort = {
    async open(opts) {
      opens.push(opts);
      return { page: {} as never, startTracing: async () => {}, stopTracingToFile: async () => {}, saveStorageState: async () => {}, admission: undefined, close: async () => {} };
    },
  };
  const lines: string[] = [];
  const program = buildProgram({ profiles: new ProfileManager("/unused"), dbPath, explore: { browserPortFactory: () => port } });
  program.configureOutput({ writeOut: (s) => lines.push(s) });
  program.exitOverride();
  const run = async (argv: string[]) => {
    lines.length = 0;
    await program.parseAsync(argv, { from: "user" });
    return JSON.parse(lines.join("")) as { ok: boolean; error?: { code: string; message: string } };
  };
  return { run, opens };
}

async function withPolicy(policy: object, fn: (h: ReturnType<typeof harness>, dirs: { journeys: string; db: string }) => Promise<void>) {
  const root = mkdtempSync(join(tmpdir(), "jev-site-policy-"));
  try {
    const journeys = join(root, "journeys");
    const db = join(root, "db.sqlite");
    await seed(journeys);
    const h = harness(db);
    writeFileSync(join(root, "policy.json"), JSON.stringify(policy));
    // Set by a page URL: the policy is keyed by its origin.
    expect((await h.run(["site", "policy", "set", `${ORIGIN}/cart`, "--file", join(root, "policy.json"), "--json"])).ok).toBe(true);
    await fn(h, { journeys, db });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const ALL_DAY = { timezone: "UTC", windows: [{ start: "00:00", end: "12:00" }, { start: "12:00", end: "00:00" }] };

describe("site policies govern Journey runs", () => {
  it("journey run: a spent daily budget refuses the next run before any browser opens", async () => {
    await withPolicy({ version: "v1", throttles: { read: { dailyLimit: 1 } } }, async (h, dirs) => {
      expect((await h.run(["journey", "run", "browse", "--dir", dirs.journeys, "--json"])).ok).toBe(true);
      expect(h.opens).toHaveLength(1);
      const second = await h.run(["journey", "run", "browse", "--dir", dirs.journeys, "--json"]);
      expect(second.error?.code).toBe("E_SITE_THROTTLED");
      expect(second.error?.message).toMatch(/refused by the site policy for https:\/\/shop\.example\.test: its hourly\/daily run budget is spent; retry after /);
      expect(h.opens).toHaveLength(1);
    });
  });

  it("MCP run_journey: quiet hours answer `throttled` with when to retry, never opening a browser", async () => {
    await withPolicy({ version: "v1", quietHours: ALL_DAY }, async (_h, dirs) => {
      const tool = buildMcpTools({ journeysDir: dirs.journeys, sitePolicyDbPath: dirs.db }).find((t) => t.name === "run_journey")!;
      const res = await tool.handler({ id: "browse" });
      expect(res.isError).toBe(true);
      const body = JSON.parse((res.content[0] as { text: string }).text) as { error: string; reason: string; retryAfter: string };
      expect(body).toMatchObject({ error: "throttled", reason: "quiet_hours" });
      expect(Date.parse(body.retryAfter)).toBeGreaterThan(Date.now() - 1000);
    });
  });

  it("no policy database: Journey runs are unchanged and nothing is created", async () => {
    const root = mkdtempSync(join(tmpdir(), "jev-site-policy-none-"));
    try {
      const journeys = join(root, "journeys");
      await seed(journeys);
      const h = harness(join(root, "db.sqlite"));
      expect((await h.run(["journey", "run", "browse", "--dir", journeys, "--json"])).ok).toBe(true);
      expect(h.opens).toHaveLength(1);
      expect(existsSync(join(root, "db.sqlite"))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

