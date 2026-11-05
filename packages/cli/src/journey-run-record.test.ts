import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// A real browser: the default new PlaywrightBrowserPort() behind run_journey (test/browser-suites.ts reads this).
import { createServer, type Server } from "node:http";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ProfileManager } from "@jevitate/daemon";
import type { Journey } from "@jevitate/journey";
import { buildMcpTools } from "./mcp-api.js";
import { buildProgram } from "./program.js";
import { journeyReviewHash } from "./journey-review.js";
import { JourneyRunRecorder, writePathShape, type JourneyRunRecord } from "./journey-run-record.js";
import { pruneLogs } from "./logs-retention.js";

// #787: which receipt a live verifier still holds (a real one needs a running proof and its signing key).
vi.mock("./journey-verify-checkpoint.js", async (original) => ({
  ...(await original<typeof import("./journey-verify-checkpoint.js")>()),
  isLiveVerifyReceipt: (path: string) => path.endsWith("live.abc.json"),
}));

/** #790: every run_journey / journey run leaves one value-free record in the logs area, following retention. */

const SECRET = "tok_s3cret-VALUE-77";
const PLAIN = "plain-param-value";
const PAGE_TEXT = "PAGE-ONLY-TEXT-991";

let server: Server;
let origin: string;
let root: string;
let journeysDir: string;
let logs: string;

function journey(id: string, last: "ok" | "fails"): Journey {
  const j = {
    metadata: {
      id,
      name: id,
      promoted: true,
      params: [],
      parameters: [{ name: "apiKey", description: "a key", secret: true }, { name: "customer", description: "a customer" }],
      createdAtIso: "2026-11-05T00:00:00.000Z",
    },
    recording: {
      version: "1",
      site: origin,
      pages: [
        {
          url: "/",
          steps: [
            { step: { kind: "navigate", url: "/", expect: { kind: "visible", target: { testId: "note" } } } },
            { step: { kind: "fill", target: { testId: "note" }, value: { var: "apiKey" }, expect: { kind: "visible", target: { testId: "note" } } } },
            { step: { kind: "fill", target: { testId: "who" }, value: { var: "customer" }, expect: { kind: "visible", target: { testId: "who" } } } },
            { step: { kind: "click", target: { testId: "send" }, expect: { kind: "visible", target: { testId: last === "ok" ? "sent" : "never" } } } },
          ],
        },
      ],
    },
  } as unknown as Journey;
  j.metadata.approval = { contentHash: journeyReviewHash(j), at: "2026-11-05T00:00:00.000Z" };
  return j;
}

function records(): Array<{ path: string; text: string; record: JourneyRunRecord }> {
  if (!existsSync(logs)) return [];
  return readdirSync(logs).flatMap((date) =>
    readdirSync(join(logs, date))
      .filter((f) => f.startsWith("journey-run-"))
      .map((f) => {
        const path = join(logs, date, f);
        const text = readFileSync(path, "utf8");
        return { path, text, record: JSON.parse(text) as JourneyRunRecord };
      }),
  );
}

const mcpRun = async (id: string): Promise<{ text: string; body: Record<string, unknown> }> => {
  const tool = buildMcpTools({ journeysDir, pathRoots: [root], runRecordLogsRoot: logs }).find((t) => t.name === "run_journey")!;
  const text = (await tool.handler({ id, params: { apiKey: SECRET, customer: PLAIN } })).content[0]!.text;
  return { text, body: JSON.parse(text) as Record<string, unknown> };
};

async function cliRun(id: string): Promise<{ out: string; err: string }> {
  let out = "";
  let err = "";
  const program = buildProgram({ profiles: new ProfileManager(join(root, "profiles")), dbPath: join(root, "site.sqlite"), journeysDir, logs: { logsRoot: logs } });
  program.exitOverride();
  program.configureOutput({ writeOut: (s) => void (out += s), writeErr: (s) => void (err += s) });
  for (const c of program.commands) for (const sub of c.commands) sub.configureOutput({ writeOut: (s) => void (out += s), writeErr: (s) => void (err += s) });
  const saved = process.exitCode;
  await program.parseAsync(["journey", "run", id, "--param", `apiKey=${SECRET}`, "--param", `customer=${PLAIN}`, "--json"], { from: "user" });
  process.exitCode = saved;
  return { out, err };
}

