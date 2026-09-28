import { describe, expect, it } from "vitest";
import { FakeGenerationGateway, FakeJudgmentGateway } from "@jevitate/ai-core";
import {
  ANSWER_FITS_QUESTION,
  NO_ANSWER_REASON,
  ObservedPages,
  answerNotFoundReason,
  controlFields,
  errorPageReason,
  goalAsksForReply,
  groundAnswer,
  headingHint,
  pagesContext,
  quoteIsOnlyControlNames,
  reportAnswer,
} from "./answer.js";

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

describe("goalAsksForReply (#200) — code-side, conservative", () => {
  it.each([
    "Ask the assistant how to export my data, wait for its reply, and report the reply.",
    "Send the chatbot a greeting and report its response.",
    "Tell the bot your plan and find out what it replies.",
    "Ask the AI copilot about pricing and report what it responds.",
    "Report the assistant's answer to 'how do I reset my password?'",
  ])("a goal about a reply: %s", (g) => expect(goalAsksForReply(g)).toBe(true));
  it.each([
    "Find out which plan you are on and how many credits you have left.",
    "Find out the average API response time shown on the status page.",
    "Answer the onboarding survey and submit it.",
    "Reply-to address: find out what it is set to in Settings.",
  ])("not a goal about a reply: %s", (g) => expect(goalAsksForReply(g)).toBe(false));
});

describe("#207 — a form control's current value grounds an answer, recorded as such", () => {
  const profile = [
    {
      url: "http://app.test/demo/profile",
      text: "Profile\nDisplay name\nEmail\nBio\nSave",
      fields: [
        { label: "Display name", value: "Ada Lovelace" },
        { label: "Email", value: "ada@example.test" },
      ],
    },
  ];

  it("accepts a quote of a control's value — evidence source control-value, naming the control", () => {
    const v = groundAnswer(
      { answer: "The saved email is ada@example.test", claims: [{ claim: "The saved email is ada@example.test", quote: "ada@example.test" }] },
      profile,
    );
    expect(v.accept).toBe(true);
    expect(v.answer?.evidence[0]).toMatchObject({ grounded: true, source: "control-value", control: "Email", url: "http://app.test/demo/profile" });
  });

  it("accepts the value as the generator saw it (`Email: …`) or as a control summary shows it (`value=\"…\"`)", () => {
    for (const quote of ["Email: ada@example.test", 'value="ada@example.test"']) {
      const v = groundAnswer({ answer: "ada@example.test", claims: [{ claim: "The email is ada@example.test", quote }] }, profile);
      expect(v.accept, quote).toBe(true);
      expect(v.answer?.evidence[0]?.source).toBe("control-value");
    }
  });

  it("page text still grounds as page text", () => {
    const v = groundAnswer({ answer: "A profile page", claims: [{ claim: "the page is the Profile", quote: "Profile" }] }, profile);
    expect(v.accept).toBe(true);
    expect(v.answer?.evidence[0]?.source).toBe("page-text");
  });

  it("rejects a value no control holds, and a quote of only a control's label", () => {
    const other = groundAnswer({ answer: "bob@example.test", claims: [{ claim: "The email is bob@example.test", quote: "bob@example.test" }] }, profile);
    expect(other.accept).toBe(false);
    expect(!other.accept && other.reason).toMatch(/quote not found on any observed page/);
    const labelOnly = groundAnswer(
      { answer: "It is set", claims: [{ claim: "Display name is set", quote: "Display name:" }] },
      [{ url: "http://app.test/p", text: "Settings", fields: [{ label: "Display name", value: "Ada" }] }],
    );
    expect(labelOnly.accept).toBe(false);
  });

  it("figures in a control-value claim must be in the value", () => {
    const pages = [{ url: "http://app.test/s", text: "Settings", fields: [{ label: "Seats", value: "12" }] }];
    expect(groundAnswer({ answer: "12 seats", claims: [{ claim: "12 seats", quote: "12" }] }, pages).accept).toBe(false); // too short a quote
    expect(groundAnswer({ answer: "12 seats", claims: [{ claim: "12 seats", quote: "Seats: 12" }] }, pages).accept).toBe(true);
    expect(groundAnswer({ answer: "15 seats", claims: [{ claim: "15 seats", quote: "Seats: 12" }] }, pages).accept).toBe(false);
  });

  it("ObservedPages keeps controls' values redacted; pagesContext shows them as FORM FIELD VALUES", () => {
    const o = new ObservedPages(["ada@example.test"]);
    o.add("http://app.test/p", "", [{ label: "Email", value: "ada@example.test" }]);
    o.add("http://app.test/q", "Q", [{ label: "Name", value: "Ada" }]);
    const ps = o.pages();
    expect(ps).toHaveLength(2); // a page with no visible text but a field value is still observed
    expect(JSON.stringify(ps)).not.toContain("ada@example.test");
    expect(pagesContext(ps)).toContain("FORM FIELD VALUES:\nName: Ada");
  });

  it("controlFields keeps value-bearing controls only (never a button's label-value, never an empty value)", () => {
    expect(
      controlFields([
        { name: "Email", role: "textbox", tag: "input", value: "ada@example.test" },
        { name: "Bio", role: "textbox", tag: "textarea", value: "" },
        { name: "Save", role: "button", tag: "input", value: "Save" },
        { name: "Password", role: "textbox", tag: "input" },
      ]),
    ).toEqual([{ label: "Email", value: "ada@example.test" }]);
  });
});

