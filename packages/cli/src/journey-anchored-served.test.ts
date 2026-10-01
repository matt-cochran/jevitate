import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Command } from "commander";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProfileManager } from "@jevitate/daemon";
import { FsJourneyStore, type Journey } from "@jevitate/journey";
import { PlaywrightBrowserPort } from "@jevitate/playwright";
import { PersistedMissionResultSchema } from "./result-schema.js";
import { buildProgram } from "./program.js";

/**
 * #293 served e2e — journey-anchored exploration in REAL (headless) Chromium against a served
 * order wizard whose review step is pure in-page state (no server round trip):
 *
 *  - `explore --from-journey order --at-step 3` replays the Journey's first 3 steps in the mission's
 *    own context: the mission's first perception already shows the review step built from the
 *    replayed form value, and the server saw ONE page load (no fresh navigation);
 *  - a stale Journey ends typed (`journey-stale`, exit 2) — never a run from a URL;
 *  - `journey anchors` lists the declared anchors; bad anchored invocations are refused (exit 64);
 *  - a 2-job campaign runs discovery → anchored missions with the fixtures' restore around every run
 *    and writes ONE deduped report whose defect names both branch points.
 */

const WIZARD = `<!doctype html><html><head><title>Order</title></head><body><main>
  <section id="s1"><h1>Order</h1>
    <label>Name <input id="name" aria-label="Name"></label>
    <label>Note <input id="note" aria-label="Note"></label>
    <button type="button" id="next">Next</button></section>
  <section id="s2" hidden><h2>Review</h2><p id="summary"></p><div id="confirm-slot"></div></section>
  <section id="s3" hidden><p data-testid="done">Thanks</p></section>
  <script>
    document.getElementById("next").onclick = () => {
      const name = document.getElementById("name").value;
      document.getElementById("s1").hidden = true;
      document.getElementById("s2").hidden = false;
      document.getElementById("summary").textContent = "Order for " + name;
      const b = document.createElement("button");
      b.type = "button";
      b.textContent = "Confirm order for " + name;
      b.onclick = () => { document.getElementById("s2").hidden = true; document.getElementById("s3").hidden = false; };
      document.getElementById("confirm-slot").appendChild(b);
      // A deterministic defect that lives only in the review state, for one customer.
      if (name === "Mallory") setInterval(() => { throw new Error("review widget crashed"); }, 150);
    };
  </script></main></body></html>`;

let server: Server;
let origin: string;
let dir: string;
let journeysDir: string;
/** Every request the app served, in order (`GET /wizard`, `POST /api/seed`, …). */
const served: string[] = [];

