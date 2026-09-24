import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { FakeGenerationGateway, type Answer, type JudgmentPort } from "@jevitate/ai-core";
import { UnauthorizedExploreTargetError } from "@jevitate/explore";
import type { Recording } from "@jevitate/recording";
import {
  recordingToEvidence,
  snapshotToEvidence,
  runUsabilityMission,
  runUxReview,
  UxAnalysisFailedError,
  extractTypedValues,
  type MissionTranscriptEntryLike,
} from "./ux-api.js";

const APP = { appClass: "consumer", job: "buy a widget" } as const;

/** A benign judge: answers every question so nothing throws (some may or may not flag). */
const benignJudge: JudgmentPort = {
  async systemOne({ questions }) {
    const out: Record<string, Answer> = {};
    for (const [key, q] of Object.entries(questions)) {
      if (q.kind === "noul") out[key] = { kind: "noul", value: false, probability: 0.2 };
      else if (q.kind === "score") out[key] = { kind: "score", value: 0.9 };
      else out[key] = { kind: "choice", value: q.options[0] ?? "", confidence: 0.5 };
    }
    return out;
  },
};

function recording(): Recording {
  return {
    version: "1.0",
    site: "https://shop.test",
    pages: [
      {
        url: "https://shop.test/catalog",
        steps: [
          { step: { kind: "click", target: { role: "link", name: "Widgets" }, expect: { kind: "visible", target: { testId: "list" } } } },
          { step: { kind: "click", target: { role: "button", name: "Add to cart" }, expect: { kind: "visible", target: { testId: "cart" } } } },
        ],
      },
      {
        url: "https://shop.test/cart",
        steps: [
          { step: { kind: "click", target: { role: "button", name: "Checkout" }, expect: { kind: "visible", target: { testId: "pay" } } } },
        ],
      },
    ],
  };
}

describe("recordingToEvidence", () => {
  it("maps each page to one screen; controls come from step targets; history accumulates; visibleText is empty (offline)", () => {
    const screens = recordingToEvidence(recording(), APP, APP.job);
    expect(screens).toHaveLength(2);
    expect(screens[0].url).toBe("https://shop.test/catalog");
    expect(screens[0].controls.map((c) => c.name)).toEqual(["Widgets", "Add to cart"]);
    expect(screens[0].visibleText).toBe(""); // a Recording carries no full page text — items needing it will Skip
    expect(screens[0].history).toHaveLength(0);
    expect(screens[1].history).toHaveLength(1); // second screen sees the first
    expect(screens[0].job).toBe("buy a widget");
  });
});

describe("extractTypedValues (#85 item 1)", () => {
  it("collects unredacted fill/select values, skipping redacted and var-bound ones", () => {
    const rec: Recording = {
      version: "1.0",
      site: "https://app.test",
      pages: [
        {
          url: "https://app.test/new",
          steps: [
            { step: { kind: "fill", target: { testId: "title" }, value: { redacted: false, value: "Jevitate CLI: npm run a first goal mission" }, expect: { kind: "visible", target: { testId: "title" } } } },
            { step: { kind: "fill", target: { testId: "password" }, value: { redacted: true, length: 8 }, expect: { kind: "visible", target: { testId: "password" } } } },
            { step: { kind: "select", target: { testId: "plan" }, value: { var: "chosenPlan" }, expect: { kind: "visible", target: { testId: "plan" } } } },
            { step: { kind: "click", target: { role: "button", name: "Save" }, expect: { kind: "visible", target: { testId: "saved" } } } },
          ],
        },
      ],
    };
    expect(extractTypedValues(rec)).toEqual(["Jevitate CLI: npm run a first goal mission"]);
  });
});

describe("recordingToEvidence — blocked-target evidence from a mission transcript (#85 item 2)", () => {
  it("adds a disabled control on the screen matching the blocked action's url", () => {
    const transcript: MissionTranscriptEntryLike[] = [
      { op: "click", actOk: true, url: "https://shop.test/cart", descriptor: { role: "button", name: "Checkout" } },
      { op: "click", actOk: false, reason: "target not enabled", url: "https://shop.test/cart", descriptor: { role: "button", name: "Pay" } },
    ];
    const screens = recordingToEvidence(recording(), APP, APP.job, transcript);
    const cartScreen = screens.find((s) => s.url === "https://shop.test/cart")!;
    const blocked = cartScreen.controls.find((c) => c.name === "Pay");
    expect(blocked).toBeDefined();
    expect(blocked?.enabled).toBe(false);
    expect(blocked?.summary).toContain("target not enabled");
    // The successfully-recorded "Checkout" control is unaffected.
    expect(cartScreen.controls.find((c) => c.name === "Checkout")?.enabled).toBe(true);
  });

  it("without a transcript, no blocked control is added (baseline unchanged)", () => {
    const screens = recordingToEvidence(recording(), APP, APP.job);
    const cartScreen = screens.find((s) => s.url === "https://shop.test/cart")!;
    expect(cartScreen.controls.find((c) => c.name === "Pay")).toBeUndefined();
  });
});

describe("snapshotToEvidence", () => {
  it("maps a live snapshot's controls + extracted text + honest a11y facts", () => {
    const snap = {
      url: "https://shop.test/cart",
      truncated: false,
      signature: "sig-cart",
      controls: [
        { index: 0, descriptor: { role: "button", name: "Checkout" }, stability: "high", role: "button", name: "Checkout", tag: "button", inputType: null, enabled: true, summary: "button Checkout" },
      ],
    } as never;
    const ev = snapshotToEvidence(snap, "Your cart total is $9", APP, "buy a widget", []);
    expect(ev.screenId).toBe("sig-cart");
    expect(ev.controls[0].name).toBe("Checkout");
    expect(ev.visibleText).toBe("Your cart total is $9");
    expect(ev.a11yFacts.controls[0]).toMatchObject({ controlRef: "control:0", accessibleName: "Checkout", focusOrder: 0, targetSize: null, contrastRatio: null });
  });
});

