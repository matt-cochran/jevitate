import { expect, test } from "vitest";
import { parseFrontmatter } from "./frontmatter.js";

test("parses name/description frontmatter and strips the block from the body", () => {
  const md = "---\nname: jevitate-explore\ndescription: Drives exploration.\n---\nBody text.";
  const parsed = parseFrontmatter(md);
  expect(parsed).toEqual({
    name: "jevitate-explore",
    description: "Drives exploration.",
    body: "Body text.",
  });
});

test("trims a single leading blank line after the closing delimiter", () => {
  const md = "---\nname: n\ndescription: d\n---\n\nFirst paragraph.\n";
  expect(parseFrontmatter(md).body).toBe("First paragraph.\n");
});

test("throws (fail-closed) on a missing closing delimiter rather than treating the whole file as body", () => {
  const md = "---\nname: n\ndescription: d\nBody with no closing fence.";
  expect(() => parseFrontmatter(md)).toThrow(/closing/i);
});

test("throws when name is missing", () => {
  const md = "---\ndescription: d\n---\nBody.";
  expect(() => parseFrontmatter(md)).toThrow(/name/i);
});

test("throws when description is missing", () => {
  const md = "---\nname: n\n---\nBody.";
  expect(() => parseFrontmatter(md)).toThrow(/description/i);
});

test("a description value containing a literal colon parses on the first colon only", () => {
  const md = "---\nname: jevitate-explore\ndescription: Drives jevitate explore: goal-based testing\n---\nBody.";
  const parsed = parseFrontmatter(md);
  expect(parsed.description).toBe("Drives jevitate explore: goal-based testing");
});
