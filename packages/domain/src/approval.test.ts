import { expect, test } from "vitest";
import { contentHash, bindingMatches, isExpired, type ApprovalBinding } from "./approval.js";

test("content hash is stable across key order", () => {
  expect(contentHash({ a: 1, b: 2 })).toBe(contentHash({ b: 2, a: 1 }));
});

test("content hash changes when content changes", () => {
  expect(contentHash({ body: "hi" })).not.toBe(contentHash({ body: "hello" }));
});

const b: ApprovalBinding = {
  commandId: "cmd_1", recipientHash: "r", contentHash: "c", actionId: "message.reply",
  actionVersion: "1.0.0", artifactHash: "h", settingsRevision: "s", expiresAt: "2026-09-16T12:00:00Z",
};

test("binding mismatch is detected", () => {
  expect(bindingMatches(b, { ...b, contentHash: "different" })).toBe(false);
  expect(bindingMatches(b, { ...b })).toBe(true);
});

test("expiry is detected", () => {
  expect(isExpired(b, "2026-09-16T12:00:01Z")).toBe(true);
  expect(isExpired(b, "2026-09-16T11:59:59Z")).toBe(false);
});
