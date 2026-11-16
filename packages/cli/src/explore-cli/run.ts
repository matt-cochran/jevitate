import { taggedAction } from "../run-tags-cli.js";
import { Command } from "commander";
import { type CliDeps } from "../cli-shared.js";
import { withRunMetadata } from "../run-metadata.js";
import { declareExploreCommand } from "./options.js";
import { runCoverageStrategy } from "./coverage-strategy.js";
import { runAdversarialStrategy } from "./adversarial-strategy.js";
import { runUsabilityStrategy } from "./usability-strategy.js";
import { runFeatureStrategy } from "./feature-strategy.js";
import { runGoalStrategy } from "./goal-strategy.js";
import { resolveExploreRunOptions } from "./run-options.js";
import { type ExploreOpts } from "./shared.js";

/**
 * Registers `jevitate explore` (every strategy: goal, coverage, exploratory, adversarial, usability, feature, multi-run).
 * `buildProgram` builds a fresh program for each run of a multi-run (#141/#143).
 */
export function registerExploreRun(program: Command, deps: CliDeps, buildProgram: (deps: CliDeps) => Command): void {
  declareExploreCommand(program)
    .action(taggedAction(program, "explore", async function (this: Command) {
      const prepared = await resolveExploreRunOptions(program, this.opts<ExploreOpts>(), deps, buildProgram, this);
      if (prepared === undefined) return;
      const { ctx, modeMeta } = prepared;
      await withRunMetadata(modeMeta, async () => {
        if (ctx.strategy === "coverage" || ctx.strategy === "exploratory") {
          await runCoverageStrategy({ ...ctx, strategy: ctx.strategy });
          return;
        }
        if (ctx.strategy === "adversarial") {
          await runAdversarialStrategy(ctx);
          return;
        }
        if (ctx.strategy === "usability") {
          await runUsabilityStrategy(ctx);
          return;
        }
        if (ctx.o.feature) {
          await runFeatureStrategy(ctx);
          return;
        }
        await runGoalStrategy(ctx);
      });
    }));
}
