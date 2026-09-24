import { describe, it, expect } from "vitest";
import { CHAT_REPLY_INSTRUCTIONS, CHAT_REPLY_STUCK_INSTRUCTIONS, FORM_VALUE_INSTRUCTIONS, FakeGenerationGateway } from "@jevitate/ai-core";
import { FieldValueLog, FillHelper, chatReply, checkFieldValue, echoesGoal, fieldKind, goalListsSeveral } from "./index.js";

/** A gateway that returns a canned `form.value` / `chat.reply` and keeps every input it was sent. */
function capturingGen(canned: Record<string, unknown>): { gen: ConstructorParameters<typeof FillHelper>[0]; inputs: Record<string, unknown>[] } {
  const inputs: Record<string, unknown>[] = [];
  const fake = new FakeGenerationGateway(canned);
  const gen = {
    async generate(kind: "form.value", input: Record<string, unknown>) {
      inputs.push(input);
      return fake.generate(kind, input as never);
    },
  };
  return { gen: gen as unknown as ConstructorParameters<typeof FillHelper>[0], inputs };
}
const valueGen = (text: string | null) => capturingGen({ "form.value": { text } });

const TEXT = { tag: "input", inputType: "text" } as const;
const EMAIL = { tag: "input", inputType: "email" } as const;
const SEARCH = { tag: "input", inputType: "search" } as const;
const TEXTAREA = { tag: "textarea", inputType: null } as const;

/** Goals and recorded `form.value` outputs from the #71 reopen (build 147b50b, Preveti round 2). */
const J8A_GOAL =
  "Set up customer interviews about the 'Raise Pro to $149' bet: create two separate interview links, one for each of two customers you want to talk to, and check whether anyone has responded yet.";
const J3_GOAL =
  "Take the 'Raise Pro to $149' bet forward: give it a stakes estimate, record why you are making the call, and move it to testing.";

describe("fill — the goal is never a field's value (#71 reopen)", () => {
  it.each([
    ["a name field given the whole goal (g-J8a)", "Participant name", TEXT, J8A_GOAL, J8A_GOAL],
    ["a search box given the whole goal (g-J8a)", "Find a participant", TEXT, J8A_GOAL, J8A_GOAL],
    ["a rationale given the goal text (g-J3)", "Rationale — why this call", TEXTAREA, J3_GOAL, J3_GOAL],
    [
      "a rationale that copies a run of the goal",
      "Rationale — why this call",
      TEXTAREA,
      J3_GOAL,
      "Because I want to take the Raise Pro to $149 bet forward: give it a stakes estimate.",
    ],
  ])("rejects %s — never typed", async (_what, fieldLabel, field, goal, recorded) => {
    const { gen, inputs } = valueGen(recorded);
    const r = await new FillHelper(gen).valueFor({ fieldLabel, goal, visibleContext: "", field });
    expect(r.text).toBeNull();
    expect(r.rejected).toMatch(/echoes the goal/);
    expect(inputs).toHaveLength(1);
  });

  it("echo rules: equal, a 40+ char run of 5+ goal words, >60% word overlap — a stated or quoted value is not an echo", () => {
    expect(echoesGoal(J8A_GOAL, J8A_GOAL)).toMatch(/goal text/);
    expect(echoesGoal("create two separate interview links, one for each of two customers", J8A_GOAL)).toMatch(/copies the goal/);
    expect(echoesGoal("Customer interviews: set up two links for customers, check whether anyone responded", J8A_GOAL)).toMatch(
      /restates|copies/,
    );
    expect(echoesGoal("Dana Ruiz", J8A_GOAL)).toBeNull();
    expect(echoesGoal("pricing interviews", J8A_GOAL)).toBeNull();
    expect(echoesGoal("Ada Lovelace", "Enter Ada Lovelace")).toBeNull();
    const quoted = 'Create a project titled "Quarterly planning for the whole product org"';
    expect(echoesGoal("Quarterly planning for the whole product org", quoted)).toBeNull();
    expect(echoesGoal("Churn doubled after the last price change, so testing $149 on new signups first limits the risk.", J3_GOAL)).toBeNull();
  });

  it("tells the model the field's kind: name → a name, search → a term, rationale → one sentence", async () => {
    expect(fieldKind("Participant name", TEXT)).toBe("name");
    expect(fieldKind("Find a participant", TEXT)).toBe("search");
    expect(fieldKind("q", SEARCH)).toBe("search");
    expect(fieldKind("Rationale — why this call", TEXTAREA)).toBe("reasoning");
    expect(fieldKind("Title", TEXT)).toBe("title");
    expect(fieldKind("Username", TEXT)).toBeNull();
    const { gen, inputs } = valueGen("Dana Ruiz");
    const r = await new FillHelper(gen).valueFor({ fieldLabel: "Participant name", goal: J8A_GOAL, visibleContext: "", field: TEXT });
    expect(r).toEqual({ text: "Dana Ruiz", source: "model" });
    expect(inputs[0]!.fieldKind).toBe("name");
    expect(FORM_VALUE_INSTRUCTIONS).toMatch(/NEVER the goal/);
    expect(FORM_VALUE_INSTRUCTIONS.length).toBeLessThanOrEqual(1000);
  });

  it("a name or search value of more than a few words is rejected", () => {
    expect(checkFieldValue("Dana Ruiz from the pricing team who wants to talk about churn and pricing", TEXT, "Participant name")).toMatch(
      /too long for a name/,
    );
    expect(checkFieldValue("Dana Ruiz", TEXT, "Participant name")).toBeNull();
  });
});

