import { describe, it, expect } from "vitest";
import * as sources from "./index.js";

describe("@jevitate/sources scaffold", () => {
  it("exposes a package marker so the barrel resolves", () => {
    expect(sources.PACKAGE_NAME).toBe("@jevitate/sources");
  });
});
