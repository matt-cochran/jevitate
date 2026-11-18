/**
 * #872 follow-up: facts about how THIS run's browser was launched that a result must record,
 * because they change what the run proves. Today: the local dev server origins whose self-signed
 * certificate the run accepted (`--accept-local-dev-cert`). `stampRunMetadata` stamps them on every
 * emitted and persisted result, beside the run's tags and target (#426).
 *
 * Process-level on purpose: one CLI process runs one command, and the flag is CLI-only (never an
 * MCP argument), so the long-lived MCP server never records any. `buildProgram` resets it, so
 * programs built in one process (tests) never inherit an earlier run's origins.
 */

let acceptedLocalDevCerts: string[] = [];

/** Records an origin `--accept-local-dev-cert` accepted (each once). */
export function recordAcceptedLocalDevCert(origin: string): void {
  if (!acceptedLocalDevCerts.includes(origin)) acceptedLocalDevCerts = [...acceptedLocalDevCerts, origin];
}

/** Clears the run environment (called when a program is built). */
export function resetRunEnvironment(): void {
  acceptedLocalDevCerts = [];
}

/** True when this run recorded anything a result must carry. */
export function hasRunEnvironment(): boolean {
  return acceptedLocalDevCerts.length > 0;
}

/** The result fields for this run's environment: `localDevCerts` only when any were accepted. */
export function runEnvironmentFields(): { readonly localDevCerts?: readonly string[] } {
  return acceptedLocalDevCerts.length === 0 ? {} : { localDevCerts: [...acceptedLocalDevCerts] };
}
