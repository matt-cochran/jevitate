import { readFile } from "node:fs/promises";
import { Command } from "commander";
import { SitePolicySchema, simulateTiming, type PlannedStep, type SitePolicy } from "@jevitate/domain";
import { SAFETY_RULES } from "@jevitate/explore";
import { ok, fail } from "./envelope.js";
import { sitePolicyKey } from "./site-gate-cli.js";
import { type CliDeps, resolveDbPath, withSitePolicyRepository, parsePlannedScript, emitJson } from "./cli-shared.js";

/** Registers `jevitate site`: `policy get|set|rules` and `simulate`. */
export function registerSiteCommands(program: Command, deps: CliDeps): void {
  const site = program
    .command("site")
    .description("per-site policies for Journey runs: human-like pacing, throttles, run budgets and quiet hours");
  const sitePolicy = site
    .command("policy")
    .description("read or set a site's policy (the site is the Journey's origin, e.g. https://app.example.com)");

  sitePolicy
    .command("get <site>")
    .description("print the policy for a site (an origin) and account")
    .option("--account <account>", "account id", "primary")
    .option("--db <path>", "sqlite db path")
    .option("--json", "emit a JSON envelope")
    .action(async function (this: Command, siteId: string) {
      const { account, db, json } = this.opts<{ account: string; db?: string; json?: boolean }>();
      try {
        const dbPath = resolveDbPath(deps, db);
        const policy = await withSitePolicyRepository(dbPath, (repository) => repository.get(sitePolicyKey(siteId), account));
        const envelope = ok(policy);
        if (json) {
          emitJson(program, envelope);
        } else {
          if (policy) {
            program.configureOutput().writeOut?.(
              `policy for '${siteId}' (version ${policy.version}): ${JSON.stringify(policy)}\n`
            );
          } else {
            program.configureOutput().writeOut?.(
              `no policy configured for '${siteId}' (account '${account}')\n`
            );
          }
          process.exitCode = 0;
        }
      } catch (err) {
        emitJson(program, fail("E_SITE_POLICY_GET", String(err)));
      }
    });

  sitePolicy
    .command("rules")
    .description(
      "#428: list the control safety rules every run applies — built-in heuristics (ids, what they match, their regex), operator patterns and hard " +
        "boundaries — and whether --allow-control can waive each (only the soft 'may cost money' heuristic). A refusal names the rule id it matched",
    )
    .option("--json", "emit a JSON envelope")
    .action(function (this: Command) {
      const { json } = this.opts<{ json?: boolean }>();
      const rules = SAFETY_RULES.map((r) => ({ ...r }));
      if (json) {
        emitJson(program, ok({ rules }));
        return;
      }
      const out = program.configureOutput().writeOut;
      for (const r of rules) {
        out?.(`${r.id}  [${r.source}] ${r.allowControl ? "waivable by --allow-control" : "not waivable by --allow-control"}\n`);
        out?.(`  matches: ${r.matches}\n`);
        if (r.regex !== undefined) out?.(`  regex:   /${r.regex}/i\n`);
        out?.(`  lifted by: ${r.liftedBy}\n`);
      }
      process.exitCode = 0;
    });

  sitePolicy
    .command("set <site>")
    .description(
      "set the policy for a site (an origin): Journey runs there are paced, throttled, budgeted and kept out of quiet hours " +
        "(journey run, source run, check, MCP run_journey); load run applies the pacing only",
    )
    .requiredOption("--file <path>", "path to a policy JSON file")
    .option("--account <account>", "account id", "primary")
    .option("--db <path>", "sqlite db path")
    .option("--json", "emit a JSON envelope")
    .action(async function (this: Command, siteId: string) {
      const { account, db, file, json } = this.opts<{
        account: string;
        db?: string;
        file: string;
        json?: boolean;
      }>();
      let policy: SitePolicy;
      try {
        const raw = await readFile(file, "utf8");
        policy = SitePolicySchema.parse(JSON.parse(raw));
      } catch (err) {
        emitJson(program, fail("E_INVALID_POLICY", String(err)));
        return;
      }
      try {
        const dbPath = resolveDbPath(deps, db);
        // The policy is stored (and reported) under the site's origin: a page URL names its origin.
        const site = sitePolicyKey(siteId);
        await withSitePolicyRepository(dbPath, (repository) => repository.set(site, account, policy));
        const envelope = ok({ site, account, version: policy.version });
        if (json) {
          emitJson(program, envelope);
        } else {
          program.configureOutput().writeOut?.(
            `policy for '${site}' (account '${account}') set to version ${policy.version}\n`
          );
          process.exitCode = 0;
        }
      } catch (err) {
        emitJson(program, fail("E_SITE_POLICY_SET", String(err)));
      }
    });

  site
    .command("simulate <site>")
    .description("estimate, offline, how long a planned step script takes under a site's pacing policy")
    .requiredOption("--script <path>", "path to a planned-step script JSON file")
    .option("--seed <n>", "deterministic RNG seed", "0")
    .option("--account <account>", "account id", "primary")
    .option("--db <path>", "sqlite db path")
    .option("--json", "emit a JSON envelope")
    .action(async function (this: Command, siteId: string) {
      const { account, db, script, seed, json } = this.opts<{
        account: string;
        db?: string;
        script: string;
        seed: string;
        json?: boolean;
      }>();
      let plannedScript: PlannedStep[];
      try {
        const raw = await readFile(script, "utf8");
        plannedScript = parsePlannedScript(raw);
      } catch (err) {
        emitJson(program, fail("E_INVALID_SCRIPT", String(err)));
        return;
      }
      const seedNum = Number(seed);
      if (!Number.isFinite(seedNum)) {
        emitJson(program, fail("E_INVALID_SEED", `--seed must be a finite number, got ${JSON.stringify(seed)}`));
        return;
      }
      try {
        const dbPath = resolveDbPath(deps, db);
        const policy = await withSitePolicyRepository(dbPath, (repository) => repository.get(sitePolicyKey(siteId), account));
        const interaction = policy?.interaction ?? {};
        const profile = simulateTiming(interaction, seedNum, plannedScript);
        const envelope = ok(profile);
        if (json) {
          emitJson(program, envelope);
        } else {
          const out = program.configureOutput().writeOut;
          for (const step of profile.steps) {
            out?.(`${step.kind} '${step.label}': ${step.delayMs}ms\n`);
          }
          out?.(`totalMs: ${profile.totalMs}\n`);
          process.exitCode = 0;
        }
      } catch (err) {
        emitJson(program, fail("E_SITE_SIMULATE", String(err)));
      }
    });
}
