import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Page } from "playwright";
import { FakeGenerationGateway, FakeJudgmentGateway, REDACTION_MASK } from "@jevitate/ai-core";
import { BrowseTheWeb, CastActor } from "@jevitate/screenplay";
import type { BrowserSession } from "@jevitate/playwright";
import { explore, type ExploreRun } from "./explore.js";
import { readPageHeadings, readPageText } from "./conversation.js";
import { snapshot, type Snapshot } from "./snapshot.js";
import { perceive } from "./perceive.js";
import { monitorFor } from "./page-monitor.js";
import { occluderOf } from "./occlusion.js";
import { runInductionMission, type InductionRunResult } from "./missions/induction.js";
import { runAdversarialMission, type AdversarialOutcome } from "./missions/adversarial.js";
import { DEMO_OVERLAY_ATTR, DEMO_OVERLAY_HIDE_STYLE, DemoOverlay, demoOverlayFor } from "./demo-overlay.js";
import { ScriptedJudge, withSession, type ScriptedStep } from "./testkit.js";

/**
 * #245 — the demo overlay is INVISIBLE TO JEVITATE. Served pages, real Chromium, deterministic fakes:
 * the overlay shows the step/intent (redacted), never reaches a snapshot, visible text, the judge,
 * the accessibility tree or a screenshot, is never a hit target, and the same scripted run gives the
 * identical outcome/transcript/state signatures with and without it. Absent/false injects nothing.
 */

const SECRET = "hunter2-S3CRET-9f";

const APP = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Settings</title></head>
<body><h1>Settings</h1>
<label>Display name <input id="name" aria-label="Display name"></label>
<button id="save" type="button">Save</button>
<p role="status" id="status"></p>
<a href="/done">Continue</a>
<script>
window.__clicks = [];
document.addEventListener("click", (e) => {
  const t = e.target;
  window.__clicks.push((t.tagName || "?") + (t.closest && t.closest("[${DEMO_OVERLAY_ATTR}]") ? "!overlay" : ""));
}, true);
document.getElementById("save").addEventListener("click", () => {
  document.getElementById("status").textContent = "Saved " + document.getElementById("name").value;
});
</script></body></html>`;

const DONE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Done</title></head>
<body><h1>All set</h1><p>Your settings were saved.</p><button type="button" onclick="this.textContent='Finished'">Finish</button></body></html>`;

