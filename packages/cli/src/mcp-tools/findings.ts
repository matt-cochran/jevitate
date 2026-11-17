import type { McpToolCtx, McpToolGroup } from "./shared.js";
import { getMissionResult, verifyFixTool } from "./findings-handlers.js";

/** `verify_fix` and `get_mission_result`: reading and re-checking a mission result by id. */
export function findingTools(ctx: McpToolCtx): McpToolGroup {
  const { deps, pathRoots, verifyFixImpl } = ctx;

  return {
    verify_fix: {
      description:
        "Replay a finding's reproduction (by mission result id — or a finished queue_exploration missionId — + fingerprint) N times in fresh browsers (default 3) — `jevitate verify-fix`. status: fixed (signal absent on every replay) | still-reproduces | intermittent (fired on some but not all replays — never a pass) | inconclusive (replay could not reach the step — never a pass). " +
        "#255 (same as the CLI flags): 'replays' (>= 1); 'recordVideo' (true or a directory: the before/after evidence pair — `evidence.before` is the run's own clip, `evidence.after` a captioned replay — plus videoPaths); 'screenshots'; 'headed'/'slowMo'; " +
        "'storageState' (a path inside the project or ~/.jevitate, never a repo's .jevitate/; overrides the mission's session); 'viewport' {width,height} or 'device' (refused when it differs from the finding's recorded emulation unless 'allowEmulationOverride'); 'geolocation' '<lat>,<lng>[,<accuracy m>]' (#329); " +
        "'invariants' (invariant file paths re-checking a declared-invariant defect); 'fixtures' (a fixtures file overriding the mission's saved one); 'fixtureIdentity' (#243: 'name=<storageState path>' entries re-binding a fixture step's auth.identity; default: the identities the mission recorded); 'extension' (#256: unpacked extension directories — refused unless the same build the finding was recorded with); 'actionDeltas' (#303, opt-in: the defect step's replayed delta vs the recorded one, as evidence on each attempt); 'maxBrowsers'/'maxBrowserMemory' (#205: machine-wide browser cap, browser memory ceiling in MiB); 'tags' (#426: {key: value} run metadata, returned on the result — never a secret); #484 'env' (a named environment in environments.json: replay under its CURRENT allow list instead of the one stored with the result, e.g. to prove a localhost → 127.0.0.1 config fix; explicit only, never defaulted) — the result then carries allowlistOverride (source, origins, recorded, added, removed); raw origins are CLI-only (`jevitate verify-fix --allow`), never an MCP argument. Operator-only settings (shell hooks, cmd: log sources, re-sending paid/destructive hang writes) come from targets.json, never an argument.",
      inputSchema: {
        type: "object",
        properties: {
          id: { type: "string" },
          fingerprint: { type: "string" },
          replays: { type: "integer", minimum: 1 },
          actionDeltas: { type: "boolean" },
          recordVideo: { type: ["boolean", "string"] },
          screenshots: { type: ["boolean", "string"] },
          headed: { type: "boolean" },
          slowMo: { type: "integer", minimum: 0 },
          storageState: { type: "string" },
          viewport: { type: "object", properties: { width: { type: "integer" }, height: { type: "integer" } }, required: ["width", "height"] },
          device: { type: "string" },
          geolocation: { type: "string" },
          allowEmulationOverride: { type: "boolean" },
          invariants: { type: "array", items: { type: "string" } },
          fixtures: { type: "string" },
          fixtureIdentity: { type: "array", items: { type: "string" } },
          extension: { type: "array", items: { type: "string" } },
          maxBrowsers: { type: "integer", minimum: 1 },
          maxBrowserMemory: { type: "integer", minimum: 1 },
          tags: { type: "object", additionalProperties: { type: "string" } },
          env: { type: "string" },
        },
        required: ["id", "fingerprint"],
      },
      handler: (args) => verifyFixTool(deps, pathRoots, verifyFixImpl, args),
    },
    get_mission_result: {
      description:
        "Read a mission's TYPED result by id: a result stem (explore-|coverage-|exploratory-|adversarial-|feature-|usability-<stamp>, e.g. adversarial-2026-09-23T00-00-00-000Z) or a queue_exploration missionId, or a queue_journey callId (journey-<uuid>: its stored record — status queued | running (pending), failed (an error with the refusal `code`, e.g. E_JOURNEY_APPROVAL_STALE), else the run's outcome (ok | failed | held | …) with exitCode and runId, the run's journey-evidence-<runId> directory; exit 2 is an error result). A queued mission reports status queued | running (pending: true — poll again; `jevitate mission run` drains the queue) or failed (an error: it could not run). A finished one: status is clean | defects-found | hang | intermittent | inconclusive | crashed, with the matching CLI exit code. A broken run (inconclusive/crashed) is returned as an error result — never a pass. An adversarial result carries `coverage` (target controls exercised/total, forms submitted, strategies applied vs found nothing, out-of-scope steps): a run below its coverage thresholds is inconclusive, never clean.",
      inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
      handler: (args) => getMissionResult(deps, args),
    },
  };
}
