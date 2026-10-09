import { describe, expect, it } from "vitest";
import { assertNoOutboundCredential, CredentialLeakError } from "./credential-guard.js";
import { assertPlaintextAllowed, envCredentialStore, PlaintextCredentialRefusedError } from "./credentials.js";
import { credentialProvenance } from "./key-verify.js";

/** #464: the Journeeze upload key is never held in (or read from) the plaintext local config. */

const KEY = "jzu_abcdefghijklmnopqrstuvwxyz234567abcdefgh";

describe("JOURNEEZE_UPLOAD_KEY: no plaintext fallback", () => {
  it("a value in the local config is never read", () => {
    expect(envCredentialStore({}, { JOURNEEZE_UPLOAD_KEY: KEY }).detect("JOURNEEZE_UPLOAD_KEY")).toBe(false);
  });

  it("the environment (CI) supplies it", () => {
    expect(envCredentialStore({ JOURNEEZE_UPLOAD_KEY: KEY }, {}).read("JOURNEEZE_UPLOAD_KEY")).toBe(KEY);
  });

  it("the other keys keep their local-config fallback", () => {
    expect(envCredentialStore({}, { OPENROUTER_API_KEY: "sk-or" }).read("OPENROUTER_API_KEY")).toBe("sk-or");
  });

  it("persisting it in plain text is refused", () => {
    expect(() => assertPlaintextAllowed("JOURNEEZE_UPLOAD_KEY")).toThrow(PlaintextCredentialRefusedError);
  });

  it("provenance never reports the file as its source", () => {
    expect(credentialProvenance("JOURNEEZE_UPLOAD_KEY", {}, { JOURNEEZE_UPLOAD_KEY: KEY }).source).toEqual({ kind: "missing" });
  });

  it("the never-to-model guard checks it like every credential", () => {
    const store = envCredentialStore({ JOURNEEZE_UPLOAD_KEY: KEY });
    expect(() => assertNoOutboundCredential({ prompt: `use ${KEY}` }, store)).toThrow(CredentialLeakError);
  });
});