describe("#207 — no answer", () => {
  it("an answer that only says there is none ('null') is no answer, not an uncited one", () => {
    for (const answer of ["null", "None", "unknown", "not found."]) {
      const v = groundAnswer({ answer, claims: [] }, pages);
      expect(!v.accept && v.reason, answer).toBe(NO_ANSWER_REASON);
    }
  });

  it("the end reason names the pages seen, first seen first, deduped and bounded", () => {
    const o = new ObservedPages();
    o.add("http://app.test/packs", "Packs");
    o.add("http://app.test/pricing?tier=pro", "Pricing");
    o.add("http://app.test/packs", "Packs, scrolled");
    expect(answerNotFoundReason(o.pages())).toBe("answer not found (pages seen: /packs, /pricing?tier=pro)");
    const many = new ObservedPages();
    for (let i = 0; i < 10; i++) many.add(`http://app.test/p${i}`, `page ${i}`);
    expect(answerNotFoundReason(many.pages())).toMatch(/^answer not found \(pages seen: \/p0, .*\/p7, \+2 more\)$/);
    expect(answerNotFoundReason([])).toBe("answer not found (no page text was observed)");
  });
});

describe("#216 — the heading hint for a null answer", () => {
  it("keeps a page's h1 and <title> (redacted, whitespace folded) and hints them; none → no hint", () => {
    const observed = new ObservedPages(["s3cr3t-token"]);
    observed.add("http://app.test/items/1", "Tenant B roadmap\nOwner: b", [], { heading: "  Tenant B\n roadmap ", title: "Item s3cr3t-token" });
    const [page] = observed.pages();
    expect(page?.heading).toBe("Tenant B roadmap");
    expect(page?.title).not.toContain("s3cr3t-token");
    expect(headingHint(page)).toContain('main heading is "Tenant B roadmap"');
    expect(headingHint({ url: "http://app.test/", text: "x" })).toBeNull();
    expect(headingHint(undefined)).toBeNull();
  });
});

