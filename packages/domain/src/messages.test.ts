import { expect, test } from "vitest";
import { NormalizedThreadSchema } from "./messages.js";

test("valid thread parses; missing sourceThreadId rejected", () => {
  const t = { sourceThreadId: "t1", subject: "Hi", messages: [
    { sourceMessageId: "m1", sourceThreadId: "t1", sender: "jane", receivedAt: "2026-09-17T00:00:00Z", text: "hello" },
  ]};
  expect(NormalizedThreadSchema.parse(t).messages).toHaveLength(1);
  expect(() => NormalizedThreadSchema.parse({ subject: "x", messages: [] })).toThrow();
});
