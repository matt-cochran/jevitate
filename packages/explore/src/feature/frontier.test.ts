import { describe, expect, test } from "vitest";
import { Frontier, type FrontierItem } from "./frontier.js";
import type { Control } from "../snapshot.js";

const c: Control = {
  index: 0,
  descriptor: { role: "link", name: "t-1" },
  stability: "high",
  role: "link",
  name: "t-1",
  tag: "a",
  inputType: null,
  enabled: true,
  summary: 'link "t-1"',
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

  test("dedupes by key", () => {
    const f = new Frontier();
    f.push(item({ key: "dup" }));
    f.push(item({ key: "dup" }));
    expect(f.size).toBe(1);
  });

  test("popPreferring prefers the given fingerprint", () => {
    const f = new Frontier();
    f.push(item({ key: "a", fromFingerprint: "fp-a" }));
    f.push(item({ key: "b", fromFingerprint: "fp-b" }));
    expect(f.popPreferring("fp-b")?.key).toBe("b");
  });

  test("popPreferring falls back to FIFO when the preferred fingerprint is absent", () => {
    const f = new Frontier();
    f.push(item({ key: "a", fromFingerprint: "fp-a" }));
    f.push(item({ key: "b", fromFingerprint: "fp-b" }));
    expect(f.popPreferring("fp-z")?.key).toBe("a");
  });
});
