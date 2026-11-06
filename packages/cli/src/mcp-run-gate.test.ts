import { describe, expect, it, beforeAll, afterAll } from "vitest";

// A real browser: the default new PlaywrightBrowserPort() behind run_journey (test/browser-suites.ts reads this).
import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { assertJourneyRunnable, JourneyRunRefusedError } from "@jevitate/mcp-facade";
import type { Journey } from "@jevitate/journey";
import { buildMcpTools } from "./mcp-api.js";
import { journeyReviewHash } from "./journey-review.js";
import { journeyApprovalState, journeyDraftWarning } from "./journey-stale-api.js";
import { runJourneyLoadTest } from "./load-api.js";
import { resolveJourneyPrefix } from "./journey-prefix.js";
import { runAsMcpInvocation } from "./approval-provenance.js";
import { ProfileManager } from "@jevitate/daemon";
import { buildProgram } from "./program.js";
import { makeInProcessCliRunner } from "./mcp-cli-runner.js";

/** #788: over MCP only a promoted Journey with a current approval runs; refused before any browser. */

let server: Server;
let origin: string;
let root: string;
let journeysDir: string;
let posts = 0;
let pageViews = 0;

function journey(id: string, meta: Partial<Journey["metadata"]> = {}): Journey {
  return {
    metadata: { id, name: id, promoted: false, params: [], parameters: [{ name: "note", description: "a note" }], createdAtIso: "2026-11-05T00:00:00.000Z", ...meta },
    recording: {
      version: "1",
      site: origin,
      pages: [
        {
          url: "/",
          steps: [
            { step: { kind: "navigate", url: "/", expect: { kind: "visible", target: { testId: "note" } } } },
            { step: { kind: "fill", target: { testId: "note" }, value: { var: "note" }, expect: { kind: "visible", target: { testId: "note" } } } },
            { step: { kind: "click", target: { testId: "send" }, expect: { kind: "visible", target: { testId: "sent" } } } },
          ],
        },
      ],
    },
  } as Journey;
}

const approved = (j: Journey): Journey => ({ ...j, metadata: { ...j.metadata, promoted: true, approval: { contentHash: journeyReviewHash(j), at: "2026-11-05T00:00:00.000Z" } } });

const seed = (j: Journey): void => writeFileSync(join(journeysDir, `${j.metadata.id}.json`), JSON.stringify(j));

const run = async (id: string, note = "s3cret-note-value"): Promise<{ isError?: boolean; body: Record<string, unknown>; text: string }> => {
  const tool = buildMcpTools({ journeysDir, pathRoots: [root] }).find((t) => t.name === "run_journey")!;
  const res = await tool.handler({ id, params: { note } });
  const text = res.content[0]!.text;
  return { ...(res.isError === undefined ? {} : { isError: res.isError }), body: JSON.parse(text) as Record<string, unknown>, text };
};

