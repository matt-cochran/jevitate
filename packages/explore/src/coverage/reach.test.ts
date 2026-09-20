import { describe, expect, test, vi } from "vitest";
import { reachFrontierState } from "./reach.js";
import { stateFingerprint } from "./fingerprint.js";
import type { FrontierItem } from "./frontier.js";
import type { Control, Snapshot } from "../index.js";

function fakeActor() {
  return { name: "t", ability: vi.fn(), attemptsTo: vi.fn().mockResolvedValue(undefined), asks: vi.fn() };
}

const control: Control = {
  index: 0,
  descriptor: { role: "button", name: "Go" },
  stability: "high",
  role: "button",
  name: "Go",
  tag: "button",
  inputType: null,
  enabled: true,
  summary: 'button "Go"',
};

const baseItem: FrontierItem = {
  key: "k",
  fromFingerprint: "fp-expected",
  // Empty prefix: reach only re-navigates to the seed, no interpreter replay.
  pathPrefix: { version: "1", site: "https://x.test", pages: [] },
  control,
  op: "click",
};

describe("reachFrontierState", () => {
  test("returns ok + the snapshot when the replayed fingerprint matches fromFingerprint", async () => {
    const snap: Snapshot = { url: "https://x.test/a", signature: "s", truncated: false, controls: [] };
    const result = await reachFrontierState({
      page: {} as never,
      actor: fakeActor() as never,
      seedUrl: "https://x.test/a",
      item: { ...baseItem, fromFingerprint: stateFingerprint(snap) },
      snapshotNow: async () => snap,
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.snapshot).toBe(snap);
  });

  test("returns { ok: false, reason: 'stale' } when the replayed state doesn't match — never guesses", async () => {
    const snap: Snapshot = { url: "https://x.test/different", signature: "s", truncated: false, controls: [] };
    const result = await reachFrontierState({
      page: {} as never,
      actor: fakeActor() as never,
      seedUrl: "https://x.test/a",
      item: baseItem,
      snapshotNow: async () => snap,
    });
    expect(result).toEqual({ ok: false, reason: "stale" });
  });
});
