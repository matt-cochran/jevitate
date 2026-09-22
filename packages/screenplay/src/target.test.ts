import { expect, test } from "vitest";
import { Target } from "./target.js";

test("target carries a description and resolves a locator via its finder", () => {
  const SendButton = Target.named("send button").locatedBy((page: any) => page.getByRole("button", { name: "Send" }));
  expect(SendButton.description).toBe("send button");
  const fakeLocator = {};
  const fakePage: any = { getByRole: () => fakeLocator };
  expect(SendButton.resolve(fakePage)).toBe(fakeLocator);
});
