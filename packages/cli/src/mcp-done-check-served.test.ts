import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Journey } from "@jevitate/journey";
import { PlaywrightBrowserPort } from "@jevitate/playwright";
import { DONE_CHECK_HOOK_OWNER } from "./journey-done-check-hook.js";
import { journeyReviewHash } from "./journey-review.js";
import { hasRunHookOwner, resetRunHooksForTests } from "./journey-run-hooks.js";
import { buildMcpTools } from "./mcp-api.js";
import { realQueuedJourneyExecutor } from "./mission-queue-runner.js";
import { useSkippingTime } from "../../explore/src/testkit.js";

useSkippingTime({ per: "all", pageClock: false });

/**
 * GAPS 21 served acceptance: MCP `run_journey` and a drained `queue_journey` call read the linked job's done
 * check as `journey run` does, with no manual hook registration (buildMcpTools registers it), and report
 * `job: {attainment, basis}` with the exit code the job gives. Real Chromium, a served app.
 */

let server: Server;
let origin: string;
let root: string;
let journeysDir: string;
let projectDir: string;
let logs: string;
let targetsFile: string;
/** `broken` answers Save with 200 and stores nothing. */
const app = { broken: false, items: [] as string[] };

function serve(): Promise<Server> {
  const s = createServer((req, res) => {
    const path = (req.url ?? "/").split("?")[0] ?? "/";
    if (req.method === "POST" && path === "/api/items") {
      let body = "";
      req.on("data", (c: Buffer) => (body += c.toString("utf8")));
      req.on("end", () => {
        if (!app.broken) app.items.push(body);
        res.writeHead(200, { "content-type": "application/json" }).end('{"ok":true}');
      });
      return;
    }
    const html = (b: string) => res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(`<!doctype html><html><body>${b}</body></html>`);
    if (path === "/items") return html(`<ul data-testid="items">${app.items.map((i) => `<li>${i.replace(/[&<>"]/g, "")}</li>`).join("")}</ul>`);
    if (path === "/new")
      return html(`<input data-testid="name" aria-label="Name"><button data-testid="save" type="button">Save</button><p data-testid="status"></p>
<script>
document.querySelector("[data-testid=save]").addEventListener("click", async () => {
  await fetch("/api/items", { method: "POST", body: document.querySelector("[data-testid=name]").value });
  document.querySelector("[data-testid=status]").textContent = "Saved";
});
</script>`);
    res.writeHead(404).end();
  });
  return new Promise((r) => s.listen(0, "127.0.0.1", () => r(s)));
}

function journey(): Journey {
  const j = {
    metadata: { id: "save-item", name: "save-item", promoted: false, params: ["item"], job: "save-item", createdAtIso: "2026-11-09T00:00:00.000Z" },
    recording: {
      version: "1",
      site: origin,
      pages: [
        {
          url: "/new",
          steps: [
            { step: { kind: "navigate", url: "/new", expect: { kind: "visible", target: { testId: "name" } } } },
            { step: { kind: "fill", target: { testId: "name" }, value: { var: "item" }, expect: { kind: "visible", target: { testId: "name" } } } },
            { step: { kind: "click", target: { testId: "save" }, expect: { kind: "textIncludes", target: { testId: "status" }, text: "Saved" } } },
          ],
        },
      ],
    },
  } as unknown as Journey;
  // Promoted with a current approval a person made at a terminal (what run_journey requires).
  return { ...j, metadata: { ...j.metadata, promoted: true, approval: { contentHash: journeyReviewHash(j), at: "2026-11-09T00:00:00.000Z", provenance: { channel: "tty", agentSignals: [] } } } } as Journey;
}

beforeAll(async () => {
  server = await serve();
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  root = mkdtempSync(join(tmpdir(), "jev-mcp-done-check-"));
  journeysDir = join(root, "journeys");
  projectDir = join(root, ".jevitate");
  logs = join(root, "logs");
  targetsFile = join(root, "targets.json");
  mkdirSync(journeysDir, { recursive: true });
  mkdirSync(projectDir, { recursive: true });
  writeFileSync(targetsFile, JSON.stringify({ [origin]: { trust: "test" } }));
  writeFileSync(join(projectDir, "project.json"), JSON.stringify({}));
  writeFileSync(
    join(projectDir, "jobs.json"),
    JSON.stringify({
      jobs: [{ id: "save-item", trigger: "When I have a new item", motivation: "I want to save it", outcome: "I can find it later", done: { version: 1, at: "/items", check: "textIncludes:testId=items|${item}", distinguishedBy: ["item"] } }],
    }),
  );
  writeFileSync(join(journeysDir, "save-item.json"), JSON.stringify(journey()));
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((r) => server.close(() => r()));
  rmSync(root, { recursive: true, force: true });
});

beforeEach(() => {
  vi.stubEnv("JEVITATE_RUN_RECORD", "");
  resetRunHooksForTests();
  app.items = [];
});

afterEach(() => {
  vi.unstubAllEnvs();
  resetRunHooksForTests();
});

const tools = () => buildMcpTools({ journeysDir, catalogDir: projectDir, pathRoots: [root], targetsConfigPath: targetsFile, runRecordLogsRoot: logs, browserPortFactory: () => new PlaywrightBrowserPort() } as Parameters<typeof buildMcpTools>[0]);

describe("GAPS 21: MCP and the queue read the job's done check (real Chromium)", () => {
  it("run_journey through buildMcpTools, with no manual registration, returns job {attainment, basis} and its exit code", async () => {
    const runJourney = tools().find((t) => t.name === "run_journey")!;
    expect(hasRunHookOwner(DONE_CHECK_HOOK_OWNER)).toBe(true);

    app.broken = false;
    const ok = JSON.parse((await runJourney.handler({ id: "save-item", params: { item: "item-one" } })).content[0]!.text) as Record<string, unknown>;
    expect(ok, JSON.stringify(ok)).toMatchObject({ outcome: "ok", job: { attainment: "achieved", basis: "done-check" }, exitCode: 0 });
    expect(ok).not.toHaveProperty("failure");

    app.broken = true;
    const notDone = JSON.parse((await runJourney.handler({ id: "save-item", params: { item: "item-two" } })).content[0]!.text) as Record<string, unknown>;
    expect(notDone, JSON.stringify(notDone)).toMatchObject({ outcome: "ok", job: { attainment: "not-achieved", basis: "done-check" }, failure: { kind: "done-check-failed" }, exitCode: 1 });
  }, 120_000);

  it("a drained queued Journey call reports the job and the exit code it gives", async () => {
    tools(); // registers the run hooks, as the server does
    app.broken = true;
    const run = await realQueuedJourneyExecutor({ journeysDir, targetsFile, catalogDir: projectDir, logsRoot: logs, browserPortFactory: () => new PlaywrightBrowserPort() })({
      kind: "journey",
      journey: { id: "save-item", hash: (journey().metadata as { approval: { contentHash: string } }).approval.contentHash },
      params: { item: "item-three" },
      requestedAt: "2026-11-09T00:00:00.000Z",
    } as never);
    expect(run).toMatchObject({ outcome: "ok", exitCode: 1, job: { attainment: "not-achieved", basis: "done-check" } });
  }, 120_000);
});
