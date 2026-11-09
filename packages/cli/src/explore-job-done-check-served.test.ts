import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { FakeGenerationGateway, type Answer, type JudgmentPort } from "@jevitate/ai-core";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PlaywrightBrowserPort } from "@jevitate/playwright";
import { runExploration } from "./explore-api.js";
import { goalJobDecision, prepareJobDoneCheck, type ExploreJobCheck } from "./explore-job-done-check.js";
import { useSkippingTime } from "../../explore/src/testkit.js";

useSkippingTime({ per: "all", pageClock: false });

/**
 * 0.30.0 RC nav lab (rc-030): `explore --job` read `reading-unknown` on 15 of 30 looks-done runs with a page
 * check, and on every run with an `http:` check. Served (real Chromium, one pooled browser): a page check and
 * an http check on the app's own state read reliably (10 of 10 each, every reading in a new fresh context),
 * and a check that truly cannot be read stays unknown and says why (`job.reason`).
 */

let server: Server;
let origin: string;
let root: string;
let projectDir: string;
const state = { done: false };

function serve(): Promise<Server> {
  const s = createServer((req, res) => {
    const path = (req.url ?? "/").split("?")[0] ?? "/";
    if (path === "/__state") return void res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ case: "lab", done: state.done, docs: ["/"] }));
    // Answers nothing: the connection is dropped, so no reading can be taken.
    if (path === "/__hangup") return void req.socket.destroy();
    // rc-030b: a page whose one link does the job (the lab's looks-done-wrong-page: the real page reached).
    if (path === "/act") return void res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end('<!doctype html><html><body><h1>Act</h1><a href="/do">Open billing settings</a></body></html>');
    if (path === "/do") {
      state.done = true;
      return void res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end("<!doctype html><html><body><h1>Billing settings</h1></body></html>");
    }
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end("<!doctype html><html><body><h1>Home</h1></body></html>");
  });
  return new Promise((r) => s.listen(0, "127.0.0.1", () => r(s)));
}

const story = { trigger: "the lab goal is stated", motivation: "complete it", outcome: "the state shows it is done" };

beforeAll(async () => {
  server = await serve();
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  root = mkdtempSync(join(tmpdir(), "jev-explore-job-served-"));
  projectDir = join(root, ".jevitate");
  mkdirSync(projectDir, { recursive: true });
  writeFileSync(
    join(projectDir, "jobs.json"),
    JSON.stringify({
      jobs: [
        // The lab's exact check (rc-030/proj/.jevitate/jobs.json).
        { id: "page", ...story, done: { version: 1, at: "/__state", check: 'textIncludes:css=body|"done":true' } },
        { id: "http", ...story, done: { version: 1, at: "/__state", check: "http:GET /__state|jsonPath=$.done|equals=true" } },
        { id: "unreadable", ...story, done: { version: 1, at: "/", check: "http:GET /__hangup|status=200" } },
      ],
    }),
  );
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((r) => server.close(() => r()));
  rmSync(root, { recursive: true, force: true });
});

beforeEach(() => {
  state.done = false;
});

const prepare = (jobId: string): Promise<ExploreJobCheck> =>
  prepareJobDoneCheck({ jobId, catalogDir: projectDir, journeysDir: join(root, "journeys"), startUrl: `${origin}/`, sessionPortFactory: () => new PlaywrightBrowserPort() });

describe("explore --job: fresh-context done-check readings (served)", () => {
  for (const jobId of ["page", "http"]) {
    it(`a ${jobId} check reads false before and decides every after reading, 10 of 10`, async () => {
      const check = await prepare(jobId);
      expect(check).toMatchObject({ ok: true, basis: "done-check" });
      const reader = check.ok ? check.reader : undefined;
      expect(reader).toBeDefined();
      const readings: (boolean | null)[] = [];
      for (let i = 0; i < 10; i += 1) {
        state.done = i % 2 === 1;
        readings.push(await reader!());
      }
      expect(readings).toEqual([false, true, false, true, false, true, false, true, false, true]);
    });
  }

  it("a check that truly cannot be read stays unknown, and the verdict says why", async () => {
    const check = await prepare("unreadable");
    expect(check).toEqual({ ok: true, basis: "reading-unknown", reason: "check-unevaluable" });
    const reason = check.ok ? check.reason : undefined;
    const d = goalJobDecision({ completed: false, hasReader: false, basis: "reading-unknown", unknownReason: reason, goalOutcome: "blocked", foldedOutcome: "blocked" });
    expect(d.job).toEqual({ attainment: "unverified", basis: "reading-unknown", reason: "check-unevaluable" });
  });
});

