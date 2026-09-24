import { describe, expect, it } from "vitest";
import { textMatcher, urlMatcher } from "./settle-config.js";

describe("settle-config patterns", () => {
  it("path patterns match path+query; full-URL patterns match the whole URL; anchored", () => {
    const m = urlMatcher(["/api/notifications/poll*", "https://cdn.test/*", "/hub"]);
    expect(m("http://app.test/api/notifications/poll?since=3")).toBe(true);
    expect(m("https://cdn.test/a/b.js")).toBe(true);
    expect(m("http://app.test/hub")).toBe(true);
    expect(m("http://app.test/hub/negotiate")).toBe(false);
    expect(m("http://app.test/api/notifications")).toBe(false);
    expect(urlMatcher(undefined)("http://x.test/")).toBe(false);
  });

  it("text patterns match routes, action labels and indicators", () => {
    const t = textMatcher(["click Refresh*", "/dashboard"]);
    expect(t("click Refresh now")).toBe(true);
    expect(t("/dashboard")).toBe(true);
    expect(t("/dashboard/x")).toBe(false);
  });
});
