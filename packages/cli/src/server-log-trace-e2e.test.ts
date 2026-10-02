import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProfileManager } from "@jevitate/daemon";
import { FakeGenerationGateway, type Answer, type JudgmentPort } from "@jevitate/ai-core";
import { buildProgram } from "./program.js";

/**
 * #204 + #282, served end to end (real Chromium, a real tailed log file, the real `explore` CLI).
 *
 * The app answers every API call with an `x-request-id` and logs the request's work with that id —
 * a busy backend shared with another tenant:
 *  - "Save draft" (step 1) answers 200 at once, but its background indexing fails and is LOGGED
 *    ~1.5 s later — while step 2 runs. By time window it would land on step 2.
 *  - "Publish" (step 2) is refused (409) and logs its cause right away; the page shows an alert.
 *  - Meanwhile another user's concurrent publish fails the same way (`request_id=` of a request this
 *    run never sent), and another tenant logs a line with no id at all.
 *
 * With trace/correlation-id matching each line goes to the exact request — and step — that caused
 * it; the other user's id-carrying line is foreign, and `--log-scope tenant=acme` keeps the other
 * tenant's id-less line out (both counted as `ignoredLines`). A line of this tenant with no id still
 * falls back to the time window. The run's `reason` composes the UI blocker with the correlated
 * server cause on its exact request.
 */

let app: Server;
let origin: string;
let logFile: string;
let seq = 0;
const log = (line: string): void => appendFileSync(logFile, `${new Date().toISOString()} ${line}\n`);

const PAGE = `<!doctype html><html><body>
<h1>Draft</h1>
<button type="button" id="save">Save draft</button>
<button type="button" id="publish">Publish</button>
<p id="status" role="status"></p>
<script>
  document.getElementById("save").addEventListener("click", async () => {
    const r = await fetch("/api/drafts", { method: "POST", body: "{}" });
    document.getElementById("status").textContent = r.ok ? "Draft saved" : "Save failed";
  });
  document.getElementById("publish").addEventListener("click", async () => {
    const r = await fetch("/api/publish", { method: "POST", body: "{}" });
    if (!r.ok) {
      const a = document.createElement("div");
      a.setAttribute("role", "alert");
      a.textContent = "Publishing is not available right now";
      document.body.appendChild(a);
    }
  });
</script>
</body></html>`;

