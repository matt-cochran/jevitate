import { describe, expect, it } from "vitest";
import { detectRepeatedAdvances, type RunSignalCapture, type SignalScreen, type SignalStep } from "../signals.js";

// #642: the same advance control needed again and again — avoidable steps the run measured.

const URL = "http://app.test/import";

function click(n: number, name: string, url = URL): SignalStep {
  return { step: n, op: "click", target: `button "${name}"`, actOk: true, url, descriptor: { role: "button", name } };
}

function input(n: number): SignalStep {
  return { step: n, op: "select", target: 'combobox "Email column"', actOk: true, url: URL, value: "email" };
}

/** One screen per step, its text naming the step so every click moves the page on. */
function screens(n: number, text: (i: number) => string = (i) => `Confirmation ${i} of ${n}`, url = URL): SignalScreen[] {
  return Array.from({ length: n + 1 }, (_, i) => ({ index: i, step: i + 1, at: i * 1000, url, signature: `sig-${i}`, visibleText: text(i), busy: false }));
}

const capture = (steps: SignalStep[], shown: SignalScreen[]): RunSignalCapture => ({ steps, requests: [], screens: shown, endedAt: 60_000 });

describe("#642 repeated advance", () => {
  it("reports three consecutive Continue clicks that each moved the page on", () => {
    expect(detectRepeatedAdvances(capture([click(1, "Continue"), click(2, "Continue"), click(3, "Continue")], screens(3)))).toHaveLength(1);
  });

  it("cites the streak's steps", () => {
    const [f] = detectRepeatedAdvances(capture([click(1, "Continue"), click(2, "Continue"), click(3, "Continue")], screens(3)));
    expect(f?.signal?.steps).toEqual([1, 2, 3]);
  });

  it("does not report two advance clicks", () => {
    expect(detectRepeatedAdvances(capture([click(1, "Continue"), click(2, "Continue")], screens(2)))).toEqual([]);
  });

  it("does not report advances separated by input", () => {
    expect(detectRepeatedAdvances(capture([click(1, "Continue"), click(2, "Continue"), input(3), click(4, "Continue")], screens(4)))).toEqual([]);
  });

  it("does not report clicks that left the page text unchanged", () => {
    expect(detectRepeatedAdvances(capture([click(1, "Continue"), click(2, "Continue"), click(3, "Continue")], screens(3, () => "Same page")))).toEqual([]);
  });

  it("does not report a non-advance control clicked three times", () => {
    expect(detectRepeatedAdvances(capture([click(1, "Add row"), click(2, "Add row"), click(3, "Add row")], screens(3)))).toEqual([]);
  });
});
