import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";

/** No recorded fixture holds a secret or a credential-like value: evidence is value-free by construction, and this keeps the fixtures so. */

const dir = new URL("../fixtures/", import.meta.url);
const files = readdirSync(dir).filter((f) => f.endsWith(".json"));

const SECRET_SHAPES: readonly [string, RegExp][] = [
  ["a planted marker, bearer token, JWT or query string", /MARKER_|Bearer |eyJ|\?[a-z]+=/],
  ["a credential-looking key with a string value", /"(?:password|passwd|apikey|api_key|secret|token|authorization|cookie)"\s*:\s*"[^"]+"/i],
  ["a provider key", /\b(?:sk|pk|ghp|gho|xox[bap])[-_][A-Za-z0-9_-]{16,}/],
  ["an email address", /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/],
];

describe("fixture secret scan", () => {
  it("scans something", () => expect(files.length).toBeGreaterThan(0));

  it.each(SECRET_SHAPES)("no fixture holds %s", (_what, re) => {
    expect(files.filter((f) => re.test(readFileSync(new URL(f, dir), "utf8")))).toEqual([]);
  });
});