let server: Server;
let base: string;
beforeAll(async () => {
  server = createServer((req, res) => {
    const path = (req.url ?? "").split("?")[0] ?? "";
    if (path === "/app") return void res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(APP);
    if (path === "/done") return void res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(DONE);
    res.writeHead(404).end();
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((r) => server.close(() => r()));
});

/**
 * Test-only spy (installed for BOTH runs, for parity): keeps a reference to the overlay's CLOSED
 * shadow root, so the test — and only the test — can read what the audience sees.
 */
const SHADOW_SPY = `(() => {
  const orig = Element.prototype.attachShadow;
  Object.defineProperty(window, "__testOverlayRoots", { value: [], enumerable: false });
  Element.prototype.attachShadow = function (init) {
    const root = orig.call(this, init);
    if (this.hasAttribute("${DEMO_OVERLAY_ATTR}")) window.__testOverlayRoots.push({ root, mode: init.mode });
    return root;
  };
})()`;

interface OverlayView {
  readonly hosts: number;
  readonly roots: number;
  readonly mode: string | null;
  readonly api: boolean;
  readonly panel: string;
  readonly panelShown: boolean;
  readonly banner: string;
  readonly bannerShown: boolean;
}

async function overlayView(page: Page): Promise<OverlayView> {
  return page.evaluate((attr) => {
    const w = window as unknown as { __testOverlayRoots?: Array<{ root: ShadowRoot; mode: string }>; __jevitateOverlay?: unknown };
    const last = w.__testOverlayRoots?.at(-1);
    const panel = last?.root.querySelector(".panel") as HTMLElement | null | undefined;
    const banner = last?.root.querySelector(".banner") as HTMLElement | null | undefined;
    return {
      hosts: document.querySelectorAll(`[${attr}]`).length,
      roots: w.__testOverlayRoots?.length ?? 0,
      mode: last?.mode ?? null,
      api: w.__jevitateOverlay !== undefined,
      panel: panel?.textContent ?? "",
      panelShown: panel !== null && panel !== undefined && !panel.hidden,
      banner: banner?.textContent ?? "",
      bannerShown: banner !== null && banner !== undefined && !banner.hidden,
    };
  }, DEMO_OVERLAY_ATTR);
}

/** Every string jevitate itself could read off the page, the ways it reads it. */
async function perceived(page: Page, snap: Snapshot): Promise<string> {
  const headings = await readPageHeadings(page);
  const aria = await page.locator("html").ariaSnapshot();
  const cdp = await page.context().newCDPSession(page);
  const ax = (await cdp.send("Accessibility.getFullAXTree")) as { nodes: Array<{ ignored?: boolean; name?: { value?: unknown } }> };
  await cdp.detach();
  return JSON.stringify({
    controls: snap.controls.map((c) => [c.name, c.summary, c.role, c.tag]),
    text: await readPageText(page),
    headings,
    aria,
    // The exposed accessibility tree (the aria-hidden host is an `ignored` node with no name).
    ax: ax.nodes.filter((n) => n.ignored !== true).map((n) => n.name?.value ?? ""),
    axAll: ax.nodes.map((n) => n.name?.value ?? "").join("|"),
    byText: await page.getByText(/jevitate/i).count(),
    byCss: await page.locator("text=/step \\d/").count(),
  });
}

// Settings: [0] Display name, [1] Save, [2] Continue; then (on /done) done.
const SCRIPT: ScriptedStep[] = [{ op: "type", target: "0" }, { op: "click", target: "1" }, { op: "click", target: "2" }, { op: "done" }];
const GOAL = `Save a display name for account ${SECRET}, then continue.`;

interface Observed {
  readonly run: ExploreRun;
  readonly judge: ScriptedJudge;
  readonly perceivedAtSnapshots: string[];
  readonly panels: string[];
  readonly final: OverlayView;
  readonly clicks: string[];
}

async function scriptedRun(demoOverlay: boolean | undefined): Promise<Observed> {
  return withSession(
    "demo-overlay-",
    async (session: BrowserSession) => {
      const page = session.page;
      await page.addInitScript(SHADOW_SPY);
      const judge = new ScriptedJudge(SCRIPT);
      const perceivedAtSnapshots: string[] = [];
      const panelReads: Array<Promise<string>> = [];
      const actor = CastActor.named("demo-overlay").whoCan(new BrowseTheWeb(session, [base]));
      const run = await explore({
        actor,
        judge,
        gen: new FakeGenerationGateway(),
        goal: GOAL,
        secrets: [SECRET],
        allowlist: [base],
        startUrl: `${base}/app`,
        bounds: { maxDecisions: 8 },
        ...(demoOverlay === undefined ? {} : { demoOverlay }),
        onSnapshot: async (snap) => {
          perceivedAtSnapshots.push(await perceived(page, snap));
        },
        // Read right after each step is recorded: what the panel showed for that step.
        onTranscriptEntry: () => {
          panelReads.push(overlayView(page).then((v) => v.panel, () => ""));
        },
      });
      const panels = await Promise.all(panelReads);
      const final = await overlayView(page);
      const clicks = await page.evaluate(() => (window as unknown as { __clicks?: string[] }).__clicks ?? []).catch(() => []);
      return { run, judge, perceivedAtSnapshots, panels, final, clicks };
    },
    base,
  );
}

/** What must be identical with and without the overlay. */
function shape(r: ExploreRun): unknown {
  return {
    stop: r.stop,
    outcome: r.outcome,
    decisions: r.decisions,
    actions: r.actions,
    finalUrl: r.finalUrl,
    steps: r.transcript.map((e) => [e.step, e.op, e.target, e.actOk, e.url, e.signature, e.controlCount, e.controls]),
    recording: r.recording.pages.map((p) => p.steps.map((s) => JSON.stringify(s.target ?? null))),
    sideEffects: r.sideEffects.map((s) => `${s.step} ${s.request.method} ${s.request.endpoint}`),
  };
}

describe("#245 demo overlay — invisible to jevitate (served, real Chromium)", () => {
  let withOverlay: Observed;
  let without: Observed;
  beforeAll(async () => {
    withOverlay = await scriptedRun(true);
    without = await scriptedRun(undefined);
  }, 180_000);

  it("(a) the overlay host exists (closed shadow root) and shows the step and intent", () => {
    expect(withOverlay.final.hosts).toBe(1);
    expect(withOverlay.final.mode).toBe("closed");
    // Step 1 typed, step 2 clicked Save, step 3 clicked Continue (a navigation — re-applied after it).
    expect(withOverlay.panels[0]).toMatch(/step 1 · goal/);
    expect(withOverlay.panels[0]).toMatch(/type into\s*“Display name”/);
    expect(withOverlay.panels[1]).toMatch(/step 2 · goal/);
    expect(withOverlay.panels[1]).toMatch(/click\s*“Save”/);
    expect(withOverlay.panels[1]).toContain("— goal: Save a display name");
    // After the navigation the new document got the latest panel back (re-applied on load).
    expect(withOverlay.final.panel).toMatch(/step 3 · goal.*click\s*“Continue”/);
    // The final banner carries the outcome.
    expect(withOverlay.final.bannerShown).toBe(true);
    expect(withOverlay.final.banner).toMatch(/^jevitate · done — done$/);
  });

  it("(b) it never appears in any snapshot's controls, visible text, headings, the a11y tree or the judge's state", () => {
    expect(withOverlay.perceivedAtSnapshots.length).toBeGreaterThanOrEqual(3);
    for (const p of withOverlay.perceivedAtSnapshots) {
      expect(p).not.toMatch(/jevitate|step \d · goal|redacted/i);
      expect(JSON.parse(p)).toMatchObject({ byText: 0, byCss: 0 });
    }
    // Identical to what the run without the overlay perceived at the same points (the raw AX dump may
    // list the ignored, nameless host nodes — never any text; checked by the regex above).
    const exposed = (all: string[]): unknown[] => all.map((p) => ({ ...(JSON.parse(p) as object), axAll: undefined }));
    expect(exposed(withOverlay.perceivedAtSnapshots)).toEqual(exposed(without.perceivedAtSnapshots));
    const shown = JSON.stringify(withOverlay.judge.calls.map((c) => c.state)) + JSON.stringify(withOverlay.judge.goalCalls.map((c) => c.state));
    expect(shown).not.toMatch(/jevitate ·|step \d · goal/);
    expect(withOverlay.judge.states).toEqual(without.judge.states);
    expect(withOverlay.judge.goalCalls.map((c) => c.state)).toEqual(without.judge.goalCalls.map((c) => c.state));
  });

  it("(c) it is never clicked: every click the page saw landed on the app's own targets", () => {
    expect(withOverlay.clicks.some((c) => c.includes("!overlay"))).toBe(false);
    expect(withOverlay.run.transcript.every((e) => !/jevitate/i.test(e.target ?? ""))).toBe(true);
  });

  it("(d) the same scripted run gives the identical outcome, transcript ops/targets and state signatures", () => {
    expect(withOverlay.run.outcome.status).toBe("completed");
    expect(shape(withOverlay.run)).toEqual(shape(without.run));
  });

  it("(f) secrets in the reason are redacted in the overlay text", () => {
    const all = [...withOverlay.panels, withOverlay.final.panel, withOverlay.final.banner].join("\n");
    expect(all).not.toContain(SECRET);
    expect(withOverlay.panels[0]).toContain(`account ${REDACTION_MASK}`);
  });

  it("golden: demoOverlay absent/false injects nothing at all", async () => {
    expect(demoOverlayFor(undefined, [])).toBeNull();
    expect(demoOverlayFor(false, [])).toBeNull();
    expect(without.final).toEqual({ hosts: 0, roots: 0, mode: null, api: false, panel: "", panelShown: false, banner: "", bannerShown: false });
    const explicitOff = await scriptedRun(false);
    expect(explicitOff.final).toEqual(without.final);
    expect(shape(explicitOff.run)).toEqual(shape(without.run));
  }, 60_000);
});

describe("#245 demo overlay — hit-testing, screenshots, settle and redaction (direct)", () => {
  async function onPage<T>(body: (page: Page, overlay: DemoOverlay) => Promise<T>): Promise<T> {
    return withSession(
      "demo-overlay-direct-",
      async (session) => {
        await session.page.addInitScript(SHADOW_SPY);
        await session.page.goto(`${base}/app`);
        return body(session.page, new DemoOverlay([SECRET]));
      },
      base,
    );
  }

  it("(c) the host is never a hit target: elementFromPoint finds the target under the highlight; the panel area hits the page", async () => {
    await onPage(async (page, overlay) => {
      await monitorFor(page).instrument();
      const snap = await snapshot(page);
      const save = snap.controls.find((c) => c.name === "Save");
      expect(save).toBeDefined();
      // Announce + highlight WITHOUT awaiting: check hit-testing while the box is drawn.
      const announcing = overlay.announce(page, { step: 2, strategy: "goal", op: "click", target: "Save", why: "persist it" }, save!);
      await page.waitForTimeout(150);
      const hits = await page.evaluate((attr) => {
        const save = document.getElementById("save")!;
        const r = save.getBoundingClientRect();
        const inOverlay = (el: Element | null): boolean => el !== null && el.closest(`[${attr}]`) !== null;
        const center = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
        const edge = document.elementFromPoint(r.left + 1, r.top + 1);
        // The panel lives bottom-right.
        const px = window.innerWidth - 40;
        const py = window.innerHeight - 30;
        const underPanel = document.elementFromPoint(px, py);
        const stack = document.elementsFromPoint(px, py);
        return {
          centerIsSave: center === save,
          edgeIsSave: edge === save,
          underPanelInOverlay: inOverlay(underPanel),
          stackHasOverlay: stack.some((e) => inOverlay(e)),
        };
      }, DEMO_OVERLAY_ATTR);
      expect(hits).toEqual({ centerIsSave: true, edgeIsSave: true, underPanelInOverlay: false, stackHasOverlay: false });
      // Jevitate's own occlusion check (elementFromPoint at each control) finds nothing covering any control.
      for (const sel of ["#name", "#save", "a[href='/done']"]) expect(await page.locator(sel).evaluate(occluderOf), sel).toBeNull();
      // Playwright's actionability hit-test passes, and a real click lands on the button.
      await page.locator("#save").click({ trial: true, timeout: 2_000 });
      await announcing;
      await page.locator("#save").click({ timeout: 2_000 });
      expect(await page.evaluate(() => (window as unknown as { __clicks: string[] }).__clicks)).toEqual(["BUTTON"]);
      const view = await overlayView(page);
      expect(view.panel).toMatch(/click\s*“Save”\s*— persist it/);
      // The snapshot (controls + state signature) is unchanged by the overlay.
      const after = await snapshot(page);
      expect(after.controls.map((c) => c.summary)).toEqual(snap.controls.map((c) => c.summary));
    });
  }, 60_000);

  it("panel/highlight updates never reset the page monitor's quiet window (shadow mutations are unseen)", async () => {
    await onPage(async (page, overlay) => {
      await monitorFor(page).instrument();
      await overlay.announce(page, { step: 1, strategy: "goal", op: "wait" });
      const before = await page.evaluate(() => (window as unknown as { __jevitateMonitor: { lastMutation: number } }).__jevitateMonitor.lastMutation);
      await page.waitForTimeout(60);
      const snap = await snapshot(page);
      await overlay.announce(page, { step: 2, strategy: "goal", op: "click", target: "Save" }, snap.controls.find((c) => c.name === "Save")!);
      await overlay.finish("jevitate · done", true);
      const after = await page.evaluate(() => (window as unknown as { __jevitateMonitor: { lastMutation: number } }).__jevitateMonitor.lastMutation);
      expect(after).toBe(before);
      // Perception still settles and sees exactly the app's controls.
      const p = await perceive(page);
      expect(p.snapshot.controls.map((c) => c.name)).toEqual(["Display name", "Save", "Continue"]);
    });
  }, 60_000);

  it("(e) screenshots hide it: a capture with DEMO_OVERLAY_HIDE_STYLE equals one with no overlay at all", async () => {
    await onPage(async (page, overlay) => {
      const clean = await page.screenshot({ animations: "disabled" });
      await overlay.announce(page, { step: 3, strategy: "goal", op: "click", target: "Continue", why: "move on" });
      await overlay.finish("jevitate · done — done", true);
      const raw = await page.screenshot({ animations: "disabled" });
      const hidden = await page.screenshot({ animations: "disabled", style: DEMO_OVERLAY_HIDE_STYLE });
      expect(raw.equals(clean)).toBe(false); // the overlay IS on screen for the audience
      expect(hidden.equals(clean)).toBe(true); // …and never in a capture
      // The style is scoped to the capture: the overlay is back on screen afterwards.
      expect((await page.screenshot({ animations: "disabled" })).equals(raw)).toBe(true);
    });
  }, 60_000);

  it("(f) the panel and banner are redacted, and page-controlled text is set as text, never markup", async () => {
    await onPage(async (page, overlay) => {
      await overlay.announce(page, {
        step: 1,
        strategy: "goal",
        op: "type",
        target: `<img src=x onerror=alert(1)> ${SECRET}`,
        why: `sign in with ${SECRET}`,
      });
      await overlay.finish(`failed: token ${SECRET} rejected`, false);
      const view = await overlayView(page);
      expect(`${view.panel}${view.banner}`).not.toContain(SECRET);
      expect(view.panel).toContain(`sign in with ${REDACTION_MASK}`);
      expect(view.banner).toBe(`failed: token ${REDACTION_MASK} rejected`);
      expect(view.panel).toContain("<img src=x onerror=alert(1)>");
      expect(await page.evaluate(() => document.querySelectorAll("img").length)).toBe(0);
    });
  }, 60_000);

  it("re-applied across navigations: a new document gets the latest panel back", async () => {
    await onPage(async (page, overlay) => {
      await overlay.announce(page, { step: 3, strategy: "goal", op: "click", target: "Continue", why: "move on" });
      await page.goto(`${base}/done`);
      await expect.poll(async () => (await overlayView(page)).panel, { timeout: 5_000 }).toMatch(/step 3 · goal/);
      expect((await overlayView(page)).hosts).toBe(1);
    });
  }, 60_000);
});

describe("#245 demo overlay — coverage and adversarial missions are unchanged by it", () => {
  async function coverage(demoOverlay: boolean): Promise<{ r: InductionRunResult; view: OverlayView }> {
    return withSession(
      "demo-overlay-cov-",
      async (session) => {
        await session.page.addInitScript(SHADOW_SPY);
        const actor = CastActor.named("cov").whoCan(new BrowseTheWeb(session, [base]));
        const r = await runInductionMission({
          page: session.page,
          actor,
          judgment: new FakeJudgmentGateway({ isDefect: { kind: "noul", value: false, probability: 0 } }),
          generation: new FakeGenerationGateway(),
          seedUrl: `${base}/app`,
          allowlist: [base],
          routeGlobs: ["/**"],
          bounds: { maxActions: 6, maxDecisions: 12 },
          demoOverlay,
        });
        return { r, view: await overlayView(session.page) };
      },
      base,
    );
  }

  it(
    "coverage: identical outcome, states, transitions, defects and state fingerprints; the overlay showed coverage steps",
    async () => {
      const on = await coverage(true);
      const off = await coverage(false);
      const cov = (r: InductionRunResult): unknown => ({
        outcome: r.outcome,
        states: r.coverage.statesVisited,
        transitions: r.coverage.transitionsExercised,
        defects: r.coverage.defects,
        steps: r.transcript.map((e) => [e.op, e.target, e.actOk, e.url, e.signature]),
      });
      expect(cov(on.r)).toEqual(cov(off.r));
      expect(on.view.panel).toMatch(/· coverage/);
      expect(on.view.bannerShown).toBe(true);
      expect(off.view.roots).toBe(0);
    },
    120_000,
  );

  async function adversarial(demoOverlay: boolean): Promise<{ r: AdversarialOutcome; view: OverlayView }> {
    return withSession(
      "demo-overlay-adv-",
      async (session) => {
        await session.page.addInitScript(SHADOW_SPY);
        const actor = CastActor.named("adv").whoCan(new BrowseTheWeb(session, [base]));
        const r = await runAdversarialMission({
          page: session.page,
          actor,
          judgment: new FakeJudgmentGateway({ looksBroken: { kind: "noul", value: false, probability: 0.1 } }),
          generation: new FakeGenerationGateway(),
          seedUrl: `${base}/app`,
          allowlist: [base],
          // Non-racing strategies: an equality check on a timing race (double submit) would be flaky under load.
          strategies: ["boundary-submit", "edit-cancel-save"],
          bounds: { maxDecisions: 3 },
          demoOverlay,
        });
        return { r, view: await overlayView(session.page) };
      },
      base,
    );
  }

  it(
    "adversarial: identical stop, defects and transcript; the overlay showed the strategy",
    async () => {
      const on = await adversarial(true);
      const off = await adversarial(false);
      const adv = (r: AdversarialOutcome): unknown => ({
        outcome: r.outcome,
        stop: r.stop,
        defects: r.defects.map((d) => [d.fingerprint, d.kind]),
        steps: r.transcript.map((e) => [e.op, e.target, e.strategy, e.actOk, e.signature]),
      });
      expect(adv(on.r)).toEqual(adv(off.r));
      expect(on.view.banner).toMatch(/^jevitate · adversarial — /);
      expect(off.view.roots).toBe(0);
    },
    120_000,
  );
});
