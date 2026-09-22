import { describe, expect, test, vi } from "vitest";
import { reachFrontierState } from "./reach.js";
import { stateFingerprint } from "./fingerprint.js";
import type { FrontierItem } from "./frontier.js";
import type { Snapshot } from "../snapshot.js";

// A fake actor whose activities are no-ops — the reach unit test uses an
// EMPTY pathPrefix, so the interpreter validates it and runs zero steps
// without ever touching the actor.
function fakeActor() {
  return { name: "t", ability: vi.fn(), attemptsTo: vi.fn().mockResolvedValue(undefined), asks: vi.fn() };
}

function itemFor(fromFingerprint: string): FrontierItem {
  return {
    key: "k",
    fromFingerprint,
    pathPrefix: { version: "1", site: "https://x.test", pages: [] },
    control: {
      index: 0,
      descriptor: { role: "link", name: "Go" },
      stability: "high",
      role: "link",
      name: "Go",
      tag: "a",
      inputType: null,
      enabled: true,
      summary: 'link "Go"',
    },
    op: "click",
  };
}

describe("reachFrontierState", () => {
  test("ok when the replayed state's fingerprint matches", async () => {
    const snap: Snapshot = { url: "https://x.test/a", controls: [], truncated: false, signature: "s" };
    const result = await reachFrontierState({
      actor: fakeActor() as never,
      item: itemFor(stateFingerprint(snap)),
      snapshotNow: async () => snap,
    });
    expect(result.ok).toBe(true);
  });

  test("stale when it doesn't", async () => {
    const snap: Snapshot = { url: "https://x.test/different-thing-entirely", controls: [], truncated: false, signature: "s" };
    const result = await reachFrontierState({
      actor: fakeActor() as never,
      item: itemFor("some-other-fingerprint"),
      snapshotNow: async () => snap,
    });
    expect(result).toEqual({ ok: false, reason: "stale" });
  });
});
