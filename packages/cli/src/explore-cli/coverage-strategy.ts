import { MissingCredentialError, UsageTracker, type JudgmentPort, type GenerationPort } from "@jevitate/ai-core";
import { ScopeUnderivableError, UnauthorizedExploreTargetError } from "@jevitate/explore";
import { ok, fail } from "../envelope.js";
import { runCoverageMission, resolveExploreAllowlist } from "../explore-api.js";
import { triagedServerLog } from "../explore-shared.js";
import { stallTimeoutMs, GatewaySelectionError, buildExploreGateways } from "../cli-shared.js";
import type { ExploreRunContext } from "./shared.js";

/** `--strategy coverage|exploratory` (moved verbatim out of registerExploreCommands). */
export async function runCoverageStrategy(ctx: ExploreRunContext<"coverage" | "exploratory">): Promise<void> {
  const { deps, o, emitExplore, strategy, target, browser, screenshotsOpt, emulation, overflow, withInvariants, serverLog, withPrefix, withScopeRegion, emitJourneyFailure, withEvidence } = ctx;
  if (!o.url) {
    emitExplore(fail("E_EXPLORE_ARGS", "--url is required"));
    return;
  }
  if (o.scope !== undefined && o.scope !== "app") {
    emitExplore(fail("E_EXPLORE_ARGS", `--scope must be "app" (got ${JSON.stringify(o.scope)})`));
    return;
  }
  const covAllowlist = resolveExploreAllowlist(o.url, o.allow);
  const covBounds: Record<string, number> = {};
  if (o.maxActions !== undefined) covBounds.maxActions = Number(o.maxActions);
  if (o.maxDecisions !== undefined) covBounds.maxDecisions = Number(o.maxDecisions);
  // Scope containment (#89, reusing #64's model): the start URL's route plus --route globs;
  // --scope app (or --route '/**') widens it to the whole app.
  const covRouteGlobs = [...o.route, ...(o.scope === "app" ? ["/**"] : [])];
  const covStall = stallTimeoutMs(o.stallTimeout);
  if (covStall === null) {
    emitExplore(fail("E_EXPLORE_ARGS", `--stall-timeout must be a positive number of seconds (got ${JSON.stringify(o.stallTimeout)})`));
    return;
  }

  let covJudge: JudgmentPort;
  let covGen: GenerationPort;
  let covUsage: UsageTracker;
  try {
    ({ judge: covJudge, gen: covGen, usage: covUsage } = await buildExploreGateways(deps, {
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
    const result = await runCoverageMission({
      ...(target === undefined ? {} : { target }),
      ...(o.actionDeltas === true ? { actionDeltas: true } : {}),
      ...(o.blockOffAllowlistNavigation === true ? { blockOffAllowlistNavigation: true } : {}),
      url: o.url,
      allowlist: covAllowlist,
      judge: covJudge,
      gen: covGen,
      usage: covUsage,
      bounds: Object.keys(covBounds).length > 0 ? covBounds : undefined,
      ...(covRouteGlobs.length > 0 ? { routeGlobs: covRouteGlobs } : {}),
      strategy,
      ...(covStall === undefined ? {} : { stallTimeoutMs: covStall }),
      outDir: o.out,
      browserPortFactory: deps.explore?.browserPortFactory,
      browser,
      ...screenshotsOpt,
      ...(emulation === undefined ? {} : { emulation }),
      overflow,
      ...(o.storageState !== undefined ? { storageState: o.storageState } : {}),
      ...(o.saveStorageState !== undefined ? { saveStorageState: o.saveStorageState } : {}),
      ...withInvariants,
      ...triagedServerLog(serverLog, covJudge, o.real === true),
      ...withPrefix,
      ...withScopeRegion,
    });
    // Typed verdict → exit code (0 clean · 1 defects · 2 crashed; see exit-codes.ts).
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
