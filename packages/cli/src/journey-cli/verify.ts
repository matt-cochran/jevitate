import type { Command } from "commander";
import { REPLAY_SECRET_FIELD_HELP, collectSecretField } from "../secret-params.js";
import { withFixtureFlags } from "../fixture-cli.js";
import { withEnvironmentFlags, withReplayAllowFlag } from "../environments.js";
import { type CliDeps, withBrowserLaunchFlags, withEmulationFlags, collectParam } from "../cli-shared.js";
import { withProjectFlags } from "../project-layout.js";
import { DEPRECATED_DIR_HELP } from "./shared.js";
import { runJourneyVerifyAction, type JourneyVerifySeams } from "./verify-action.js";

export type { JourneyVerifySeams } from "./verify-action.js";

/** Registers `jevitate journey verify`. */
export function registerJourneyVerify(journey: Command, program: Command, deps: CliDeps, seams: JourneyVerifySeams = {}): void {
  // #402 — the negative proof: replay the Journey once as recorded, then once per mutation (skip a
  // write step, abort its writes, type an empty value into a checked fill); each assertion must fail
  // under its paired mutation. `--plan` previews that exact pairing without opening a browser.
  withReplayAllowFlag(withEnvironmentFlags(withBrowserLaunchFlags(withEmulationFlags(withFixtureFlags(withProjectFlags(journey.command("verify <id>")))))))
    .description("preview or prove that each Journey assertion fails when its outcome is absent")
    .option("--mutate", "run the mutation proof")
    .option("--plan", "print the static mutation/assertion plan without opening a browser")
    .option("--status", "read a proof's durable progress and whether its verifier is live, exited or stale; no browser, no hook, nothing of the app's")
    .option("--resume", "with --mutate: continue an interrupted proof of the same Journey and configuration, or one that ended inconclusive on errored replays, reusing finished pairs after the base replay passes again and running errored pairs again; any mismatch, a damaged or over-24h checkpoint, or a live verifier is refused and never starts over")
    .option("--dir <path>", DEPRECATED_DIR_HELP)
    .option("--param <kv>", "param as key=value (repeatable)", collectParam, {} as Record<string, string>)
    .option("--secret-field <binding>", REPLAY_SECRET_FIELD_HELP, collectSecretField, [] as string[])
    .option("--storage-state <file>", "Playwright storageState JSON to start each replay authenticated (as journey run)")
    .option("--app-version <label>", "the app's release label the proof runs against, bound into its receipt (1-64 of [A-Za-z0-9._+-]); also JEVITATE_APP_VERSION. A reader that sets another reads the proof stale")
    .option("--json", "emit a JSON envelope")
    .action(async function (this: Command, id: string) {
      await runJourneyVerifyAction.call(this, id, program, deps, seams);
    });
}
