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
});
