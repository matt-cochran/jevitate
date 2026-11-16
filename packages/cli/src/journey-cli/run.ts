import { type CliDeps, JEV_PROVIDER_FLAG_HELP, jevProviderArg, collectParam, withBrowserLaunchFlags, withDemoFlags, withScreenshotsFlag, withEmulationFlags } from "../cli-shared.js";
import { withProjectFlags } from "../project-layout.js";
import { DEPRECATED_DIR_HELP } from "./shared.js";
import { TAG_FLAG, TAG_HELP, collectTag, taggedAction } from "../run-tags-cli.js";
import { Command, Option } from "commander";
import { withReplayAllowFlag, withEnvironmentFlags } from "../environments.js";
import { REPLAY_SECRET_FIELD_HELP } from "../secret-params.js";
import { intArg, positiveIntArg } from "../cli-args.js";
import { MAX_STEP_RESPONSE_TIMEOUT_MS } from "../journey-network-checks.js";
import { SECRET_MODE_FLAGS } from "../journey-secret-mode.js";
import { withFixtureFlags } from "../fixture-cli.js";
import { runJourneyRunAction } from "./run-action.js";

/** Registers `jevitate journey run`. */
export function registerJourneyRun(journey: Command, program: Command, deps: CliDeps): void {
  withScreenshotsFlag(withReplayAllowFlag(withEnvironmentFlags(withDemoFlags(withBrowserLaunchFlags(withEmulationFlags(withFixtureFlags(withProjectFlags(journey.command("run <id>"))))), { recordVideo: true }))))
    .option("--dir <path>", DEPRECATED_DIR_HELP)
    .option("--param <kv>", "param as key=value (repeatable); a secret one is on the command line: use --secret-field", collectParam, {} as Record<string, string>)
    .option("--secret-field <binding>", REPLAY_SECRET_FIELD_HELP, (v: string, prev: string[]) => [...prev, v], [] as string[])
    .option(
      "--storage-state <file>",
      "Playwright storageState JSON to start the session authenticated (#118: required when the journey declares metadata.requiresAuth); must exist",
    )
    // Ticket #7 (additive): opt a run into scoped self-healing. Default
    // `fail-closed` preserves Slice 1 behavior exactly (no healer wired). A
    // write/irreversible step NEVER auto-heals in any mode (enforced by the
    // runtime's write floor). `hybrid`/`full` need an AI gateway, selected
    // with --real/--fake-ai (mirrors `explore`); requesting a heal mode
    // without one fails CLOSED, never a silent unhealed run.
    .addOption(
      new Option("--secret-mode <mode>", "0.30.0: how a handback step (or a secret nobody supplied) is met on an automation-mode target: auto (the target's targets.json secretFields type it on its own origin, else the run holds for a person: jevitate inbox resume <holdId> opens it headed) | vault-autofill (the binding, or refuse E_SECRET_MODE_UNAVAILABLE) | visible-handback (always hold for a person) | fail-closed (never wait: quarantine at the step). A test-mode target never waits: E_HUMAN_STEP_IN_TEST_MODE")
        .choices([...SECRET_MODE_FLAGS])
        .default("auto"),
    )
    .option("--self-heal <mode>", "self-heal policy mode: fail-closed | hybrid | full (#453: hybrid/full need --changes and/or --change-note; a heal is proposed for review, exit 5 — never a pass)", "fail-closed")
    .option("--changes <range>", "#453: the git range that explains a break (e.g. HEAD~1..HEAD, main...HEAD; read-only, in the journeys dir's repo) — needs --self-heal hybrid|full")
    .option("--change-note <text>", "#453: a change note that explains a break (e.g. 'renamed \"Create New\" to \"Create\"'; repeatable) — needs --self-heal hybrid|full", (v: string, prev: string[]) => [...prev, v], [] as string[])
    .option("--heal-max-attempts <n>", "#453: candidates tried per broken step (default 2)", positiveIntArg)
    .option("--heal-max-model-calls <n>", "#453: model calls per broken step (default 6)", positiveIntArg)
    .option("--heal-max-ms <ms>", "#453: healing time per broken step in ms (default 60000)", positiveIntArg)
    .option("--heal-max-run-attempts <n>", "#453: candidates tried in the whole run (default 4)", positiveIntArg)
    .option("--heal-max-run-ms <ms>", "#453: healing time in the whole run in ms (default 180000)", positiveIntArg)
    .option("--real", "use live Jev + OpenRouter gateways for self-heal (requires keys)", false)
    .option("--fake-ai", "use deterministic fake gateways for self-heal (pipeline smoke only)", false)
    .option("--jev-provider <provider>", JEV_PROVIDER_FLAG_HELP, jevProviderArg)
    .option("--step-response-timeout <ms>", "#486: how long a step's responseStatus check waits for a matching request that was sent but has no response yet, e.g. a cold start after a deploy (default 15000). A late 2xx is an advisory slow-step finding (slowSteps), not a quarantine; a non-2xx, or no response within the bound, fails. A step's own responseTimeoutMs overrides it; at most 300000", intArg({ min: 1, max: MAX_STEP_RESPONSE_TIMEOUT_MS }))
    .option("--action-deltas", "opt-in (#303): record what each replayed step changed on the page (redacted, a code verdict per step) and compare it with the delta its Recording stored — returned as actionDeltas")
    .option("--no-done-check", "#800: skip the linked job's done check (two fresh-session readings, before step 1 and after the end state); the job reads unverified (basis no-check), which exits 2 unless project.json doneCheckPolicy is advisory")
    .option("--require-done-check", "#800: an unverified job (no done check, or one already true) exits 2 even when project.json doneCheckPolicy is advisory")
    .option("--retry", "#795: this run retries an earlier attempt: the job's done check is read first, in a fresh session, and a job that already reads true is not run again (E_RECONCILE_ALREADY_DONE, exit 2; an unreadable check is E_RECONCILE_UNREADABLE, exit 2)")
    .option("--json", "emit a JSON envelope")
    .option(TAG_FLAG, TAG_HELP, collectTag, [])
    .action(taggedAction(program, "journey run", function (this: Command, id: string): Promise<void> {
      return runJourneyRunAction(this, program, deps, id);
    }));
}