beforeAll(async () => {
  logFile = join(await mkdtemp(join(tmpdir(), "jevitate-trace-log-")), "app.log");
  await writeFile(logFile, "");
  app = createServer((req, res) => {
    const rid = `req-${String(++seq).padStart(4, "0")}-7f3a9c`;
    if (req.method === "POST" && req.url === "/api/drafts") {
      res.writeHead(200, { "content-type": "application/json", "x-request-id": rid, "access-control-expose-headers": "x-request-id" }).end("{}");
      // The draft's background indexing fails LATER, while the next step runs.
      setTimeout(() => log(`ERROR tenant=acme request_id=${rid} draft indexing failed: search cluster unavailable`), 1_500);
      return;
    }
    if (req.method === "POST" && req.url === "/api/publish") {
      log(`ERROR tenant=acme request_id=${rid} publish refused: plan quota exceeded`);
      // Concurrent work in the same window: another user of this tenant (a request this run never
      // sent), and another tenant on the same backend (no id at all).
      log("ERROR tenant=acme request_id=req-9999-0bd1e2 publish refused: plan quota exceeded");
      log("WARN tenant=globex cache rebuild slow");
      log("WARN tenant=acme slow query on drafts");
      res.writeHead(409, { "content-type": "application/json", "x-request-id": rid }).end('{"error":"quota"}');
      return;
    }
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(PAGE);
  });
  await new Promise<void>((resolve) => app.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(app.address() as AddressInfo).port}`;
});
afterAll(async () => {
  app.closeAllConnections();
  await new Promise<void>((resolve) => app.close(() => resolve()));
  await rm(join(logFile, ".."), { recursive: true, force: true });
});

class ScriptedJudge implements JudgmentPort {
  #i = 0;
  constructor(private readonly seq: ReadonlyArray<{ op: string; target?: string }>) {}
  async systemOne(): Promise<Record<string, Answer>> {
    const cur = this.seq[Math.min(this.#i, this.seq.length - 1)];
    this.#i += 1;
    if (cur === undefined) throw new Error("ScriptedJudge: empty script");
    const value = cur.target !== undefined ? `${cur.op}:${cur.target}` : cur.op;
    return { action: { kind: "choice", value, confidence: 0.9 } };
  }
}

interface Logged {
  level: string;
  message: string;
  request?: { method: string; url: string; status: number | null; id: string };
}

describe("backend-log correlation by request id, scoped to one run (#204, #282)", () => {
  it(
    "attaches each line to its exact request and step, drops the other tenant's lines, and composes the reason",
    async () => {
      const outDir = await mkdtemp(join(tmpdir(), "jevitate-trace-out-"));
      const out: string[] = [];
      const program = buildProgram({
        profiles: new ProfileManager("/unused"),
        explore: {
          judge: new ScriptedJudge([{ op: "click", target: "0" }, { op: "click", target: "1" }, { op: "blocked" }]),
          gen: new FakeGenerationGateway({}),
        },
      });
      program.configureOutput({ writeOut: (s) => out.push(s) });
      program.exitOverride();
      await program.parseAsync(
        [
          "explore",
          "--url",
          `${origin}/drafts/1`,
          "--goal",
          "save the draft and publish it",
          "--success",
          "textIncludes:[role=status]|Published",
          "--allow",
          origin,
          "--log-source",
          `file:${logFile}`,
          "--log-scope",
          "tenant=acme",
          "--server-log-drain-ms",
          "2500",
          "--out",
          outDir,
          "--json",
        ],
        { from: "user" },
      );
      const parsed = JSON.parse(out.join(""));
      expect(parsed.ok, JSON.stringify(parsed)).toBe(true);
      const result = parsed.data;
      const steps = result.transcript as Array<{ step: number; op: string; serverLogs?: Logged[] }>;
      const [save, publish] = steps;
      expect(save?.op).toBe("click");
      expect(publish?.op).toBe("click");

      // The draft's late failure is on the SAVE step, tied to its exact request — not on step 2.
      const indexing = save?.serverLogs?.find((l) => l.message.includes("draft indexing failed"));
      expect(indexing?.request).toMatchObject({ method: "POST", url: `${origin}/api/drafts`, status: 200 });
      expect(indexing?.request?.id).toMatch(/^req-\d{4}-7f3a9c$/);
      expect(publish?.serverLogs?.some((l) => l.message.includes("draft indexing failed"))).toBe(false);

      // The publish step: its own refusal (by id) and this tenant's id-less line (by time) — only.
      const refused = publish?.serverLogs?.filter((l) => l.message.includes("publish refused")) ?? [];
      expect(refused).toHaveLength(1);
      expect(refused[0]?.request).toMatchObject({ method: "POST", url: `${origin}/api/publish`, status: 409 });
      expect(publish?.serverLogs?.some((l) => l.message.includes("slow query on drafts") && l.request === undefined)).toBe(true);
      const all = JSON.stringify(steps);
      expect(all).not.toContain("globex");
      expect(all).not.toContain("req-9999");

      // The other user's and the other tenant's lines are counted, never attributed.
      expect(result.serverLogs.correlation).toMatchObject({ idMatchedLines: 2, foreignLines: 1, outOfScopeLines: 1 });
      expect(result.serverLogs.correlation.requestsWithIds).toBeGreaterThanOrEqual(2);
      expect(result.serverLogs.ignoredLines).toBe(2);

      // The reason joins the UI blocker with its server cause on the exact request.
      expect(result.reason).toContain('the page shows alert "Publishing is not available right now"');
      expect(result.reason).toMatch(/; caused by: error "[^"]*request_id=req-\d{4}-7f3a9c publish refused: plan quota exceeded" on POST \/api\/publish \(409\)$/);

      await rm(outDir, { recursive: true, force: true });
    },
    180_000,
  );

  it(
    "#313 --log-triage: the signal timeline is written, and each defect keeps only its related lines (correlated by id, then scored by Jev)",
    async () => {
      const outDir = await mkdtemp(join(tmpdir(), "jevitate-triage-out-"));
      const out: string[] = [];
      const actions = new ScriptedJudge([{ op: "click", target: "0" }, { op: "click", target: "1" }, { op: "blocked" }]);
      const asked: string[] = [];
      // One gateway, as a live run has: the loop's action choices, and the triage's line questions.
      const judge: JudgmentPort = {
        async systemOne(args) {
          if (!Object.keys(args.questions).some((k) => k.startsWith("line"))) return actions.systemOne();
          const answers: Record<string, Answer> = {};
          for (const [name, q] of Object.entries(args.questions)) {
            const text = /«(.*)»/s.exec(q.instructions ?? "")?.[1] ?? "";
            asked.push(text);
            const p = text.includes("quota") ? 0.9 : 0.1;
            answers[name] = { kind: "noul", value: p >= 0.5, probability: p };
          }
          return answers;
        },
      };
      const program = buildProgram({ profiles: new ProfileManager("/unused"), explore: { judge, gen: new FakeGenerationGateway({}) } });
      program.configureOutput({ writeOut: (s) => out.push(s) });
      program.exitOverride();
      await program.parseAsync(
        [
          "explore", "--url", `${origin}/drafts/2`, "--goal", "save the draft and publish it", "--success", "textIncludes:[role=status]|Published",
          "--allow", origin, "--log-source", `file:${logFile}`, "--log-scope", "tenant=acme", "--log-defect", "/publish refused/",
          "--log-triage", "--server-log-drain-ms", "2500", "--out", outDir, "--real", "--json",
        ],
        { from: "user" },
      );
      const parsed = JSON.parse(out.join(""));
      expect(parsed.ok, JSON.stringify(parsed)).toBe(true);
      const result = parsed.data as {
        resultPath: string;
        defects: Array<{ kind: string; relatedLogs?: Array<{ text: string; keptBy: string; request?: { url: string } }> }>;
        signals: { path: string; entries: number; triage: { mode: string; jevCalls: number } };
      };
      expect(existsSync(result.signals.path)).toBe(true);
      expect(result.signals.triage.mode).toBe("jev");
      const timeline = readFileSync(result.signals.path, "utf8");
      expect(timeline).toContain("slow query on drafts"); // every in-scope line is on the timeline…
      expect(timeline).not.toContain("globex"); // …never another tenant's
      const refused = result.defects.find((d) => d.kind === "server-log");
      const kept = refused?.relatedLogs ?? [];
      expect(kept.find((l) => l.keptBy === "request-id")?.request?.url).toBe(`${origin}/api/publish`);
      // Jev saw the step's other in-scope line and judged it unrelated: it does not travel.
      expect(asked.some((t) => t.includes("slow query on drafts"))).toBe(true);
      expect(kept.some((l) => l.text.includes("slow query on drafts"))).toBe(false);
      expect(JSON.stringify(kept)).not.toContain("req-9999");
      // The persisted result carries the same.
      const file = JSON.parse(readFileSync(result.resultPath, "utf8")) as { result: { defects: Array<{ kind: string; relatedLogs?: unknown[] }> } };
      expect(file.result.defects.find((d) => d.kind === "server-log")?.relatedLogs).toEqual(kept);
      await rm(outDir, { recursive: true, force: true });
    },
    180_000,
  );
});