/** Proposes `done` at every turn; the goal judgment never finds it achieved, so code rejects each one (rc-030 other-record). */
function rejectingJudge(): JudgmentPort {
  return {
    async systemOne({ questions }) {
      const out: Record<string, Answer> = {};
      for (const [name, q] of Object.entries(questions)) {
        if (q.kind === "choice") out[name] = { kind: "choice", value: name === "action" && q.options.includes("done") ? "done" : q.options[0]!, confidence: 1 };
        else if (q.kind === "noul") out[name] = { kind: "noul", value: false, probability: 0 };
        else out[name] = { kind: "score", value: 0 };
      }
      return out;
    },
  };
}

describe("explore --job: a run that ends with every done rejected (served)", () => {
  const runWith = async (reading: boolean | null, reason?: "session-unavailable") => {
    const outDir = mkdtempSync(join(root, "out-"));
    let reads = 0;
    const result = await runExploration({
      url: `${origin}/`,
      goal: "finish the lab job",
      allowlist: [origin],
      judge: rejectingJudge(),
      gen: new FakeGenerationGateway(),
      outDir,
      bounds: { maxDecisions: 4 },
      doneCheck: async () => {
        reads += 1;
        return reading;
      },
      ...(reason === undefined ? {} : { doneCheckUnknownReason: () => reason }),
    });
    return { result, reads };
  };

  it("is decided by its final fresh reading, not left reading-unknown unread", async () => {
    const { result, reads } = await runWith(false);
    expect(result.goalOutcome).not.toBe("succeeded");
    expect(reads).toBeGreaterThan(0);
    expect(result.job).toEqual({ attainment: "not-achieved", basis: "done-check" });
  }, 90_000);

  it("rc-030b (job gates, proof advisory): a final reading of true over the model's own non-pass is the job done, exit 0, and the fields agree", async () => {
    const outDir = mkdtempSync(join(root, "out-"));
    const rejecting = rejectingJudge();
    let clicked = false;
    // Opens the link that does the job, then proposes done at every turn; the judgment rejects each one.
    const judge: JudgmentPort = {
      async systemOne(args) {
        const q = args.questions.action;
        if (!clicked && q?.kind === "choice") {
          const link = q.options.find((id) => (q.descriptions?.[id] ?? "").includes('"Open billing settings"'));
          if (link !== undefined) {
            clicked = true;
            return { action: { kind: "choice", value: link, confidence: 1 } };
          }
        }
        return rejecting.systemOne(args);
      },
    };
    const result = await runExploration({
      url: `${origin}/act`,
      goal: "open the billing settings",
      allowlist: [origin],
      judge,
      gen: new FakeGenerationGateway(),
      outDir,
      bounds: { maxDecisions: 4 },
      doneCheck: async () => state.done,
    });
    expect(result.job).toEqual({ attainment: "achieved", basis: "done-check" });
    expect(result).toMatchObject({ goalOutcome: "succeeded", outcome: "succeeded", missionOutcome: "clean", exitCode: 0 });
    expect(result.goalReason).toBeUndefined();
    expect(result.failure).toBeUndefined();
    expect(result.reason).toMatch(/the job happened, so the job decides \(the run's own ending is advisory\)/);
  }, 90_000);

  it("a final reading that cannot be taken stays unknown and says why", async () => {
    const { result } = await runWith(null, "session-unavailable");
    expect(result.job).toEqual({ attainment: "unverified", basis: "reading-unknown", reason: "session-unavailable" });
  }, 90_000);
});
