import { describe, expect, it } from "vitest";
import type { Recording, RecordedStep } from "@jevitate/recording";
import { refuseShortening, shortenRecording, type ShortenVerdict } from "./shorten.js";

/** #801: the model-free shortest-path search: ddmin step removal, the confirmation guard, the replay budget. */
const visible = (testId: string) => ({ kind: "visible", target: { testId } }) as const;
const nav = (url: string): RecordedStep => ({ step: { kind: "navigate", url, expect: visible("main") } }) as RecordedStep;
const click = (testId: string): RecordedStep => ({ step: { kind: "click", target: { testId }, expect: visible("main") } }) as RecordedStep;
const fill = (testId: string): RecordedStep => ({ step: { kind: "fill", target: { testId }, value: { redacted: false, value: "x" }, expect: visible("main") } }) as unknown as RecordedStep;
const rec = (steps: RecordedStep[]): Recording => ({ version: "1.0", site: "http://127.0.0.1:1", pages: [{ url: "/", steps }] }) as unknown as Recording;

// The accuracy lab's J2: a detour, then the contacts page, a recipient, a body and Send.
const J2 = rec([nav("/"), click("nav-profile"), click("nav-contacts"), fill("contact-select"), fill("message-body"), click("send-message")]);
/** The lab's J2 done check (`count:testId=sent-row|min=1`) holds whenever Send is reached from the contacts page. */
const j2Check = async (kept: readonly number[]): Promise<ShortenVerdict> => ([0, 2, 5].every((i) => kept.includes(i)) ? "achieved" : "not-achieved");

describe("#801 shortenRecording", () => {
  it("shortens the lab's J2 from 6 steps to 3 within the default 30-replay budget", async () => {
    const r = await shortenRecording(J2, { decide: j2Check });
    expect(r).toMatchObject({ originalSteps: 6, shortestSteps: 3, kept: [0, 2, 5], removed: [1, 3, 4], budget: 30, stopped: "searched", baseline: "achieved" });
    expect(r.replaysUsed).toBeLessThanOrEqual(30);
    expect(r.recording.pages.flatMap((p) => p.steps)).toEqual([J2.pages[0]!.steps[0], J2.pages[0]!.steps[2], J2.pages[0]!.steps[5]]);
  });

  it("replays the recorded path first and tries nothing shorter when it does not achieve the job", async () => {
    const r = await shortenRecording(J2, { decide: async () => "not-achieved" });
    expect(r).toMatchObject({ stopped: "recorded-path-fails", baseline: "not-achieved", replaysUsed: 1, shortestSteps: 6, removed: [] });
  });

  it("stops at the budget and keeps the shortest found so far", async () => {
    const r = await shortenRecording(J2, { decide: j2Check, budget: 3 });
    expect(r.stopped).toBe("budget");
    expect(r.replaysUsed).toBe(3);
    // Whatever it found so far is a path that achieved the job; a shorter one may remain untried.
    expect(r.shortestSteps).toBeGreaterThanOrEqual(3);
    expect(r.candidates.filter((c) => c.verdict !== "refused" && c.cached !== true)).toHaveLength(3);
  });

  it("never drops a confirmation click, and the refusal costs no replay", async () => {
    const steps = [nav("/"), click("go-import"), fill("csv-text"), click("import-confirm"), nav("/contacts")];
    const decided: number[][] = [];
    const r = await shortenRecording(rec(steps), {
      decide: async (kept) => {
        decided.push([...kept]);
        return "achieved"; // the check would pass anything: only the guard keeps the confirmation
      },
    });
    expect(r.kept).toContain(3);
    expect(decided.every((k) => k.includes(3))).toBe(true);
    expect(r.candidates.some((c) => c.verdict === "refused")).toBe(true);
    expect(r.replaysUsed).toBe(decided.length);
  });

  it("refuses a candidate that deep-links past a dropped confirmation, or skips it", () => {
    const steps = [nav("/"), click("go-import"), click("import-accept-terms"), nav("/done")];
    expect(refuseShortening(steps, new Set([0, 1, 2, 3]))).toBeNull();
    expect(refuseShortening(steps, new Set([0, 1, 3]))).toBe("deep-link-past-confirmation");
    expect(refuseShortening(steps, new Set([0, 1]))).toBe("skipped-confirmation");
    expect(refuseShortening(steps, new Set([0, 2, 3]))).toBeNull();
  });

  it("refuses a budget that is not a positive whole number", async () => {
    await expect(shortenRecording(J2, { decide: j2Check, budget: 0 })).rejects.toThrow(/budget/);
  });
});
