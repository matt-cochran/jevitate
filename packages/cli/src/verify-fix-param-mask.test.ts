import { describe, expect, it } from "vitest";
import { redactText } from "@jevitate/ai-core";
import { maskedVerifyFixParams } from "./verify-fix-cli.js";

/** Independent check (low): verify-fix masks `--param` values by the credential guard's short-secret rule, not only from 6 characters. */
describe("maskedVerifyFixParams", () => {
  it("masks a 3-5 character value and any credential-named one, leaves a 1-2 character ordinary value", () => {
    expect(maskedVerifyFixParams({ pin: "4821", user: "acme", n: "1", password: "x9", note: "" }).sort()).toEqual(["4821", "acme", "x9"].sort());
  });

  it("the short-secret rule keeps the diagnosis readable: a masked short value is matched by token, not inside words", () => {
    const masked = redactText("Timeout at step 2 for acme (pin 4821)", maskedVerifyFixParams({ user: "me", pin: "4821", org: "acme" }));
    expect(masked).toBe("Timeout at step 2 for «redacted» (pin «redacted»)");
  });
});
