import { resolveDataDir } from "./data-dir.js";
import { HOLD_HOOK_OWNER, registerHoldHooks, type HoldHookOptions } from "./journey-hold.js";
import { registerParamTypeHooks } from "./journey-param-types.js";
import { hasRunHookOwner } from "./journey-run-hooks.js";
import { registerSentinelShadowHookOnce } from "./sentinel-hook.js";
import type { SentinelGateway } from "@jevitate/runtime";
import { registerRunModeHooks, runModeHooksRegistered, trustOfRunContext } from "./journey-run-mode-gate.js";

/** The inbox a hold is shown in: the one the last program or server built in this process resolved. */
let holdInboxDir: string | undefined;

/**
 * 0.30.0: the run hooks every run surface carries, registered once per process from where the CLI program
 * (`buildProgram`) and the MCP server (`buildMcpTools`) start. Idempotent by owner, so a second program or
 * server in the same process adds nothing (and a test that reset the hooks gets them back):
 *  - the run mode (journey-run-mode-gate.ts, §5): `run.mode`/`target.trust` in the evidence and its refusals;
 *  - typed parameters (journey-param-types.ts, #796);
 *  - holds (journey-hold.ts, §5.4): a hold is made durable under the project's `.jevitate/logs/holds`, with
 *    the target's trust as the run-mode gate resolves it, and shown in `inboxDir` (`resolveInboxDir`).
 * The job done check (`registerDoneCheckHooks`) is registered separately.
 */
export function registerRunSurfaceHooks(opts: { readonly inboxDir?: string | undefined; /** #794: when given, Jev's write sentinel runs in shadow mode (advisory only). */ readonly sentinelGateway?: SentinelGateway | undefined } = {}): void {
  // `resolveInboxDir`'s default when a surface names none (`~/.jevitate/inbox`).
  holdInboxDir = opts.inboxDir ?? resolveDataDir(["inbox"]);
  if (!runModeHooksRegistered()) registerRunModeHooks();
  if (!hasRunHookOwner("param-types")) registerParamTypeHooks();
  if (!hasRunHookOwner(HOLD_HOOK_OWNER)) {
    // Read when a hold is made, so the holds dir follows the project and the inbox the latest build.
    const holdOptions: HoldHookOptions = {
      get inboxDir() {
        return holdInboxDir;
      },
      trustOf: trustOfRunContext,
    };
    registerHoldHooks(holdOptions);
  }
  if (opts.sentinelGateway !== undefined) registerSentinelShadowHookOnce({ gateway: opts.sentinelGateway });
}
