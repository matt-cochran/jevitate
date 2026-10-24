import { expect, test } from "vitest";
import { canonicalJson, compareUtf16CodeUnits, contentHash, sha256 } from "./content-hash.js";

test("contentHash is key-order independent and content sensitive", () => {
  expect(contentHash({ a: 1, b: 2 })).toBe(contentHash({ b: 2, a: 1 }));
  expect(contentHash({ body: "hi" })).not.toBe(contentHash({ body: "hello" }));
  // Existing ASCII approvals remain stable when moving away from localeCompare.
  expect(contentHash({ id: "review-work", trigger: "work is ready", motivation: "review it", outcome: "ship with confidence", personas: ["owner"] }))
    .toBe("2d15af87ec10aa0aad33dbc79a20ae761f35eff0ba4db3f099b43c91303463a6");
});

test("canonical JSON orders Unicode keys by unsigned UTF-16 code units", () => {
  expect(canonicalJson({ z: 1, "ä": 2, a: 3, "Å": 4 })).toBe('{"a":3,"z":1,"Å":4,"ä":2}');
  // U+10000 starts with the high surrogate D800, so it sorts before BMP private-use U+E000.
  expect(canonicalJson({ "\uE000": 1, "𐀀": 2, "e\u0301": 3, "é": 4 })).toBe('{"é":3,"é":4,"𐀀":2,"":1}');
  expect(compareUtf16CodeUnits("a", "a\u0000")).toBeLessThan(0);
  expect(compareUtf16CodeUnits("𐀀", "\uE000")).toBeLessThan(0);
});

test("sha256 hashes UTF-8 text to lowercase hex", () => {
  expect(sha256("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
});
