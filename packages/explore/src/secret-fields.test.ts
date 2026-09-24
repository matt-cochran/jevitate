import { describe, expect, it } from "vitest";
import type { Control, Snapshot } from "./snapshot.js";
import {
  SecretFieldSpecError,
  boundSecretField,
  maskSecretFields,
  parseSecretField,
  secretFieldContext,
  secretFieldValue,
} from "./secret-fields.js";
import { decodeBase32, totp } from "./totp.js";

// RFC 6238 appendix B: the SHA-1 seed is ASCII "12345678901234567890".
const RFC_SEED = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";

describe("totp — RFC 6238, computed in-process (#72)", () => {
  it.each([
    [59, "94287082"],
    [1111111109, "07081804"],
    [1111111111, "14050471"],
    [1234567890, "89005924"],
    [2000000000, "69279037"],
    [20000000000, "65353130"],
  ])("t=%is → %s (8 digits)", (t, code) => {
    expect(totp(RFC_SEED, t * 1000, { digits: 8 })).toBe(code);
  });

  it("defaults to 6 digits / 30 s and tolerates spaced, lower-case, padded seeds", () => {
    expect(totp("gezd gnbv gy3t qojq gezd gnbv gy3t qojq==", 59_000)).toBe("287082");
    expect(decodeBase32(RFC_SEED).toString("ascii")).toBe("12345678901234567890");
  });

  it("refuses a non-base32 seed without echoing it", () => {
    expect(() => decodeBase32("not-base32!!")).toThrow(/not base32/);
    expect(() => decodeBase32("not-base32!!")).not.toThrow(/not-base32!!/);
  });
});

const control = (over: Partial<Control>): Control => ({
  index: 0,
  descriptor: {},
  stability: "high",
  role: "textbox",
  name: "",
  tag: "input",
  inputType: "text",
  enabled: true,
  summary: "",
  ...over,
});

describe("secret field bindings (#72)", () => {
  const env = { APP_PW: "pw-canary-123", APP_SEED: RFC_SEED, EMPTY: "" };

  it("parses <key>=<value>=env:<VAR> and resolves the value from the environment", () => {
    const f = parseSecretField("label=Password=env:APP_PW", "value", env);
    expect(f).toMatchObject({ descriptor: "label=Password", matcher: { key: "label", value: "Password" }, name: "APP_PW", kind: "value" });
    expect(secretFieldValue(f, 0)).toBe("pw-canary-123");
    const t = parseSecretField("testId=otp=env:APP_SEED", "totp", env);
    expect(secretFieldValue(t, 59_000)).toBe("287082");
    // A descriptor value may itself contain `=`.
    expect(parseSecretField("label=a=b=env:APP_PW", "value", env).matcher).toEqual({ key: "label", value: "a=b" });
  });

  it("fails closed on a malformed spec, an unset variable or a bad seed — never echoing a value", () => {
    const bad = (spec: string, kind: "value" | "totp" = "value") => () => parseSecretField(spec, kind, env);
    expect(bad("label=Password=hunter2")).toThrow(SecretFieldSpecError);
    expect(bad("label=Password=hunter2")).not.toThrow(/hunter2/);
    expect(bad("colour=red=env:APP_PW")).toThrow(/expects/);
    expect(bad("label=Password=env:MISSING")).toThrow(/MISSING is not set/);
    expect(bad("label=Password=env:EMPTY")).toThrow(/EMPTY is not set/);
    expect(bad("label=Code=env:APP_PW", "totp")).toThrow(/not a base32 TOTP seed/);
    expect(bad("label=Code=env:APP_PW", "totp")).not.toThrow(/pw-canary/);
  });

  it("matches a control by label, testId, type, id or name — text-entry controls only", () => {
    const fields = [
      parseSecretField("label=Password=env:APP_PW", "value", env),
      parseSecretField("testId=otp=env:APP_SEED", "totp", env),
    ];
    expect(boundSecretField(control({ name: "Password *", inputType: "password" }), fields)?.name).toBe("APP_PW");
    expect(boundSecretField(control({ descriptor: { testId: "otp" } }), fields)?.kind).toBe("totp");
    expect(boundSecretField(control({ name: "Password", tag: "button", role: "button", inputType: null }), fields)).toBeNull();
    expect(boundSecretField(control({ name: "Username" }), fields)).toBeNull();
    const byType = [parseSecretField("type=password=env:APP_PW", "value", env)];
    expect(boundSecretField(control({ inputType: "password" }), byType)).not.toBeNull();
    expect(boundSecretField(control({ inputType: "text" }), byType)).toBeNull();
    expect(boundSecretField(control({ descriptor: { anchor: { id: "pw" } } }), [parseSecretField("id=pw=env:APP_PW", "value", env)])).not.toBeNull();
  });

  it("shows the model only placeholders: masked summaries and a placeholder-only mission context", () => {
    const fields = [parseSecretField("label=Code=env:APP_SEED", "totp", env)];
    const snap: Snapshot = {
      url: "http://x/",
      truncated: false,
      signature: "s",
      controls: [control({ name: "Code", summary: 'textbox "Code" (value="287082")' }), control({ index: 1, name: "Other", summary: "o" })],
    };
    const masked = maskSecretFields(snap, fields);
    expect(masked.controls[0]!.summary).toBe('textbox "Code" (bound: «totp:APP_SEED» — typed by code)');
    expect(masked.controls[1]!.summary).toBe("o");
    expect(masked.signature).toBe("s");
    expect(secretFieldContext(fields)).toContain("label=Code → «totp:APP_SEED»");
    expect(secretFieldContext(fields)).not.toContain(RFC_SEED);
  });
});
