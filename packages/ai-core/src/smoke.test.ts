import { describe, it, expect } from "vitest";
import { AI_CORE } from "./index.js";

describe("@doit/ai-core scaffold", () => {
  it("is importable via the workspace alias", () => {
    expect(AI_CORE).toBe("ai-core");
  });
});