beforeAll(async () => {
  server = createServer((req, res) => {
    const path = (req.url ?? "").split("?")[0] ?? "";
    served.push(`${req.method} ${path}`);
    if (path === "/wizard") return void res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(WIZARD);
    if (path === "/api/seed" || path === "/api/reset") return void res.writeHead(200, { "content-type": "application/json" }).end("{}");
    res.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  dir = await mkdtemp(join(tmpdir(), "jevitate-anchored-"));
  journeysDir = join(dir, "journeys");
  const store = new FsJourneyStore(journeysDir);
  await store.put(order("order", "Next"));
  await store.put(order("order-stale", "Continue")); // the app has no "Continue" button any more
  await store.put({ ...order("order-draft", "Next"), metadata: { ...order("order-draft", "Next").metadata, promoted: false } });
  await store.put(orderWithNote("order-noted"));
  // A Journey whose prefix types a secret (a credential-like param name): never into an unredacted strategy.
  await store.put({
    ...order("signin", "Next"),
    metadata: { ...order("signin", "Next").metadata, params: ["password"], anchors: [] },
    recording: { version: "1", site: origin, pages: [{ url: "/wizard", steps: [nav, { ...fillName, step: { ...fillName.step, value: { var: "password" } }, variableName: "password" }] }] },
  });
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await rm(dir, { recursive: true, force: true });
});

const nav = { step: { kind: "navigate" as const, url: "/wizard", expect: { kind: "visible" as const, target: { role: "heading", name: "Order" } } }, objective: "Open the order wizard" };
const fillName = { step: { kind: "fill" as const, target: { label: "Name" }, value: { var: "name" }, expect: { kind: "visible" as const, target: { label: "Name" } } }, variableName: "name" };
const next = (button: string) => ({ step: { kind: "click" as const, label: "Go to review", target: { role: "button", name: button }, expect: { kind: "visible" as const, target: { role: "heading", name: "Review" } } } });
const confirm = { step: { kind: "click" as const, target: { css: "#confirm-slot button" }, expect: { kind: "visible" as const, target: { testId: "done" } } } };

function order(id: string, nextButton: string): Journey {
  return {
    metadata: {
      id,
      name: "Place an order",
      promoted: true,
      params: ["name"],
      createdAtIso: "2026-10-01T00:00:00.000Z",
      anchors: [
        { name: "filled", step: 2, description: "the name is typed, nothing submitted" },
        { name: "review", step: 3, description: "the in-page review step", probes: ["double submit the confirm", "go back and change the name"] },
      ],
    },
    recording: { version: "1", site: origin, pages: [{ url: "/wizard", steps: [nav, fillName, next(nextButton), confirm] }] },
  };
}

/** A second Journey that reaches the SAME review state another way (it also types a note). */
function orderWithNote(id: string): Journey {
  const fillNote = { step: { kind: "fill" as const, target: { label: "Note" }, value: { redacted: false as const, value: "gift" }, expect: { kind: "visible" as const, target: { label: "Note" } } } };
  return {
    metadata: { id, name: "Order with a note", promoted: true, params: ["name"], createdAtIso: "2026-10-01T00:00:00.000Z", anchors: [{ name: "noted-review", step: 4 }] },
    recording: { version: "1", site: origin, pages: [{ url: "/wizard", steps: [nav, fillName, fillNote, next("Next")] }] },
  };
}

interface CliRun {
  readonly out: string;
  readonly err: string;
  readonly exitCode: number | undefined;
  readonly envelope: { ok: boolean; data?: Record<string, unknown>; error?: { code: string; message: string } } | undefined;
}

async function cli(args: string[]): Promise<CliRun> {
  const out: string[] = [];
  const err: string[] = [];
  const program = buildProgram({
    profiles: new ProfileManager("/unused"),
    journeysDir,
    dbPath: join(dir, "no-site-policy.sqlite"),
    explore: { browserPortFactory: () => new PlaywrightBrowserPort() },
  });
  program.configureOutput({ writeOut: (s) => out.push(s), writeErr: (s) => err.push(s) });
  const override = (c: Command): void => {
    c.exitOverride();
    c.commands.forEach(override);
  };
  override(program);
  process.exitCode = undefined;
  await program.parseAsync(args, { from: "user" });
  const exitCode = typeof process.exitCode === "number" ? process.exitCode : undefined;
  process.exitCode = undefined;
  const text = out.join("");
  let envelope: CliRun["envelope"];
  try {
    envelope = JSON.parse(text.trim().split("\n").at(-1) ?? "") as CliRun["envelope"];
  } catch {
    envelope = undefined;
  }
  return { out: text, err: err.join(""), exitCode, envelope };
}

describe("journey-anchored exploration (#293, served)", () => {
  it("explore --from-journey --at-step 3 starts the mission on the replayed page, form state included, with no fresh navigation", async () => {
    const out = join(dir, "anchored");
    served.length = 0;
    const r = await cli([
      "explore", "--from-journey", "order", "--at-step", "3", "--param", "name=Alice", "--journeys-dir", journeysDir,
      "--strategy", "adversarial", "--fake-ai", "--max-actions", "2", "--out", out, "--json",
    ]);
    expect(r.envelope?.ok, r.out + r.err).toBe(true);
    const data = r.envelope!.data!;
    // The branch point: step 3 is the "review" anchor; every finding of the run came from there.
    expect(data.branch).toEqual({ journeyId: "order", step: 3, anchor: "review", stepLabel: "Go to review" });
    expect((data.target as { seedUrl: string }).seedUrl).toBe(`${origin}/wizard`);
    // ONE page load: the Journey's own navigate. The mission never reloaded the start URL.
    expect(served.filter((s) => s === "GET /wizard")).toHaveLength(1);
    // The mission's first perception is the review step built from the replayed form value.
    const transcript = JSON.parse(readFileSync(String(data.transcriptPath), "utf8")) as Array<{ controls?: string[]; url: string }>;
    expect(transcript[0]?.controls ?? []).toContain('button "Confirm order for Alice"');
    expect(transcript[0]?.controls ?? []).not.toContain('button "Next"');
    // The persisted result carries the branch point and parses under the unified schema (additive, v1).
    const persisted = PersistedMissionResultSchema.parse(JSON.parse(readFileSync(String(data.resultPath), "utf8")));
    expect(persisted.result.branch).toMatchObject({ journeyId: "order", step: 3, anchor: "review" });
  }, 180_000);

  it("a stale Journey ends the run typed (journey-stale, exit 2) — the mission never runs from a URL", async () => {
    const out = join(dir, "stale");
    served.length = 0;
    const r = await cli([
      "explore", "--from-journey", "order-stale", "--at-step", "review", "--param", "name=Alice", "--journeys-dir", journeysDir,
      "--strategy", "exploratory", "--fake-ai", "--max-actions", "2", "--out", out, "--json",
    ]);
    expect(r.exitCode).toBe(2);
    expect(r.envelope?.ok).toBe(true);
    const data = r.envelope!.data!;
    expect(data).toMatchObject({ missionOutcome: "inconclusive", failure: { kind: "journey-stale" }, branch: { journeyId: "order-stale", step: 3, anchor: "review" }, failedStep: 3 });
    expect(String((data.failure as { message: string }).message)).toMatch(/is stale: it no longer reaches step 3 \(anchor review\)/);
    expect(served.filter((s) => s === "GET /wizard")).toHaveLength(1); // the replay's own load; no restart from the URL
    expect(existsSync(out) ? readdirSync(out).filter((f) => f.endsWith(".result.json")) : []).toEqual([]);
  }, 120_000);

  it("journey anchors lists the named states and their probes; an unknown Journey is refused", async () => {
    const r = await cli(["journey", "anchors", "order", "--json"]);
    expect(r.envelope?.data).toEqual({
      journeyId: "order",
      promoted: true,
      steps: 4,
      anchors: [
        { name: "filled", step: 2, afterStep: 'fill field "Name" with <param name>', description: "the name is typed, nothing submitted", probes: [] },
        { name: "review", step: 3, afterStep: "Go to review", description: "the in-page review step", probes: ["double submit the confirm", "go back and change the name"] },
      ],
    });
    const human = await cli(["journey", "anchors", "order"]);
    expect(human.out).toContain("review\tstep 3\tafter: Go to review");
    const unknown = await cli(["journey", "anchors", "nope", "--json"]);
    expect(unknown.exitCode).toBe(64);
    expect(unknown.envelope?.error?.code).toBe("E_UNKNOWN_JOURNEY");
  });

  it.each([
    [["--from-journey", "order"], /--from-journey and --at-step go together/],
    [["--from-journey", "order", "--at-step", "3", "--url", "http://127.0.0.1:1/"], /--url cannot be combined/],
    [["--from-journey", "order", "--at-step", "3", "--feature", "x"], /supports --strategy/],
    [["--from-journey", "order", "--at-step", "3", "--repeat", "2"], /not supported with it/],
    [["--from-journey", "order", "--at-step", "9"], /not a step of journey 'order' \(steps 1\.\.4 or an anchor: filled, review\)/],
    [["--from-journey", "order", "--at-step", "nope"], /names no anchor/],
    [["--from-journey", "order-draft", "--at-step", "2"], /is not promoted/],
    [["--from-journey", "missing", "--at-step", "2"], /unknown journey 'missing'/],
    [["--from-journey", "order", "--at-step", "2", "--param", "colour=red"], /unknown: \[colour\]/],
    [["--from-journey", "order", "--at-step", "2"], /missing: \[name\]/],
  ])("refuses %j before any browser opens (exit 64)", async (args, message) => {
    served.length = 0;
    const r = await cli(["explore", ...args, "--journeys-dir", journeysDir, "--strategy", "adversarial", "--fake-ai", "--json"]);
    expect(r.exitCode).toBe(64);
    expect(r.envelope?.ok).toBe(false);
    expect(r.envelope?.error?.message).toMatch(message);
    expect(served).toEqual([]);
  });

  it("a prefix that types a secret param refuses coverage/exploratory (they carry no redaction set)", async () => {
    served.length = 0;
    const r = await cli(["explore", "--from-journey", "signin", "--at-step", "2", "--param", "password=hunter2", "--journeys-dir", journeysDir, "--strategy", "exploratory", "--fake-ai", "--json"]);
    expect(r.exitCode).toBe(64);
    expect(r.envelope?.error?.message).toMatch(/types a secret param before step 2: --strategy exploratory cannot redact it/);
    expect(r.out + r.err).not.toContain("hunter2");
    expect(served).toEqual([]);
  });

  it("campaign run: discovery → anchored missions with restore between runs → one deduped report naming both branch points", async () => {
    const fixtures = join(dir, "restore.json");
    await writeFile(fixtures, JSON.stringify({ setup: [{ name: "seed", method: "POST", url: "/api/seed" }], restore: [{ name: "reset", method: "POST", url: "/api/reset" }] }));
    const spec = join(dir, "campaign.json");
    await writeFile(
      spec,
      JSON.stringify({
        version: 1,
        name: "release-candidate",
        fixtures: "restore.json",
        maxActions: 3,
        jobs: [
          { id: "checkout", journey: "order", params: { name: "Mallory" }, anchors: ["review"], strategies: ["adversarial"] },
          { id: "gift-checkout", journey: "order-noted", params: { name: "Mallory" }, strategies: ["adversarial"] },
        ],
      }),
    );
    const out = join(dir, "campaign-out");
    served.length = 0;
    const r = await cli(["campaign", "run", spec, "--journeys-dir", journeysDir, "--out", out, "--fake-ai", "--json"]);
    expect(r.envelope?.ok, r.out + r.err).toBe(true);
    const data = r.envelope!.data! as {
      discovery: Array<{ job: string; outcome: string }>;
      missions: Array<{ job: string; status: string; branch: { journeyId: string; step: number; anchor?: string }; restored?: boolean; resultPath?: string }>;
      report: { defects: Array<{ title: string; runCount: number; branches?: Array<{ journeyId: string; step: number; anchor?: string }> }>; summary: { runs: number } };
      reportPath: string;
      exitCode: number;
    };
    expect(data.discovery.map((d) => [d.job, d.outcome])).toEqual([["checkout", "ok"], ["gift-checkout", "ok"]]);
    expect(data.missions.map((m) => [m.job, m.status, m.branch.journeyId, m.branch.step, m.branch.anchor, m.restored])).toEqual([
      ["checkout", "ran", "order", 3, "review", true],
      ["gift-checkout", "ran", "order-noted", 4, "noted-review", true],
    ]);
    // State restore around EVERY run (discovery included): seed → the run's page load → reset, in order.
    const lifecycle = served.filter((s) => s === "POST /api/seed" || s === "POST /api/reset" || s === "GET /wizard");
    expect(lifecycle).toEqual(Array.from({ length: 4 }, () => ["POST /api/seed", "GET /wizard", "POST /api/reset"]).flat());
    // ONE deduped report: the review-step crash both anchored missions hit is one defect, from both branch points.
    expect(data.report.summary.runs).toBe(2);
    const crash = data.report.defects.filter((d) => /review widget crashed/.test(d.title));
    expect(crash, JSON.stringify(data.report.defects.map((d) => d.title))).toHaveLength(1);
    expect(crash[0]).toMatchObject({ runCount: 2, branches: [{ journeyId: "order", step: 3, anchor: "review" }, { journeyId: "order-noted", step: 4, anchor: "noted-review" }] });
    expect(data.exitCode).toBe(1);
    expect(r.exitCode).toBe(1);
    expect(readFileSync(data.reportPath, "utf8")).toMatch(/branched from: journey `order` step 3 \(anchor `review`\), journey `order-noted` step 4 \(anchor `noted-review`\)/);
  }, 300_000);

  it("campaign run refuses an invalid spec with every problem listed (exit 64), before any browser", async () => {
    const spec = join(dir, "bad-campaign.json");
    await writeFile(
      spec,
      JSON.stringify({
        version: 1,
        jobs: [
          { id: "a", journey: "order", anchors: ["nope", 9], strategies: ["usability"] },
          { id: "a", journey: "order-draft", anchors: [2], strategies: ["adversarial"], params: { name: "x" } },
          { id: "../c", journey: "missing", strategies: ["exploratory"] },
        ],
      }),
    );
    served.length = 0;
    const r = await cli(["campaign", "run", spec, "--journeys-dir", journeysDir, "--fake-ai", "--json"]);
    expect(r.exitCode).toBe(64);
    expect(r.envelope?.error?.code).toBe("E_CAMPAIGN_SPEC");
    const message = r.envelope?.error?.message ?? "";
    for (const problem of [
      /jobs\[0\] \(a\)\.goal: required by strategy usability/,
      /jobs\[0\] \(a\)\.appClass: required by strategy usability/,
      /jobs\[0\] \(a\)\.anchors\[0\]: .*names no anchor/,
      /jobs\[0\] \(a\)\.anchors\[1\]: .*not a step/,
      /jobs\[1\] \(a\)\.id: duplicate job id/,
      /jobs\[1\] \(a\)\.journey: journey 'order-draft' is not promoted/,
      /jobs\[2\] \(\.\.\/c\)\.id: invalid job id/,
      /jobs\[2\] \(\.\.\/c\)\.journey: unknown journey 'missing'/,
    ]) {
      expect(message).toMatch(problem);
    }
    expect(served).toEqual([]);
    const shape = await cli(["campaign", "run", spec, "--journeys-dir", journeysDir, "--json"]);
    expect(shape.envelope?.error?.code).toBe("E_CAMPAIGN_ARGS");
  });
});
