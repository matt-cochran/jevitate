import { describe, expect, test } from "vitest";
import { UnauthorizedExploreTargetError } from "./index.js";
import { runFeatureMission } from "./missions/feature.js";
import { boundaryValueCandidates, isSecretLike } from "./feature/boundary-values.js";
import type { Control } from "./snapshot.js";
import type { CapabilityScope } from "./feature/capability-scope.js";

describe("feature mission — guardrail invariants", () => {
  test("#1 refuses an undeclared origin before touching a Page", async () => {
    const scope: CapabilityScope = { name: "checkout", originAllowlist: ["https://authorized.test"], routeGlobs: ["/checkout/**"] };
    await expect(
      runFeatureMission({
        page: {} as never,
        actor: {} as never,
        seedUrl: "https://not-authorized.test/checkout",
        allowlist: ["https://authorized.test"],
        scope,
      }),
    ).rejects.toThrow(UnauthorizedExploreTargetError);
  });

  test("#1 refuses when the allowlist is empty (fail-closed, never 'anything in scope')", async () => {
    const scope: CapabilityScope = { name: "checkout", originAllowlist: [], routeGlobs: ["/checkout/**"] };
    await expect(
      runFeatureMission({
        page: {} as never,
        actor: {} as never,
        seedUrl: "https://authorized.test/checkout",
        allowlist: [],
        scope,
      }),
    ).rejects.toThrow(UnauthorizedExploreTargetError);
  });

  test("#3 a secret-like field is never given a boundary-value candidate", () => {
    const passwordField: Control = {
      index: 0,
      descriptor: { css: "#pw" },
      stability: "high",
      role: "textbox",
      name: "Password",
      tag: "input",
      inputType: "password",
      enabled: true,
      summary: "",
    };
    expect(isSecretLike(passwordField)).toBe(true);
    expect(boundaryValueCandidates(passwordField)).toEqual([]);
  });
});
