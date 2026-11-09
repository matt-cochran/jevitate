import { describe, expect, it } from "vitest";
import { redactSecretValues } from "./journey-api.js";
import { withJourneyExitCode } from "./mcp-tools/shared.js";

/**
 * Independent check M7: a short secret equal to a code token (`ok`) never masks a structural field
 * (`outcome`, `exitCode`, `code`, `codes`, a verdict or a status): those are the run's own words, not
 * page text, so the exit code is still attached. Free text and value fields are still redacted.
 */
describe("M7: redaction leaves structural code-token fields alone", () => {
  it("a secret 'ok' keeps outcome 'ok' and its exit code, and still masks 'ok' in free text and values", () => {
    const raw = {
      outcome: "ok",
      code: "ok",
      codes: ["ok"],
      verdict: "ok",
      status: "ok",
      reason: "the page said ok",
      output: { greeting: "ok" },
      failures: [{ outcome: "ok", message: "token ok shown" }],
    };
    const redacted = redactSecretValues(raw, ["ok"]);
    expect(redacted.outcome).toBe("ok");
    expect(redacted.code).toBe("ok");
    expect(redacted.codes).toEqual(["ok"]);
    expect(redacted.verdict).toBe("ok");
    expect(redacted.status).toBe("ok");
    expect(redacted.failures[0]!.outcome).toBe("ok");
    expect(redacted.reason).not.toMatch(/\bok\b/);
    expect(redacted.output.greeting).not.toBe("ok");
    expect(redacted.failures[0]!.message).not.toMatch(/\bok\b/);
    expect(withJourneyExitCode(redacted)).toMatchObject({ outcome: "ok", exitCode: 0 });
  });

  it("a structural field holding free text, not a code token, is still redacted", () => {
    const redacted = redactSecretValues({ outcome: "quarantined", status: "page showed MARKER_S3cret here" }, ["MARKER_S3cret"]);
    expect(redacted.status).not.toContain("MARKER_S3cret");
    expect(redacted.outcome).toBe("quarantined");
  });

  it("a value field named like a structural one (an extracted `code`, a fixture `status`) is still redacted", () => {
    const redacted = redactSecretValues({ outcome: "ok", output: { code: "483920", outcome: "ok" }, fixtures: { status: "ok" } }, ["483920", "ok"]);
    expect(redacted.outcome).toBe("ok");
    expect(redacted.output.code).not.toBe("483920");
    expect(redacted.output.outcome).not.toBe("ok");
    expect(redacted.fixtures.status).not.toBe("ok");
  });
});
