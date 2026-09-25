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

describe("Frontier — toggle round trips are exercised once in each direction, then dropped (#160)", () => {
  const button = (name: string): Control => ({ ...c, name, descriptor: { role: "button", name } });

  test("Collapse/Expand (name-paired, different identities): both directions blacklisted and purged after the 2nd", () => {
    const f = new Frontier();
    const collapse = button("Collapse signal minimap");
    const expand = button("Expand signal minimap");
    f.push(item({ key: "collapse-1", fromFingerprint: "s0", control: collapse }));
    // s0 --Collapse--> s1
    f.noteTransition("s0", collapse, "s1");
    // s1 re-offers Expand — several times, from several near-identical states, exactly as the bug
    // report describes ("each toggle produces a 'new' state signature").
    f.push(item({ key: "expand-1", fromFingerprint: "s1", control: expand }));
    f.push(item({ key: "expand-2", fromFingerprint: "s1b", control: expand }));
    f.push(item({ key: "collapse-2", fromFingerprint: "s2", control: collapse }));
    // s1 --Expand--> s2 (the reverse of s0->s1): the toggle has now gone both ways.
    f.noteTransition("s1", expand, "s2");
    expect(f.size).toBe(0); // every queued Collapse/Expand item was purged
    // A LATER state re-offering either direction is refused too (never enqueued again).
    f.push(item({ key: "expand-3", fromFingerprint: "s3", control: expand }));
    f.push(item({ key: "collapse-3", fromFingerprint: "s4", control: collapse }));
    expect(f.size).toBe(0);
  });

  test("a same-name disclosure (A→B→A via the SAME control): dropped after its round trip", () => {
    const f = new Frontier();
    const toggle = button("Supporting Details");
    f.push(item({ key: "open", fromFingerprint: "a", control: toggle }));
    f.noteTransition("a", toggle, "b"); // opens: a -> b
    f.push(item({ key: "close-1", fromFingerprint: "b", control: toggle }));
    f.push(item({ key: "close-2", fromFingerprint: "b2", control: toggle })); // a near-duplicate state
    f.noteTransition("b", toggle, "a"); // closes: b -> a, the exact reverse
    expect(f.size).toBe(0);
    f.push(item({ key: "again", fromFingerprint: "c", control: toggle }));
    expect(f.size).toBe(0);
  });

  test("a no-op action (before === after) records nothing — never mistaken for a toggle", () => {
    const f = new Frontier();
    const btn = button("Refresh");
    f.noteTransition("a", btn, "a");
    f.push(item({ key: "still-queued", fromFingerprint: "a", control: btn }));
    expect(f.size).toBe(1);
  });

  test("an ordinary (non-toggle, non-round-trip) control is never affected", () => {
    const f = new Frontier();
    const btn = button("Export");
    f.noteTransition("a", btn, "b");
    f.push(item({ key: "still-queued", fromFingerprint: "b", control: btn }));
    expect(f.size).toBe(1);
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
