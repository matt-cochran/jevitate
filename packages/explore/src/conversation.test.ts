import { describe, expect, it } from "vitest";
import {
  GOAL_MET_THRESHOLD,
  UnsubmittedTypeTracker,
  groundDone,
  isReply,
  isSubmitControl,
  newPageText,
  pendingStatusShown,
  sameMessage,
  withoutAuthored,
} from "./conversation.js";
import { capMessage, matchOption } from "./fill.js";
import { sendable } from "./actions.js";

describe("newPageText — what a reply added to the page", () => {
  it("keeps only new lines, dropping the echoed message and busy text", () => {
    const baseline = "Assistant\nHow can I help?\nType a reply";
    const current = "Assistant\nHow can I help?\nI want to cut churn\nThinking…\nWhich plan do they cancel from?\nType a reply";
    expect(newPageText(baseline, current, "I want to cut churn")).toBe("Which plan do they cancel from?");
    expect(newPageText("", "Preparing your conversation…\nWorking...", "")).toBe("");
    // A balance that ticked is not a reply; a genuinely new numeric line still is.
    expect(newPageText("400.00 credits balance\nHi", "399.76 credits balance\nHi", "")).toBe("");
    expect(newPageText("Hi", "Hi\nYou have 3 open questions left", "")).toBe("You have 3 open questions left");
  });

  it("treats a re-rendered existing line as old (multiset difference)", () => {
    expect(newPageText("a\nb", "a\nb\nb", "")).toBe("b");
    expect(newPageText("a\nb", "b\na", "")).toBe("");
  });

  it("a 'waiting for the server' status is pending, never the reply", () => {
    const now = "Hi\nYou · Confirmation pending\nWaiting for the server to confirm your message and return a reply. This may take a few minutes.";
    expect(newPageText("Hi", now, "")).toBe("");
    expect(pendingStatusShown("Hi", now)).toBe(true);
    expect(pendingStatusShown("Hi", "Hi\nWhich plan do they cancel from?")).toBe(false);
  });

  it("a short status chip is not a reply; a sentence is", () => {
    expect(isReply("just now")).toBe(false);
    expect(isReply("Which plan do they cancel from?")).toBe(true);
  });
});

describe("UnsubmittedTypeTracker — the repeated-type anti-pattern", () => {
  it("flags a second type into the same field with no submit in between", () => {
    const t = new UnsubmittedTypeTracker();
    expect(t.wouldRepeat("box")).toBe(false);
    t.typed("box", "Type a reply", "hello");
    expect(t.wouldRepeat("box")).toBe(true);
    expect(t.wouldRepeat("other")).toBe(false);
    expect(t.noteRepeat()).toBe(1);
    expect(t.stuckSignals).toBe(1);
  });

  it("clears on submit/navigation, and forgets a field that left the page", () => {
    const t = new UnsubmittedTypeTracker();
    t.typed("box", "Type a reply", "hello");
    t.submitted();
    expect(t.wouldRepeat("box")).toBe(false);
    t.typed("box", "Type a reply", "again");
    t.typed("gone", "Old field", "x");
    t.retain(new Set(["box"]));
    expect([...t.pending().keys()]).toEqual(["box"]);
    expect(t.pending().get("box")).toEqual({ label: "Type a reply", text: "again", message: false });
  });
});

describe("groundDone — a proposed done is weighed by code", () => {
  it("rejects while typed text was never submitted, whatever the oracle says", () => {
    const v = groundDone({ unsubmitted: ["Type a reply"], successCheck: true });
    expect(v).toEqual({ accept: false, reason: 'typed text in "Type a reply" was never submitted' });
  });

  it("an independent success condition decides when present", () => {
    expect(groundDone({ unsubmitted: [], successCheck: true })).toEqual({
      accept: true,
      outcome: { status: "completed", verifiedBy: "success-condition" },
    });
    expect(groundDone({ unsubmitted: [], successCheck: false })).toMatchObject({ accept: false, reason: /success condition/ });
  });

  it("without an oracle, the advisory goal judgment must clear the threshold (and be available)", () => {
    expect(groundDone({ unsubmitted: [], goalMetProbability: GOAL_MET_THRESHOLD })).toMatchObject({
      accept: true,
      outcome: { status: "completed", verifiedBy: "grounded-judgment" },
    });
    expect(groundDone({ unsubmitted: [], goalMetProbability: 0.4 })).toMatchObject({ accept: false, reason: /not observably achieved/ });
    expect(groundDone({ unsubmitted: [], goalMetProbability: null })).toMatchObject({ accept: false, reason: /could not be judged/ });
    expect(groundDone({ unsubmitted: [] })).toMatchObject({ accept: false });
  });
});

describe("messages and options", () => {
  it("withoutAuthored drops the run's own echoed words from what the goal judgment sees (J-11)", () => {
    const page = "Assistant\nNext steps for Preveti to investigate: pricing\nWhat else?";
    expect(withoutAuthored(page, ["Next steps for Preveti to investigate: pricing"])).toBe("Assistant\nWhat else?");
  });

  it("sameMessage compares normalized text", () => {
    expect(sameMessage("  Hello   there ", "hello there")).toBe(true);
    expect(sameMessage("hello", "hello!")).toBe(false);
  });

  it("capMessage enforces the cap at a sentence or word boundary and strips markdown marks", () => {
    const essay = `## Inquiry\n**Question:** ${"Customers cancel after a month. ".repeat(40)}`;
    const out = capMessage(essay, 120);
    expect(out.length).toBeLessThanOrEqual(120);
    expect(out).not.toMatch(/##|\*\*/);
    expect(out.endsWith(".")).toBe(true);
    expect(capMessage("short one", 120)).toBe("short one");
  });

  it("matchOption accepts only an option the page has", () => {
    const opts = ["Small (< $10k)", "Medium", "Large"];
    expect(matchOption("Medium", opts)).toBe("Medium");
    expect(matchOption("  medium ", opts)).toBe("Medium");
    expect(matchOption("Huge", opts)).toBeNull();
  });

  it("send is offered only on free-text fields; Send-named buttons submit", () => {
    const f = (tag: string, inputType: string | null, name: string) => ({ tag, inputType, role: "textbox", enabled: true, name });
    expect(sendable(f("textarea", null, "Type a reply"))).toBe(true);
    expect(sendable(f("input", "text", "Start a new inquiry"))).toBe(true);
    expect(sendable(f("input", "password", "Type a reply"))).toBe(false);
    expect(sendable(f("input", "date", "Ask by"))).toBe(false);
    // Form fields (dogfood J3: "Rationale (required)", "Your name") are typed, never "sent" as chat.
    expect(sendable(f("textarea", null, "Rationale (required)"))).toBe(false);
    expect(sendable(f("input", "text", "Your name"))).toBe(false);
    expect(isSubmitControl({ role: "button", tag: "button", inputType: null, name: "Send" })).toBe(true);
    expect(isSubmitControl({ role: "button", tag: "button", inputType: null, name: "Close inspector" })).toBe(false);
    expect(isSubmitControl({ role: "link", tag: "a", inputType: null, name: "Send feedback" })).toBe(false);
  });
});
