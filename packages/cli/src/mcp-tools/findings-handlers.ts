import { isMissionResultId, isQueuedJourneyCallId, isQueuedMissionId, missionResultFileName, missionStatus, parseResultOutcome } from "@jevitate/mcp-facade";
import { FsJourneyCallQueueStore, FsMissionQueueStore } from "@jevitate/missions";
import { existsSync } from "node:fs";
import { access, readFile } from "node:fs/promises";
import { join } from "node:path";
import { runAsMcpInvocation, type McpInvocation } from "../approval-provenance.js";
import { RunGuardRefusedError, runGuardRefusalBody } from "../mcp-run-guard.js";
import { stampRunMetadata, withRunMetadata } from "../run-metadata.js";
import { browserRunFromFlags, emulationFromFlags } from "../cli-shared.js";
import { parseScreenshotsArg } from "../run-screenshots.js";
import { redactSensitiveText } from "../terminal-result.js";
import { McpArgError, argErrorBody, optBool, optInt, optNamedSessions, optPath, optExtensions, optRecordVideo, optScreenshots, optString, optStringArray, optViewport } from "../mcp-args.js";
import { resourcePreflight } from "../resource-preflight.js";
import { jsonResult, errorResult, governanceArgs, goalOutcomeOf, defectStatusOf, resultField, tagsArg } from "./shared.js";
import type { McpApiDeps, McpToolResult, McpVerifyFixArgs } from "../mcp-api.js";

/** Why a mission result id resolved: a readable result stem, or a response/pending mission to poll. */
export type ResolveResultIdResult =
  | { resultId: string; missionId?: string }
  | { response: McpToolResult; pending?: Record<string, unknown> };

/**
 * get_mission_result: the id is either a result stem (`explore-<stamp>`, `usability-<stamp>.recording`, …) or a
 * `queue_exploration` missionId (#117): the latter resolves through the mission's queue record —
 * `queued`/`running` is reported as such (not an error, not a result), `failed` as an error, and
 * `done` reads the result its drain wrote. Both shapes are closed regexes; nothing caller-shaped
 * ever reaches a path.
 */
