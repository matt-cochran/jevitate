import { describe, it, expect } from "vitest";
import { assertAuthorizedTarget, UnauthorizedLoadTargetError } from "./authorized-targets.js";

describe("assertAuthorizedTarget", () => {
  it("does not throw when the target origin is in the allowlist", () => {
    expect(() => assertAuthorizedTarget("https://example.com", ["https://example.com"])).not.toThrow();
  });

  it("throws UnauthorizedLoadTargetError when the origin is absent from the allowlist", () => {
    expect(() => assertAuthorizedTarget("https://evil.example.com", ["https://example.com"])).toThrow(
      UnauthorizedLoadTargetError,
    );
  });

  it("throws (fail-closed) when the allowlist is empty — no implicit trust", () => {
    expect(() => assertAuthorizedTarget("https://example.com", [])).toThrow(UnauthorizedLoadTargetError);
  });

  // C7: compare by PARSED origin, not exact string equality.
  it("accepts a cosmetic mismatch — allowlist entry has a trailing slash, target does not", () => {
    expect(() => assertAuthorizedTarget("https://example.com", ["https://example.com/"])).not.toThrow();
  });

  it("accepts a cosmetic mismatch — allowlist entry has different hostname case", () => {
    expect(() => assertAuthorizedTarget("https://example.com", ["https://EXAMPLE.com"])).not.toThrow();
  });

  it("still rejects a genuinely different origin (different host)", () => {
    expect(() => assertAuthorizedTarget("https://evil.example.com", ["https://example.com/"])).toThrow(
      UnauthorizedLoadTargetError,
    );
  });

  it("still rejects a genuinely different origin (different port)", () => {
    expect(() => assertAuthorizedTarget("https://example.com:8443", ["https://example.com"])).toThrow(
      UnauthorizedLoadTargetError,
    );
  });

  it("fails closed when the target origin is unparseable", () => {
    expect(() => assertAuthorizedTarget("not a url", ["https://example.com"])).toThrow(
      UnauthorizedLoadTargetError,
    );
  });

  it("fails closed when an allowlist entry is unparseable — never accidentally matches", () => {
    expect(() => assertAuthorizedTarget("https://example.com", ["not a url"])).toThrow(
      UnauthorizedLoadTargetError,
    );
  });
});
