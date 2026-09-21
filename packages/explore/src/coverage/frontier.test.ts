import { describe, expect, test } from "vitest";
import { Frontier, type FrontierItem } from "./frontier.js";
import type { Control } from "../index.js";

const c: Control = {
  index: 0,
  descriptor: { role: "button", name: "Reply" },
  stability: "high",
  role: "button",
  name: "Reply",
  tag: "button",
  inputType: null,
  enabled: true,
  summary: 'button "Reply"',
};

function item(over: Partial<FrontierItem>): FrontierItem {
  return {
    key: "k1",
    fromFingerprint: "fp-a",
    pathPrefix: { version: "1", site: "https://x.test", pages: [] },
    control: c,
    op: "click",
    ...over,
  };
}

describe("Frontier", () => {
  test("starts exhausted", () => {
    expect(new Frontier().isExhausted()).toBe(true);
  });

  test("dedupes by key — pushing the same key twice only enqueues once", () => {
    const f = new Frontier();
    f.push(item({ key: "dup" }));
    f.push(item({ key: "dup" }));
    expect(f.size).toBe(1);
  });

  test("popPreferring returns an item matching the preferred fingerprint before falling back to FIFO order", () => {
    const f = new Frontier();
    f.push(item({ key: "a", fromFingerprint: "fp-a" }));
    f.push(item({ key: "b", fromFingerprint: "fp-b" }));
    const popped = f.popPreferring("fp-b");
    expect(popped?.key).toBe("b");
    expect(f.size).toBe(1);
  });

  test("popPreferring falls back to the oldest item when no preferred-fingerprint item exists", () => {
    const f = new Frontier();
    f.push(item({ key: "a", fromFingerprint: "fp-a" }));
    f.push(item({ key: "b", fromFingerprint: "fp-b" }));
    const popped = f.popPreferring("fp-nonexistent");
    expect(popped?.key).toBe("a");
  });

  test("isExhausted flips true once every item is popped", () => {
    const f = new Frontier();
    f.push(item({ key: "only" }));
    f.popPreferring(undefined);
    expect(f.isExhausted()).toBe(true);
  });
});