export async function resolveResultId(deps: McpApiDeps, id: unknown, tool: string): Promise<ResolveResultIdResult> {
  if (isMissionResultId(id)) return { resultId: id };
  if (!isQueuedMissionId(id)) {
    return {
      response: errorResult({
        error: "invalid_args",
        message: `${tool} requires a mission result 'id' (explore-|coverage-|exploratory-|adversarial-|feature-|usability-<stamp>), a queue_exploration missionId or a queue_journey callId`,
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
}

/** The dirs a result may live in: recordings, and (usability reviews) the UX reports dir. */
function resultPathsFor(deps: McpApiDeps, resultId: string): string[] {
  const file = missionResultFileName(resultId);
  const dirs = deps.resultDirsFor?.(resultId) ?? [deps.recordingsDir, ...(resultId.startsWith("usability-") ? [deps.uxReportsDir] : [])];
  return dirs.filter((d): d is string => d !== undefined).map((d) => join(d, file));
}

/**
 * GAPS 19 (#797): a `queue_journey` callId answers with its stored queue record, never a path: `queued` /
 * `running` is pending (poll again), `failed` (it could not run: a refusal `code`) is an error, and a
 * finished call reports its run's `outcome`, `exitCode` and `runId` (its `journey-evidence-<runId>`
 * directory). Held or inconclusive (exit 2) proves nothing yet, so it is an error result, never a pass.
 */
async function getJourneyCallResult(deps: McpApiDeps, id: string): Promise<McpToolResult> {
  if (!deps.missionQueueDir) return errorResult({ error: "not_configured", message: "get_mission_result requires missionQueueDir to resolve a queue_journey callId" });
  let record;
  try {
    record = await new FsJourneyCallQueueStore(deps.missionQueueDir).get(id);
  } catch {
    return errorResult({ error: "corrupt_mission", id });
  }
  if (record === null) return errorResult({ error: "not_found", id });
  const base = { id, callId: id, kind: "journey", journey: record.call.journey, enqueuedAtIso: record.enqueuedAtIso, ...(record.startedAtIso === undefined ? {} : { startedAtIso: record.startedAtIso }) };
  if (record.status === "queued" || record.status === "running") return jsonResult({ ...base, status: record.status, pending: true });
  const ended = { ...(record.finishedAtIso === undefined ? {} : { finishedAtIso: record.finishedAtIso }), ...(record.code === undefined ? {} : { code: record.code }) };
  // M2: masked as it is stored (drainJourneyCalls); masked again here, so a record an older drain wrote is too.
  if (record.status === "failed") return errorResult({ ...base, ...ended, status: "failed", isError: true, error: redactSensitiveText(record.error ?? "the queued Journey call could not run", []) });
  const exitCode = record.exitCode ?? 2;
  const body = { ...base, ...ended, status: record.outcome ?? "inconclusive", outcome: record.outcome ?? "inconclusive", exitCode, isError: exitCode === 2, ...(record.runId === undefined ? {} : { runId: record.runId }), ...(record.job === undefined ? {} : { job: record.job }) };
  return body.isError ? errorResult(body) : jsonResult(body);
}

/**
 * get_mission_result: reads a persisted typed mission result by ID only (the artifact stem the
 * CLI wrote) — never a caller-supplied path. The status carries the CLI exit code, and a run that
 * itself broke (inconclusive/crashed) is an MCP error result, so it can never read as a pass.
 */
export async function getMissionResult(deps: McpApiDeps, args: Record<string, unknown>): Promise<McpToolResult> {
  if (isQueuedJourneyCallId(args.id)) return getJourneyCallResult(deps, args.id);
  if (!deps.recordingsDir) {
    return errorResult({ error: "not_configured", message: "get_mission_result requires recordingsDir" });
  }
  const ref = await resolveResultId(deps, args.id, "get_mission_result");
  if ("response" in ref) return ref.response;
  const ids = { id: args.id, ...(ref.missionId === undefined ? {} : { missionId: ref.missionId, resultId: ref.resultId }) };
  let raw: string | undefined;
  for (const path of resultPathsFor(deps, ref.resultId)) {
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
}

/** #255: verify_fix's CLI-parity replay options, validated like `verify-fix`'s flags (typed, before any browser). */
function verifyFixOptions(pathRoots: readonly string[], environmentsFile: string | undefined, args: Record<string, unknown>): Omit<McpVerifyFixArgs, "resultPath" | "fingerprint"> {
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
      ...(env === undefined ? {} : { env, ...(environmentsFile === undefined ? {} : { environmentsFile }) }),
    };
  } catch (err) {
    throw new McpArgError(err instanceof Error ? err.message : String(err));
  }
}

export async function verifyFixTool(
  deps: McpApiDeps,
  pathRoots: readonly string[],
  verifyFixImpl: NonNullable<McpApiDeps["verifyFix"]>,
  args: Record<string, unknown>,
): Promise<McpToolResult> {
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
    options = verifyFixOptions(pathRoots, deps.environmentsFile, args);
  } catch (err) {
    const body = argErrorBody(err);
    if (body === undefined) throw err;
    return errorResult(body);
  }
  // #205: the same pre-run checks as `jevitate verify-fix` (orphan sweep, starved-host refusal).
  const starved = await resourcePreflight({});
  if (starved !== null) return errorResult({ error: "refused", code: starved.error?.code, message: starved.error?.message });
  const ref = await resolveResultId(deps, args.id, "verify_fix");
  if ("response" in ref) {
    // A mission still queued/running has nothing to verify yet: never a pass.
    return ref.pending === undefined ? ref.response : errorResult({ error: "not_ready", ...ref.pending });
  }
  // The first candidate that exists (usability results may sit in the UX reports dir).
  const candidates = resultPathsFor(deps, ref.resultId);
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
  // #789: an MCP invocation, so the floor applies (the production refusal, and a branch-point finding's Journey prefix).
  const invocation: McpInvocation = {};
  const guardRefusal = (): McpToolResult | undefined => (invocation.refusal instanceof RunGuardRefusedError ? errorResult(runGuardRefusalBody(invocation.refusal)) : undefined);
  try {
    const fingerprint = args.fingerprint;
    const report = await runAsMcpInvocation(() => withRunMetadata({ tags: tagged.tags }, () => verifyFixImpl({ ...options, resultPath, fingerprint })), invocation);
    const refused = guardRefusal();
    if (refused !== undefined) return refused;
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
    const refused = guardRefusal();
    if (refused !== undefined) return refused;
    return errorResult({ error: "verify_fix_refused", message: err instanceof Error ? err.message : String(err) });
  }
}
