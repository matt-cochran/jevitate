import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Page } from "playwright";
import { FakeGenerationGateway, type Answer, type JudgmentPort, type JudgmentState, type Question } from "@jevitate/ai-core";
import { BrowseTheWeb, CastActor } from "@jevitate/screenplay";
import { ActionDeltas, DELTA_MAX_CHANGES, type ActionDelta } from "./action-delta.js";
import { monitorFor } from "./page-monitor.js";
import { explore } from "./explore.js";
import type { Control } from "./snapshot.js";
import { PreferenceJudge, withSession } from "./testkit.js";

/**
 * #303 — action deltas, served in real Chromium: each verdict, the volatility baseline (a ticking
 * clock is never a change), a big list summarised, redaction (no secret in any stored or sent delta),
 * a Jev ignore rule rejected when it would hide a real change, and expected-vs-actual.
 */

const CLOCK = `<p id="clock">Time: 0</p><script>let n = 0; setInterval(() => { document.getElementById("clock").textContent = "Time: " + (++n); }, 100);</script>`;

const PAGES: Record<string, string> = {
  "/clock": `<main><h1>Clock</h1>${CLOCK}<button>Do nothing</button></main>`,
  "/save": `<main><h1>Save</h1>${CLOCK}<form aria-label="Profile"><label>Name <input id="n"></label><button type="button" id="s">Save</button></form>
    <div role="status" id="st"></div></main>
    <script>document.getElementById("s").onclick = () => { document.getElementById("st").textContent = "Saved"; };</script>`,
  "/elsewhere": `<main><h1>Elsewhere</h1><button id="b">Go</button><p id="far">Result: none</p></main>
    <script>document.getElementById("b").onclick = () => { document.getElementById("far").textContent = "Result: done " + Math.random().toString(36).slice(2, 6).replace(/[0-9]/g, "x"); };</script>`,
  "/ping": `<main><h1>Ping</h1><button id="b">Ping</button></main>
    <script>document.getElementById("b").onclick = () => { fetch("/api/ping", { method: "POST" }); };</script>`,
  "/canvas": `<main><h1>Draw</h1><canvas id="c" width="300" height="150" aria-label="Board" role="button" tabindex="0"></canvas></main>`,
  "/list": `<main><h1>List</h1><section aria-label="Items"><button id="b">Load</button><ul id="l"><li>Row 0</li></ul></section></main>
    <script>document.getElementById("b").onclick = () => { const l = document.getElementById("l"); for (let i = 1; i <= 50; i++) { const li = document.createElement("li"); li.textContent = "Entry " + i + " " + "abcdefghij".slice(0, i % 10); l.appendChild(li); } };</script>`,
  "/secret": `<main><h1>Keys</h1><form aria-label="Login"><label>Password <input id="pw" type="password" value="hunter2pass"></label>
    <label>Access code <input id="code" value="registered-s3cret"></label></form>
    <button id="b">Reveal</button><div role="status" id="st"></div><div data-secret id="k"></div><p id="tok"></p></main>
    <script>document.getElementById("b").onclick = () => {
      document.getElementById("st").textContent = "Your code registered-s3cret is ready";
      document.getElementById("k").textContent = "plainmarkedvalue42";
      document.getElementById("tok").textContent = "Key: sk_live_abcdefghijklmnop1234";
    };</script>`,
  "/ad": `<main><h1>Ads</h1><aside><p id="ad">Ad: buy shoes</p></aside><button id="b">Go</button><p id="far">Result: none</p></main>
    <script>const word = () => Array.from({ length: 6 }, () => "abcdefghijklmnopqrstuvwxyz"[Math.floor(Math.random() * 26)]).join("");
    setInterval(() => { document.getElementById("ad").textContent = "Ad: buy " + word(); }, 150);
    document.getElementById("b").onclick = () => { document.getElementById("far").textContent = "Result: done"; };</script>`,
  "/big": `<main><h1>Big</h1><button id="b">Refresh</button><div role="status" id="st"></div><table><tbody>${Array.from({ length: 400 }, (_, i) => `<tr><td>Row ${i}</td><td><a href="#r${i}">Open ${i}</a></td><td><button>Edit ${i}</button></td></tr>`).join("")}</tbody></table></main>
    <script>document.getElementById("b").onclick = () => { document.getElementById("st").textContent = "Refreshed"; };</script>`,
  "/reset": `<main><h1>Reset</h1><label>Nick <input id="n" aria-label="Nick"></label></main>
    <script>document.getElementById("n").addEventListener("input", (e) => { e.target.value = ""; });</script>`,
};

