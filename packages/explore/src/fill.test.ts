import { describe, it, expect } from "vitest";
import { FORM_VALUE_INSTRUCTIONS, FakeGenerationGateway, FormValueInput } from "@jevitate/ai-core";
import { FillHelper, SELECT_OPTION_INSTRUCTIONS, checkFieldValue, valueStatedInGoal } from "./index.js";

const base = { goal: "sign in", visibleContext: "login form", history: [] as string[] };

describe("fill — generative text discipline (Task 6, guardrail #3)", () => {
  it("reuses the value while the helper input is identical (one gateway call)", async () => {
    const helper = new FillHelper(new FakeGenerationGateway({ "form.value": { text: "jane" } }));
    const a = await helper.valueFor({ ...base, fieldLabel: "Username" });
    const b = await helper.valueFor({ ...base, fieldLabel: "Username" });
    expect(a.text).toBe("jane");
    expect(b.text).toBe("jane");
    expect(helper.generateCalls).toBe(1); // reused, not regenerated
  });

  it("regenerates when the field/context changes", async () => {
    const helper = new FillHelper(new FakeGenerationGateway());
    await helper.valueFor({ ...base, fieldLabel: "Username" });
    await helper.valueFor({ ...base, fieldLabel: "Email" });
    expect(helper.generateCalls).toBe(2);
  });

  it("discards the reused value after commit() (successful mutation)", async () => {
    const helper = new FillHelper(new FakeGenerationGateway());
    await helper.valueFor({ ...base, fieldLabel: "Username" });
    helper.commit();
    await helper.valueFor({ ...base, fieldLabel: "Username" });
    expect(helper.generateCalls).toBe(2); // cache dropped, so a fresh call
  });

  it("returns { text: null } for a required value the gateway will not supply", async () => {
    const helper = new FillHelper(new FakeGenerationGateway({ "form.value": { text: null } }));
    const r = await helper.valueFor({ ...base, fieldLabel: "SSN" });
    expect(r.text).toBeNull();
  });

  it("never lets a registered secret reach the generation input", async () => {
    let seen = "";
    const gen = {
      async generate(_kind: "form.value", input: unknown) {
        seen = JSON.stringify(input);
        return {
          output: { text: "ok" },
          provenance: { adapter: "fake" as const, model: "fake", promptVersion: "1", latencyMs: 0, responseHash: "h" },
        };
      },
    };
    const helper = new FillHelper(gen as unknown as ConstructorParameters<typeof FillHelper>[0]);
    await helper.valueFor({
      fieldLabel: "Password",
      goal: "sign in as hunter2 holder",
      visibleContext: "the current value is hunter2",
      history: ["typed hunter2"],
      secrets: ["hunter2"],
    });
    expect(seen).not.toContain("hunter2");
  });
});

/** A gateway that returns a canned `form.value` and keeps every input it was sent. */
function capturingGen(text: string | null): { gen: ConstructorParameters<typeof FillHelper>[0]; inputs: Record<string, unknown>[] } {
  const inputs: Record<string, unknown>[] = [];
  const fake = new FakeGenerationGateway({ "form.value": { text } });
  const gen = {
    async generate(kind: "form.value", input: Record<string, unknown>) {
      inputs.push(input);
      return fake.generate(kind, input as never);
    },
  };
  return { gen: gen as unknown as ConstructorParameters<typeof FillHelper>[0], inputs };
}

const TEXT = { tag: "input", inputType: "text" } as const;
const EMAIL = { tag: "input", inputType: "email" } as const;
const URL_FIELD = { tag: "input", inputType: "url" } as const;
const SIGNUP = "Sign up with name Ada Lovelace, email ada@example.com and website URL https://example.com, then submit.";

