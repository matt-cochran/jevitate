import { expect, test } from "vitest";
import { contentHash, sha256 } from "./content-hash.js";

test("contentHash is key-order independent and content sensitive", () => {
  expect(contentHash({ a: 1, b: 2 })).toBe(contentHash({ b: 2, a: 1 }));
  expect(contentHash({ body: "hi" })).not.toBe(contentHash({ body: "hello" }));
});

test("sha256 hashes UTF-8 text to lowercase hex", () => {
  expect(sha256("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
});
