import { existsSync, readFileSync } from "node:fs";
import { Command } from "commander";
import { fail, ok } from "./envelope.js";
import { browserRunFromFlags, collectParam, emitCommandResult, withBrowserLaunchFlags, type BrowserLaunchFlags, type CliDeps } from "./cli-shared.js";
import { isEnvironmentError, withEnvironmentFlags, fixtureRebaseUrl, type ResolvedJourneyEnvironment } from "./environments.js";
import { buildMissionFixtures, withFixtureFlags, type FixtureFlags } from "./fixture-cli.js";
import { withRecordedFixtures } from "./journey-fixtures.js";
import { FixtureSpecError } from "./mission-fixtures.js";
import { resolveCatalogDir } from "./catalog-api.js";
import { withProjectFlags } from "./project-layout.js";
import { UnknownJourneyError, type RunJourneyProgrammaticallyOptions } from "./journey-api.js";
import { ReadinessError, runJourneyReadiness, type ReadinessMode, type ReadinessReceipt } from "./journey-readiness.js";
import { EXIT_CODES } from "./exit-codes.js";
import { flaggedCatalogDir, journeyLayout } from "./journey-cli/shared.js";
import { ProjectConfigError } from "./project-config.js";

/**
 * #581 — `jevitate journey readiness <id> [--with <toId>] --mode report|replay|prove`
 * (docs/contracts/readiness-and-bundle.md §1). Reuses `journey-review-api` (the review sheet with
 * `--strict`), `journey-readiness` (the code-computed verdict) and, in `replay`/`prove`,
 * `journey run`/`chain`/`verify`. Refusals before any browser open exit 64 with `E_READINESS_*`.
 */

/** The exit code a verdict carries: ready 0, blocked 1, otherwise 2 (docs/contracts/readiness-and-bundle.md §3). */
function readinessExitCode(verdict: ReadinessReceipt["verdict"]): number {
  if (verdict === "technically-ready") return EXIT_CODES.ok;
  if (verdict === "blocked") return EXIT_CODES.defects;
  return EXIT_CODES.inconclusive;
}

function readinessHuman(receipt: ReadinessReceipt): string {
  const lines = [`${receipt.verdict} — ${receipt.mode} mode`];
  for (const check of receipt.checks) {
    lines.push(`  ${check.journey}  ${check.check.padEnd(14)} ${check.state}  ${check.detail}`);
  }
  for (const blocker of receipt.blockers) lines.push(`  blocker: ${blocker.journey} ${blocker.check} — ${blocker.why} (${blocker.next})`);
  for (const item of receipt.awaitingHuman) lines.push(`  awaiting a person: ${item.item} (${item.next})`);
  for (const command of receipt.next) lines.push(`  next: ${command}`);
  return `${lines.join("\n")}\n`;
}

