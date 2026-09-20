import { describe, it, expect } from "vitest";
import {
  assertAuthorizedExploreTarget,
  isAuthorizedExploreTarget,
  UnauthorizedExploreTargetError,
  normalizeAllowlist,
} from "./index.js";

const ALLOW = ["http://127.0.0.1:3000", "https://staging.example.com"];

describe("authorized-targets guard (guardrail #1: authoring/test plane only)", () => {
  it("accepts a URL whose origin is on the allowlist and returns the origin", () => {
    expect(assertAuthorizedExploreTarget("http://127.0.0.1:3000/login?x=1", ALLOW)).toBe(
      "http://127.0.0.1:3000",
    );
  });

  it("REFUSES an off-allowlist origin", () => {
    expect(() => assertAuthorizedExploreTarget("https://evil.example.com/", ALLOW)).toThrow(
      UnauthorizedExploreTargetError,
    );
  });

  it("REFUSES a matching host on a different port (origin, not host)", () => {
    expect(() => assertAuthorizedExploreTarget("http://127.0.0.1:9999/login", ALLOW)).toThrow(
      UnauthorizedExploreTargetError,
    );
  });

  it("fails closed on an empty allowlist (authorizes nothing)", () => {
    expect(() => assertAuthorizedExploreTarget("http://127.0.0.1:3000/", [])).toThrow(
      UnauthorizedExploreTargetError,
    );
  });

  it("REFUSES a dangerous / non-http scheme even if it 'contains' an allowed host", () => {
    expect(() =>
      assertAuthorizedExploreTarget("javascript:fetch('http://127.0.0.1:3000')", ALLOW),
    ).toThrow(UnauthorizedExploreTargetError);
    expect(() => assertAuthorizedExploreTarget("data:text/html,x", ALLOW)).toThrow(
      UnauthorizedExploreTargetError,
    );
  });

  it("REFUSES an unparseable URL", () => {
    expect(() => assertAuthorizedExploreTarget("not a url", ALLOW)).toThrow(
      UnauthorizedExploreTargetError,
    );
  });

  it("a path/query cannot smuggle onto an unauthorized host", () => {
    expect(() =>
      assertAuthorizedExploreTarget("https://evil.example.com/?next=http://127.0.0.1:3000", ALLOW),
    ).toThrow(UnauthorizedExploreTargetError);
  });

  it("normalizeAllowlist drops un-parseable entries and de-dupes origins", () => {
    expect(normalizeAllowlist(["http://a.test/x", "http://a.test/y", "garbage", "ftp://a.test"])).toEqual([
      "http://a.test",
    ]);
  });

  it("isAuthorizedExploreTarget is the non-throwing companion", () => {
    expect(isAuthorizedExploreTarget("http://127.0.0.1:3000/x", ALLOW)).toBe(true);
    expect(isAuthorizedExploreTarget("http://other.test/x", ALLOW)).toBe(false);
  });
});