describe("fill — one field, one value (#71)", () => {
  it("sends the field-scoped instructions and the field's type for a text field", async () => {
    const { gen, inputs } = capturingGen("jane");
    await new FillHelper(gen).valueFor({ ...base, fieldLabel: "Username", field: TEXT });
    expect(inputs).toHaveLength(1);
    expect(inputs[0]!.instructions).toBe(FORM_VALUE_INSTRUCTIONS);
    expect(inputs[0]!.fieldType).toBe("text");
    // The schema default: every adapter sees the brief even when a caller sends none.
    expect(FormValueInput.parse({ fieldLabel: "x", goal: "g", visibleContext: "" }).instructions).toBe(FORM_VALUE_INSTRUCTIONS);
  });

  it("a select keeps its own option instructions", async () => {
    const { gen, inputs } = capturingGen("Red");
    await new FillHelper(gen).valueFor({ ...base, fieldLabel: "Colour", options: ["Red", "Blue"], field: TEXT });
    expect(inputs[0]!.instructions).toBe(SELECT_OPTION_INSTRUCTIONS);
    expect(inputs[0]!.fieldType).toBeUndefined();
  });

  it.each([
    ["a prose essay", "To sign up for a new account, follow these steps:\n1. Enter Name: Ada Lovelace\n2. Enter Email", /multi-line/],
    ["a JSON map of every field", '{"Name":"Ada Lovelace","Email":"ada@example.com","Website URL":"https://example.com"}', /JSON object/],
    ["a JSON object keyed by the field", '{"sourceUrl":"https://jevitate.com"}', /JSON object/],
    ["an over-long single line", `To create a new API key named dogfood-key, ${"click the button and then ".repeat(20)}`, /too long/],
    ["the field's own Label: prefix", "Nickname: ada", /echoes the field's label/],
  ])("rejects %s — never typed, never cached", async (_what, text, reason) => {
    const { gen } = capturingGen(text);
    const helper = new FillHelper(gen);
    const r = await helper.valueFor({ fieldLabel: "Nickname", goal: "pick a nickname", visibleContext: "", field: TEXT });
    expect(r.text).toBeNull();
    expect(r.rejected).toMatch(reason);
    await helper.valueFor({ fieldLabel: "Nickname", goal: "pick a nickname", visibleContext: "", field: TEXT });
    expect(helper.generateCalls).toBe(2);
  });

  it("rejects a malformed value for an email or url input", () => {
    expect(checkFieldValue("the email", EMAIL, "Email")).toBe("not an email address");
    expect(checkFieldValue("Source URL: https://jevitate.com", URL_FIELD, "Source URL")).toMatch(/label/);
    expect(checkFieldValue("jevitate.com", URL_FIELD, "Source URL")).toBe("not an absolute URL");
    expect(checkFieldValue("ada@example.com", EMAIL, "Email")).toBeNull();
    expect(checkFieldValue("line one\nline two", { tag: "textarea", inputType: null }, "Notes")).toBeNull();
  });

  it("takes a value the goal states verbatim for the field, without the model", async () => {
    const { gen, inputs } = capturingGen('{"Name":"x"}');
    const helper = new FillHelper(gen);
    const at = (fieldLabel: string, field: { tag: string; inputType: string | null }, goal = SIGNUP) =>
      helper.valueFor({ fieldLabel, goal, visibleContext: "", field });
    expect(await at("Name", TEXT)).toEqual({ text: "Ada Lovelace", source: "goal" });
    expect((await at("Email", EMAIL)).text).toBe("ada@example.com");
    expect((await at("Website URL", URL_FIELD)).text).toBe("https://example.com");
    expect((await at("Source URL", URL_FIELD, "Source URL: https://jevitate.com . Enter that URL, click Analyze")).text).toBe(
      "https://jevitate.com",
    );
    expect((await at("Name", TEXT, "Create a new API key named dogfood-key and copy it")).text).toBe("dogfood-key");
    expect((await at("Name *", TEXT, "Name field value: Dogfood Tester. Email field value: x@y.z.")).text).toBe("Dogfood Tester");
    expect((await at("Title", TEXT, 'Create a project titled "Docs site" and open it')).text).toBe("Docs site");
    expect(inputs).toHaveLength(0);
  });

  it("falls back to the model when the goal names no literal value, or two", () => {
    expect(valueStatedInGoal("Change the name of the project to something short", "Name", TEXT)).toBeNull();
    expect(valueStatedInGoal("email a@x.io or b@x.io", "Contact", EMAIL)).toBeNull();
    expect(valueStatedInGoal("Log in with password «redacted»", "Password", { tag: "input", inputType: "password" })).toBeNull();
  });
});
