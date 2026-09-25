import { describe, expect, it } from "vitest";
import { ObservedPages, groundAnswer, pagesContext } from "./answer.js";

const pages = [
  { url: "http://app.test/settings", text: "Settings\nPlan: Pro\nDesign Partner pricing: book one interview per month." },
  { url: "http://app.test/billing", text: "Billing\nCredits left: 1,200" },
];

describe("groundAnswer — code adjudicates a reported answer (#101)", () => {
  it("accepts an answer whose every claim quotes an observed page, with its evidence", () => {
    const v = groundAnswer(
      {
        answer: "Pro plan, 1200 credits left.",
        claims: [
          { claim: "Pro plan", quote: "“Plan: Pro”" },
          { claim: "1200 credits left", quote: "credits  left: 1,200." },
        ],
      },
      pages,
    );
    expect(v.accept).toBe(true);
    expect(v.answer?.evidence.map((e) => e.url)).toEqual(["http://app.test/settings", "http://app.test/billing"]);
  });

  it("rejects a quote no observed page shows", () => {
    const v = groundAnswer({ answer: "Enterprise plan", claims: [{ claim: "Enterprise plan", quote: "Plan: Enterprise" }] }, pages);
    expect(v.accept).toBe(false);
    expect(!v.accept && v.reason).toMatch(/quote not found on any observed page/);
  });

  it("rejects a claim whose figure is not in its (real) quote", () => {
    const v = groundAnswer({ answer: "5000 credits", claims: [{ claim: "5000 credits left", quote: "Credits left" }] }, pages);
    expect(!v.accept && v.reason).toMatch(/figure 5000 is not in its quote/);
  });

  it("rejects a quote that does not say what the claim says", () => {
    const v = groundAnswer({ answer: "Billing is overdue", claims: [{ claim: "Payment overdue", quote: "Billing" }] }, pages);
    expect(!v.accept && v.reason).toMatch(/does not say what the claim says/);
  });

  it("rejects a figure smuggled into the answer text outside every grounded claim", () => {
    const v = groundAnswer({ answer: "Pro plan, renews in 3 days", claims: [{ claim: "Pro plan", quote: "Plan: Pro" }] }, pages);
    expect(!v.accept && v.reason).toMatch(/states 3, which no observed page shows/);
  });

  it("rejects no answer and an answer citing nothing", () => {
    expect(groundAnswer({ answer: null, claims: [] }, pages).accept).toBe(false);
    expect(groundAnswer({ answer: "Pro", claims: [] }, pages).accept).toBe(false);
  });
});

describe("figures are free-standing numerals only (#157)", () => {
  const keys = [{ url: "http://app.test/keys", text: "API keys\nTwo-factor authentication is required before you can create an API key.\nPro: $25/mo · 25% off · 1,234 seats · 5GB" }];

  it("digits inside words are never figures: 'no2fa', '2FA', 'v2', 'S3' ground on the quote alone", () => {
    const v = groundAnswer(
      {
        answer: "You cannot create the key 'no2fa' via the v2 API or S3: 2FA is required first.",
        claims: [{ claim: "2FA is required before creating an API key", quote: "Two-factor authentication is required before you can create an API key" }],
      },
      keys,
    );
    expect(v.accept).toBe(true);
  });

  it("currency, percent, thousands and unit figures are still figures", () => {
    const quote = "Pro: $25/mo · 25% off · 1,234 seats · 5GB";
    const ok = groundAnswer({ answer: "Pro costs $25/mo, 25% off, 1234 seats, 5GB.", claims: [{ claim: "Pro is $25/mo with 1,234 seats and 5GB", quote }] }, keys);
    expect(ok.accept).toBe(true);
    for (const bad of ["Pro costs $26/mo.", "Pro is 30% off.", "Pro has 1,235 seats.", "Pro has 6GB."]) {
      const v = groundAnswer({ answer: bad, claims: [{ claim: "Pro pricing", quote }] }, keys);
      expect(v.accept, bad).toBe(false);
      expect(!v.accept && v.reason).toMatch(/which no observed page shows/);
    }
  });

  it("names the offending token when a figure carries a unit", () => {
    const v = groundAnswer({ answer: "Pro has 7GB.", claims: [{ claim: "Pro pricing", quote: "Pro: $25/mo" }] }, keys);
    expect(!v.accept && v.reason).toMatch(/states 7 \(in "7GB"\)/);
  });

  it("a figure the goal itself states needs no page to show it", () => {
    const claims = [{ claim: "2FA is required", quote: "Two-factor authentication is required" }];
    const answer = "The key 'key 42' cannot be created: 2FA is required.";
    expect(groundAnswer({ answer, claims }, keys).accept).toBe(false);
    expect(groundAnswer({ answer, claims }, keys, { goal: "Try to create an API key named 'key 42'." }).accept).toBe(true);
  });
});

describe("ObservedPages", () => {
  it("redacts secrets when observed, dedupes, and lists most recent first (bounded context)", () => {
    const o = new ObservedPages(["s3cret-token"]);
    o.add("http://app.test/a", "token s3cret-token here");
    o.add("http://app.test/b", "B page");
    o.add("http://app.test/a", "token s3cret-token here");
    const all = o.pages();
    expect(all.map((p) => p.url)).toEqual(["http://app.test/a", "http://app.test/b"]);
    expect(JSON.stringify(all)).not.toContain("s3cret-token");
    expect(pagesContext(all, 30).length).toBeLessThanOrEqual(30);
  });
});
