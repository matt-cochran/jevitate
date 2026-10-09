import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { STEP_ID_RE } from "@jevitate/recording";
import type { Journey } from "./journey.js";
import { FsJourneyStore } from "./store.js";

/** #467: `put` is the one choke point where a Journey is written — it mints missing step ids; reads never do. */

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "jev-step-ids-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const click = (testId: string) => ({ kind: "click" as const, target: { testId }, expect: { kind: "visible" as const, target: { testId } } });
const journey = (stepIds: (string | undefined)[]): Journey => ({
  metadata: { id: "flow", name: "flow", promoted: false, params: [], createdAtIso: "2026-10-09T00:00:00Z" },
  recording: {
    version: "1",
    site: "https://shop.example.test",
    pages: [{ url: "/", steps: stepIds.map((stepId, i) => (stepId === undefined ? { step: click(`b${i}`) } : { step: click(`b${i}`), stepId })) }],
  },
});
const idsOf = (j: Journey | null): (string | undefined)[] => (j?.recording.pages ?? []).flatMap((p) => p.steps.map((s) => s.stepId));
const file = (): string => readFileSync(join(dir, "flow.json"), "utf8");

describe("FsJourneyStore step ids", () => {
  it("put mints an id for every step without one", async () => {
    const store = new FsJourneyStore(dir);
    await store.put(journey([undefined, undefined]));
    expect(idsOf(await store.get("flow")).every((id) => id !== undefined && STEP_ID_RE.test(id))).toBe(true);
  });

  it("put keeps the ids a Journey already has", async () => {
    const store = new FsJourneyStore(dir);
    await store.put(journey(["s-aaaaaa", undefined]));
    expect(idsOf(await store.get("flow"))[0]).toBe("s-aaaaaa");
  });

  it("put is idempotent: re-writing what was read leaves the file byte-identical", async () => {
    const store = new FsJourneyStore(dir);
    await store.put(journey([undefined, undefined]));
    const first = file();
    await store.put((await store.get("flow"))!);
    expect(file()).toBe(first);
  });

  it("put of the same id-less Journey twice mints the same ids", async () => {
    const store = new FsJourneyStore(dir);
    await store.put(journey([undefined, undefined]));
    const first = file();
    await store.put(journey([undefined, undefined]));
    expect(file()).toBe(first);
  });

  it("an id-complete Journey round-trips unchanged through put and get", async () => {
    const store = new FsJourneyStore(dir);
    const complete = journey(["s-aaaaaa", "s-bbbbbb"]);
    await store.put(complete);
    expect(await store.get("flow")).toEqual(complete);
  });

  it("get never mints an id", async () => {
    writeFileSync(join(dir, "flow.json"), JSON.stringify(journey([undefined])));
    expect(idsOf(await new FsJourneyStore(dir).get("flow"))).toEqual([undefined]);
  });

  it("put refuses a Journey whose steps share an id", async () => {
    await expect(new FsJourneyStore(dir).put(journey(["s-aaaaaa", "s-aaaaaa"]))).rejects.toThrow(/duplicate stepId/);
  });
});