describe("#223 — on the page is not the same as answering", () => {
  const list = { url: "http://app.test/items", text: "Items\nNo items yet.\nTitle\nCreate item", heading: "Items", controls: ["Title", "Create item"] };
  const title = "Find out the title of this item";

  it("a quote made only of controls' names is rejected as no answer — unless the goal asks about controls", () => {
    for (const quote of ["Create item", "Title Create item", "“Create item.”"]) {
      const v = groundAnswer({ answer: "Create item", claims: [{ claim: "The title is Create item", quote }] }, [list], { goal: title });
      expect(v.accept).toBe(false);
      expect(!v.accept && v.notAnswer).toBe(true);
      expect(!v.accept && v.reason).toMatch(/only a control's label/);
    }
    const v = groundAnswer({ answer: "Create item", claims: [{ claim: "The button says Create item", quote: "Create item" }] }, [list], {
      goal: "What does the button on the items page say?",
    });
    expect(v.accept).toBe(true);
  });

  it("content a control repeats (an h1 a breadcrumb link repeats) is still content", () => {
    const page = { url: "http://app.test/items/1", text: "Roadmap review\nRoadmap review\nOwner: b", controls: ["Roadmap review"] };
    expect(quoteIsOnlyControlNames("Roadmap review", page)).toBe(false);
    expect(quoteIsOnlyControlNames("Roadmap review", { ...page, text: "Roadmap review\nOwner: b" })).toBe(true);
  });

  it("an error page (status ≥ 400, or a not-found / 404 heading or title) grounds no answer, and gets no heading hint", () => {
    const notFound = { url: "http://app.test/items/2", text: "Item not found\nBack to items", heading: "Item not found", controls: ["Back to items"] };
    expect(errorPageReason(notFound)).toMatch(/Item not found/);
    expect(errorPageReason({ url: "u", text: "x", status: 404 })).toBe("the page it is on answered HTTP 404");
    expect(errorPageReason({ url: "u", text: "x", title: "404 — Page not found" })).not.toBeNull();
    for (const heading of ["Error log settings", "Top 500 companies", "Errors this week", "Quarterly roadmap"]) {
      expect(errorPageReason({ url: "u", text: "x", heading })).toBeNull();
    }
    const v = groundAnswer({ answer: "Item not found", claims: [{ claim: "The title is Item not found", quote: "Item not found" }] }, [notFound], { goal: title });
    expect(!v.accept && v.notAnswer).toBe(true);
    expect(headingHint(notFound)).toBeNull();
    // A goal about the error itself may quote it.
    expect(groundAnswer({ answer: "Item not found", claims: [{ claim: "The error says Item not found", quote: "Item not found" }] }, [notFound], { goal: "What error does the page show?" }).accept).toBe(true);
  });

  it("a textarea / contenteditable value quoted as 'Label: value' grounds despite the value's own trailing full stop", () => {
    const profile = { url: "http://app.test/profile", text: "Profile\nBio", fields: [{ label: "Bio", value: "Loves hiking, tea, and analytical engines." }] };
    const v = groundAnswer(
      { answer: "Loves hiking, tea, and analytical engines.", claims: [{ claim: "The current bio text on the profile is 'Loves hiking, tea, and analytical engines.'", quote: "Bio: Loves hiking, tea, and analytical engines." }] },
      [profile],
      { goal: "what is the current bio text on the profile?" },
    );
    expect(v.accept).toBe(true);
    expect(v.accept && v.answer.evidence[0]).toMatchObject({ source: "control-value", control: "Bio" });
  });

  it("Jev can veto a grounded answer, never approve an ungrounded one; an unusable judgment leaves code's verdict", async () => {
    const page = { url: "http://app.test/items/1", text: "Roadmap review\nOwner: tenant b", heading: "Roadmap review" };
    const gen = new FakeGenerationGateway({ "goal.answer": { answer: "tenant b", claims: [{ claim: "The owner is tenant b", quote: "Owner: tenant b" }] } });
    const input = { goal: "Find out who owns this item", url: page.url, pages: [page], history: [] };
    const no = new FakeJudgmentGateway({ [ANSWER_FITS_QUESTION]: { kind: "noul", value: false, probability: 0.05 } });
    const vetoed = await reportAnswer(gen, { ...input, judge: no });
    expect(!vetoed.accept && vetoed.notAnswer).toBe(true);
    const yes = new FakeJudgmentGateway({ [ANSWER_FITS_QUESTION]: { kind: "noul", value: true, probability: 0.99 } });
    expect((await reportAnswer(gen, { ...input, judge: yes })).accept).toBe(true);
    expect((await reportAnswer(gen, { ...input, judge: new FakeJudgmentGateway({}) })).accept).toBe(true); // throws → no veto
    const bad = new FakeGenerationGateway({ "goal.answer": { answer: "tenant c", claims: [{ claim: "The owner is tenant c", quote: "Owner: tenant c" }] } });
    expect((await reportAnswer(bad, { ...input, judge: yes })).accept).toBe(false);
  });
});
