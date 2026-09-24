import { describe, expect, it } from "vitest";
import { adjudicate } from "./adjudicate.js";
import { redactEvidence } from "./redact.js";
import type { UxEvidence } from "./types.js";

const ev = redactEvidence(
  {
    screenId: "s1",
    url: "https://app.example.com/plans",
    controls: [
      { index: 0, role: "button", name: "Get Started", tag: "button", inputType: null, enabled: true, summary: 'button "Get Started"' },
      { index: 1, role: "link", name: "Getting Started", tag: "a", inputType: null, enabled: true, summary: 'link "Getting Started"' },
    ],
    visibleText: "Choose a plan.\nStart your free trial today.",
    appContext: { appClass: "consumer" },
    job: "start a trial",
    history: [],
    behavior: { noProgress: false, backtracks: 0, formReentry: 0, dwellMs: 0, errors: 0 },
    a11yFacts: { controls: [] },
  } satisfies UxEvidence,
  [],
);
const item = {
  rubricItemId: "nielsen-4",
  violated: true,
  implicatedControls: [0, 1],
  quotes: ["“start your free   trial”"],
  observation: 'button "Get Started" and link "Getting Started" look like the same step.',
  userImpact: "The user hesitates between two entry points.",
  recommendation: 'Rename "Getting Started" to "Read the setup guide".',
};

describe("adjudicate (independent code)", () => {
  it("accepts verified controls + quotes (quotes normalized for case, whitespace and smart quotes)", () => {
    const a = adjudicate(item, ev);
    expect(a).toMatchObject({ kind: "accepted", grounding: 1, controls: ['button "Get Started"', 'link "Getting Started"'] });
    if (a.kind === "accepted") expect(a.evidenceRefs.map((r) => r.id)).toEqual(["control:0", "control:1", "visibleText"]);
  });
  it("lower grounding when the prose names none of the cited evidence", () => {
    const a = adjudicate({ ...item, quotes: [], observation: "Two entry points compete.", recommendation: "Keep one." }, ev);
    expect(a).toMatchObject({ kind: "accepted", grounding: 0.6 });
  });
  it("rejects a cited control index that is not on the screen", () => {
    expect(adjudicate({ ...item, implicatedControls: [3] }, ev)).toMatchObject({ kind: "suppressed", reason: "rejected-evidence" });
  });
  it("rejects a fabricated quote", () => {
    expect(adjudicate({ ...item, quotes: ["No credit card required"] }, ev)).toMatchObject({ kind: "suppressed", reason: "rejected-evidence" });
  });
  it("no controls and no quotes is ungrounded; violated=false is not-confirmed", () => {
    expect(adjudicate({ ...item, implicatedControls: [], quotes: [] }, ev)).toMatchObject({ kind: "suppressed", reason: "ungrounded" });
    expect(adjudicate({ ...item, violated: false }, ev)).toMatchObject({ kind: "suppressed", reason: "not-confirmed" });
  });
});
