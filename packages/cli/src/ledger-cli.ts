import type { Command } from "commander";
import type { BrowserLaunchOptions, BrowserPort } from "@jevitate/playwright";
import { UnauthorizedExploreTargetError } from "@jevitate/explore";
import { ok, fail, type JsonEnvelope } from "./envelope.js";
import { withEngine } from "./engine.js";
import { LedgerError, ledgerAdd, ledgerList, runLedgerVerify } from "./ledger-api.js";
import { TargetConfigError, loadTargetsFile } from "./target-config.js";
import { VERIFY_FIX_EXIT_CODES, VerifyFixInputError } from "./verify-fix-api.js";

/**
 * `jevitate ledger add|list|verify` (#195 part 6) — registered by `program.ts`, which supplies the
 * browser wiring. See `ledger-api.ts` for what an entry holds (and never holds).
 *
 * Exit codes: `add`/`list` 0 ok · 2 refused. `verify` 0 every entry fixed · 1 any still reproduces ·
 * 4 any intermittent · 2 any inconclusive (or the ledger/arguments were unusable).
 */

export interface LedgerCliDeps {
  readonly targetsConfigPath?: string;
  readonly browserPortFactory?: () => BrowserPort;
  /** Maps the command's browser launch flags to launch options (program.ts's `browserLaunchFromFlags`). */
  readonly browserLaunch?: (flags: object) => BrowserLaunchOptions | undefined;
}

const INPUT_EXIT = VERIFY_FIX_EXIT_CODES.inconclusive;

function emit(program: Command, envelope: JsonEnvelope<unknown>, exitCode: number): void {
  program.configureOutput().writeOut?.(`${JSON.stringify(envelope)}\n`);
  process.exitCode = exitCode;
}

function refuse(program: Command, err: unknown): void {
  if (err instanceof LedgerError || err instanceof VerifyFixInputError || err instanceof TargetConfigError) {
    emit(program, fail(err.code, err.message), INPUT_EXIT);
  } else if (err instanceof UnauthorizedExploreTargetError) {
    emit(program, fail("E_UNAUTHORIZED_EXPLORE_TARGET", err.message), INPUT_EXIT);
  } else {
    emit(program, fail("E_LEDGER", err instanceof Error ? err.message : String(err)), INPUT_EXIT);
  }
}

const collect = (v: string, prev: string[]): string[] => [...prev, v];
const DIR_HELP = "regressions directory; the ledger is its ledger/ subdirectory (default: the repo's .jevitate/regressions)";

export function registerLedgerCommands(program: Command, deps: LedgerCliDeps, withLaunchFlags: (cmd: Command) => Command): void {
  const ledger = program
    .command("ledger")
    .description("keep each finding's repro material by fingerprint, so verify-fix works long after the run's output is gone");

  ledger
    .command("add")
    .description("store a finding's redacted repro material (never a session or storage state) in the committed ledger")
    .argument("<result>", "the mission's <stem>.result.json that contains the finding")
    .argument("<fingerprint>", "the defect/hang fingerprint")
    .option("--ticket <id>", "the tracker ticket the finding was filed as")
    .option("--dir <path>", DIR_HELP)
    .option("--secret <value>", "refuse the entry if its material contains this value (repeatable)", collect, [] as string[])
    .option("--json", "emit a JSON envelope (the default output)")
    .action(function (this: Command, result: string, fingerprint: string) {
      const o = this.opts<{ ticket?: string; dir?: string; secret: string[] }>();
      try {
        const added = ledgerAdd({
          resultPath: result,
          fingerprint,
          secrets: o.secret,
          ...(o.ticket === undefined ? {} : { ticket: o.ticket }),
          ...(o.dir === undefined ? {} : { regressionsDir: o.dir }),
        });
        emit(program, ok(added), 0);
      } catch (err) {
        refuse(program, err);
      }
    });

  ledger
    .command("list")
    .description("list the ledger's entries (fingerprint, kind, title, ticket, when added)")
    .option("--dir <path>", DIR_HELP)
    .option("--json", "emit a JSON envelope (the default output)")
    .action(function (this: Command) {
      const o = this.opts<{ dir?: string }>();
      try {
        emit(program, ok({ entries: ledgerList(o.dir) }), 0);
      } catch (err) {
        refuse(program, err);
      }
    });

  withLaunchFlags(
    ledger
      .command("verify")
      .description("re-check every ledger entry (or the named ones) with verify-fix, from the ledger alone"),
  )
    .argument("[fingerprints...]", "only these entries (default: every entry)")
    .option("--ticket <id>", "only the entries filed as this ticket")
    .option("--dir <path>", DIR_HELP)
    .option("--storage-state <file>", "the session to replay an authenticated target with (entries never store one)")
    .option("--replays <n>", "fresh-context replays per entry that confirm a fix (default 3)")
    .option("--allow-log-cmd", "re-checking a server-log entry whose source is cmd:<command> needs this too", false)
    .option("--json", "emit a JSON envelope (the default output)")
    .action(async function (this: Command, fingerprints: string[]) {
      const o = this.opts<{ ticket?: string; dir?: string; storageState?: string; replays?: string; allowLogCmd?: boolean }>();
      try {
        const browser = deps.browserLaunch?.(o);
        const result = await runLedgerVerify({
          fingerprints,
          ...(o.ticket === undefined ? {} : { ticket: o.ticket }),
          ...(o.dir === undefined ? {} : { regressionsDir: o.dir }),
          targets: loadTargetsFile(deps.targetsConfigPath),
          ...(o.storageState === undefined ? {} : { storageState: o.storageState }),
          ...(o.replays === undefined ? {} : { replays: Number(o.replays) }),
          ...(o.allowLogCmd === true ? { allowLogCmd: true } : {}),
          ...(deps.browserPortFactory === undefined ? {} : { browserPortFactory: deps.browserPortFactory }),
          ...(browser === undefined ? {} : { browser }),
        });
        emit(program, ok(withEngine(result)), result.exitCode);
      } catch (err) {
        refuse(program, err);
      }
    });
}
