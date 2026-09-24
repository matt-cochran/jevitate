import { describe, expect, it } from "vitest";
import { routeOf, scopeGlobs, scopePredicate } from "./scope.js";
import { matchGlob } from "../feature/capability-scope.js";

describe("adversarial scope (#64)", () => {
  it("is the start URL's route and everything under it, plus the caller's globs", () => {
    expect(scopeGlobs("https://app.test/org/admin/profile?tab=1")).toEqual([
      "/org/admin/profile",
      "/org/admin/profile/",
      "/org/admin/profile/**",
    ]);
    expect(scopeGlobs("https://app.test/org/profile/", ["/org/settings/*", " "])).toEqual([
      "/org/profile",
      "/org/profile/",
      "/org/profile/**",
      "/org/settings/*",
    ]);
    expect(scopeGlobs("https://app.test/")).toEqual(["/", "/**"]);
    expect(routeOf("https://app.test/a/b/")).toBe("/a/b");
  });

  it("matches on the path (query and hash ignored), on authorized origins only", () => {
    const inScope = scopePredicate(["https://app.test"], scopeGlobs("https://app.test/org/profile", ["/org/*/edit"]));
    expect(inScope("https://app.test/org/profile")).toBe(true);
    expect(inScope("https://app.test/org/profile?x=1#top")).toBe(true);
    expect(inScope("https://app.test/org/profile/general")).toBe(true);
    expect(inScope("https://app.test/org/42/edit")).toBe(true);
    expect(inScope("https://app.test/org/profiles")).toBe(false);
    expect(inScope("https://app.test/")).toBe(false);
    expect(inScope("https://evil.test/org/profile")).toBe(false);
    expect(inScope("not a url")).toBe(false);
  });

  it("route globs treat regex metacharacters literally", () => {
    expect(matchGlob("/files/report.pdf", "/files/report.pdf")).toBe(true);
    expect(matchGlob("/files/report.pdf", "/files/reportXpdf")).toBe(false);
    expect(matchGlob("/a+b/*", "/a+b/c")).toBe(true);
  });
});
