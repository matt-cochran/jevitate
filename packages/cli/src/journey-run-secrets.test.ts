import { describe, expect, it } from "vitest";
import { redactSecretValues, runSecretValues } from "./journey-api.js";

/** #564: a value the run extracted under a credential-like name is one of the run's secrets. */
describe("runSecretValues", () => {
  const result = { outcome: "ok", output: { apiKey: "sk-live-9f8e7d", orderId: "A-1001", sessionToken: "tok-abc123" } };

  it("adds every credential-named output value to the run's secrets", () => {
    expect(runSecretValues(["hunter2"], result).sort()).toEqual(["hunter2", "sk-live-9f8e7d", "tok-abc123"]);
  });

  it("leaves an ordinary output value out", () => {
    expect(runSecretValues([], result)).not.toContain("A-1001");
  });

  it("so the redacted result carries no extracted key anywhere", () => {
    const failed = { ...result, failures: [{ detail: "expected text 'sk-live-9f8e7d' not found" }] };
    const json = JSON.stringify(redactSecretValues(failed, runSecretValues([], failed)));
    expect(json).not.toContain("sk-live-9f8e7d");
    expect(json).toContain("A-1001");
  });
});
