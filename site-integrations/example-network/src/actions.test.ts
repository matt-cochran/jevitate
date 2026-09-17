import { expect, test } from "vitest";
import { SessionStatus, InboxList, ThreadGet } from "./actions.js";

test("action metadata and input schemas are correct", () => {
  expect(SessionStatus.id).toBe("session.status");
  expect(InboxList.id).toBe("inbox.list");
  expect(InboxList.input.parse({}).limit).toBe(20);
  expect(() => InboxList.input.parse({ limit: 0 })).toThrow();
  expect(ThreadGet.id).toBe("thread.get");
  expect(() => ThreadGet.input.parse({})).toThrow();
});
