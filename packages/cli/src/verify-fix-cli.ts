import { parseScreenshotsArg, type ScreenshotsSpec } from "./run-screenshots.js";
import { Command } from "commander";
import { UnauthorizedExploreTargetError } from "@jevitate/explore";
import { ok, fail, type JsonEnvelope } from "./envelope.js";
import { runVerifyFix, VerifyFixInputError } from "./verify-fix-api.js";
import { LedgerError, ledgerEntryFor } from "./ledger-api.js";
import { TargetConfigError, loadTargetsFile } from "./target-config.js";
import { withFixtureFlags, type FixtureFlags } from "./fixture-cli.js";
import { LITERAL_SECRET_WARNING, SecretArgError, resolveSecretArgs } from "./secret-args.js";
import { withEngine } from "./engine.js";
import { positiveIntArg } from "./cli-args.js";
import { formatVerifyFixHuman } from "./cli-output.js";
import { type EmulationSpec } from "@jevitate/playwright";
import {
  type CliDeps,
  type BrowserLaunchFlags,
  withBrowserLaunchFlags,
  browserRunFromFlags,
  withDemoFlags,
  withScreenshotsFlag,
  type ScreenshotsFlags,
  type DemoFlags,
  type EmulationFlags,
  withEmulationFlags,
  emulationFromFlags,
  emitCommandResult,
  collectParam,
  environmentSeams,
  resolveDbPath,
} from "./cli-shared.js";

