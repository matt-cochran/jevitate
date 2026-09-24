import { describe, expect, test } from "vitest";
import { Frontier, type FrontierItem } from "./frontier.js";
import { controlIdentity } from "./fingerprint.js";
import { chromeClassifier } from "./chrome.js";
import { ChromeTracker } from "../feature/relevance.js";
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

describe("Frontier — chrome last (#115)", () => {
  const sidebar = (n: number): Control => ({ ...nav(`Section ${n}`), href: `https://x.test/other${n}`, landmark: "navigation" });
  const button = (name: string): Control => ({ ...c, name, descriptor: { role: "button", name } });
  const classify = chromeClassifier({ chrome: new ChromeTracker(), inScope: (url) => new URL(url).pathname.startsWith("/app") });

  test("a non-chrome item is popped before any chrome, whatever the queue order", () => {
    const f = new Frontier({ classify });
    f.push(item({ key: "nav", control: sidebar(1) }));
    f.push(item({ key: "in-page", control: button("Export") }));
    expect(f.popPreferring("fp-a")?.key).toBe("in-page");
  });

  test("chrome that leaves the scope stays within 20% of the attempted actions; the rest is dropped", () => {
    const f = new Frontier({ classify });
    for (let n = 1; n <= 8; n++) f.push(item({ key: `nav-${n}`, control: sidebar(n) }));
    for (const name of ["Refresh", "Export", "Archive", "Share"]) f.push(item({ key: name, control: button(name) }));
    const popped: string[] = [];
    for (let it = f.popPreferring("fp-a"); it !== undefined; it = f.popPreferring("fp-a")) {
      popped.push(it.key);
      f.recordAttempt();
    }
    expect(popped.slice(0, 4)).toEqual(["Refresh", "Export", "Archive", "Share"]);
    // 4 in-page actions allow exactly one leaving-scope nav click (1 of 5 = 20%).
    expect(popped.filter((k) => k.startsWith("nav-"))).toEqual(["nav-1"]);
    expect(f.isExhausted()).toBe(true);
  });

  test("each chrome destination is tried at most once per run, from however many states offer it", () => {
    const inScopeNav = (fp: string, key: string): FrontierItem =>
      item({ key, fromFingerprint: fp, control: { ...nav("Settings"), href: "https://x.test/app/settings", landmark: "navigation" } });
    const f = new Frontier({ classify });
    f.push(inScopeNav("fp-a", "from-a"));
    f.push(inScopeNav("fp-b", "from-b"));
    expect(f.popPreferring("fp-a")?.key).toBe("from-a");
    f.recordAttempt();
    expect(f.popPreferring("fp-b")).toBeUndefined();
  });

  test("dropState (#114) drops every queued item replaying the same stale path", () => {
    const f = new Frontier();
    f.push(item({ key: "a1", fromFingerprint: "fp-a" }));
    f.push(item({ key: "a2", fromFingerprint: "fp-a", control: button("Other") }));
    f.push(item({ key: "b1", fromFingerprint: "fp-b" }));
    expect(f.dropState("fp-a")).toBe(2);
    expect(f.size).toBe(1);
  });
});

describe("Frontier — novelty order (exploratory, #115)", () => {
  const button = (name: string): Control => ({ ...c, name, descriptor: { role: "button", name } });

  const second = (f: Frontier): string | undefined => {
    f.push(item({ key: "open-a", fromFingerprint: "s0", control: button("Open A") }));
    f.push(item({ key: "open-b", fromFingerprint: "s0", control: button("Open B") }));
    expect(f.popPreferring("s0")?.key).toBe("open-a");
    f.markExercised(controlIdentity(button("Open A")));
    // "Open A" revealed state s1: it re-offers "Open B" and shows a new control "A1".
    f.push(item({ key: "s1-open-b", fromFingerprint: "s1", control: button("Open B") }));
    f.push(item({ key: "a1", fromFingerprint: "s1", control: button("A1") }));
    return f.popPreferring("s1")?.key;
  };

  test("breadth sweeps the siblings first; novelty follows the control the last action revealed", () => {
    expect(second(new Frontier())).toBe("s1-open-b");
    expect(second(new Frontier({ order: "novelty" }))).toBe("a1");
  });
});
