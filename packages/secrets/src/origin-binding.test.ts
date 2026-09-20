import { describe, it, expect } from "vitest";
import { assertOriginBound } from "./origin-binding.js";
import { SecretOriginMismatchError } from "./errors.js";

const ref = { manager: "stub", key: "gmail-password", origin: "https://mail.example.com", field: "password" };

describe("assertOriginBound", () => {
  it("passes silently when the current URL's origin matches ref.origin", () => {
    expect(() => assertOriginBound(ref, "https://mail.example.com/login")).not.toThrow();
  });

  it("throws SecretOriginMismatchError on a different host", () => {
    expect(() => assertOriginBound(ref, "https://evil.example.com/login")).toThrow(SecretOriginMismatchError);
  });

  it("throws SecretOriginMismatchError on a different scheme (https vs http)", () => {
    expect(() => assertOriginBound(ref, "http://mail.example.com/login")).toThrow(SecretOriginMismatchError);
  });

  it("throws SecretOriginMismatchError on a different port", () => {
    expect(() =>
      assertOriginBound({ ...ref, origin: "https://mail.example.com:8443" }, "https://mail.example.com/login"),
    ).toThrow(SecretOriginMismatchError);
  });
});
