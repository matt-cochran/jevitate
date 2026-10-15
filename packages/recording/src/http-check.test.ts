import { describe, expect, it } from "vitest";
import { OutcomeCheckSchema } from "./schema.js";
import { selectJsonValues } from "./json-path.js";

const valid = {
  kind: "http",
  method: "GET",
  url: "http://localhost:8025/api/v1/search?query=to:${email}",
  json: [{ path: "$.messages[*].Subject", op: "includes", value: "Reset your password" }],
};

describe("http outcome check schema (#543)", () => {
  it("accepts a GET with a templated query and a json assertion", () => {
    expect(OutcomeCheckSchema.safeParse(valid).success).toBe(true);
  });

  it("rejects a POST", () => {
    expect(OutcomeCheckSchema.safeParse({ ...valid, method: "POST" }).success).toBe(false);
  });

  it("rejects a placeholder in the origin", () => {
    expect(OutcomeCheckSchema.safeParse({ ...valid, url: "http://${host}/api" }).success).toBe(false);
  });

  it("rejects a relative url", () => {
    expect(OutcomeCheckSchema.safeParse({ ...valid, url: "/api/v1/messages" }).success).toBe(false);
  });

  it("rejects a JSON path the grammar cannot read", () => {
    expect(OutcomeCheckSchema.safeParse({ ...valid, json: [{ path: "$..Subject", op: "exists" }] }).success).toBe(false);
  });

  it("rejects a poll window over 60 seconds", () => {
    expect(OutcomeCheckSchema.safeParse({ ...valid, withinMs: 60_001 }).success).toBe(false);
  });

  it("rejects a check with no assertion", () => {
    expect(OutcomeCheckSchema.safeParse({ kind: "http", method: "GET", url: "http://localhost:8025/api" }).success).toBe(false);
  });

  it("rejects an equals assertion without a value", () => {
    expect(OutcomeCheckSchema.safeParse({ ...valid, json: [{ path: "$.total", op: "equals" }] }).success).toBe(false);
  });
});

describe("selectJsonValues (#543)", () => {
  const doc = { messages: [{ Subject: "a", To: [{ Address: "x@y" }] }, { Subject: "b", To: [{ Address: "z@y" }] }], total: 2 };

  it("fans out over an array with [*]", () => {
    expect(selectJsonValues(doc, "$.messages[*].Subject")).toEqual(["a", "b"]);
  });

  it("fans out through nested arrays", () => {
    expect(selectJsonValues(doc, "$.messages[*].To[*].Address")).toEqual(["x@y", "z@y"]);
  });

  it("selects a single scalar without a fan-out", () => {
    expect(selectJsonValues(doc, "$.total")).toEqual([2]);
  });

  it("returns an empty list for a missing member", () => {
    expect(selectJsonValues(doc, "$.missing[*].Subject")).toEqual([]);
  });
});
