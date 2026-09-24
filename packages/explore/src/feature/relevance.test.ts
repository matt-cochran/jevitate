import { describe, expect, test } from "vitest";
import { ChromeTracker, featureWords, lexicalScore, relevanceScore } from "./relevance.js";
import type { Control } from "../snapshot.js";

function control(over: Partial<Control>): Control {
  return {
    index: 0,
    descriptor: { role: "button", name: "x" },
    stability: "high",
    role: "button",
    name: "x",
    tag: "button",
    inputType: null,
    enabled: true,
    summary: "",
    ...over,
  };
}

describe("featureWords", () => {
  test("lowercases, splits on non-alphanumerics, and drops stopwords", () => {
    expect(featureWords("Buy a pack")).toEqual(["buy", "pack"]);
    expect(featureWords("sign in")).toEqual(["sign"]);
  });

  test("drops single-character tokens", () => {
    expect(featureWords("a b buy")).toEqual(["buy"]);
  });
});

describe("lexicalScore", () => {
  test("scores 0 with no feature words", () => {
    expect(lexicalScore(control({ name: "Buy pack" }), [])).toBe(0);
  });

  test("counts distinct word matches across name/label/testId/role", () => {
    const buyPack = control({ name: "Buy pack #1", descriptor: { testId: "buy-pack-1" } });
    expect(lexicalScore(buyPack, ["buy", "pack"])).toBe(2);
  });

  test("scores 0 for an irrelevant control", () => {
    const home = control({ name: "Home", role: "link" });
    expect(lexicalScore(home, ["buy", "pack"])).toBe(0);
  });
});

describe("ChromeTracker", () => {
  test("a control seen on only one pathname is not chrome", () => {
    const t = new ChromeTracker();
    const nav = control({ name: "Home", role: "link" });
    t.observe("/shop", [nav]);
    expect(t.isChrome(nav)).toBe(false);
  });

  test("a control seen on 2+ distinct pathnames is chrome", () => {
    const t = new ChromeTracker();
    const nav = control({ name: "Home", role: "link" });
    t.observe("/shop", [nav]);
    t.observe("/about", [nav]);
    expect(t.isChrome(nav)).toBe(true);
  });

  test("a capability-specific control repeated on the SAME pathname stays non-chrome", () => {
    const t = new ChromeTracker();
    const buy = control({ name: "Buy pack #1" });
    t.observe("/shop", [buy]);
    t.observe("/shop", [buy]);
    expect(t.isChrome(buy)).toBe(false);
  });
});

describe("relevanceScore", () => {
  test("a relevant, non-chrome control outranks an irrelevant chrome control", () => {
    const words = featureWords("buy a pack");
    const chrome = new ChromeTracker();
    const nav = control({ name: "Home", role: "link" });
    const buy = control({ name: "Buy pack #1", descriptor: { testId: "buy-pack-1" } });
    chrome.observe("/shop", [nav, buy]);
    chrome.observe("/about", [nav]); // nav recurs elsewhere; buy does not
    expect(relevanceScore(buy, words, chrome)).toBeGreaterThan(relevanceScore(nav, words, chrome));
    expect(chrome.isChrome(nav)).toBe(true);
    expect(chrome.isChrome(buy)).toBe(false);
  });

  test("chrome is de-prioritised, never given a positive score even with lexical overlap", () => {
    const words = featureWords("sign in");
    const chrome = new ChromeTracker();
    const signInNav = control({ name: "Sign in", role: "link" });
    chrome.observe("/a", [signInNav]);
    chrome.observe("/b", [signInNav]);
    expect(chrome.isChrome(signInNav)).toBe(true);
    expect(relevanceScore(signInNav, words, chrome)).toBeLessThan(0);
  });
});