beforeAll(async () => {
  server = createServer((req, res) => {
    res.writeHead(200, { "content-type": "text/html" });
    if (req.method === "POST") {
      posts += 1;
      res.end("<p data-testid=sent>sent</p>");
      return;
    }
    pageViews += 1;
    res.end("<form method=post action=/send><input data-testid=note name=note><button data-testid=send>Send</button></form>");
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  root = mkdtempSync(join(tmpdir(), "jev-788-"));
  journeysDir = join(root, "journeys");
  mkdirSync(journeysDir, { recursive: true });
});

afterAll(() => {
  server.closeAllConnections();
  server.close();
  rmSync(root, { recursive: true, force: true });
});

describe("#788 run_journey's promotion gate", () => {
  it("refuses an unpromoted Journey before any browser, naming the fix and the CLI for a draft", async () => {
    seed(journey("draft"));
    pageViews = 0;
    const r = await run("draft");
    expect(r.isError).toBe(true);
    expect(r.body).toMatchObject({ error: "refused", outcome: "refused", code: "E_JOURNEY_NOT_PROMOTED", retryable: false, fix: "jevitate journey promote draft", tryDraft: "jevitate journey run draft" });
    expect(String(r.body.message)).toContain("promote_journey");
    expect(r.text).not.toContain("s3cret-note-value");
    expect(pageViews).toBe(0);
  });

  it("refuses a Journey edited after its approval, with the hash that re-approves it", async () => {
    const ok = approved(journey("edited"));
    const edited = { ...ok, metadata: ok.metadata, recording: { ...ok.recording, pages: [{ ...ok.recording.pages[0]!, steps: ok.recording.pages[0]!.steps.slice(0, 2) }] } } as Journey;
    seed(edited);
    pageViews = 0;
    const r = await run("edited");
    expect(r.body).toMatchObject({ error: "refused", code: "E_JOURNEY_APPROVAL_STALE", fix: `jevitate journey promote edited --reviewed-hash ${journeyReviewHash(edited)}` });
    expect(r.text).not.toContain("s3cret-note-value");
    expect(pageViews).toBe(0);
  });

  it("fails closed on promoted: true with no approval on record", async () => {
    seed(journey("handmade", { promoted: true }));
    pageViews = 0;
    const r = await run("handmade");
    expect(r.body).toMatchObject({ error: "refused", code: "E_JOURNEY_APPROVAL_UNKNOWN" });
    expect(pageViews).toBe(0);
  });

  it("fails closed when the catalog behind the staleness check cannot be read", async () => {
    const j = approved(journey("unreadable"));
    const bad = join(root, "not-a-catalog");
    mkdirSync(bad, { recursive: true });
    writeFileSync(join(bad, "jobs.json"), "{ not json");
    writeFileSync(join(bad, "personas.json"), "{ not json");
    const state = await journeyApprovalState(j, { journeysDir, catalogDir: bad });
    expect(state.approval).toBe("undetermined");
    expect(() => assertJourneyRunnable("unreadable", state)).toThrow(JourneyRunRefusedError);
  });

  it("runs a promoted Journey with a current approval (the write reaches the server)", async () => {
    seed(approved(journey("approved")));
    const before = posts;
    const r = await run("approved");
    expect(r.isError, r.text).toBeUndefined();
    expect(r.body.outcome).toBe("ok");
    expect(posts).toBe(before + 1);
  }, 60_000);
});

describe("#788 the other surfaces", () => {
  it("chain_journeys refuses over MCP with the same codes: unpromoted and stale", async () => {
    seed(journey("chain-draft"));
    const ok = approved(journey("chain-ok"));
    seed(ok);
    const stale = approved(journey("chain-stale"));
    seed({ ...stale, recording: { ...stale.recording, site: `${origin}/` } } as Journey);
    const reqs = join(root, "requests.jsonl");
    writeFileSync(reqs, "");
    const runCli = makeInProcessCliRunner(() => buildProgram({ profiles: new ProfileManager(join(root, "profiles")), dbPath: join(root, "site.sqlite"), journeysDir }));
    const chain = buildMcpTools({ journeysDir, pathRoots: [root], runCli }).find((t) => t.name === "chain_journeys")!;
    const body = async (from: string): Promise<Record<string, unknown>> => JSON.parse((await chain.handler({ from, to: "chain-ok", requests: reqs, params: { note: "x" } })).content[0]!.text) as Record<string, unknown>;
    pageViews = 0;
    expect(await body("chain-draft")).toMatchObject({ error: "refused", code: "E_JOURNEY_NOT_PROMOTED" });
    expect(await body("chain-stale")).toMatchObject({ error: "refused", code: "E_JOURNEY_APPROVAL_STALE" });
    expect(pageViews).toBe(0);
  });

  it("`journey run` warns once on stderr for a draft and a stale approval, and nothing for a current one", async () => {
    seed(journey("warn-draft"));
    expect(await journeyDraftWarning(journeysDir, "warn-draft", null)).toMatch(/^warning: E_JOURNEY_NOT_PROMOTED: running anyway.*journey promote warn-draft\n$/);
    const a = approved(journey("warn-stale"));
    seed({ ...a, recording: { ...a.recording, site: `${origin}/x` } } as Journey);
    expect(await journeyDraftWarning(journeysDir, "warn-stale", null)).toMatch(/^warning: E_JOURNEY_APPROVAL_STALE/);
    seed(approved(journey("warn-ok")));
    expect(await journeyDraftWarning(journeysDir, "warn-ok", null)).toBeUndefined();
    expect(await journeyDraftWarning(journeysDir, "no-such-journey", null)).toBeUndefined();
  });

  it("over MCP, journey-anchored missions and run_check refuse a stale approval; the CLI's own calls are as they were", async () => {
    const a = approved(journey("anchored"));
    seed({ ...a, recording: { ...a.recording, site: `${origin}/x` } } as Journey);
    const prefix = { dir: journeysDir, id: "anchored", params: { note: "x" }, atStep: "1" };
    await expect(runAsMcpInvocation(() => resolveJourneyPrefix(prefix))).rejects.toThrow(/E_JOURNEY_APPROVAL_STALE/);
    await expect(resolveJourneyPrefix(prefix)).resolves.toBeDefined();
  });

  it("`load run` refuses an unpromoted Journey on both surfaces and a stale one over MCP", async () => {
    seed(journey("load-draft"));
    const load = { dir: journeysDir, params: { note: "x" }, authorizedOrigins: [origin], concurrency: 1, iterationsPerActor: 1, seed: 1 };
    await expect(runJourneyLoadTest({ ...load, id: "load-draft" })).rejects.toMatchObject({ code: "E_JOURNEY_NOT_PROMOTED" });
    const a = approved(journey("load-stale"));
    seed({ ...a, recording: { ...a.recording, site: `${origin}/x` } } as Journey);
    await expect(runAsMcpInvocation(() => runJourneyLoadTest({ ...load, id: "load-stale" }))).rejects.toMatchObject({ code: "E_JOURNEY_APPROVAL_STALE" });
  });
});
