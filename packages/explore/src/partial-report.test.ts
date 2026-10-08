import { describe, expect, it } from "vitest";
import { buildPartialReport } from "./partial-report.js";
import type { ObservedPage } from "./answer.js";
import type { TranscriptEntry } from "./transcript.js";

const entry = (url: string, signature: string, op: TranscriptEntry["op"], target: string | null, actOk: boolean, reason?: string): TranscriptEntry =>
  ({ step: 0, op, target, confidence: 0.9, chosenBy: "model", actOk, url, signature, controlCount: 2, ...(reason === undefined ? {} : { reason }) }) as TranscriptEntry;

describe("#424 buildPartialReport", () => {
  // ObservedPages.pages() is most recent first.
  const pages: ObservedPage[] = [
    { url: "https://x.test/b", text: "Nav A Nav B\nB detail\nError: export failed", heading: "B", controls: ["Nav A", "Nav B", "Export"] },
    { url: "https://x.test/", text: "Nav A Nav B\nWelcome to the tool\nExport\nThree items pending", title: "Tool", controls: ["Nav A", "Nav B", "Export"] },
  ];
  const transcript = [
    entry("https://x.test/", "s1", "click", 'button "Export"', false, "refused: read-only run"),
    entry("https://x.test/", "s1", "click", 'link "Nav B"', true),
    entry("https://x.test/b", "s2", "report", null, false, "report rejected"),
  ];

  it("lists each page in visit order with its own grounded text lines, controls, and what was tried", () => {
    const r = buildPartialReport({
      goal: "Use the main features and report every error",
      pages,
      transcript,
      claims: [
        { claim: "three pending", quote: "Three items pending", url: "https://x.test/", grounded: true, source: "page-text" },
        { claim: "invented", quote: "Nothing", url: null, grounded: false, why: "not found" },
        { claim: "three pending", quote: "Three items pending", url: "https://x.test/", grounded: true, source: "page-text" },
      ],
      note: "answer not found (pages seen: /, /b)",
    });
    expect(r.states.map((s) => s.url)).toEqual(["/", "/b"]);
    expect(r.states[0]).toMatchObject({
      title: "Tool",
      seen: ["Welcome to the tool", "Three items pending"],
      controls: ["Nav A", "Nav B", "Export"],
      tried: [
        { op: "click", control: 'button "Export"', ok: false, result: "refused: read-only run" },
        { op: "click", control: 'link "Nav B"', ok: true, result: "led to /b" },
      ],
    });
    // A control's label ("Export") and the shared nav line are not "seen" content; the error is (the goal asks for errors).
    expect(r.states[1]).toMatchObject({ heading: "B", seen: ["B detail", "Error: export failed"], tried: [] });
    // Only grounded claims, deduped.
    expect(r.claims).toHaveLength(1);
    expect(r.note).toBe("answer not found (pages seen: /, /b)");
  });

  it("never lists a line that is not on the page it is attributed to", () => {
    const r = buildPartialReport({ goal: "Explore the app", pages, transcript, claims: [], note: "n" });
    for (const s of r.states) {
      const page = pages.find((p) => new URL(p.url).pathname === s.url)!;
      for (const line of s.seen) expect(page.text).toContain(line);
    }
  });
});
