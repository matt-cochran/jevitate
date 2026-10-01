import { describe, expect, it } from "vitest";
import { formatMissionHuman } from "./cli-output.js";

/** #303: the human output lists each step's action delta — only when the run recorded deltas. */
describe("human mission output — action deltas (#303)", () => {
  const base = { missionOutcome: "clean", outcome: "succeeded", goalOutcome: "succeeded", strategy: "goal" };

  it("adds a verdict count and one short line per step that carries a delta", () => {
    const text = formatMissionHuman({
      ...base,
      transcript: [
        { step: 1, op: "click", delta: { action: "click Save", verdict: "relevant-change", why: "x", changes: [{ text: '~ status: "" → "Saved"' }] } },
        { step: 2, op: "click", delta: { action: "click Save", verdict: "no-change", why: "nothing changed and no request was sent", changes: [] } },
        { step: 3, op: "done" },
      ],
    });
    expect(text).toMatch(/DELTAS\s+2 action\(s\): 1 relevant-change, 1 no-change/);
    expect(text).toMatch(/DELTA\s+step 1 click Save: relevant-change — ~ status: "" → "Saved"/);
    expect(text).toMatch(/DELTA\s+step 2 click Save: no-change — nothing changed and no request was sent/);
  });

  it("adds nothing when the run recorded no deltas (the default)", () => {
    const text = formatMissionHuman({ ...base, transcript: [{ step: 1, op: "click" }] });
    expect(text).not.toMatch(/DELTA/);
  });
});
