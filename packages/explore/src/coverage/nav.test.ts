import { describe, expect, test } from "vitest";
import { isNavControl } from "./nav.js";

describe("isNavControl (#75)", () => {
  test("a link to a different route is nav", () => {
    expect(
      isNavControl({ tag: "a", role: "link", href: "https://app.test/activity" }, "https://app.test/projects"),
    ).toBe(true);
  });

  test("a same-page anchor (a skip link, a hash-only link) is NOT nav", () => {
    expect(
      isNavControl({ tag: "a", role: "link", href: "https://app.test/projects#main" }, "https://app.test/projects"),
    ).toBe(false);
  });

  test("a non-link control is never nav", () => {
    expect(isNavControl({ tag: "button", role: "button", href: null }, "https://app.test/projects")).toBe(false);
  });

  test("a link with no href is never nav", () => {
    expect(isNavControl({ tag: "a", role: "link", href: null }, "https://app.test/projects")).toBe(false);
  });

  test("a malformed href never throws — treated as not nav", () => {
    expect(isNavControl({ tag: "a", role: "link", href: "not a url" }, "https://app.test/projects")).toBe(false);
  });
});
