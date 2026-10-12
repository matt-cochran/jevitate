import { isMissionResultId, isQueuedMissionId, missionResultFileName, missionStatus, parseResultOutcome } from "@jevitate/mcp-facade";
import { FsMissionQueueStore } from "@jevitate/missions";
import { existsSync } from "node:fs";
import { access, readFile } from "node:fs/promises";
import { join } from "node:path";
import { stampRunMetadata, withRunMetadata } from "../run-metadata.js";
import { browserRunFromFlags, emulationFromFlags } from "../cli-shared.js";
import { parseScreenshotsArg } from "../run-screenshots.js";
import { McpArgError, argErrorBody, optBool, optInt, optNamedSessions, optPath, optExtensions, optRecordVideo, optScreenshots, optString, optStringArray, optViewport } from "../mcp-args.js";
import { resourcePreflight } from "../resource-preflight.js";
import type { McpToolCtx, McpToolGroup } from "./shared.js";
import { jsonResult, errorResult, governanceArgs, goalOutcomeOf, defectStatusOf, resultField, tagsArg } from "./shared.js";
import type { McpToolResult, McpVerifyFixArgs } from "../mcp-api.js";

/** `verify_fix` and `get_mission_result`: reading and re-checking a mission result by id. */
export function findingTools(ctx: McpToolCtx): McpToolGroup {
  const { deps, pathRoots, verifyFixImpl } = ctx;

  // get_mission_result: reads a persisted typed mission result by ID only (the artifact stem the
  // CLI wrote) — never a caller-supplied path. The status carries the CLI exit code, and a run that
  // itself broke (inconclusive/crashed) is an MCP error result, so it can never read as a pass.
  //
  // The id is either a result stem (`explore-<stamp>`, `usability-<stamp>.recording`, …) or a
  // `queue_exploration` missionId (#117): the latter resolves through the mission's queue record —
  // `queued`/`running` is reported as such (not an error, not a result), `failed` as an error, and
  // `done` reads the result its drain wrote. Both shapes are closed regexes; nothing caller-shaped
  // ever reaches a path.
  const resolveResultId = async (
    id: unknown,
    tool: string,
  ): Promise<{ resultId: string; missionId?: string } | { response: McpToolResult; pending?: Record<string, unknown> }> => {
    if (isMissionResultId(id)) return { resultId: id };
    if (!isQueuedMissionId(id)) {
      return {
        response: errorResult({
          error: "invalid_args",
          message: `${tool} requires a mission result 'id' (explore-|coverage-|exploratory-|adversarial-|feature-|usability-<stamp>) or a queue_exploration missionId`,
        }),
      };
    }
    if (!deps.missionQueueDir) {
      return { response: errorResult({ error: "not_configured", message: `${tool} requires missionQueueDir to resolve a missionId` }) };
    }
    let mission;
    try {
      mission = await new FsMissionQueueStore(deps.missionQueueDir).get(id);
    } catch {
      return { response: errorResult({ error: "corrupt_mission", id }) };
    }
    if (mission === null) return { response: errorResult({ error: "not_found", id }) };
    if (mission.status === "queued" || mission.status === "running") {
      // Not finished: neither a pass nor a failure — the agent polls again later.
      const pending = {
        id,
        missionId: id,
        status: mission.status,
        pending: true,
        enqueuedAtIso: mission.enqueuedAtIso,
        ...(mission.startedAtIso === undefined ? {} : { startedAtIso: mission.startedAtIso }),
      };
      return { response: jsonResult(pending), pending };
    }
    if (mission.status === "failed") {
      return { response: errorResult({ id, missionId: id, status: "failed", isError: true, error: mission.error ?? "mission failed" }) };
    }
    if (!isMissionResultId(mission.resultId)) return { response: errorResult({ error: "corrupt_mission", id }) };
    return { resultId: mission.resultId, missionId: id };
  };

  /** The dirs a result may live in: recordings, and (usability reviews) the UX reports dir. */
  const resultPathsFor = (resultId: string): string[] => {
    const file = missionResultFileName(resultId);
    const dirs = deps.resultDirsFor?.(resultId) ?? [deps.recordingsDir, ...(resultId.startsWith("usability-") ? [deps.uxReportsDir] : [])];
    return dirs.filter((d): d is string => d !== undefined).map((d) => join(d, file));
  };

  const getMissionResult = async (args: Record<string, unknown>): Promise<McpToolResult> => {
    if (!deps.recordingsDir) {
      return errorResult({ error: "not_configured", message: "get_mission_result requires recordingsDir" });
    }
    const ref = await resolveResultId(args.id, "get_mission_result");
    if ("response" in ref) return ref.response;
    const ids = { id: args.id, ...(ref.missionId === undefined ? {} : { missionId: ref.missionId, resultId: ref.resultId }) };
    let raw: string | undefined;
    for (const path of resultPathsFor(ref.resultId)) {
      try {
        raw = await readFile(path, "utf8");
        break;
      } catch {
        // Try the next candidate dir.
      }
    }
    if (raw === undefined) {
      return errorResult({ error: "not_found", ...ids });
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return errorResult({ error: "corrupt_result", ...ids });
    }
    // #217: `missionOutcome` is canonical; a goal run's own ending rides beside it as `goalOutcome`.
    const parsedOutcome =
      parsed !== null && typeof parsed === "object" && "missionOutcome" in parsed
        ? parseResultOutcome((parsed as { missionOutcome: unknown }).missionOutcome, goalOutcomeOf(parsed), defectStatusOf(parsed))
        : null;
    if (parsedOutcome === null) {
      return errorResult({ error: "corrupt_result", ...ids });
    }
    // #423: the two orthogonal verdicts beside the status — did the goal get reached (goalOutcome +
    // goalReason) and did the app break (defectOutcome, counted by kind) — read from the structured
    // result, never from its `reason` prose.
    const goalReason = resultField(parsed as object, "goalReason");
    const defectOutcome = resultField(parsed as object, "defectOutcome");
    const status = {
      ...missionStatus(parsedOutcome.outcome),
      ...(parsedOutcome.goalOutcome === undefined ? {} : { goalOutcome: parsedOutcome.goalOutcome }),
      ...(typeof goalReason === "string" ? { goalReason } : {}),
      ...(defectOutcome !== null && typeof defectOutcome === "object" ? { defectOutcome } : {}),
    };
    const result = (parsed as { result?: unknown }).result ?? null;
    // An adversarial run's coverage is surfaced next to the status: an `inconclusive` run says what
    // it did and did not exercise, so an agent can tell "found nothing" from "tried nothing".
    const coverage =
      result !== null && typeof result === "object" && "coverage" in result ? (result as { coverage: unknown }).coverage : undefined;
    const body = { ...ids, ...status, ...(coverage === undefined ? {} : { coverage }), result };
    return status.isError ? errorResult(body) : jsonResult(body);
  };

  /** #255: verify_fix's CLI-parity replay options, validated like `verify-fix`'s flags (typed, before any browser). */
  const verifyFixOptions = (args: Record<string, unknown>): Omit<McpVerifyFixArgs, "resultPath" | "fingerprint"> => {
    const storageState = optPath(args, "storageState", pathRoots, { session: true });
    if (storageState !== undefined && !existsSync(storageState)) throw new McpArgError(`storage state not found: ${storageState}`);
    const replays = optInt(args, "replays", 1);
    const invariantFiles = (optStringArray(args, "invariants") ?? []).map((f, i) => optPath({ [`invariants[${i}]`]: f }, `invariants[${i}]`, pathRoots)!);
    const fixtures = optPath(args, "fixtures", pathRoots);
    const fixtureIdentity = optNamedSessions(args, "fixtureIdentity", pathRoots);
    const allowEmulationOverride = optBool(args, "allowEmulationOverride");
    const headed = optBool(args, "headed");
    const slowMo = optInt(args, "slowMo", 0);
    const recordVideo = optRecordVideo(args, pathRoots);
    const shots = optScreenshots(args, pathRoots);
    const viewport = optViewport(args);
    const device = optString(args, "device");
    const geolocation = optString(args, "geolocation");
    const extension = optExtensions(args, pathRoots);
    const governance = governanceArgs(args);
    const actionDeltas = optBool(args, "actionDeltas");
    // #484: replaying under another allow list widens what the replay may reach — explicit only (never
    // defaulted), and the report carries allowlistOverride. An MCP caller never names origins: only
    // `env` (an operator-configured environment) can override the stored list; `--allow` is CLI-only.
    if (args["allow"] !== undefined) throw new McpArgError("'allow' is not an MCP argument: a replay reaches only operator-configured origins — pass 'env' (an environment in environments.json), or run `jevitate verify-fix --allow` yourself");
    const env = optString(args, "env");
    try {
      const browser = browserRunFromFlags({ browserArg: [], ...governance, ...(extension === undefined ? {} : { extension }), ...(headed === undefined ? {} : { headed }), ...(slowMo === undefined ? {} : { slowMo }), ...(recordVideo === undefined ? {} : { recordVideo }) });
      const screenshots = parseScreenshotsArg(shots);
      const emulation = emulationFromFlags({ ...(viewport === undefined ? {} : { viewport }), ...(device === undefined ? {} : { device }), ...(geolocation === undefined ? {} : { geolocation }) });
      return {
        ...(storageState === undefined ? {} : { storageState }),
        ...(replays === undefined ? {} : { replays }),
        ...(invariantFiles.length === 0 ? {} : { invariantFiles }),
        ...(fixtures === undefined && fixtureIdentity === undefined
          ? {}
          : { fixtureFlags: { ...(fixtures === undefined ? {} : { fixtures }), ...(fixtureIdentity === undefined ? {} : { fixtureIdentity }) } }),
        ...(allowEmulationOverride === undefined ? {} : { allowEmulationOverride }),
        ...(browser === undefined ? {} : { browser }),
        ...(screenshots === undefined ? {} : { screenshots }),
        ...(emulation === undefined ? {} : { emulation }),
        ...(actionDeltas === true ? { actionDeltas: true } : {}),
        ...(env === undefined ? {} : { env, ...(deps.environmentsFile === undefined ? {} : { environmentsFile: deps.environmentsFile }) }),
      };
    } catch (err) {
      throw new McpArgError(err instanceof Error ? err.message : String(err));
    }
  };
  const verifyFixTool = async (args: Record<string, unknown>): Promise<McpToolResult> => {
    if (!deps.recordingsDir) {
      return errorResult({ error: "not_configured", message: "verify_fix requires recordingsDir" });
    }
    if (
      !(isMissionResultId(args.id) || isQueuedMissionId(args.id)) ||
      typeof args.fingerprint !== "string" ||
      !/^[0-9a-f]{16}$/.test(args.fingerprint)
    ) {
      return errorResult({ error: "invalid_args", message: "verify_fix requires a mission result 'id' (or missionId) and a 16-hex 'fingerprint'" });
    }
    const tagged = tagsArg(args);
    if ("error" in tagged) return errorResult(tagged.error);
    let options: Omit<McpVerifyFixArgs, "resultPath" | "fingerprint">;
    try {
      options = verifyFixOptions(args);
    } catch (err) {
      const body = argErrorBody(err);
      if (body === undefined) throw err;
      return errorResult(body);
    }
    // #205: the same pre-run checks as `jevitate verify-fix` (orphan sweep, starved-host refusal).
    const starved = await resourcePreflight({});
    if (starved !== null) return errorResult({ error: "refused", code: starved.error?.code, message: starved.error?.message });
    const ref = await resolveResultId(args.id, "verify_fix");
    if ("response" in ref) {
      // A mission still queued/running has nothing to verify yet: never a pass.
      return ref.pending === undefined ? ref.response : errorResult({ error: "not_ready", ...ref.pending });
    }
    // The first candidate that exists (usability results may sit in the UX reports dir).
    const candidates = resultPathsFor(ref.resultId);
    let resultPath = candidates[0]!;
    for (const path of candidates) {
      try {
        await access(path);
        resultPath = path;
        break;
      } catch {
        // Try the next candidate dir.
      }
    }
    try {
      const fingerprint = args.fingerprint;
      const report = await withRunMetadata({ tags: tagged.tags }, () => verifyFixImpl({ ...options, resultPath, fingerprint }));
      const body = stampRunMetadata(
        {
          id: args.id,
          ...(ref.missionId === undefined ? {} : { missionId: ref.missionId, resultId: ref.resultId }),
          status: report.verdict,
          ...report,
        },
        { tags: tagged.tags },
      );
      // Neither is a pass: `inconclusive` proved nothing either way, `intermittent` (#74) means the
      // signal fired on SOME but not all fresh-context replays — never trustworthy as "fixed".
      return report.verdict === "inconclusive" || report.verdict === "intermittent" ? errorResult(body) : jsonResult(body);
    } catch (err) {
      return errorResult({ error: "verify_fix_refused", message: err instanceof Error ? err.message : String(err) });
    }
  };

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
      handler: verifyFixTool,
    },
    get_mission_result: {
      description:
        "Read a mission's TYPED result by id: a result stem (explore-|coverage-|exploratory-|adversarial-|feature-|usability-<stamp>, e.g. adversarial-2026-09-23T00-00-00-000Z) or a queue_exploration missionId. A queued mission reports status queued | running (pending: true — poll again; `jevitate mission run` drains the queue) or failed (an error: it could not run). A finished one: status is clean | defects-found | hang | intermittent | inconclusive | crashed, with the matching CLI exit code. A broken run (inconclusive/crashed) is returned as an error result — never a pass. An adversarial result carries `coverage` (target controls exercised/total, forms submitted, strategies applied vs found nothing, out-of-scope steps): a run below its coverage thresholds is inconclusive, never clean.",
      inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
      handler: getMissionResult,
    },
  };
}
