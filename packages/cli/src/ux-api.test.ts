import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { Answer, JudgmentPort } from "@jevitate/ai-core";
import { UnauthorizedExploreTargetError } from "@jevitate/explore";
import type { Recording } from "@jevitate/recording";
import {
  recordingToEvidence,
  snapshotToEvidence,
  runUsabilityMission,
  runUxReview,
  UxAnalysisFailedError,
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
    const { report, reportPath } = await runUxReview({ recording: recording(), appContext: APP, judge: benignJudge, outDir, nowIso: () => "2026-09-21T00:00:00Z" });
    expect(report.coverage).toBeDefined();
    expect(report.coverage.totalItems).toBeGreaterThan(0);
    const written = JSON.parse(await readFile(reportPath, "utf8"));
    expect(written.coverage.totalItems).toBe(report.coverage.totalItems);
  });

  it("FAILS FAST: an analysis failure throws UxAnalysisFailedError — never a fabricated clean report", async () => {
    const throwingJudge: JudgmentPort = { async systemOne() { throw new Error("gateway down"); } };
    await expect(
      runUxReview({ recording: recording(), appContext: APP, judge: throwingJudge, outDir: "/unused" }),
    ).rejects.toBeInstanceOf(UxAnalysisFailedError);
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
