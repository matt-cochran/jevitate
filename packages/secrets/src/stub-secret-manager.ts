import type { SecretRef } from "./secret-ref.js";
import type { SecretManagerPort } from "./secret-manager-port.js";
import { Secret } from "./secret.js";
import { SecretUnresolvableError } from "./errors.js";

/**
 * Test-only `SecretManagerPort`: an in-memory map keyed by `ref.key`. Real
 * adapters (e.g. `CliSecretManager`) shell out to an actual external
 * manager; this one exists so runtime/journey tests never need a real
 * vault. It still enforces the same "thin delegation, nothing persisted"
 * contract — the map is caller-supplied fixture data, not something this
 * class writes to.
 */
export class StubSecretManager implements SecretManagerPort {
  constructor(private readonly values: Record<string, string>) {}

  async assertResolvable(ref: SecretRef): Promise<void> {
    if (!(ref.key in this.values)) {
      throw new SecretUnresolvableError(
        `stub secret manager has no entry for key "${ref.key}" (manager "${ref.manager}")`,
      );
    }
  }

  async fetch(ref: SecretRef): Promise<Secret> {
    const value = this.values[ref.key];
    if (value === undefined) {
      throw new SecretUnresolvableError(
        `stub secret manager has no entry for key "${ref.key}" (manager "${ref.manager}")`,
      );
    }
    return new Secret(value);
  }
}
