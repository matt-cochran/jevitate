import { describe, it, expect } from "vitest";
import {
  contentFreeTurn,
  goalCallToAction,
  lastQuestion,
  newPageText,
  newTurnText,
  repetitiveTurns,
  turnSimilarity,
} from "./conversation.js";
import type { Control } from "./snapshot.js";

/** User turns recorded in Preveti g-J2-real (#122, build 147b50b): acknowledgements, never answers. */
const RECORDED_ACKS = [
  "That makes sense. I'll start compiling that data and get back to you with what I find.",
  "I appreciate your insights on the data pull. I'll prioritize getting that information together.",
  "Let's focus on pulling the cancellation data first, then we can look at pricing.",
];

describe("stuck conversations (#122)", () => {
  it("the recorded acknowledgements are content-free and make the conversation stuck", () => {
    for (const m of RECORDED_ACKS) expect(contentFreeTurn(m)).toBe(true);
    expect(repetitiveTurns(["Customers cancel after month one; I want to know why.", ...RECORDED_ACKS])).toBe(true);
  });

  it("near-identical turns are stuck too; concrete answers are not", () => {
    const same = [
      "I'll pull the cancellation records and pricing details for you",
      "I'll pull the cancellation records and the pricing details",
      "I will pull cancellation records and pricing details today",
    ];
    expect(turnSimilarity(same[0]!, same[1]!)).toBeGreaterThan(0.6);
    expect(repetitiveTurns(same)).toBe(true);
    const answers = [
      "Dana owns the extract; she can have it by Friday.",
      "The price change went live on March 3.",
      "Let's go with option B: survey churned customers.",
    ];
    for (const m of answers) expect(contentFreeTurn(m)).toBe(false);
    expect(repetitiveTurns(answers)).toBe(false);
    expect(repetitiveTurns([...RECORDED_ACKS.slice(0, 2), answers[0]!])).toBe(false);
    expect(repetitiveTurns(RECORDED_ACKS.slice(0, 2))).toBe(false);
  });

  it("extracts the assistant's last question", () => {
    expect(lastQuestion("Thanks. Who owns the data extract? And by what date can you have it?")).toBe("And by what date can you have it?");
    expect(lastQuestion("Noted. I'll draft the bet.")).toBeNull();
    expect(lastQuestion(null)).toBeNull();
  });

  it("finds the page's goal call to action (arrow-marked first)", () => {
    const c = (index: number, name: string, role = "button"): Control =>
      ({ index, name, role, tag: role === "link" ? "a" : "button", enabled: true, inputType: null, summary: name, descriptor: {} }) as unknown as Control;
    const controls = [c(0, "Send"), c(1, "Settings", "link"), c(2, "Develop & vet a candidate bet →")];
    const goal = "Talk it through with Preveti until you have a concrete bet saved that you could go on to test.";
    expect(goalCallToAction(controls, goal)?.name).toBe("Develop & vet a candidate bet →");
    expect(goalCallToAction([c(0, "Send"), c(1, "Save the bet")], goal)?.name).toBe("Save the bet");
    expect(goalCallToAction([c(0, "Send")], goal)).toBeNull();
  });
});

describe("reply.text is the new assistant turn only (#122)", () => {
  const SIDEBAR_BEFORE = "Inquiries\nWhy do customers churn?\nPricing questions";
  const baseline = `${SIDEBAR_BEFORE}\nPreveti\nTell me what is going on.\nType a reply`;
  const sent = "Customers keep cancelling after their first month.";

  it("a sidebar that re-rendered new titles is not part of the reply", () => {
    const current =
      "Inquiries\nCustomers cancelling after month one\nWhy do customers churn?\nPricing questions\nPreveti\nTell me what is going on.\n" +
      `${sent}\nThat is a common pattern. When did the price change take effect?\nType a reply`;
    expect(newPageText(baseline, current, sent)).toContain("Customers cancelling after month one");
    expect(newTurnText(baseline, current, sent)).toBe("That is a common pattern. When did the price change take effect?");
  });

  it("nothing after the echoed message = no reply yet (even when other text changed)", () => {
    const current = `Inquiries\nCustomers cancelling after month one\nWhy do customers churn?\nPricing questions\nPreveti\nTell me what is going on.\n${sent}\nType a reply`;
    expect(newTurnText(baseline, current, sent)).toBe("");
  });

  it("a multi-line turn is kept whole; busy text inside it is dropped", () => {
    const current = `${SIDEBAR_BEFORE}\nPreveti\nTell me what is going on.\n${sent}\nThinking…\nGood question.\nWho owns the extract?\nType a reply`;
    expect(newTurnText(baseline, current, sent)).toBe("Good question.\nWho owns the extract?");
  });

  it("without an echo of the message, every new line still counts", () => {
    const current = `${baseline}\nA reply that does not echo the message.`;
    expect(newTurnText(baseline, current, sent)).toBe("A reply that does not echo the message.");
  });
});
