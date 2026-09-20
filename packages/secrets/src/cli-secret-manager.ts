import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { SecretRef } from "./secret-ref.js";
import type { SecretManagerPort } from "./secret-manager-port.js";
import { Secret } from "./secret.js";
import { SecretUnresolvableError } from "./errors.js";

const execFileAsync = promisify(execFile);

export interface CliCommand {
  cmd: string;
  args: string[];
}

export type ExecFn = (cmd: string, args: string[]) => Promise<string>;

const defaultExec: ExecFn = async (cmd, args) => {
  const { stdout } = await execFileAsync(cmd, args);
  return stdout;
};

/**
 * Thin delegation to an EXTERNAL password manager's own CLI (e.g. `op`,
 * `bw`, `pass`) — the platform never implements a vault itself.
 * `buildCommand` maps a `SecretRef` to the manager-specific CLI invocation
 * (syntax varies per manager, so this is caller-supplied, never hardcoded
 * to one vendor). Nothing fetched is cached: every `fetch`/`assertResolvable`
 * call re-invokes the CLI.
 */
export class CliSecretManager implements SecretManagerPort {
  constructor(
    private readonly buildCommand: (ref: SecretRef) => CliCommand,
    private readonly exec: ExecFn = defaultExec,
  ) {}

  async assertResolvable(ref: SecretRef): Promise<void> {
    await this.fetch(ref); // discarded immediately — never stored, never logged
  }

  async fetch(ref: SecretRef): Promise<Secret> {
    const { cmd, args } = this.buildCommand(ref);
    let stdout: string;
    try {
      stdout = await this.exec(cmd, args);
    } catch (err) {
      throw new SecretUnresolvableError(
        `manager "${ref.manager}" could not resolve key "${ref.key}": ${(err as Error).message}`,
      );
    }
    return new Secret(stdout.trim());
  }
}
