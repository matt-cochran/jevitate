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

  it("a count word in a compound or qualifier phrase lists no items (#184)", () => {
    for (const goal of [
      "Sign in as d3@test.allumata.dev with the bound password, then complete the two-factor authentication step with the code from the authenticator.",
      "Set up two-factor authentication",
      "Enable 2FA on the account",
      "Enter the one-time code",
      "Complete the second factor",
      "Connect a third-party integration",
      "Finish the 2-step verification",
      "Retry the login each time it fails",
    ]) {
      expect(goalListsSeveral(goal), goal).toBe(false);
    }
    for (const goal of ["Create two interview links", "Add both customers", "Add 3 contacts", "Invite dana@example.com and lee@example.com", "Add another address"]) {
      expect(goalListsSeveral(goal), goal).toBe(true);
    }
  });

  it("FieldValueLog: a reload undoes the last submit — retyping its value is a retry (#184)", () => {
    const log = new FieldValueLog();
    log.typed("Email", "dana@example.com");
    log.submitted();
    log.typed("Email", "lee@example.com");
    log.submitted();
    log.reloaded();
    expect(log.used("Email")).toEqual(["dana@example.com"]);
    log.reloaded();
    expect(log.used("Email")).toEqual(["dana@example.com"]);
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

describe("fill — never the field's own label; `exactly:` literals typed verbatim (#185)", () => {
  const M05_GOAL =
    'Switch the editor task to "Edit". In the FIRST block, replace its text with exactly: Dogfood3 edit marker kept after reload. Then click that block\'s "Save block" button and wait for it to finish saving.';

  it.each([
    ["the label itself", "Edit block text", TEXTAREA, "Edit block text"],
    ["the label minus its imperative", "Edit block text", TEXTAREA, "block text"],
    ["a placeholder-style label", "Enter your name", TEXT, "Enter your name"],
    ["the label with a trailing ellipsis", "Write a note…", TEXTAREA, "write a note"],
  ])("rejects %s", (_what, label, field, value) => {
    expect(checkFieldValue(value, field, label, "Update the note")).toMatch(/field's own label/);
  });

  it("accepts a value the goal quotes even when it equals the label", () => {
    expect(checkFieldValue("Block text", TEXTAREA, "Block text", 'Type "Block text" into the box')).toBeNull();
  });

  it("the `exactly:` literal is not a goal echo, and the pre-pass types it without the model", async () => {
    expect(echoesGoal("Dogfood3 edit marker kept after reload", M05_GOAL)).toBeNull();
    const { gen, inputs } = valueGen("Edit block text");
    const helper = new FillHelper(gen);
    const r = await helper.valueFor({ fieldLabel: "Edit block text", goal: M05_GOAL, visibleContext: "", field: TEXTAREA });
    expect(r).toEqual({ text: "Dogfood3 edit marker kept after reload", source: "goal" });
    expect(inputs).toHaveLength(0);
  });

  it("a model value that is the field's label is rejected, never typed", async () => {
    const { gen } = valueGen("Edit block text");
    const r = await new FillHelper(gen).valueFor({ fieldLabel: "Edit block text", goal: "Rewrite the first block", visibleContext: "", field: TEXTAREA });
    expect(r.text).toBeNull();
    expect(r.rejected).toMatch(/field's own label/);
  });

  it("the `exactly:` literal never fills a typed input (the caller cannot tell which field it is for)", async () => {
    const { gen, inputs } = valueGen("Dana Ruiz");
    await new FillHelper(gen).valueFor({ fieldLabel: "Participant name", goal: M05_GOAL, visibleContext: "", field: TEXT });
    expect(inputs).toHaveLength(1);
  });

  it("the prompt forbids typing the label", () => {
    expect(FORM_VALUE_INSTRUCTIONS).toMatch(/NEVER the field's own label/);
  });
});

describe("fill — a passage the goal quotes is typed verbatim, line breaks and all (#281)", () => {
  const PASSAGE = "Hi team,\n\nClick here to learn more about reminders and how they can help you stay on track.";
  const GOAL = `Create a reminder note. Import this text exactly as written: "${PASSAGE}" and save it.`;

  it("the pre-pass types the quoted passage into a textarea without the model", async () => {
    const { gen, inputs } = valueGen("Discover more about how reminders can assist you.");
    const r = await new FillHelper(gen).valueFor({ fieldLabel: "Reminder text", goal: GOAL, visibleContext: "", field: TEXTAREA });
    expect(r).toEqual({ text: PASSAGE, source: "goal" });
    expect(inputs).toHaveLength(0);
  });

  it("never for a single-line input, a short quoted name, or a goal quoting two passages", async () => {
    const { gen, inputs } = valueGen("Dana Ruiz");
    await new FillHelper(gen).valueFor({ fieldLabel: "Title", goal: GOAL, visibleContext: "", field: TEXT });
    await new FillHelper(gen).valueFor({ fieldLabel: "Notes", goal: 'Add a bet called "Raise Pro to $149" and save it.', visibleContext: "", field: TEXTAREA });
    await new FillHelper(gen).valueFor({
      fieldLabel: "Notes",
      goal: 'Type "the first long passage of six words here" then type "a second long passage of six words"',
      visibleContext: "",
      field: TEXTAREA,
    });
    expect(inputs).toHaveLength(3);
  });
});

describe("fill — the goal's instruction is never a value to enter (#338)", () => {
  const GOAL = "Add an answer to the knowledge base and test it with a sample question.";

  it.each([
    ["a clause of the goal", "add an answer and test it"],
    ["the test instruction", "Test it with a sample question"],
    ["a near-copy joined with 'then'", "Add an answer to the knowledge base, then test it"],
  ])("rejects %s with a reason the model can act on", (_what, value) => {
    expect(checkFieldValue(value, TEXTAREA, "Answer", GOAL)).toMatch(/that is the goal's instruction, not a value to enter/);
  });

  it("rejects it through the helper (never typed, never cached)", async () => {
    const { gen } = valueGen("Test it with a sample question");
    const r = await new FillHelper(gen).valueFor({ fieldLabel: "Answer", goal: GOAL, visibleContext: "", field: TEXTAREA });
    expect(r.text).toBeNull();
    expect(r.rejected).toMatch(/goal's instruction/);
  });

  it("a value the goal quotes or gives `exactly` passes (#281)", async () => {
    const quoted = 'Add an answer "Test it with a sample question first" and save it.';
    expect(checkFieldValue("Test it with a sample question first", TEXTAREA, "Answer", quoted)).toBeNull();
    const exactly = "Set the note to exactly: check the logs before every deploy.";
    expect(checkFieldValue("check the logs before every deploy", TEXTAREA, "Note", exactly)).toBeNull();
    const { gen, inputs } = valueGen("ignored");
    const r = await new FillHelper(gen).valueFor({ fieldLabel: "Answer", goal: quoted, visibleContext: "", field: TEXTAREA });
    expect(r).toEqual({ text: "Test it with a sample question first", source: "goal" });
    expect(inputs).toHaveLength(0);
  });

  it("short values and values that merely share words pass", () => {
    expect(checkFieldValue("Test answer", TEXT, "Title", GOAL)).toBeNull();
    expect(checkFieldValue("Add an answer", TEXT, "Title", GOAL)).toBeNull();
    expect(checkFieldValue("Refunds take five business days to reach your card.", TEXTAREA, "Answer", GOAL)).toBeNull();
    expect(checkFieldValue("How long do refunds take?", TEXT, "Sample question", GOAL)).toBeNull();
    expect(checkFieldValue("A sample answer for the knowledge base", TEXTAREA, "Answer", GOAL)).toBeNull();
  });

  it("a run the goal introduces as a value (titled / saying / a colon) passes; prose without an instruction verb passes", () => {
    expect(checkFieldValue("Update the pricing page copy", TEXT, "Title", "Create a task titled update the pricing page copy and save it")).toBeNull();
    expect(checkFieldValue("check the logs before deploying", TEXT, "Note", "Post a note saying check the logs before deploying")).toBeNull();
    expect(checkFieldValue("review the Q3 roadmap draft", TEXT, "Title", "Add a todo: review the Q3 roadmap draft")).toBeNull();
    expect(checkFieldValue("the meeting moved to Friday", TEXT, "Message", "Write a note that the meeting moved to Friday")).toBeNull();
  });
});

describe("fill — a value built from what the goal dictates is not an echo (#371)", () => {
  // Recorded (#371, 0.5.0): every answer was refused "it restates the goal (83% of its words are the goal's)".
  const BARBER_GOAL =
    "Start a new site for a barber shop, choose that they don't have a website, answer any remaining question with a short description of the barber shop (classic cuts, hot-towel shaves, walk-ins welcome), then click Prepare design directions and wait for the design directions to appear.";
  const BARBER_ANSWER = "Classic barber shop offering classic cuts, hot-towel shaves, and walk-ins welcome for everyone.";

  it("the barber-shop answer passes the echo and instruction checks, and is typed", async () => {
    expect(echoesGoal(BARBER_ANSWER, BARBER_GOAL)).toBeNull();
    expect(checkFieldValue(BARBER_ANSWER, TEXT, "Your answer", BARBER_GOAL)).toBeNull();
    const { gen } = valueGen(BARBER_ANSWER);
    const r = await new FillHelper(gen).valueFor({ fieldLabel: "Your answer", goal: BARBER_GOAL, visibleContext: "", field: TEXT });
    expect(r).toEqual({ text: BARBER_ANSWER, source: "model" });
  });

  it("the issue's bakery repro, and the other value lead-ins (describing / saying / about), pass", () => {
    const bakery = "type a short description of a bakery (sourdough bread, morning buns, custom cakes) into Your answer and send it";
    expect(checkFieldValue("A neighbourhood bakery with sourdough bread, morning buns and custom cakes made to order.", TEXT, "Your answer", bakery)).toBeNull();
    const describing = "Fill in the bio describing a family-run bakery that bakes sourdough bread and morning buns every day, then save it";
    expect(checkFieldValue("A family-run bakery that bakes sourdough bread and morning buns every day.", TEXTAREA, "Bio", describing)).toBeNull();
    const about = "Post a message about the new sourdough bread and the morning buns we bake daily, then close the chat";
    expect(checkFieldValue("We now bake new sourdough bread and morning buns daily!", TEXTAREA, "Message", about)).toBeNull();
  });

  it("copying the goal's instruction prose is still refused, beside a value span", () => {
    expect(checkFieldValue("answer any remaining question with a short description", TEXTAREA, "Your answer", BARBER_GOAL)).toMatch(
      /echoes the goal|goal's instruction/,
    );
    expect(checkFieldValue("then click Prepare design directions and wait for the design directions", TEXTAREA, "Your answer", BARBER_GOAL)).toMatch(
      /echoes the goal|goal's instruction/,
    );
    expect(checkFieldValue(BARBER_GOAL, TEXTAREA, "Your answer", BARBER_GOAL)).toMatch(/echoes the goal/);
    // An `about` span ends at the next instruction: "test it …" after it is still the goal's instruction (#338).
    const faq = "Add an answer about refund timing and test it with a sample question.";
    expect(checkFieldValue("Test it with a sample question", TEXTAREA, "Answer", faq)).toMatch(/goal's instruction/);
    expect(checkFieldValue("Refunds reach your card within five business days.", TEXTAREA, "Answer", faq)).toBeNull();
  });
});

describe("fill — a repeat is refused only into the same live field (#366)", () => {
  const SUSPEND_GOAL =
    "Suspend the agency (type SUSPEND and a reason), check it shows Suspended, then Reinstate it (type REINSTATE and a reason), then do the same for the second agency.";
  const confirmAsk = (helper: FillHelper, log: FieldValueLog, label: string, prompt = "") =>
    helper.valueFor({
      fieldLabel: label,
      goal: SUSPEND_GOAL,
      visibleContext: "",
      field: TEXT,
      alreadyUsed: log.used(label),
      liveUsed: log.liveUsed(label),
      prompt,
    });

  it("REINSTATE typed twice into a remounted confirm dialog's empty field passes", async () => {
    expect(goalListsSeveral(SUSPEND_GOAL)).toBe(true);
    const log = new FieldValueLog();
    const label = "Confirmation";
    log.observe([{ label, value: "" }]);
    log.typed(label, "REINSTATE");
    log.submitted();
    log.observe([]); // the dialog closed
    log.observe([{ label, value: null }]); // reopened: a new, empty field
    expect(log.used(label)).toEqual(["REINSTATE"]);
    expect(log.liveUsed(label)).toEqual([]);
    const { gen } = valueGen("REINSTATE");
    const r = await confirmAsk(new FillHelper(gen), log, label);
    expect(r).toEqual({ text: "REINSTATE", source: "model" });
  });

  it("a literal the field's label or prompt asks for is exempt, even into the same live field", async () => {
    const log = new FieldValueLog();
    for (const [label, prompt] of [
      ["Type REINSTATE to confirm", ""],
      ["Confirmation", 'alertdialog "Reinstate agency"\nTo confirm, type "REINSTATE" below.'],
      ["Confirmation", "Enter REINSTATE"],
    ] as const) {
      log.typed(label, "REINSTATE");
      log.submitted();
      const { gen } = valueGen("REINSTATE");
      const r = await confirmAsk(new FillHelper(gen), log, label, prompt);
      expect(r.text).toBe("REINSTATE");
    }
  });

  it("a true repeat into the same live field is still refused", async () => {
    const log = new FieldValueLog();
    log.observe([{ label: "Name", value: "" }]);
    log.typed("Name", "Dana Ruiz");
    log.submitted();
    log.observe([{ label: "Name", value: "" }]); // the form stayed on the page (cleared, never left)
    expect(log.liveUsed("Name")).toEqual(["Dana Ruiz"]);
    const { gen } = valueGen("Dana Ruiz");
    const r = await new FillHelper(gen).valueFor({
      fieldLabel: "Name",
      goal: "Add two customers as private participant contacts.",
      visibleContext: "",
      field: TEXT,
      alreadyUsed: log.used("Name"),
      liveUsed: log.liveUsed("Name"),
      prompt: "Type a name for the participant",
    });
    expect(r.text).toBeNull();
    expect(r.rejected).toMatch(/repeats "Dana Ruiz", already submitted into this field/);
  });

  it("a field back with its old value is the same instance; a goal-listed item is refused again while the next is unused", async () => {
    const log = new FieldValueLog();
    log.observe([{ label: "Name", value: "" }]);
    log.typed("Name", "Dana Ruiz");
    log.submitted();
    log.observe([]);
    log.observe([{ label: "Name", value: "Dana Ruiz" }]);
    expect(log.liveUsed("Name")).toEqual(["Dana Ruiz"]);
    // Remounted empty, but the goal lists the items for this field and the next is still unused.
    const listed = new FieldValueLog();
    listed.typed("Name", "Dana Ruiz");
    listed.submitted();
    listed.observe([]);
    listed.observe([{ label: "Name", value: "" }]);
    expect(listed.liveUsed("Name")).toEqual([]);
    const { gen } = valueGen("Dana Ruiz");
    const r = await new FillHelper(gen).valueFor({
      fieldLabel: "Name",
      goal: 'Add two customers: Name "Dana Ruiz" and Name "Lee Park".',
      visibleContext: "",
      field: TEXT,
      alreadyUsed: listed.used("Name"),
      liveUsed: listed.liveUsed("Name"),
    });
    // The goal-stated pre-pass already takes the next listed item, without the model.
    expect(r).toEqual({ text: "Lee Park", source: "goal" });
  });
});
