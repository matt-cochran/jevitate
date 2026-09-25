import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  FakeGenerationGateway,
  FakeJudgmentGateway,
  type Answer,
  type GenerationPort,
  type JudgmentPort,
  type JudgmentState,
  type Question,
} from "@jevitate/ai-core";
import { BrowseTheWeb, CastActor } from "@jevitate/screenplay";
import { explore } from "./explore.js";
import { runInductionMission } from "./missions/induction.js";
import { withSession } from "./testkit.js";

/**
 * Served fixtures for the side-effect work of round 3:
 *  - #110: a gRPC-web/Connect READ sent as POST is not a guarded side effect (not refused, not listed);
 *  - #123: re-typing the SAME values and submitting again is refused as a repeat; new values are not;
 *  - #92 (reopened): an in-progress status the page shows ("Simulating…") is waited on, never
 *    "nothing is pending", and a model `blocked` is deferred while it shows;
 *  - #116: coverage never clicks "Sign out" / "Delete account" unless `allowDestructive`.
 */

const hits = new Map<string, number>();
const hit = (k: string): void => void hits.set(k, (hits.get(k) ?? 0) + 1);
const count = (k: string): number => hits.get(k) ?? 0;

const page = (body: string): string => `<!doctype html><html><body>${body}</body></html>`;

const CARD = page(`
<h1>Workspace</h1>
<button type="button" id="open">Open question</button>
<button type="button" id="save">Save note</button>
<p id="out">Nothing open</p>
<script>
  let n = 0;
  document.getElementById("open").addEventListener("click", async () => {
    const r = await fetch("/simuli.workspace.WorkspaceService/ListNodeTests", {
      method: "POST", headers: { "content-type": "application/connect+json" }, body: "{}",
    });
    document.getElementById("out").textContent = "Question " + (++n) + " open (" + r.status + ")";
  });
  document.getElementById("save").addEventListener("click", async () => {
    await fetch("/api/notes", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    document.getElementById("out").textContent = "Note saved";
  });
</script>`);

const FORM = page(`
<h1>Participants</h1>
<form id="f">
  <label>Participant name <input type="text" name="name" aria-label="Participant name" /></label>
  <button type="submit">Save participant</button>
</form>
<ul id="list"></ul>
<script>
  document.getElementById("f").addEventListener("submit", async (e) => {
    e.preventDefault();
    const input = e.target.elements.name;
    await fetch("/api/participants", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: input.value }) });
    const li = document.createElement("li");
    li.textContent = input.value;
    document.getElementById("list").appendChild(li);
    input.value = "";
  });
</script>`);

const SIM = page(`
<h1>Raise Pro to $149</h1>
<button type="button" id="run">Run the simulation →</button>
<p id="state">Not run yet</p>
<script>
  document.getElementById("run").addEventListener("click", async () => {
    document.getElementById("state").textContent = "Simulating…";
    await fetch("/api/simulations", { method: "POST", body: "{}" });
    // The app polls on a timer: no request is in flight while the job runs.
    setTimeout(() => { document.getElementById("state").textContent = "Verdict: go ahead"; }, 4000);
  });
</script>`);

const SETTINGS = page(`
<h1>Settings</h1>
<button type="button" onclick="fetch('/api/logout',{method:'POST'});document.getElementById('s').textContent='Signed out'">Sign out</button>
<button type="button" onclick="fetch('/api/account',{method:'DELETE'});document.getElementById('s').textContent='Account deleted'">Delete account</button>
<p id="s">Signed in</p>
<button type="button" onclick="document.getElementById('s').textContent='Export queued'">Export data</button>
<button type="button" onclick="document.getElementById('d').hidden=!document.getElementById('d').hidden">Show details</button>
<p id="d" hidden>Plan: Pro</p>`);

