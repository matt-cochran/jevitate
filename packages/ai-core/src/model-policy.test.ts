import { describe, it, expect } from "vitest";
import { filterCatalog, selectModel, NoEligibleModelError } from "./index.js";

const cat = [
  { id: "a/cheap-eu", promptUsdPer1k: 0.1, completionUsdPer1k: 0.1, regions: ["EU"], latencyClass: "fast" as const, capabilities: [] },
  { id: "b/cheap-us", promptUsdPer1k: 0.1, completionUsdPer1k: 0.1, regions: ["US"], latencyClass: "fast" as const, capabilities: [] },
  { id: "c/dear-us",  promptUsdPer1k: 9.0, completionUsdPer1k: 9.0, regions: ["US"], latencyClass: "slow" as const, capabilities: [] },
];
describe("ModelPolicy hard filter + selection", () => {
  it("hard-filters by region and cost BEFORE choosing", () => {
    const c = { requireRegion: "US", maxPromptUsdPer1k: 1, requiredCapabilities: [] };
    expect(filterCatalog(cat, c).map((m) => m.id)).toEqual(["b/cheap-us"]);
    expect(selectModel(cat, c)).toBe("b/cheap-us");
    expect(selectModel(cat, c)).toBe("b/cheap-us"); // cache-stable
  });
  it("fails closed when nothing is eligible", () => {
    expect(() => selectModel(cat, { requireRegion: "APAC", requiredCapabilities: [] })).toThrow(NoEligibleModelError);
  });
  it("ignores a pin that no longer passes the filter", () => {
    const c = { requireRegion: "US", maxPromptUsdPer1k: 1, requiredCapabilities: [], pinnedModelId: "c/dear-us" };
    expect(selectModel(cat, c)).toBe("b/cheap-us");
  });
});
