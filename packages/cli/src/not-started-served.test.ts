import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FakeGenerationGateway, type Answer, type JudgmentPort } from "@jevitate/ai-core";
import { GOAL_ALREADY_MET_QUESTION, GOAL_MET_QUESTION } from "@jevitate/explore";
import { runExploration } from "./explore-api.js";
import { useSkippingTime } from "../../explore/src/testkit.js";

/**
 * #448 served e2e: a goal run that executed zero actions is `not-started`, never exercised.
 * A page with no interactive controls → `not-started` (reason no-controls, mission `inconclusive`,
 * exit 2); a page with one clickable control and a reachable goal → `succeeded`.
 */
useSkippingTime({ per: "all" });

const EMPTY = `<!doctype html><html><head><title>Static</title></head><body><main><h1>Just text</h1><p>Nothing to click.</p></main></body></html>`;
const CLICKABLE = `<!doctype html><html><head><title>One</title></head><body><main><h1>One button</h1>
  <button type="button" id="go">Go</button><p id="out" data-testid="out" role="status"></p>
  <script>document.getElementById("go").onclick = () => { document.getElementById("out").textContent = "Reached the goal"; };</script></main></body></html>`;

let server: Server;
let origin: string;
beforeAll(async () => {
  server = createServer((req, res) => {
    const path = (req.url ?? "").split("?")[0] ?? "";
    const html = path === "/empty" ? EMPTY : path === "/one" ? CLICKABLE : undefined;
    if (html === undefined) return void res.writeHead(404).end();
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(html);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

/** Clicks the first click control, then done; says the goal is met only once clicked. */
function clickThenDone(): JudgmentPort {
  let clicked = false;
  return {
    async systemOne({ questions }) {
      const out: Record<string, Answer> = {};
      for (const [key, q] of Object.entries(questions)) {
        if (key === "action" && q.kind === "choice") {
          const click = q.options.find((o) => o.startsWith("click"));
          const pick = clicked ? "done" : (click ?? q.options.find((o) => o === "done") ?? q.options[0] ?? "");
          if (click !== undefined && !clicked) clicked = true;
          out[key] = { kind: "choice", value: pick, confidence: 0.9 };
        } else if (key === GOAL_MET_QUESTION) out[key] = { kind: "noul", value: true, probability: 0.95 };
        else if (key === GOAL_ALREADY_MET_QUESTION) out[key] = { kind: "noul", value: false, probability: 0.05 };
        else if (q.kind === "noul") out[key] = { kind: "noul", value: false, probability: 0.1 };
        else if (q.kind === "score") out[key] = { kind: "score", value: 0.1 };
        else out[key] = { kind: "choice", value: q.options[0] ?? "", confidence: 0.1 };
      }
      return out;
    },
  } as unknown as JudgmentPort;
}

async function run(path: string, successText: string) {
  const outDir = await mkdtemp(join(tmpdir(), "jev-not-started-"));
  try {
    return await runExploration({
      url: `${origin}${path}`,
      goal: "reach the goal",
      allowlist: [origin],
      judge: clickThenDone(),
      gen: new FakeGenerationGateway({}),
      successChecks: [{ kind: "page", assertion: { kind: "textIncludes", target: { testId: "out" }, text: successText } }],
      bounds: { maxDecisions: 4, maxActions: 4 },
      outDir,
    });
  } finally {
    await rm(outDir, { recursive: true, force: true });
  }
}

describe("a run with zero executed actions is not-started (#448)", () => {
  it("a page with no interactive controls reports goalOutcome not-started", async () => {
    const r = await run("/empty", "Reached the goal");
    expect(r.goalOutcome).toBe("not-started");
  }, 180_000);

  it("a not-started run names why: no controls offered", async () => {
    const r = await run("/empty", "Reached the goal");
    expect(r.goalReason).toBe("no-controls");
  }, 180_000);

  it("a not-started run is inconclusive with exit code 2, never clean", async () => {
    const r = await run("/empty", "Reached the goal");
    expect([r.missionOutcome, r.exitCode]).toEqual(["inconclusive", 2]);
  }, 180_000);

  it("a page with one clickable control and a reachable goal reports succeeded", async () => {
    const r = await run("/one", "Reached the goal");
    expect(r.goalOutcome).toBe("succeeded");
  }, 180_000);
});
