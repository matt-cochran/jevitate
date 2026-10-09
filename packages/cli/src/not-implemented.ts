/**
 * 0.10 surface (d-surface-0): every new command and MCP tool of the release is registered up front
 * (so the MCP allowlist change is reviewed once) and calls a typed function in its feature module.
 * Until a feature deliverable lands, that function throws this error: the command refuses with
 * `E_NOT_IMPLEMENTED` (exit 2 — the command could not do its work, it proves nothing; never 0, never
 * a usage error), and the MCP tool that mirrors it returns `{error: "refused", code: "E_NOT_IMPLEMENTED"}`.
 */
export class NotImplementedError extends Error {
  readonly code = "E_NOT_IMPLEMENTED" as const;
  constructor(
    /** What is missing, e.g. `jevitate locator-health`. */
    readonly feature: string,
    /** The jevitate issue that implements it, e.g. `#470`. */
    readonly issue: string,
  ) {
    super(`${feature} is not implemented in this build (jevitate${issue})`);
    this.name = "NotImplementedError";
  }
}
