import { describe, it, expect } from "vitest";
import { StubSecretManager } from "./stub-secret-manager.js";
import { SecretUnresolvableError } from "./errors.js";
import { Secret } from "./secret.js";

const ref = { manager: "stub", key: "gmail-password", origin: "https://mail.example.com", field: "password" };

describe("StubSecretManager", () => {
  it("assertResolvable resolves cleanly when the key is present", async () => {
    const mgr = new StubSecretManager({ "gmail-password": "hunter2" });
    await expect(mgr.assertResolvable(ref)).resolves.toBeUndefined();
  });

  it("assertResolvable throws SecretUnresolvableError when the key is absent", async () => {
    const mgr = new StubSecretManager({});
    await expect(mgr.assertResolvable(ref)).rejects.toBeInstanceOf(SecretUnresolvableError);
  });

  it("fetch returns a Secret wrapping the value", async () => {
    const mgr = new StubSecretManager({ "gmail-password": "hunter2" });
    const secret = await mgr.fetch(ref);
    expect(secret).toBeInstanceOf(Secret);
    expect(secret.reveal()).toBe("hunter2");
  });

  it("fetch throws SecretUnresolvableError when the key is absent", async () => {
    const mgr = new StubSecretManager({});
    await expect(mgr.fetch(ref)).rejects.toBeInstanceOf(SecretUnresolvableError);
  });
});
