import { describe, it, expect } from "vitest";
import { safeRunPolicy, type RunPolicy } from "./run-policy.js";

describe("safeRunPolicy", () => {
  it("defaults to the safe policy: fail-closed self-heal, deterministic direction, fail-closed secret", () => {
    const p: RunPolicy = safeRunPolicy();
    expect(p).toEqual({
      selfHeal: { mode: "fail-closed" },
      direction: { direction: "deterministic" },
      secret: { secretMode: "fail-closed" },
    });
  });
});

describe("SecretMode — vault-autofill (Slice 1b)", () => {
  it("accepts secretMode: 'vault-autofill' as a valid RunPolicy without any extra required fields", () => {
    const p: RunPolicy = {
      selfHeal: { mode: "fail-closed" },
      direction: { direction: "deterministic" },
      secret: { secretMode: "vault-autofill" },
    };
    expect(p.secret.secretMode).toBe("vault-autofill");
  });

  it("safeRunPolicy() is unchanged — still defaults to fail-closed secret, never vault-autofill", () => {
    expect(safeRunPolicy().secret.secretMode).toBe("fail-closed");
  });
});