const TWO = "Add two customers as private participant contacts: Dana Ruiz (dana@example.com) and Lee Park (lee@example.com).";

describe("fill — add-another flows take the next item (#123)", () => {
  it("the model sees the values already submitted into the field, and a repeat is rejected", async () => {
    const { gen, inputs } = valueGen("Dana Ruiz");
    const r = await new FillHelper(gen).valueFor({ fieldLabel: "Name", goal: TWO, visibleContext: "", field: TEXT, alreadyUsed: ["Dana Ruiz"] });
    expect(inputs[0]!.alreadyUsed).toEqual(["Dana Ruiz"]);
    expect(r.text).toBeNull();
    expect(r.rejected).toMatch(/repeats "Dana Ruiz", already submitted/);
  });

  it("the next unused item is accepted; a goal with one item may repeat a value", async () => {
    const next = await new FillHelper(valueGen("Lee Park").gen).valueFor({
      fieldLabel: "Name",
      goal: TWO,
      visibleContext: "",
      field: TEXT,
      alreadyUsed: ["Dana Ruiz"],
    });
    expect(next.text).toBe("Lee Park");
    const single = await new FillHelper(valueGen("Dana Ruiz").gen).valueFor({
      fieldLabel: "Display",
      goal: "Set the display to Dana Ruiz",
      visibleContext: "",
      field: TEXT,
      alreadyUsed: ["Dana Ruiz"],
    });
    expect(single.text).toBe("Dana Ruiz");
  });

  it("a field the goal lists several values for takes them in order, without the model", async () => {
    const { gen, inputs } = valueGen("dana@example.com");
    const helper = new FillHelper(gen);
    expect((await helper.valueFor({ fieldLabel: "Email", goal: TWO, visibleContext: "", field: EMAIL })).text).toBe("dana@example.com");
    const second = await helper.valueFor({ fieldLabel: "Email", goal: TWO, visibleContext: "", field: EMAIL, alreadyUsed: ["dana@example.com"] });
    expect(second.text).toBe("lee@example.com");
    expect(inputs).toHaveLength(0);
    expect(goalListsSeveral(TWO)).toBe(true);
    expect(goalListsSeveral("Sign up as ada@example.com")).toBe(false);
  });

  it("FieldValueLog: a typed value is used only once submitted, keyed by the bare label", () => {
    const log = new FieldValueLog();
    log.typed("Name *", "Dana Ruiz");
    expect(log.used("Name")).toEqual([]);
    log.submitted();
    log.typed("Name", "dana ruiz");
    log.submitted();
    expect(log.used("Name:")).toEqual(["Dana Ruiz"]);
  });
});

describe("chat.reply — answer the question; the stuck brief (#122)", () => {
  it("sends the assistant's question, and the stuck instructions only when stuck", async () => {
    const { gen, inputs } = capturingGen({ "chat.reply": { text: "The price change went live on March 3; Dana owns the extract." } });
    const req = { goal: "g", fieldLabel: "Type a reply", latestReply: "Who owns the extract?", sentMessages: [], maxChars: 280 };
    await chatReply(gen, { ...req, question: "Who owns the extract?" });
    await chatReply(gen, { ...req, question: "Who owns the extract?", stuck: true });
    expect(inputs[0]!.question).toBe("Who owns the extract?");
    expect(inputs[0]!.instructions).toBeUndefined();
    expect(inputs[1]!.instructions).toBe(CHAT_REPLY_STUCK_INSTRUCTIONS);
    expect(CHAT_REPLY_INSTRUCTIONS).toMatch(/Never merely acknowledge/);
    expect(CHAT_REPLY_STUCK_INSTRUCTIONS.length).toBeLessThanOrEqual(1000);
    expect(CHAT_REPLY_INSTRUCTIONS.length).toBeLessThanOrEqual(1000);
  });
});
