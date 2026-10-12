import { FixturePathError } from "@jevitate/recording";
import { MissingCredentialError, UsageTracker, type JudgmentPort, type GenerationPort } from "@jevitate/ai-core";
import { FixtureNotFoundError, ScopeUnderivableError, UnauthorizedExploreTargetError, type SuccessCheck } from "@jevitate/explore";
import { ok, fail } from "../envelope.js";
import { parseSuccessSpec, resolveExploreAllowlist } from "../explore-api.js";
import { triagedServerLog } from "../explore-shared.js";
import { runUsabilityMission, UsabilityInvariantsUnsupportedError } from "../ux-api.js";
import { UxConfigError } from "../ux-config.js";
import { MinConfidenceError, QualityPolicyError, MaxFindingsPerRouteError, ProductFactsError } from "@jevitate/ux";
import { GatewaySelectionError, buildExploreGateways } from "../cli-shared.js";
import type { ExploreRunContext } from "./shared.js";

/** `--strategy usability` (moved verbatim out of registerExploreCommands). */
export async function runUsabilityStrategy(ctx: ExploreRunContext): Promise<void> {
  const { deps, o, emitExplore, strategy, target, browser, screenshotsOpt, emulation, overflow, withInvariants, serverLog, withPrefix, emitJourneyFailure, withEvidence, conversation, secretFields, secretCommand } = ctx;
  if (!o.url || !o.goal) {
    emitExplore(fail("E_EXPLORE_ARGS", "--url and --goal (the job) are required for --strategy usability"));
    return;
  }
  if (!o.appClass) {
    emitExplore(fail("E_UX_ARGS", "--app-class is required for --strategy usability"));
    return;
  }
  // #225: --success is never ignored — an independent completion check on the job, parsed and
  // validated exactly as for --strategy goal (same kinds, same --success-when / vacuous rules).
  let uxSuccessChecks: SuccessCheck[];
  try {
    uxSuccessChecks = o.success.map(parseSuccessSpec);
  } catch (err) {
    emitExplore(fail("E_EXPLORE_ASSERTION", String(err instanceof Error ? err.message : err)));
    return;
  }
  if (o.successWhen !== undefined && o.successWhen !== "held" && o.successWhen !== "final" && o.successWhen !== "each") {
    emitExplore(fail("E_EXPLORE_ARGS", `--success-when must be "final", "held" or "each", got ${JSON.stringify(o.successWhen)}`));
    return;
  }
  if (uxSuccessChecks.length === 0 && (o.successWhen !== undefined || o.allowVacuousChecks === true)) {
    emitExplore(fail("E_EXPLORE_ARGS", "--success-when and --allow-vacuous-checks need at least one --success check"));
    return;
  }
  const uxAllowlist = resolveExploreAllowlist(o.url, o.allow);
  const uxBounds: Record<string, number> = {};
  if (o.maxActions !== undefined) uxBounds.maxActions = Number(o.maxActions);
  if (o.maxDecisions !== undefined) uxBounds.maxDecisions = Number(o.maxDecisions);
  let uxJudge: JudgmentPort;
  let uxGen: GenerationPort;
  let uxUsage: UsageTracker;
  try {
    ({ judge: uxJudge, gen: uxGen, usage: uxUsage } = await buildExploreGateways(deps, {
      real: o.real ?? false,
      fakeAi: o.fakeAi ?? false,
      jevProvider: o.jevProvider,
    }));
  } catch (err) {
    if (err instanceof MissingCredentialError || err instanceof GatewaySelectionError) {
      emitExplore(fail("E_AI_SETUP_REQUIRED", err.message));
    } else {
      emitExplore(fail("E_EXPLORE_SETUP", String(err instanceof Error ? err.message : err)));
    }
    return;
  }
  try {
    const result = await runUsabilityMission({
      ...(target === undefined ? {} : { target }),
      url: o.url,
      job: o.goal,
      allowlist: uxAllowlist,
      appContext: { appClass: o.appClass, job: o.goal },
      judge: uxJudge,
      gen: uxGen,
      usage: uxUsage,
      ...(o.minConfidence !== undefined ? { minConfidence: o.minConfidence } : {}),
      ...(o.show !== undefined ? { show: o.show } : {}),
      ...(o.maxFindingsPerPage !== undefined ? { maxFindingsPerRoute: o.maxFindingsPerPage } : {}),
      ...(o.product !== undefined ? { product: o.product } : {}),
      ...(o.polish === true ? { polish: true } : {}),
      ...(o.probeGuards === true ? { probeGuards: true } : {}),
      bounds: Object.keys(uxBounds).length > 0 ? uxBounds : undefined,
      conversation,
      secrets: o.secret.length > 0 ? o.secret : undefined,
      ...(secretFields.length > 0 ? { secretFields } : {}),
      ...(secretCommand === undefined ? {} : { secretCommand }),
    ...(o.secretCmdAttempts === undefined ? {} : { secretCommandAttempts: o.secretCmdAttempts }),
      fixture: o.fixture,
      outDir: o.out,
      browserPortFactory: deps.explore?.browserPortFactory,
      browser,
      ...screenshotsOpt,
      ...(emulation === undefined ? {} : { emulation }),
      overflow,
      ...(o.storageState !== undefined ? { storageState: o.storageState } : {}),
      ...(o.saveStorageState !== undefined ? { saveStorageState: o.saveStorageState } : {}),
      ...triagedServerLog(serverLog, uxJudge, o.real === true),
      ...withInvariants,
      ...(uxSuccessChecks.length === 0 ? {} : { successChecks: uxSuccessChecks }),
      ...(o.successWhen === "held" || o.successWhen === "final" || o.successWhen === "each" ? { successWhen: o.successWhen } : {}),
      ...(o.allowVacuousChecks === true ? { allowVacuousChecks: true } : {}),
      ...withPrefix,
      ...(o.actionDeltas === true ? { actionDeltas: true } : {}),
    });
    // UX findings are advisory (0); a failed --success check (#225) is 1, as on a goal run; a
    // broken run or an unavailable analysis is 2.
    emitExplore(ok(await withEvidence(result)), result.exitCode);
  } catch (err) {
    if (emitJourneyFailure(err)) return;
    if (err instanceof UnauthorizedExploreTargetError) {
      emitExplore(fail("E_UNAUTHORIZED_EXPLORE_TARGET", err.message));
    } else if (err instanceof ScopeUnderivableError) {
      // #224: no default route scope from --url — a usage error (64), refused before any browser.
      emitExplore(fail("E_EXPLORE_ARGS", err.message));
    } else if (err instanceof FixtureNotFoundError || err instanceof FixturePathError) {
      emitExplore(fail("E_EXPLORE_FIXTURE", err.message));
    } else if (err instanceof MinConfidenceError || err instanceof QualityPolicyError || err instanceof MaxFindingsPerRouteError || err instanceof UxConfigError) {
      emitExplore(fail("E_UX_ARGS", err.message));
    } else if (err instanceof UsabilityInvariantsUnsupportedError) {
      emitExplore(fail("E_EXPLORE_ARGS", err.message));
    } else if (err instanceof ProductFactsError) {
      emitExplore(fail(err.code, err.message));
    } else {
      emitExplore(fail("E_EXPLORE_RUN", String(err instanceof Error ? err.message : err)));
    }
  }
  return;
}
