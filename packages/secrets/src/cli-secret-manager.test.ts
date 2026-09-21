import { describe, it, expect, vi } from "vitest";
import { CliSecretManager } from "./cli-secret-manager.js";
import { Secret } from "./secret.js";
import { SecretUnresolvableError } from "./errors.js";

const ref = { manager: "op", key: "gmail-password", origin: "https://mail.example.com", field: "password" };

describe("CliSecretManager", () => {
  it("fetch runs the built command and wraps trimmed stdout in a Secret", async () => {
    const exec = vi.fn(async () => "hunter2\n");
    const mgr = new CliSecretManager((r) => ({ cmd: "op", args: ["read", r.key] }), exec);
    const secret = await mgr.fetch(ref);
    expect(exec).toHaveBeenCalledWith("op", ["read", "gmail-password"]);
    expect(secret).toBeInstanceOf(Secret);
    expect(secret.reveal()).toBe("hunter2");
  });

  it("fetch throws SecretUnresolvableError (not the raw exec error) when the CLI fails", async () => {
    const exec = vi.fn(async () => {
      throw new Error("exit code 1");
    });
    const mgr = new CliSecretManager((r) => ({ cmd: "op", args: ["read", r.key] }), exec);
    await expect(mgr.fetch(ref)).rejects.toBeInstanceOf(SecretUnresolvableError);
  });

  it("assertResolvable succeeds when the CLI succeeds (and discards the value)", async () => {
    const exec = vi.fn(async () => "hunter2\n");
    const mgr = new CliSecretManager((r) => ({ cmd: "op", args: ["read", r.key] }), exec);
    await expect(mgr.assertResolvable(ref)).resolves.toBeUndefined();
  });

  it("assertResolvable rejects with SecretUnresolvableError when the CLI fails", async () => {
    const exec = vi.fn(async () => {
      throw new Error("not found");
    });
    const mgr = new CliSecretManager((r) => ({ cmd: "op", args: ["read", r.key] }), exec);
    await expect(mgr.assertResolvable(ref)).rejects.toBeInstanceOf(SecretUnresolvableError);
  });

  it("does not echo the raw exec error/stderr text into the thrown error message (a misconfigured manager CLI could echo the secret to stderr)", async () => {
    const leaked = "hunter2-leaked-to-stderr";
    const exec = vi.fn(async () => {
      // Mirrors node's exec/execFile behavior: a failed process's error
      // folds stderr into `.message` and also attaches it as `.stderr`.
      const err = new Error(`Command failed: op read gmail-password\n${leaked}`) as Error & {
        code?: number;
        stderr?: string;
      };
      err.code = 1;
      err.stderr = leaked;
      throw err;
    });
    const mgr = new CliSecretManager((r) => ({ cmd: "op", args: ["read", r.key] }), exec);

    let caught: unknown;
    try {
      await mgr.fetch(ref);
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(SecretUnresolvableError);
    const message = (caught as Error).message;
    expect(message).not.toContain(leaked);
    expect(message).toContain(ref.manager);
    expect(message).toContain(ref.key);
  });
});
