import { describe, expect, test } from "vitest";
import { Frontier, type FrontierItem } from "./frontier.js";
import { controlIdentity } from "./fingerprint.js";
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

function nav(name: string): Control {
  return { ...c, role: "link", name, tag: "a", descriptor: { role: "link", name } };
}

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

  test("blacklist (#75): a control identity that failed with a timeout is never enqueued again, from any state", () => {
    const f = new Frontier();
    f.blacklist(controlIdentity(c));
    f.push(item({ key: "from-state-a", fromFingerprint: "fp-a" }));
    f.push(item({ key: "from-state-b", fromFingerprint: "fp-b" }));
    expect(f.isExhausted()).toBe(true);
    expect(f.size).toBe(0);
  });

  test("blacklist() called after a push does not retroactively drop it, but refuses every FURTHER push for that identity", () => {
    const f = new Frontier();
    f.push(item({ key: "already-queued" }));
    f.blacklist(controlIdentity(c));
    f.push(item({ key: "a-later-state-re-offers-it", fromFingerprint: "fp-other" }));
    expect(f.size).toBe(1);
  });

  test("exercised preference (#75): a not-yet-exercised control is preferred over an already-exercised one, even from the preferred fingerprint", () => {
    const f = new Frontier();
    const navLink = nav("Home");
    f.push(item({ key: "nav-again", fromFingerprint: "fp-a", control: navLink }));
    f.push(item({ key: "in-page", fromFingerprint: "fp-a", control: c }));
    f.markExercised(controlIdentity(navLink));
    // Both are reachable from fp-a (no reset needed); the unexercised in-page control wins.
    const popped = f.popPreferring("fp-a");
    expect(popped?.key).toBe("in-page");
  });

  test("exercised preference falls back to an exercised control reachable from the preferred fingerprint when nothing unexercised is reachable there", () => {
    const f = new Frontier();
    const navLink = nav("Home");
    f.push(item({ key: "nav-again", fromFingerprint: "fp-a", control: navLink }));
    f.markExercised(controlIdentity(navLink));
    const popped = f.popPreferring("fp-a");
    expect(popped?.key).toBe("nav-again");
  });

  test("an unexercised item wins over the FIFO order when nothing is reachable from the preferred fingerprint", () => {
    const f = new Frontier();
    const navLink = nav("Home");
    f.push(item({ key: "old-exercised-nav", fromFingerprint: "fp-b", control: navLink }));
    f.push(item({ key: "newer-unexercised", fromFingerprint: "fp-c", control: c }));
    f.markExercised(controlIdentity(navLink));
    const popped = f.popPreferring("fp-nonexistent");
    expect(popped?.key).toBe("newer-unexercised");
  });
});