describe("runUxReview (offline)", () => {
  it("writes a report with first-class coverage", async () => {
    const outDir = await mkdtemp(join(tmpdir(), "ux-report-"));
    const { report, reportPath } = await runUxReview({ recording: recording(), appContext: APP, judge: benignJudge, gen: new FakeGenerationGateway(), outDir, env: {}, configPath: join(outDir, "no-config.json"), nowIso: () => "2026-09-21T00:00:00Z" });
    expect(report.coverage).toBeDefined();
    expect(report.coverage.totalItems).toBeGreaterThan(0);
    const written = JSON.parse(await readFile(reportPath, "utf8"));
    expect(written.coverage.totalItems).toBe(report.coverage.totalItems);
  });

  it("(#85) with no mission transcript, the report states what it cannot see", async () => {
    const outDir = await mkdtemp(join(tmpdir(), "ux-report-"));
    const { report } = await runUxReview({ recording: recording(), appContext: APP, judge: benignJudge, gen: new FakeGenerationGateway(), outDir, env: {}, configPath: join(outDir, "no-config.json"), nowIso: () => "2026-09-21T00:00:00Z" });
    expect(report.evidenceCaveats?.[0]).toMatch(/blocked|disabled/i);
  });

  it("(#85) a mission transcript suppresses the evidence caveat", async () => {
    const outDir = await mkdtemp(join(tmpdir(), "ux-report-"));
    const { report } = await runUxReview({
      recording: recording(),
      appContext: APP,
      judge: benignJudge,
      gen: new FakeGenerationGateway(),
      outDir,
      env: {},
      configPath: join(outDir, "no-config.json"),
      nowIso: () => "2026-09-21T00:00:00Z",
      missionTranscript: [],
    });
    expect(report.evidenceCaveats).toBeUndefined();
  });

  it("FAILS FAST: an analysis failure throws UxAnalysisFailedError — never a fabricated clean report", async () => {
    const throwingJudge: JudgmentPort = { async systemOne() { throw new Error("gateway down"); } };
    await expect(
      runUxReview({ recording: recording(), appContext: APP, judge: throwingJudge, gen: new FakeGenerationGateway(), outDir: "/unused", env: {}, configPath: "/nonexistent/config.json" }),
    ).rejects.toBeInstanceOf(UxAnalysisFailedError);
  });
});

describe("runUxReview — min-confidence + quality policy resolution", () => {
  it("flag > env > config > default; the report records the cutoff and policy applied", async () => {
    const outDir = await mkdtemp(join(tmpdir(), "ux-cutoff-"));
    const configPath = join(outDir, "config.json");
    await writeFile(configPath, JSON.stringify({ ux: { minConfidence: 0.3, show: ["actionable"] } }));
    const base = { recording: recording(), appContext: APP, judge: benignJudge, gen: new FakeGenerationGateway(), outDir, configPath, nowIso: () => "2026-09-21T00:00:00Z" };
    expect((await runUxReview({ ...base, env: {} })).report).toMatchObject({ minConfidence: 0.3, qualityShown: ["actionable"] });
    expect((await runUxReview({ ...base, env: { JEVITATE_UX_MIN_CONFIDENCE: "0.6", JEVITATE_UX_SHOW: "generic" } })).report).toMatchObject({ minConfidence: 0.6, qualityShown: ["generic"] });
    expect((await runUxReview({ ...base, env: { JEVITATE_UX_MIN_CONFIDENCE: "0.6" }, minConfidence: "0.9", show: "wrong" })).report).toMatchObject({ minConfidence: 0.9, qualityShown: ["wrong"] });
    expect((await runUxReview({ ...base, configPath: join(outDir, "absent.json"), env: {} })).report.minConfidence).toBe(0.3);
  });

  it("an invalid cutoff or policy fails closed (never silently defaulted)", async () => {
    const outDir = await mkdtemp(join(tmpdir(), "ux-cutoff-bad-"));
    const base = { recording: recording(), appContext: APP, judge: benignJudge, gen: new FakeGenerationGateway(), outDir, configPath: join(outDir, "absent.json") };
    await expect(runUxReview({ ...base, env: {}, minConfidence: "1.5" })).rejects.toThrow(/min-confidence/);
    await expect(runUxReview({ ...base, env: { JEVITATE_UX_SHOW: "great" } })).rejects.toThrow(/unknown quality label/);
    const bad = join(outDir, "bad.json");
    await writeFile(bad, JSON.stringify({ ux: { minConfidence: "high" } }));
    await expect(runUxReview({ ...base, env: {}, configPath: bad })).rejects.toThrow(/ux.minConfidence/);
  });
});

describe("runUsabilityMission (live) — authorized-origin guard", () => {
  it("refuses an off-allowlist target BEFORE opening a browser", async () => {
    const browserPortFactory = vi.fn(() => {
      throw new Error("browser must not open for an unauthorized target");
    });
    await expect(
      runUsabilityMission({
        url: "https://evil.test/x",
        job: "buy a widget",
        allowlist: ["https://shop.test"],
        appContext: APP,
        judge: benignJudge,
        gen: { async generate() { return { output: { text: "" }, provenance: { model: "fake", tookMs: 0 } }; } } as never,
        browserPortFactory,
      }),
    ).rejects.toBeInstanceOf(UnauthorizedExploreTargetError);
    expect(browserPortFactory).not.toHaveBeenCalled();
  });
});
