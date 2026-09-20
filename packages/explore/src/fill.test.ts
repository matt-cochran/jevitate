import { describe, it, expect } from "vitest";
import { FakeGenerationGateway } from "@jevitate/ai-core";
import { FillHelper } from "./index.js";

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
