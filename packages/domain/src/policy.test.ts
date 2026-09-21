import { expect, test } from "vitest";
import { decide } from "./policy.js";

const base = { isNewContact: false, approvalMode: "writes" as const, newContactsEnabled: false };

test("reads are allowed", () => {
  expect(decide({ ...base, risk: "read" })).toEqual({ kind: "allow" });
});

test("external writes require approval under approvalMode=writes", () => {
  expect(decide({ ...base, risk: "external_write" })).toEqual({ kind: "require_approval" });
});

test("new contact while disabled is denied", () => {
  const d = decide({ ...base, risk: "external_write", isNewContact: true });
  expect(d.kind).toBe("deny");
});

test("approvalMode=all requires approval even for reads", () => {
  expect(decide({ ...base, risk: "read", approvalMode: "all" })).toEqual({ kind: "require_approval" });
});
