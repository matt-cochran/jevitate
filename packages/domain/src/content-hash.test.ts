import { expect, test } from "vitest";
import { contentHash } from "./content-hash.js";

test("contentHash is key-order independent and content sensitive", () => {
  expect(contentHash({ a: 1, b: 2 })).toBe(contentHash({ b: 2, a: 1 }));
  expect(contentHash({ body: "hi" })).not.toBe(contentHash({ body: "hello" }));
});