let server: Server;
let base: string;
beforeAll(async () => {
  server = createServer((req, res) => {
    const path = (req.url ?? "").split("?")[0] ?? "";
    if (req.method !== "GET") {
      hit(`${req.method} ${path}`);
      res.writeHead(200, { "content-type": "application/json" }).end("{}");
      return;
    }
    const body = { "/card": CARD, "/participants": FORM, "/sim": SIM, "/settings": SETTINGS }[path];
    if (body === undefined) {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(body);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((r) => server.close(() => r()));
});
beforeEach(() => hits.clear());

/** Picks, per step, the first offered action whose id or description matches (repeating the last). */
class PickingJudge implements JudgmentPort {
  #i = 0;
  constructor(private readonly steps: readonly RegExp[]) {}
  async systemOne(args: { state: JudgmentState; questions: Record<string, Question> }): Promise<Record<string, Answer>> {
    const q = args.questions.action;
    if (q === undefined) {
      const out: Record<string, Answer> = {};
      for (const name of Object.keys(args.questions)) out[name] = { kind: "noul", value: false, probability: 0.1 };
      return out;
    }
    if (q.kind !== "choice") throw new Error("expected a choice");
    const pattern = this.steps[Math.min(this.#i, this.steps.length - 1)] as RegExp;
    this.#i += 1;
    const pick = q.options.find((o) => pattern.test(o) || pattern.test(q.descriptions?.[o] ?? ""));
    if (pick === undefined) throw new Error(`no option matches ${String(pattern)}: ${q.options.join(", ")}`);
    return { action: { kind: "choice", value: pick, confidence: 0.9 } };
  }
}

/** A form-value generator that hands out the given values in turn (a real "add another"). */
class SequenceGen implements GenerationPort {
  #i = 0;
  readonly #fake = new FakeGenerationGateway();
  constructor(private readonly values: readonly string[]) {}
  generate: GenerationPort["generate"] = async (kind, input) => {
    const r = await this.#fake.generate(kind, input);
    if (kind !== "form.value") return r;
    const text = this.values[Math.min(this.#i++, this.values.length - 1)];
    return { ...r, output: { text } } as typeof r;
  };
}

async function runGoal(path: string, goal: string, steps: readonly RegExp[], extra: { gen?: GenerationPort; maxDecisions?: number; jobWaitMs?: number } = {}) {
  return withSession(
    "side-effects-served-",
    async (session) => {
      const actor = CastActor.named("served").whoCan(new BrowseTheWeb(session, [base]));
      return explore({
        actor,
        judge: new PickingJudge(steps),
        gen: extra.gen ?? new FakeGenerationGateway(),
        goal,
        allowlist: [base],
        startUrl: `${base}${path}`,
        bounds: { maxDecisions: extra.maxDecisions ?? steps.length },
        waitOpMs: 500,
        ...(extra.jobWaitMs === undefined ? {} : { jobWaitMs: extra.jobWaitMs }),
      });
    },
    base,
  );
}

describe("#110 — a Connect-style POST read is not a side effect", () => {
  it("re-opening a card whose click fires a read RPC is never refused, and only the real write is listed", async () => {
    const run = await runGoal("/card", "open the question twice, then save a note", [
      /Open question/,
      /Open question/,
      /Save note/,
      /^blocked$/,
    ]);
    const clicks = run.transcript.filter((e) => e.op === "click");
    expect(clicks.map((e) => e.actOk)).toEqual([true, true, true]);
    expect(run.transcript.some((e) => /repeated side effect refused/.test(e.reason ?? ""))).toBe(false);
    expect(count("POST /simuli.workspace.WorkspaceService/ListNodeTests")).toBe(2);
    // sideEffects lists the write the run fired — never the read RPCs.
    expect(run.sideEffects.map((s) => `${s.request.method} ${s.request.endpoint}`)).toEqual(["POST /api/notes"]);
    expect(run.sideEffects[0]).toMatchObject({ control: "Save note", request: { status: 200 } });
    expect(run.sideEffects[0]?.risk).toBeUndefined();
  }, 90_000);
});

describe("#123 — the repeat guard compares the submitted values", () => {
  it("re-typing identical values and saving again is refused as a repeat", async () => {
    const run = await runGoal("/participants", "add Dana Ruiz and Lee Park as participants", [
      /^type into .*Participant name/,
      /Save participant/,
      /^type into .*Participant name/,
      /Save participant/,
      /^blocked$/,
    ]);
    expect(count("POST /api/participants")).toBe(1);
    const refused = run.transcript.find((e) => /repeated side effect refused/.test(e.reason ?? ""));
    expect(refused?.op).toBe("click");
    expect(refused?.reason).toContain("the inputs hold the same values");
    expect(run.outcome.status).toBe("incomplete");
  }, 90_000);

  it("a different value is a new submission and is allowed", async () => {
    const run = await runGoal(
      "/participants",
      "add Dana Ruiz and Lee Park as participants",
      [/^type into .*Participant name/, /Save participant/, /^type into .*Participant name/, /Save participant/, /^blocked$/],
      { gen: new SequenceGen(["Dana Ruiz", "Lee Park"]) },
    );
    expect(count("POST /api/participants")).toBe(2);
    expect(run.transcript.some((e) => /repeated side effect refused/.test(e.reason ?? ""))).toBe(false);
    expect(run.sideEffects.filter((s) => s.request.endpoint === "/api/participants")).toHaveLength(2);
  }, 90_000);
});

describe("#92 — an in-progress status the page shows is pending work", () => {
  it("a wait on \"Simulating…\" waits it out instead of \"nothing is pending\"", async () => {
    const run = await runGoal(
      "/sim",
      "simulate how customers respond to raising Pro to $149 and read the verdict",
      [/Run the simulation/, /^wait$/, /^blocked$/],
      { jobWaitMs: 20_000 },
    );
    expect(count("POST /api/simulations")).toBe(1);
    const wait = run.transcript.find((e) => e.op === "wait");
    expect(wait?.reason).toMatch(/in-progress status .*Simulating.* cleared/);
    expect(run.transcript.some((e) => /waiting again will not help/.test(e.reason ?? ""))).toBe(false);
    // The run then saw the verdict: its final state is after the job, not the "Simulating…" one.
    const last = run.transcript[run.transcript.length - 1];
    expect(last?.op).toBe("blocked");
  }, 90_000);

  it("a model `blocked` while the page shows \"Simulating…\" is deferred into a job wait", async () => {
    const run = await runGoal(
      "/sim",
      "simulate how customers respond to raising Pro to $149 and read the verdict",
      [/Run the simulation/, /^blocked$/, /^blocked$/],
      { jobWaitMs: 20_000 },
    );
    expect(count("POST /api/simulations")).toBe(1);
    const deferred = run.transcript.find((e) => /^blocked deferred/.test(e.reason ?? ""));
    expect(deferred?.op).toBe("wait");
    expect(deferred?.reason).toMatch(/Simulating/);
    expect(run.stop).toBe("blocked");
    // The paid launch the goal asked for was allowed, and is marked as paid.
    expect(run.sideEffects).toEqual([expect.objectContaining({ control: "Run the simulation →", risk: "paid", request: expect.objectContaining({ method: "POST", endpoint: "/api/simulations" }) })]);
  }, 90_000);

  it("a goal that does not ask for the paid action never clicks it", async () => {
    const run = await runGoal("/sim", "read the bet's title", [/Run the simulation/, /^blocked$/]);
    expect(count("POST /api/simulations")).toBe(0);
    expect(run.transcript.find((e) => e.op === "click")?.reason).toMatch(/refused by the safety policy: .*Run the simulation.*paid/);
  }, 90_000);
});

describe("#116 — coverage never clicks session-ending or destructive controls by default", () => {
  const cover = (allowDestructive: boolean, deny?: readonly string[]) =>
    withSession(
      "side-effects-coverage-",
      async (session) => {
        const actor = CastActor.named("coverage-safety").whoCan(new BrowseTheWeb(session, [base]));
        return runInductionMission({
          page: session.page,
          actor,
          judgment: new FakeJudgmentGateway({ isDefect: { kind: "noul", value: false, probability: 0 } }),
          generation: new FakeGenerationGateway(),
          seedUrl: `${base}/settings`,
          allowlist: [base],
          bounds: { maxActions: 12, maxDecisions: 24 },
          ...(allowDestructive ? { safety: { allowDestructive: true } } : deny === undefined ? {} : { safety: { deny } }),
        });
      },
      base,
    );

  it("refuses Sign out and Delete account (recorded once each) and still exercises the rest", async () => {
    const result = await cover(false);
    expect(count("POST /api/logout")).toBe(0);
    expect(count("DELETE /api/account")).toBe(0);
    const refusals = result.transcript.filter((e) => e.strategy === "safety-policy");
    expect(refusals.map((e) => e.reason)).toEqual([
      expect.stringMatching(/"Sign out" ends the session/),
      expect.stringMatching(/"Delete account" is destructive/),
    ]);
    expect(result.transcript.some((e) => e.strategy === "coverage-frontier" && e.actOk)).toBe(true);
    expect(result.sideEffects).toEqual([]);
  }, 90_000);

  it("#186 — a refused control never enters the frontier: refused once at enqueue, before any action, never reset to", async () => {
    const result = await cover(false, ["Export"]);
    expect(result.transcript.some((e) => e.op === "click" && e.control?.name === "Export data")).toBe(false);
    const refusals = result.transcript.filter((e) => e.strategy === "safety-policy");
    expect(refusals.map((e) => e.reason)).toEqual([
      expect.stringMatching(/"Sign out" ends the session/),
      expect.stringMatching(/"Delete account" is destructive/),
      expect.stringMatching(/"Export data" matches --deny/),
    ]);
    const firstAction = result.transcript.findIndex((e) => e.strategy === "coverage-frontier");
    expect(firstAction).toBeGreaterThan(0);
    expect(result.transcript.slice(0, firstAction).every((e) => e.strategy === "safety-policy")).toBe(true);
    expect(result.transcript.slice(firstAction).some((e) => e.strategy === "safety-policy")).toBe(false);
    expect(result.transcript.some((e) => e.strategy === "coverage-frontier" && e.actOk)).toBe(true);
  }, 90_000);

  it("--allow-destructive lifts it, and the result marks the destructive side effects", async () => {
    const result = await cover(true);
    expect(count("POST /api/logout") + count("DELETE /api/account")).toBeGreaterThan(0);
    expect(result.sideEffects?.length).toBeGreaterThan(0);
    expect(result.sideEffects?.every((s) => s.risk === "session-end" || s.risk === "destructive")).toBe(true);
  }, 90_000);
});
