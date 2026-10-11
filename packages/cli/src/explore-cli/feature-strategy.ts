import { ScopeUnderivableError, UnauthorizedExploreTargetError } from "@jevitate/explore";
import { ok, fail } from "../envelope.js";
import { runFeatureCliMission, resolveExploreAllowlist } from "../explore-api.js";
import { stallTimeoutMs } from "../cli-shared.js";
import type { ExploreOpts, ExploreRunContext } from "./shared.js";

/** `--feature <name>` (moved verbatim out of registerExploreCommands). */
export async function runFeatureStrategy(ctx: ExploreRunContext): Promise<void> {
  const { deps, emitExplore, target, browser, screenshotsOpt, emulation, withInvariants, withServerLog, withEvidence } = ctx;
  const o = ctx.o as ExploreOpts & { feature: string };
  if (!o.url) {
    emitExplore(fail("E_EXPLORE_ARGS", "--url is required with --feature"));
    return;
  }
  const featAllowlist = resolveExploreAllowlist(o.url, o.allow);
  const featBounds: Record<string, number> = {};
  if (o.maxActions !== undefined) featBounds.maxActions = Number(o.maxActions);
  if (o.maxDecisions !== undefined) featBounds.maxDecisions = Number(o.maxDecisions);
  const featStall = stallTimeoutMs(o.stallTimeout);
  if (featStall === null) {
    emitExplore(fail("E_EXPLORE_ARGS", `--stall-timeout must be a positive number of seconds (got ${JSON.stringify(o.stallTimeout)})`));
    return;
  }
  try {
    const result = await runFeatureCliMission({
      ...(featStall === undefined ? {} : { stallTimeoutMs: featStall }),
      seedUrl: o.url,
      allowlist: featAllowlist,
      capability: o.feature,
      routeGlobs: o.route ?? [],
      bounds: Object.keys(featBounds).length > 0 ? featBounds : undefined,
      outDir: o.out,
      browserPortFactory: deps.explore?.browserPortFactory,
      browser,
      ...screenshotsOpt,
      ...(emulation === undefined ? {} : { emulation }),
      ...(o.storageState !== undefined ? { storageState: o.storageState } : {}),
      ...(o.saveStorageState !== undefined ? { saveStorageState: o.saveStorageState } : {}),
      ...withInvariants,
      ...withServerLog,
      ...(target?.safety === undefined ? {} : { safety: target.safety }),
    });
    emitExplore(ok(await withEvidence(result)), result.exitCode);
  } catch (err) {
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
