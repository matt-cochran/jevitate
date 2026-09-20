import { expect, test } from "vitest";
import type { Recording, PageSegment } from "@jevitate/recording";
import { minimizeRecording, type Reproduces } from "./minimize.js";

function step(name: string) {
  return { step: { kind: "click" as const, target: { role: "button", name }, expect: { kind: "visible" as const, target: { testId: "ok" } } } };
}

function recWithSteps(names: string[]): Recording {
  const page: PageSegment = { url: "/x", steps: names.map(step) };
  return { version: "1.0", site: "https://example.test", pages: [page] };
}

test("removes irrelevant middle steps, keeping only the ones the reproduces predicate needs", async () => {
  // "essential-start" and "essential-bug" are required; "noise-1"/"noise-2"/"noise-3" are not.
  const rec = recWithSteps(["essential-start", "noise-1", "noise-2", "noise-3", "essential-bug"]);
  const reproduces: Reproduces = async (candidate) => {
    const names = candidate.pages.flatMap((p) => p.steps.map((s: any) => s.step.target.name));
    return names.includes("essential-start") && names.includes("essential-bug");
  };
  const minimized = await minimizeRecording(rec, reproduces);
  const names = minimized.pages.flatMap((p) => p.steps.map((s: any) => s.step.target.name));
  expect(names).toEqual(["essential-start", "essential-bug"]);
});

test("never returns a candidate that fails the reproduces predicate", async () => {
  const rec = recWithSteps(["a", "b", "c"]);
  const reproduces: Reproduces = async (candidate) => candidate.pages[0].steps.length >= 2;
  const minimized = await minimizeRecording(rec, reproduces);
  expect(await reproduces(minimized)).toBe(true);
  expect(minimized.pages[0].steps.length).toBe(2);
});

test("a recording that is already minimal is returned unchanged", async () => {
  const rec = recWithSteps(["only-one"]);
  const reproduces: Reproduces = async (candidate) => candidate.pages[0]?.steps.length === 1;
  const minimized = await minimizeRecording(rec, reproduces);
  expect(minimized.pages[0].steps).toHaveLength(1);
});
