import { expect, test } from "vitest";
import { hello } from "./index.js";

test("workspace builds and tests run", () => {
  expect(hello()).toBe("jevitate");
});
