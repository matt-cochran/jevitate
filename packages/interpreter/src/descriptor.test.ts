import { expect, test, vi } from "vitest";
import type { TargetDescriptor } from "@doit/recording";
import { descriptorToTarget } from "./descriptor.js";

function fakePage() {
  const dummyLocator = {} as any;
  return {
    getByTestId: vi.fn(() => dummyLocator),
    getByRole: vi.fn(() => dummyLocator),
    getByLabel: vi.fn(() => dummyLocator),
    getByText: vi.fn(() => dummyLocator),
    locator: vi.fn(() => dummyLocator),
  };
}

test("testId takes top priority", () => {
  const page = fakePage();
  const d: TargetDescriptor = { testId: "send" };
  descriptorToTarget(d).resolve(page as any);
  expect(page.getByTestId).toHaveBeenCalledWith("send");
  expect(page.getByRole).not.toHaveBeenCalled();
});

test("role+name (combined) is used when both are present", () => {
  const page = fakePage();
  const d: TargetDescriptor = { role: "button", name: "Send" };
  descriptorToTarget(d).resolve(page as any);
  expect(page.getByRole).toHaveBeenCalledWith("button", { name: "Send" });
});

test("label is used when testId and role+name are absent", () => {
  const page = fakePage();
  const d: TargetDescriptor = { label: "Username" };
  descriptorToTarget(d).resolve(page as any);
  expect(page.getByLabel).toHaveBeenCalledWith("Username");
});

test("text is used when higher-priority rungs are absent", () => {
  const page = fakePage();
  const d: TargetDescriptor = { text: "Some text" };
  descriptorToTarget(d).resolve(page as any);
  expect(page.getByText).toHaveBeenCalledWith("Some text");
});

test("css is used as the last-resort rung", () => {
  const page = fakePage();
  const d: TargetDescriptor = { css: "button.primary" };
  descriptorToTarget(d).resolve(page as any);
  expect(page.locator).toHaveBeenCalledWith("button.primary");
});

test("role without name does not satisfy the role+name rung and falls through to label", () => {
  const page = fakePage();
  const d: TargetDescriptor = { role: "button", label: "Username" };
  descriptorToTarget(d).resolve(page as any);
  expect(page.getByLabel).toHaveBeenCalledWith("Username");
  expect(page.getByRole).not.toHaveBeenCalled();
});

test("throws a clear error when the descriptor has no usable selector", () => {
  expect(() => descriptorToTarget({})).toThrow(/no usable selector/i);
});

test("frameUrl set throws unconditionally, even when testId is also set (not a last-resort fallback)", () => {
  const d: TargetDescriptor = { testId: "send", frameUrl: "https://example.com/iframe" };
  expect(() => descriptorToTarget(d)).toThrow(/frameUrl is not supported in A\.1/);
});