/** Registers `jevitate verify-fix`. */
export function registerVerifyFixCommands(program: Command, deps: CliDeps): void {
  // `verify-fix`: replays a finding's reproduction N times in FRESH browsers (#74) and reports
  // whether its fingerprint still fires. Exit 0 fixed · 1 still reproduces · 2 inconclusive ·
  // 4 intermittent (fired on some but not all replays — never reported as fixed) · 64 usage error.
  withScreenshotsFlag(withEmulationFlags(
    withFixtureFlags(
      withDemoFlags(
        withBrowserLaunchFlags(
          program
            .command("verify-fix")
            .description("replay a defect's repro from a mission result (or the ledger); passes only if the defect signal is absent on every replay"),
        ),
        { recordVideo: true },
      ),
    ),
  ))
    .argument("[fingerprint]", "the defect/hang fingerprint to verify (same as --fingerprint)")
    .option("--result <path>", "the mission's <stem>.result.json (written next to its Recording); default: the fingerprint's ledger entry (#195)")
    .option("--fingerprint <fp>", "the defect/hang fingerprint to verify")
    .option("--regressions-dir <path>", "regressions directory whose ledger/ is searched when --result is omitted (default: .jevitate/regressions)")
    .option("--storage-state <file>", "override the storageState the mission ran with")
    .option("--replays <n>", "fresh-context replays that confirm a fix (default 3)", positiveIntArg)
    .option(
      "--allow-emulation-override",
      "replay at --viewport/--device even though it differs from the finding's recorded emulation (#149); default: refused (fails closed)",
    )
    .option(
      "--invariants <file>",
      "re-check a declared-invariant defect with these invariant files (repeatable) instead of the spec saved with the mission",
      (v, prev: string[]) => [...prev, v],
      [] as string[],
    )
    .option(
      "--allow-log-cmd",
      "re-checking a server-log defect whose --log-source includes cmd:<command> needs this too (operator-declared only)",
      false,
    )
    .option(
      "--hang-replay-writes",
      "let a hang's replay re-send a paid/destructive write the run sent (default: the verdict is inconclusive, never replayed)",
    )
    .option(
      "--secret <value|env:VAR>",
      "REDACTION ONLY: a value kept out of the fixture log (repeatable), e.g. one a --before hook prints; env:VAR reads it from the environment",
      (v, prev: string[]) => [...prev, v],
      [] as string[],
    )
    .option(
      "--param <kv>",
      "#293: a Journey param as key=value (repeatable) for a finding found from a Journey branch point — its replays go through the same prefix; " +
        "a secret param (never persisted with the result) must be given again; redacted like --secret",
      collectParam,
      {} as Record<string, string>,
    )
    .option("--json", "emit the JSON envelope (default: a human summary)")
    .action(async function (this: Command, positional?: string) {
      const o = this.opts<
        {
          result?: string;
          fingerprint?: string;
          regressionsDir?: string;
          storageState?: string;
          replays?: string;
          allowEmulationOverride?: boolean;
          invariants: string[];
          allowLogCmd?: boolean;
          hangReplayWrites?: boolean;
          secret: string[];
          param: Record<string, string>;
          json?: boolean;
        } & BrowserLaunchFlags &
          DemoFlags &
          FixtureFlags &
          EmulationFlags &
          ScreenshotsFlags
      >();
      // #230: the re-check hint carries the same --result the user passed (never the ledger
      // fallback's own path, which formatVerifyFixHuman never sees).
      const emitVerify = (envelope: JsonEnvelope<unknown>, exitCode?: number): void =>
        emitCommandResult(program, envelope, {
          json: o.json === true,
          command: "verify-fix",
          human: (data) => formatVerifyFixHuman(data, { result: o.result }),
          ...(exitCode === undefined ? {} : { exitCode }),
        });
      // #195: `--secret env:VAR`, as on explore.
      try {
        const resolved = resolveSecretArgs(o.secret, process.env, "--secret");
        if (resolved.literals > 0) program.configureOutput().writeErr?.(LITERAL_SECRET_WARNING);
        o.secret = resolved.secrets;
      } catch (err) {
        if (!(err instanceof SecretArgError)) throw err;
        emitVerify(fail("E_VERIFY_FIX_ARGS", err.message));
        return;
      }
      let verifyFixEmulation: EmulationSpec | undefined;
      // #245: demo mode, resolved (a headed run without a display refused) before any browser opens.
      let browser: ReturnType<typeof browserRunFromFlags>;
      const fingerprint = o.fingerprint ?? positional;
      let screenshots: ScreenshotsSpec | undefined;
      try {
        screenshots = parseScreenshotsArg(o.screenshots);
        browser = browserRunFromFlags(o, deps.explore?.env ?? process.env);
        verifyFixEmulation = emulationFromFlags(o);
        if (fingerprint === undefined) throw new Error("a fingerprint is required: verify-fix <fp> or --fingerprint <fp>");
        if (o.fingerprint !== undefined && positional !== undefined && o.fingerprint !== positional) {
          throw new Error(`two different fingerprints given (${positional} and --fingerprint ${o.fingerprint})`);
        }
      } catch (err) {
        emitVerify(fail("E_VERIFY_FIX_ARGS", err instanceof Error ? err.message : String(err)));
        return;
      }
      try {
        // #195: without --result, the fingerprint's ledger entry is the repro material (the run's output may be long gone).
        const resultPath = o.result ?? ledgerEntryFor(fingerprint, o.regressionsDir);
        const report = await runVerifyFix({
          targets: loadTargetsFile(deps.explore?.targetsConfigPath),
          resultPath,
          fingerprint,
          ...(o.storageState !== undefined ? { storageState: o.storageState } : {}),
          ...(o.replays !== undefined ? { replays: Number(o.replays) } : {}),
          ...(o.invariants.length > 0 ? { invariantFiles: o.invariants } : {}),
          ...(o.allowLogCmd === undefined ? {} : { allowLogCmd: o.allowLogCmd }),
          ...(o.hangReplayWrites === true ? { hangReplayWrites: true } : {}),
          fixtureFlags: o,
          secrets: [...o.secret, ...Object.values(o.param).filter((v) => v !== "")],
          journeyPrefix: { params: o.param, dbPath: resolveDbPath(deps), environmentSeams: environmentSeams(deps) },
          browserPortFactory: deps.explore?.browserPortFactory,
          browser,
          ...(screenshots === undefined ? {} : { screenshots }),
          ...(verifyFixEmulation === undefined ? {} : { emulation: verifyFixEmulation }),
          ...(o.allowEmulationOverride === undefined ? {} : { allowEmulationOverride: o.allowEmulationOverride }),
        });
        emitVerify(ok(withEngine(report)), report.exitCode);
      } catch (err) {
        if (err instanceof VerifyFixInputError || err instanceof TargetConfigError || err instanceof LedgerError) {
          emitVerify(fail(err.code, err.message));
        } else if (err instanceof UnauthorizedExploreTargetError) {
          emitVerify(fail("E_UNAUTHORIZED_EXPLORE_TARGET", err.message));
        } else {
          emitVerify(fail("E_VERIFY_FIX", String(err instanceof Error ? err.message : err)));
        }
      }
    });
}
