import { MissingCredentialError, UsageTracker, type JudgmentPort, type GenerationPort } from "@jevitate/ai-core";
import { ScopeUnderivableError, UnauthorizedExploreTargetError, resolveCoverageThresholds, type CoverageThresholds } from "@jevitate/explore";
import { ok, fail } from "../envelope.js";
import { runAdversarialCliMission, CLI_ADVERSARIAL_STRATEGIES, resolveExploreAllowlist } from "../explore-api.js";
import { triagedServerLog } from "../explore-shared.js";
import { GatewaySelectionError, buildExploreGateways } from "../cli-shared.js";
import type { ExploreRunContext } from "./shared.js";

/** `--strategy adversarial` (moved verbatim out of registerExploreCommands). */
export async function runAdversarialStrategy(ctx: ExploreRunContext): Promise<void> {
  const { deps, o, emitExplore, strategy, target, browser, screenshotsOpt, emulation, overflow, withInvariants, serverLog, withPrefix, withScopeRegion, emitJourneyFailure, withEvidence, runFiling, issueFiler } = ctx;
  if (!o.url) {
    emitExplore(fail("E_EXPLORE_ARGS", "--url is required for --strategy adversarial"));
    return;
  }
  const advAllowlist = resolveExploreAllowlist(o.url, o.allow);
  let advJudge: JudgmentPort;
  let advGen: GenerationPort;
  let advUsage: UsageTracker;
  try {
    ({ judge: advJudge, gen: advGen, usage: advUsage } = await buildExploreGateways(deps, {
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

  let coverageThresholds: CoverageThresholds;
  try {
    coverageThresholds = resolveCoverageThresholds({
      ...(o.minControlCoverage === undefined ? {} : { minControlRatio: Number(o.minControlCoverage) }),
      requireFormSubmit: o.requireFormSubmit,
    });
  } catch (err) {
    emitExplore(fail("E_EXPLORE_ARGS", String(err instanceof Error ? err.message : err)));
    return;
  }
  const advBounds: Record<string, number> = {};
  if (o.maxActions !== undefined) advBounds.maxActions = Number(o.maxActions);
  if (o.maxDecisions !== undefined) advBounds.maxDecisions = Number(o.maxDecisions);
  try {
    const result = await runAdversarialCliMission({
      ...(target === undefined ? {} : { target }),
      ...(o.actionDeltas === true ? { actionDeltas: true } : {}),
      ...(o.blockOffAllowlistNavigation === true ? { blockOffAllowlistNavigation: true } : {}),
      seedUrl: o.url,
      allowlist: advAllowlist,
      usage: advUsage,
      ...(o.route.length > 0 ? { routeGlobs: o.route } : {}),
      coverageThresholds,
      bounds: Object.keys(advBounds).length > 0 ? advBounds : undefined,
      secrets: o.secret.length > 0 ? o.secret : undefined,
      ...(runFiling === undefined ? {} : { filing: runFiling }),
      issueFiler,
      ...(o.hangReplays === undefined ? {} : { hangReplays: o.hangReplays }),
      strategies: CLI_ADVERSARIAL_STRATEGIES,
      judgment: advJudge,
      generation: advGen,
      browserPortFactory: deps.explore?.browserPortFactory,
      browser,
      ...screenshotsOpt,
      ...(emulation === undefined ? {} : { emulation }),
      overflow,
      outDir: o.out,
      ...(o.storageState !== undefined ? { storageState: o.storageState } : {}),
      ...(o.saveStorageState !== undefined ? { saveStorageState: o.saveStorageState } : {}),
      ...withInvariants,
      ...triagedServerLog(serverLog, advJudge, o.real === true),
      ...withPrefix,
      ...withScopeRegion,
    });
    // The typed verdict gates CI: 0 clean · 1 defects found (a failing check) · 2 the run
    // itself broke (inconclusive/crashed) — see exit-codes.ts.
    emitExplore(ok(await withEvidence(result)), result.exitCode);
  } catch (err) {
    if (emitJourneyFailure(err)) return;
    if (err instanceof UnauthorizedExploreTargetError) {
      emitExplore(fail("E_UNAUTHORIZED_EXPLORE_TARGET", err.message));
    } else if (err instanceof ScopeUnderivableError) {
      // #224: no default route scope from --url — a usage error (64), refused before any browser.
      emitExplore(fail("E_EXPLORE_ARGS", err.message));
    } else {
      emitExplore(fail("E_EXPLORE_RUN", String(err instanceof Error ? err.message : err)));
    }
  }
  return;
}