function expectValueFree(text: string): void {
  expect(text).not.toContain(SECRET);
  expect(text).not.toContain(PLAIN);
  expect(text).not.toContain(PAGE_TEXT);
  expect(text).not.toContain("q=1");
}

beforeAll(async () => {
  server = createServer((req, res) => {
    res.writeHead(200, { "content-type": "text/html" });
    if (req.method === "POST") {
      res.end(`<p data-testid=sent>${PAGE_TEXT}</p>`);
      return;
    }
    res.end(`<p>${PAGE_TEXT}</p><form method=post action="/api/v2/customers/${PLAIN}/notes/12345?q=1"><input data-testid=note name=note><input data-testid=who name=who><button data-testid=send>Save</button></form>`);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  root = mkdtempSync(join(tmpdir(), "jev-790-"));
  journeysDir = join(root, "journeys");
  mkdirSync(journeysDir, { recursive: true });
  logs = join(root, "logs");
  for (const j of [journey("good", "ok"), journey("bad", "fails")]) writeFileSync(join(journeysDir, `${j.metadata.id}.json`), JSON.stringify(j));
  writeFileSync(join(journeysDir, "draft.json"), JSON.stringify({ ...journey("draft", "ok"), metadata: { ...journey("draft", "ok").metadata, promoted: false, approval: undefined } }));
});

afterAll(() => {
  server.closeAllConnections();
  server.close();
  rmSync(root, { recursive: true, force: true });
});

beforeEach(() => {
  vi.stubEnv("JEVITATE_RUN_RECORD", "");
  rmSync(logs, { recursive: true, force: true });
});

afterEach(() => {
  vi.unstubAllEnvs();
  try {
    chmodSync(logs, 0o755);
  } catch {
    // Not every test made it read-only.
  }
});

describe("#790 the record over MCP", () => {
  it("a successful run: id, hash, origin, outcome, steps, writes with method and path shape, timestamps, channel; no value", async () => {
    const r = await mcpRun("good");
    expect(r.body.outcome, r.text).toBe("ok");
    const [one, ...rest] = records();
    expect(rest).toEqual([]);
    expect(one!.record).toMatchObject({ kind: "journey-run", channel: "mcp", journey: { id: "good", hash: journeyReviewHash(journey("good", "ok")) }, origin, outcome: "ok", stepCount: 4 });
    expect(one!.record.writes).toEqual({ count: 1, refused: 0, shapes: [{ method: "POST", path: "/api/v2/customers/:param/notes/:id", count: 1 }] });
    expect(Date.parse(one!.record.endedAt)).toBeGreaterThanOrEqual(Date.parse(one!.record.startedAt));
    expectValueFree(one!.text);
  }, 60_000);

  it("a failing run records its outcome and step, no reason text", async () => {
    await mcpRun("bad");
    const [one] = records();
    expect(one!.record).toMatchObject({ outcome: "quarantined", stoppedAtStep: 4 });
    expect(one!.record.writes.count).toBe(1);
    expectValueFree(one!.text);
  }, 60_000);

  it("a refused run is recorded too, with its code", async () => {
    await mcpRun("draft");
    const [one] = records();
    expect(one!.record).toMatchObject({ outcome: "refused", code: "E_JOURNEY_NOT_PROMOTED", writes: { count: 0 } });
    expectValueFree(one!.text);
  }, 60_000);

  it("a record that cannot be written never changes the outcome: reported as runRecordError", async () => {
    writeFileSync(logs, "a file where the logs directory should be");
    const r = await mcpRun("good");
    expect(r.body.outcome).toBe("ok");
    expect(String(r.body.runRecordError)).toContain("could not be written");
    expectValueFree(r.text.replace(/"output":\{[^}]*\}/, ""));
    rmSync(logs);
    const refused = await (async () => {
      writeFileSync(logs, "again");
      return mcpRun("draft");
    })();
    expect(refused.body).toMatchObject({ code: "E_JOURNEY_NOT_PROMOTED" });
    expect(String(refused.body.runRecordError)).toContain("could not be written");
    rmSync(logs);
  }, 60_000);
});

describe("#790 the record on the CLI", () => {
  it("success and failure, channel cli; the secret absent", async () => {
    await cliRun("good");
    await cliRun("bad");
    const all = records().map((r) => r.record.outcome).sort();
    expect(all).toEqual(["ok", "quarantined"]);
    for (const r of records()) {
      expect(r.record.channel).toBe("cli");
      expectValueFree(r.text);
    }
  }, 60_000);

  it("a record that cannot be written keeps the run's result and warns", async () => {
    writeFileSync(logs, "not a directory");
    const r = await cliRun("good");
    expect(r.out).toContain('"outcome":"ok"');
    expect(r.out).toContain("runRecordError");
    expect(r.err).toContain("warning: the run record could not be written");
    rmSync(logs);
  }, 60_000);
});

describe("#790 shapes and retention", () => {
  it("writePathShape keeps route words only", () => {
    expect(writePathShape("/api/v2/users/42/reset-password", [])).toBe("/api/v2/users/:id/reset-password");
    expect(writePathShape("/a/my-long-article-slug/b", [])).toBe("/a/:id/b");
    expect(writePathShape("/u/alice/edit", ["alice"])).toBe("/u/:param/edit");
    expect(writePathShape("/u/Alice%20B/edit", ["alice b"])).toBe("/u/:param/edit");
    expect(writePathShape("/AbC123DeF", [])).toBe("/:id");
  });

  it("write is atomic: no temp file stays, even when the write fails midway", () => {
    const rec = new JourneyRunRecorder({ channel: "cli", id: "x", params: {}, logsRoot: logs });
    expect(rec.finish({ outcome: "ok" })).toBeUndefined();
    const [date] = readdirSync(logs);
    expect(readdirSync(join(logs, date!)).filter((f) => f.endsWith(".tmp"))).toEqual([]);
  });

  it("logs prune removes an old record and keeps the newest (as for any run)", () => {
    const rec = new JourneyRunRecorder({ channel: "cli", id: "x", params: {}, logsRoot: logs });
    rec.finish({ outcome: "ok" });
    const [one] = records();
    const old = new Date("2020-01-01T00:00:00Z");
    utimesSync(one!.path, old, old);
    expect(pruneLogs(logs, { ttlDays: 14, keepLatest: 1 }).removed).toEqual([]);
    expect(pruneLogs(logs, { ttlDays: 14, keepLatest: 0 }).removed).toHaveLength(1);
    expect(records()).toEqual([]);
  });

  it("logs prune covers verify-progress receipts: old ones go, each pool keeps its newest, a live verifier's stays", () => {
    const dir = join(logs, "verify-progress");
    mkdirSync(dir, { recursive: true });
    const old = new Date("2020-01-01T00:00:00Z");
    const receipt = (name: string, body: object): string => {
      const p = join(dir, name);
      writeFileSync(p, JSON.stringify(body));
      utimesSync(p, old, old);
      return p;
    };
    const done = receipt("done.abc.json", { not: "a checkpoint" });
    const live = receipt("live.abc.json", { not: "read: the seam above answers" });
    const report = pruneLogs(logs, { ttlDays: 14, keepLatest: 0 }, { dryRun: true });
    expect(report.removed).toEqual(["verify-progress/done.abc.json"]);
    expect(existsSync(done)).toBe(true);
    expect(pruneLogs(logs, { ttlDays: 14, keepLatest: 1 }).removed).toEqual([]);
    expect(pruneLogs(logs, { ttlDays: 14, keepLatest: 0 }).removed).toEqual(["verify-progress/done.abc.json"]);
    expect(existsSync(done)).toBe(false);
    expect(existsSync(live)).toBe(true);
  });
});