/** Registers `jevitate journey readiness` (not wired into `journey-cli.ts` by this deliverable). */
export function registerJourneyReadiness(journey: Command, program: Command, deps: CliDeps): void {
  withBrowserLaunchFlags(withFixtureFlags(withEnvironmentFlags(withProjectFlags(journey.command("readiness <id>")))))
    .description("report a Journey's (or a linked pair's) technical readiness: static checks, and with --mode replay/prove a baseline replay and fresh mutation proofs")
    .option("--with <toId>", "a linked pair: <id> produces, <toId> consumes (#582 handoff is checked)")
    .option("--mode <mode>", "report (static only) | replay (baseline run/chain) | prove (replay + verify --mutate)", "report")
    .option("--param <kv>", "param as key=value (repeatable; required ones are refused by name before any browser)", collectParam, {} as Record<string, string>)
    .option("--requests <file>", "JSON Lines file of approved requests (required for a pair's replay/prove, as journey chain)")
    .option("--storage-state <file>", "Playwright storageState JSON to start each replay authenticated (as journey run)")
    .option("--json", "emit a JSON envelope")
    .action(async function (this: Command, id: string) {
      const locationFlags = this.opts<{ dir?: string; project?: string; journeysDir?: string }>();
      const layout = journeyLayout(program, deps, { dir: locationFlags.dir, project: locationFlags.project, journeysDir: locationFlags.journeysDir });
      if (layout === null) return;
      const { with: withId, mode: rawMode, param, requests: requestsFile, storageState: storageStateFlag, json } = this.opts<{
        with?: string;
        mode: string;
        param: Record<string, string>;
        requests?: string;
        storageState?: string;
        json?: boolean;
      }>();
      if (rawMode !== "report" && rawMode !== "replay" && rawMode !== "prove") {
        emitCommandResult(program, fail("E_READINESS_ARGS", `--mode must be report, replay or prove (got '${rawMode}')`), { json: json === true, exitCode: EXIT_CODES.usage, command: "journey readiness" });
        return;
      }
      const mode: ReadinessMode = rawMode;
      const { env: envName, baseUrl } = this.opts<{ env?: string; baseUrl?: string }>();
      if (storageStateFlag !== undefined && !existsSync(storageStateFlag)) {
        emitCommandResult(program, fail("E_READINESS_ARGS", `storage state not found: ${storageStateFlag}`), { json: json === true, exitCode: EXIT_CODES.usage, command: "journey readiness" });
        return;
      }
      let requests: string | undefined;
      if (requestsFile !== undefined) {
        try {
          requests = readFileSync(requestsFile, "utf8");
        } catch (err) {
          emitCommandResult(program, fail("E_READINESS_ARGS", `could not read requests file ${requestsFile}: ${err instanceof Error ? err.message : String(err)}`), { json: json === true, exitCode: EXIT_CODES.usage, command: "journey readiness" });
          return;
        }
      }
      // `--fixtures` is resolved per Journey against the store, as `journey run` does; a pair's chain takes none.
      const recordedFixtures = new Map<string, { flags: FixtureFlags }>();
      if (mode !== "report") {
        for (const journeyId of withId === undefined ? [id] : [id, withId]) {
          try {
            recordedFixtures.set(journeyId, await withRecordedFixtures(this.opts<FixtureFlags>(), { dir: layout.journeysDir, id: journeyId, deps: { cwd: () => process.cwd() } }));
          } catch (err) {
            if (!(err instanceof FixtureSpecError)) throw err;
            emitCommandResult(program, fail("E_READINESS_ARGS", err.message), { json: json === true, exitCode: EXIT_CODES.usage, command: "journey readiness" });
            return;
          }
        }
      }
      const fixtures = (journeyId: string, environment: ResolvedJourneyEnvironment | undefined): RunJourneyProgrammaticallyOptions["fixtures"] => {
        const recorded = recordedFixtures.get(journeyId);
        if (recorded === undefined) return undefined;
        const flags: FixtureFlags = {
          ...recorded.flags,
          ...(recorded.flags.before === undefined && environment?.hooks?.before !== undefined ? { before: environment.hooks.before } : {}),
          ...(recorded.flags.after === undefined && environment?.hooks?.after !== undefined ? { after: environment.hooks.after } : {}),
        };
        const storageState = storageStateFlag ?? environment?.storageState;
        return (site, allowedOrigins, sourceSite) => {
          const rebaseUrl = fixtureRebaseUrl(environment, sourceSite);
          return buildMissionFixtures(flags, {
            allowlist: [...allowedOrigins],
            baseUrl: site,
            ...(rebaseUrl === undefined ? {} : { rebaseUrl }),
            ...(storageState === undefined ? {} : { storageState }),
            ...(environment?.fixtures === undefined ? {} : { targetFixtures: environment.fixtures }),
          });
        };
      };

      if (json !== true && mode !== "report") {
        const count = withId === undefined ? 1 : 2;
        program.configureOutput().writeErr?.(`replays ${count} Journey${count === 1 ? "" : "s"} against ${baseUrl ?? envName ?? "the target"}; writes are observed, nothing is approved\n`);
      }

      let receipt: ReadinessReceipt;
      let browser: ReturnType<typeof browserRunFromFlags>;
      try {
        browser = browserRunFromFlags(this.opts<BrowserLaunchFlags>(), deps.explore?.env ?? process.env);
      } catch (err) {
        emitCommandResult(program, fail("E_READINESS_ARGS", err instanceof Error ? err.message : String(err)), { json: json === true, exitCode: EXIT_CODES.usage, command: "journey readiness" });
        return;
      }
      try {
        receipt = await runJourneyReadiness(
          {
            id,
            ...(withId === undefined ? {} : { with: withId }),
            mode,
            ...(envName === undefined ? {} : { env: envName }),
            ...(baseUrl === undefined ? {} : { baseUrl }),
            params: param,
            ...(requests === undefined ? {} : { requests }),
            ...(storageStateFlag === undefined ? {} : { storageState: storageStateFlag }),
            ...(browser === undefined ? {} : { browser }),
            browserPortFactory: deps.explore?.browserPortFactory,
            journeysDir: layout.journeysDir,
            catalogDir: resolveCatalogDir(deps.catalogDir, flaggedCatalogDir(layout)),
            ...(deps.explore?.targetsConfigPath === undefined ? {} : { targetsFile: deps.explore.targetsConfigPath }),
            ...(layout.projectDir === null ? {} : { projectDir: layout.projectDir }),
            ...(mode === "report" ? {} : { fixtures }),
          },
          {
            ...(deps.environmentsFile === undefined ? {} : { environmentsFile: deps.environmentsFile }),
          },
        );
      } catch (err) {
        if (err instanceof ReadinessError || err instanceof ProjectConfigError) {
          emitCommandResult(program, fail(err.code, err.message), { json: json === true, exitCode: EXIT_CODES.usage, command: "journey readiness" });
          return;
        }
        if (err instanceof UnknownJourneyError || isEnvironmentError(err)) {
          const code = "code" in err && typeof (err as { code?: unknown }).code === "string" ? (err as { code: string }).code : "E_UNKNOWN_JOURNEY";
          emitCommandResult(program, fail(code, err.message), { json: json === true, command: "journey readiness" });
          return;
        }
        emitCommandResult(program, fail("E_READINESS", err instanceof Error ? err.message : String(err)), { json: json === true, command: "journey readiness" });
        return;
      }
      emitCommandResult(program, ok(receipt), { json: json === true, exitCode: readinessExitCode(receipt.verdict), command: "journey readiness", human: readinessHuman });
    });
}