let server: Server;
let origin: string;
beforeAll(async () => {
  server = createServer((req, res) => {
    if (req.url?.startsWith("/api/")) return void res.writeHead(200, { "content-type": "application/json" }).end("{}");
    const body = PAGES[req.url ?? ""] ?? "<p>none</p>";
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(`<!doctype html><html><head><title>T</title></head><body>${body}</body></html>`);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

/** A minimal control for a role + accessible name (what the loop hands `beforeAction`). */
function control(role: string, name: string, extra: Partial<Control> = {}): Control {
  return { index: 0, descriptor: { role, name }, role, name, tag: role === "textbox" ? "input" : "button", inputType: null, enabled: true, summary: `${role} "${name}"`, ...extra } as unknown as Control;
}

/** A judge that labels every change question with `label` and records every call. */
class LabelJudge implements JudgmentPort {
  readonly calls: Array<{ state: JudgmentState; questions: Record<string, Question> }> = [];
  constructor(private readonly label: string) {}
  async systemOne(args: { state: JudgmentState; questions: Record<string, Question> }): Promise<Record<string, Answer>> {
    this.calls.push(args);
    const out: Record<string, Answer> = {};
    for (const [k, q] of Object.entries(args.questions)) {
      if (q.kind === "choice") out[k] = { kind: "choice", value: this.label, confidence: 0.9 };
      if (q.kind === "noul") out[k] = { kind: "noul", value: false, probability: 0.1 };
    }
    return out;
  }
}

async function open(page: Page, path: string): Promise<void> {
  await monitorFor(page).instrument();
  await page.addInitScript(() => {
    (window as unknown as { __jevitateDeltasOn?: boolean }).__jevitateDeltasOn = true;
  });
  await page.goto(`${origin}${path}`);
  await monitorFor(page).waitSettled({ ceilingMs: 5_000 });
}

/** perceive → before → act → settle → perceive: the action's delta. */
async function deltaOf(
  page: Page,
  deltas: ActionDeltas,
  route: string,
  op: string,
  target: Control | null,
  action: () => Promise<void>,
  value?: string,
): Promise<ActionDelta> {
  await deltas.perceived(route);
  await deltas.beforeAction(route, op, target);
  monitorFor(page).markAction();
  await action();
  deltas.acted({ label: `${op} ${target?.name ?? ""}`.trim(), recordIndex: 0, step: 1, ...(value === undefined ? {} : { value }) });
  await monitorFor(page).waitSettled({ ceilingMs: 5_000 });
  const d = await deltas.perceived(route);
  if (d === null) throw new Error("no delta");
  return d.delta;
}

const opts = { secrets: [] as string[], goal: "test", volatilityGapMs: 400 };

describe("#303 action deltas — verdicts (served, real Chromium)", () => {
  it("no-change: a button that does nothing, beside a ticking clock — the clock is never reported", async () => {
    await withSession("delta-", async (s) => {
      await open(s.page, "/clock");
      const deltas = new ActionDeltas(s.page, opts);
      const d = await deltaOf(s.page, deltas, "/clock", "click", control("button", "Do nothing"), () => s.page.click("button"));
      expect(d.verdict).toBe("no-change");
      expect(d.volatileIgnored ?? 0).toBeGreaterThan(0);
      expect(JSON.stringify(d)).not.toMatch(/Time:/);
      expect(d.expected).toEqual({ description: "a visible change", met: false, by: "code" });
    }, origin);
  }, 60_000);

  it("relevant-change: Save writes 'Saved' into a status region (the clock still ignored)", async () => {
    await withSession("delta-", async (s) => {
      await open(s.page, "/save");
      const deltas = new ActionDeltas(s.page, opts);
      const d = await deltaOf(s.page, deltas, "/save", "click", control("button", "Save"), () => s.page.click("#s"));
      expect(d.verdict).toBe("relevant-change");
      expect(d.changes.some((c) => c.tied && /status: "" → "Saved"/.test(c.text))).toBe(true);
      expect(JSON.stringify(d.changes)).not.toMatch(/Time:/);
    }, origin);
  }, 60_000);

  it("inconclusive: a change far from the target (no locality, no Jev) is never progress or no-progress", async () => {
    await withSession("delta-", async (s) => {
      await open(s.page, "/elsewhere");
      const deltas = new ActionDeltas(s.page, opts);
      const d = await deltaOf(s.page, deltas, "/elsewhere", "click", control("button", "Go"), () => s.page.click("#b"));
      expect(d.verdict).toBe("inconclusive");
      expect(d.changes[0]?.where).toBe("page");
      expect(d.changes[0]?.tied).toBe(false);
    }, origin);
  }, 60_000);

  it("inconclusive: a request sent with nothing visible changing is not no-change", async () => {
    await withSession("delta-", async (s) => {
      await open(s.page, "/ping");
      const deltas = new ActionDeltas(s.page, opts);
      const d = await deltaOf(s.page, deltas, "/ping", "click", control("button", "Ping"), () => s.page.click("#b"));
      expect(d.verdict).toBe("inconclusive");
      expect(d.requests).toEqual(["POST /api/ping → 200"]);
      expect(d.why).toMatch(/request was sent/);
    }, origin);
  }, 60_000);

  it("inconclusive: a canvas target is a partial capture — an empty diff is never no-change", async () => {
    await withSession("delta-", async (s) => {
      await open(s.page, "/canvas");
      const deltas = new ActionDeltas(s.page, opts);
      const d = await deltaOf(s.page, deltas, "/canvas", "click", control("button", "Board"), () => s.page.click("canvas"));
      expect(d.verdict).toBe("inconclusive");
      expect(d.partial).toContain("the target is a canvas");
    }, origin);
  }, 60_000);
});

describe("#303 action deltas — noise control, redaction, Jev rules, expectations", () => {
  it("a big change is summarised and the record stays bounded", async () => {
    await withSession("delta-", async (s) => {
      await open(s.page, "/list");
      const deltas = new ActionDeltas(s.page, opts);
      const d = await deltaOf(s.page, deltas, "/list", "click", control("button", "Load"), () => s.page.click("#b"));
      expect(d.verdict).toBe("relevant-change");
      const summary = d.changes.find((c) => (c.count ?? 0) >= 50);
      expect(summary?.text).toMatch(/50 added, 0 removed/);
      expect(d.changes.length).toBeLessThanOrEqual(DELTA_MAX_CHANGES);
      expect(JSON.stringify(d).length).toBeLessThan(4_000);
    }, origin);
  }, 60_000);

  it("redaction: no registered, learned (password / secret-marked) or credential-shaped value in a delta or a Jev payload", async () => {
    await withSession("delta-", async (s) => {
      await open(s.page, "/secret");
      const judge = new LabelJudge("irrelevant");
      const deltas = new ActionDeltas(s.page, { ...opts, secrets: ["registered-s3cret"], judge });
      const d = await deltaOf(s.page, deltas, "/secret", "click", control("button", "Reveal"), () => s.page.click("#b"));
      const all = JSON.stringify(d) + JSON.stringify(judge.calls);
      for (const secret of ["hunter2pass", "registered-s3cret", "plainmarkedvalue42", "sk_live_abcdefghijklmnop1234"]) expect(all).not.toContain(secret);
      expect(d.verdict).toBe("relevant-change");
      expect(all).toContain("«redacted»");
    }, origin);
  }, 60_000);

  it("a Jev ignore rule is REJECTED when it would hide a real change (never seen changing on its own)", async () => {
    await withSession("delta-", async (s) => {
      await open(s.page, "/elsewhere");
      const judge = new LabelJudge("changes-on-its-own");
      const deltas = new ActionDeltas(s.page, { ...opts, judge });
      const d = await deltaOf(s.page, deltas, "/elsewhere", "click", control("button", "Go"), () => s.page.click("#b"));
      expect(judge.calls.length).toBe(1);
      expect(d.rules?.accepted ?? []).toEqual([]);
      expect(d.rules?.rejected[0]).toMatch(/Result: done.*never seen changing without an action/);
      // The change stays in the record, and the verdict stays code's: inconclusive, never no-change.
      expect(d.verdict).toBe("inconclusive");
      expect(d.changes.some((c) => /Result: done/.test(c.text))).toBe(true);
    }, origin);
  }, 60_000);

  it("an ignore rule for a node seen changing on its own is accepted — and still never makes no-change", async () => {
    await withSession("delta-", async (s) => {
      await open(s.page, "/ad");
      const judge = new LabelJudge("changes-on-its-own");
      const deltas = new ActionDeltas(s.page, { ...opts, judge });
      // First action: the rotating ad shows a text the baseline never saw (not volatile by shape).
      let d = await deltaOf(s.page, deltas, "/ad", "click", control("button", "Go"), () => s.page.click("#b"));
      for (let i = 0; i < 4 && !(d.rules?.accepted ?? []).some((r) => /Ad:/.test(r)); i++) {
        d = await deltaOf(s.page, deltas, "/ad", "click", control("button", "Go"), () => s.page.click("#b"));
      }
      expect((d.rules?.accepted ?? []).some((r) => /Ad:/.test(r))).toBe(true);
      expect((d.rules?.rejected ?? []).some((r) => /Ad:/.test(r))).toBe(false);
      // Later: the "Result" text no longer changes; only the ad does — covered by the rule, but the
      // diff was not empty, so the verdict is inconclusive, never no-change.
      let later = await deltaOf(s.page, deltas, "/ad", "click", control("button", "Go"), () => s.page.click("#b"));
      for (let i = 0; i < 4 && (later.ruleIgnored ?? 0) === 0; i++) {
        later = await deltaOf(s.page, deltas, "/ad", "click", control("button", "Go"), () => s.page.click("#b"));
      }
      expect(later.ruleIgnored ?? 0).toBeGreaterThan(0);
      expect(later.verdict).not.toBe("no-change");
    }, origin);
  }, 120_000);

  it("expected vs actual: a typed value the page throws away is a mismatch", async () => {
    await withSession("delta-", async (s) => {
      await open(s.page, "/reset");
      const deltas = new ActionDeltas(s.page, opts);
      const d = await deltaOf(s.page, deltas, "/reset", "type", control("textbox", "Nick"), () => s.page.fill("#n", "Bobby"), "Bobby");
      expect(d.expected).toEqual({ description: 'the field shows "Bobby"', met: false, by: "code" });
      expect(d.verdict).toBe("no-change");
    }, origin);
  }, 60_000);
});

describe("#303 action deltas — overhead", () => {
  it("is measured per action and bounded on a large page (400 rows, 800 controls)", async () => {
    await withSession("delta-", async (s) => {
      await open(s.page, "/big");
      const deltas = new ActionDeltas(s.page, opts);
      const runs: number[] = [];
      for (let i = 0; i < 3; i++) {
        const d = await deltaOf(s.page, deltas, "/big", "click", control("button", "Refresh"), () => s.page.click("#b"));
        expect(d.verdict).not.toBe("no-change");
        runs.push(d.overheadMs);
      }
      console.log(`#303 delta overhead, 400-row page (ms per action): ${runs.join(", ")}`);
      expect(Math.max(...runs)).toBeLessThan(3_000);
    }, origin);
  }, 120_000);
});

describe("#303 action deltas in the goal loop (served)", () => {
  it("a no-op button clicked beside a clock ends no-progress on no-change deltas; transcript, Recording and prompt carry them", async () => {
    const judge = new PreferenceJudge([{ op: "click", name: "Do nothing" }]);
    const run = await withSession(
      "delta-run-",
      async (session) => {
        const actor = CastActor.named("owner").whoCan(new BrowseTheWeb(session, [origin]));
        return explore({
          actor,
          judge,
          gen: new FakeGenerationGateway(),
          goal: "make something happen",
          allowlist: [origin],
          startUrl: `${origin}/clock`,
          bounds: { maxDecisions: 12 },
          actionDeltas: { volatilityGapMs: 400 },
        });
      },
      origin,
    );
    expect(run.stop).toBe("no-progress");
    const withDelta = run.transcript.filter((e) => e.delta !== undefined);
    expect(withDelta.length).toBeGreaterThanOrEqual(3);
    expect(withDelta.every((e) => e.delta?.verdict === "no-change")).toBe(true);
    expect(JSON.stringify(run.transcript)).not.toMatch(/Time: \d/);
    const steps = run.recording.pages.flatMap((p) => p.steps);
    expect(steps.some((s) => s.delta?.verdict === "no-change")).toBe(true);
    expect(judge.states.some((st) => st.history.some((h) => /^effect of click Do nothing: no-change/.test(h)))).toBe(true);
    expect(run.actionDeltas?.noChange).toBeGreaterThanOrEqual(3);
    // Overhead is measured per action and bounded (two snapshots and a diff on a small page).
    console.log(`#303 delta overhead: ${JSON.stringify(run.actionDeltas?.overheadMs)}`);
    expect(run.actionDeltas?.overheadMs.max ?? Infinity).toBeLessThan(2_000);
  }, 120_000);
});

describe("#303 action deltas — nothing secret is stored (served goal loop)", () => {
  it("the transcript's and the Recording's deltas carry no registered, learned or credential-shaped value", async () => {
    const judge = new PreferenceJudge((n) => (n === 0 ? [{ op: "click", name: "Reveal" }] : [{ op: "done" }]));
    judge.goalMetProbability = 0.1;
    const run = await withSession(
      "delta-run-",
      async (session) => {
        const actor = CastActor.named("owner").whoCan(new BrowseTheWeb(session, [origin]));
        return explore({
          actor,
          judge,
          gen: new FakeGenerationGateway(),
          goal: "reveal the key",
          allowlist: [origin],
          startUrl: `${origin}/secret`,
          secrets: ["registered-s3cret"],
          bounds: { maxDecisions: 3 },
          actionDeltas: { volatilityGapMs: 300 },
        });
      },
      origin,
    );
    const deltas = run.transcript.flatMap((e) => (e.delta === undefined ? [] : [e.delta]));
    expect(deltas.length).toBeGreaterThanOrEqual(1);
    const stored = JSON.stringify(deltas) + JSON.stringify(run.recording) + JSON.stringify(judge.calls.map((c) => c.state));
    for (const secret of ["hunter2pass", "registered-s3cret", "plainmarkedvalue42", "sk_live_abcdefghijklmnop1234"]) expect(stored).not.toContain(secret);
    expect(deltas[0]?.verdict).toBe("relevant-change");
  }, 120_000);
});

describe("#303 action deltas are opt-in — off by default, no work at all", () => {
  it("without actionDeltas: no snapshot, no announcement notes, no delta, no prompt line, no stats", async () => {
    const judge = new PreferenceJudge([{ op: "click", name: "Save" }]);
    let snapshots = 0;
    const run = await withSession(
      "delta-off-",
      async (session) => {
        const proto = Object.getPrototypeOf(session.page.locator("body")) as { ariaSnapshot: (...a: unknown[]) => Promise<string> };
        const original = proto.ariaSnapshot;
        proto.ariaSnapshot = function (this: unknown, ...a: unknown[]) {
          snapshots += 1;
          return original.apply(this, a);
        };
        try {
          const actor = CastActor.named("owner").whoCan(new BrowseTheWeb(session, [origin]));
          const r = await explore({
            actor,
            judge,
            gen: new FakeGenerationGateway(),
            goal: "make something happen",
            allowlist: [origin],
            startUrl: `${origin}/save`,
            bounds: { maxDecisions: 6 },
          });
          const notes = await session.page.evaluate(
            () => (window as unknown as { __jevitateMonitor?: { transients?: unknown[] } }).__jevitateMonitor?.transients?.length ?? 0,
          );
          expect(notes).toBe(0);
          return r;
        } finally {
          proto.ariaSnapshot = original;
        }
      },
      origin,
    );
    expect(snapshots).toBe(0);
    expect(run.actionDeltas).toBeUndefined();
    expect(run.transcript.some((e) => e.delta !== undefined)).toBe(false);
    expect(run.recording.pages.flatMap((p) => p.steps).some((s) => s.delta !== undefined)).toBe(false);
    expect(judge.calls.some((c) => JSON.stringify(c).includes("effect of"))).toBe(false);
  }, 120_000);
});
