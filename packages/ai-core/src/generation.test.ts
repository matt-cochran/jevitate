import { describe, it, expect } from "vitest";
import { FakeGenerationGateway, type GenerationPort } from "./index.js";

const g: GenerationPort = new FakeGenerationGateway();
const input = { fieldLabel: "email", goal: "log in", visibleContext: "form", history: [] };

describe("FakeGenerationGateway", () => {
  it("is deterministic and content-addresses its output", async () => {
    const a = await g.generate("form.value", input);
    const b = await g.generate("form.value", input);
    expect(a.output).toEqual(b.output);
    expect(a.provenance.responseHash).toBe(b.provenance.responseHash);
    expect(a.provenance.model).toBe("fake");
  });
});
