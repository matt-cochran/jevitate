import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FakeGenerationGateway } from "@jevitate/ai-core";
import { RecordingInterpreter } from "@jevitate/interpreter";
import { BrowseTheWeb, CastActor, type Actor } from "@jevitate/screenplay";
import { validateInvariantSpec, type Recording } from "@jevitate/recording";
import { EDITOR_BLOCKS, startServer } from "@jevitate/example-site";
import type { Page } from "playwright";
import { runGoalBasedMission } from "./missions/goal-based.js";
import { InvariantMonitor } from "./declared-invariants.js";
import { validateTextEdit } from "./rich-text.js";
import { ScriptedJudge, withSession } from "./testkit.js";

/**
 * #148 — rich-text editing inside `contenteditable` and visual-state checks, against the served
 * `/editor-fixture` (three contenteditable blocks, `[data-heat]` spans, an SVG minimap whose cells
 * scroll their block into view and flash it).
 *
 * Controls on the fixture, in DOM order: [0..2] the minimap cells, [3..5] the prose blocks b1..b3.
 */

const ORIGINAL = new Map(EDITOR_BLOCKS);
const B2_EDITED = "Paragraph two says the slow brown fox jumps over the lazy dog.";

let site: { url: string; close(): Promise<void> };
beforeEach(async () => {
  // A fresh server per test: the fixture persists edits per server instance.
  site = await startServer();
});
afterEach(async () => {
  await site.close();
});

const editGen = (proposal: { action: string | null; quote: string | null; text: string | null; format?: string | null }) =>
  new FakeGenerationGateway({ "text.edit": { format: null, ...proposal } });

async function blockHtml(page: Page, id: string): Promise<string> {
  return page.locator(`#${id}`).evaluate((el) => el.innerHTML);
}

async function runEdit(
  proposal: Parameters<typeof editGen>[0],
): Promise<{ result: Awaited<ReturnType<typeof runGoalBasedMission>>; html: Record<string, string> }> {
  const origin = site.url;
  return withSession(
    "rich-text-",
    async (session) => {
      const actor = CastActor.named("editor").whoCan(new BrowseTheWeb(session, [origin]));
      const result = await runGoalBasedMission({
        actor,
        judge: new ScriptedJudge([{ op: "edit_text", target: "4" }, { op: "done" }]),
        gen: editGen(proposal),
        goal: "In paragraph 2, change 'quick' to 'slow'.",
        allowlist: [origin],
        startUrl: `${origin}/editor-fixture`,
        successChecks: [{ kind: "reloadThen", assertion: { kind: "textIncludes", target: { css: "#b2" }, text: "slow brown fox" } }],
        oracleTimeoutMs: 1_000,
      });
      const html: Record<string, string> = {};
      for (const id of ["b1", "b2", "b3"]) html[id] = await blockHtml(session.page, id);
      return { result, html };
    },
    origin,
  );
}

async function replay(recording: Recording): Promise<{ outcome: string; html: Record<string, string> }> {
  const server = await startServer();
  try {
    return await withSession(
      "rich-text-replay-",
      async (session) => {
        const actor = CastActor.named("replay").whoCan(new BrowseTheWeb(session, [server.url]));
        const r = await new RecordingInterpreter().run(actor, recording);
        const html: Record<string, string> = {};
        for (const id of ["b1", "b2", "b3"]) html[id] = await blockHtml(session.page, id);
        return { outcome: r.outcome, html };
      },
      server.url,
    );
  } finally {
    await server.close();
  }
}

describe("rich-text edit inside a contenteditable (#148)", () => {
  it(
    "changes one word mid-paragraph, persists it (reloadThen), leaves the rest intact, and replays deterministically",
    async () => {
      const { result, html } = await runEdit({ action: "replace", quote: "quick", text: "slow" });
      expect(result.assertionPassed, JSON.stringify(result.checks)).toBe(true);
      expect(html.b2).toBe(B2_EDITED);
      expect(html.b1).toBe(ORIGINAL.get("b1"));
      expect(html.b3).toBe(ORIGINAL.get("b3"));

      // The Recording holds the anchor, not a whole-element fill.
      const steps = result.recording.pages.flatMap((p) => p.steps.map((s) => s.step));
      const edit = steps.find((s) => s.kind === "editText");
      expect(edit).toMatchObject({ kind: "editText", anchor: { quote: "quick" }, action: "replace", value: { redacted: false, value: "slow" } });
      expect(steps.some((s) => s.kind === "fill")).toBe(false);

      // Deterministic replay: two fresh servers, the identical outcome.
      const first = await replay(result.recording);
      const second = await replay(result.recording);
      expect(first.outcome).toBe("completed");
      expect(first.html).toEqual({ b1: ORIGINAL.get("b1"), b2: B2_EDITED, b3: ORIGINAL.get("b3") });
      expect(second).toEqual(first);
    },
    180_000,
  );

  it(
    "a quote that is not in the paragraph is refused (fail-closed): nothing is typed, the check fails",
    async () => {
      const { result, html } = await runEdit({ action: "replace", quote: "purple", text: "slow" });
      expect(result.assertionPassed).toBe(false);
      expect(html).toEqual({ b1: ORIGINAL.get("b1"), b2: ORIGINAL.get("b2"), b3: ORIGINAL.get("b3") });
      const refusals = result.transcript.filter((e) => e.op === "edit_text" && !e.actOk).map((e) => e.reason ?? "");
      expect(refusals.some((r) => r.includes("is not in the element's text (fail-closed)"))).toBe(true);
      expect(result.recording.pages.flatMap((p) => p.steps).some((s) => s.step.kind === "editText")).toBe(false);
    },
    120_000,
  );

  it("code validates a proposed edit: ambiguous and secret-bearing quotes are refused", () => {
    const text = "the quick fox and the quick dog";
    expect(validateTextEdit({ action: "replace", quote: "quick", text: "slow", format: null }, text, [])).toEqual({
      refused: 'quote "quick" occurs 2 times in the element\'s text (ambiguous)',
    });
    expect(validateTextEdit({ action: "replace", quote: "quick dog", text: "slow dog", format: null }, text, [])).toEqual({
      edit: { anchor: { quote: "quick dog" }, action: "replace", value: "slow dog" },
    });
    expect("refused" in validateTextEdit({ action: "insertAfter", quote: "quick dog", text: "hunter2", format: null }, text, ["hunter2"])).toBe(true);
    expect(validateTextEdit({ action: "format", quote: "quick fox", text: null, format: "bold" }, text, [])).toEqual({
      edit: { anchor: { quote: "quick fox" }, action: "format", format: "bold" },
    });
    expect("refused" in validateTextEdit({ action: "format", quote: "quick fox", text: null, format: null }, text, [])).toBe(true);
  });
});

async function clickCell(broken: string): Promise<Awaited<ReturnType<typeof runGoalBasedMission>>> {
  const origin = site.url;
  return withSession(
    "minimap-",
    async (session) =>
      runGoalBasedMission({
        actor: CastActor.named("minimap").whoCan(new BrowseTheWeb(session, [origin])),
        // Cell 3 → block b3 (far below the fold).
        judge: new ScriptedJudge([{ op: "click", target: "2" }, { op: "done" }]),
        gen: new FakeGenerationGateway(),
        goal: "Jump to the closing paragraph with the minimap.",
        allowlist: [origin],
        startUrl: `${origin}/editor-fixture${broken === "" ? "" : `?broken=${broken}`}`,
        successChecks: [
          { kind: "page", assertion: { kind: "inViewport", target: { css: "#b3" }, min: 0.9 } },
          { kind: "page", assertion: { kind: "flashed", target: { css: "#b3" }, className: "flash", withinMs: 2_000 } },
        ],
        oracleTimeoutMs: 500,
      }),
    origin,
  );
}

describe("visual-state success checks bound to a click (#148)", () => {
  it(
    "inViewport and flashed hold on the default page, with the observed ratio and flash timing",
    async () => {
      const r = await clickCell("");
      expect(r.assertionPassed, JSON.stringify(r.checks)).toBe(true);
      const [view, flash] = r.checks;
      expect(view?.detail).toMatch(/in viewport: ratio 1 >= 0\.9/);
      expect(flash?.detail).toMatch(/gained class \.flash \d+ms after the last input/);
    },
    120_000,
  );

  it(
    "both fail on ?broken=minimap (wrong block, no flash), with the evidence",
    async () => {
      const r = await clickCell("minimap");
      expect(r.assertionPassed).toBe(false);
      const [view, flash] = r.checks;
      expect(view?.passed).toBe(false);
      expect(view?.detail).toMatch(/not in viewport: ratio 0 < 0\.9/);
      expect(flash?.passed).toBe(false);
      expect(flash?.detail).toMatch(/never gained class \.flash after the last input on 1 element\(s\)/);
    },
    120_000,
  );
});

const HEAT_SPEC = () =>
  validateInvariantSpec(
    {
      observe: {
        heatSpans: { dom: { selector: "[data-heat]", read: "count" } },
        heatAlpha: { dom: { selector: "[data-heat]", read: { style: "background-color", channel: "alpha", reduce: "min" } } },
        cellCount: { dom: { selector: "svg [data-cell]", read: "count" } },
      },
      invariants: [
        { id: "heatmap-visible", require: "heatSpans >= 1 -> heatAlpha > 0" },
        { id: "minimap-cells", require: "cellCount == 3" },
      ],
    },
    {},
  );

async function heatInvariants(broken: string) {
  const origin = site.url;
  return withSession(
    "heat-",
    async (session) => {
      const actor: Actor = CastActor.named("heat").whoCan(new BrowseTheWeb(session, [origin]));
      const monitor = new InvariantMonitor(HEAT_SPEC(), { allowlist: [origin], baseUrl: origin });
      await session.page.goto(`${origin}/editor-fixture${broken === "" ? "" : `?broken=${broken}`}`);
      await monitor.before(actor);
      await session.page.click("#b1");
      return monitor.after(actor, { op: "click", control: "b1", url: session.page.url() });
    },
    origin,
  );
}

describe("visual-state invariant observables (#148)", () => {
  it(
    "heatmap-visible holds on the default page and is violated on ?broken=heat; count on svg cells reads",
    async () => {
      const ok = await heatInvariants("");
      expect(ok.violations).toEqual([]);
      expect(ok.held.sort()).toEqual(["heatmap-visible", "minimap-cells"]);
      const broken = await heatInvariants("heat");
      expect(broken.violations.map((v) => v.id)).toEqual(["heatmap-visible"]);
      expect(broken.violations[0]?.reason).toContain("heatAlpha");
      expect(broken.held).toEqual(["minimap-cells"]);
    },
    120_000,
  );
});
