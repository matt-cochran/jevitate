import { JEV_PROVIDER_FLAG_HELP, emitUsageLine, jevProviderArg } from "./cli-shared.js";
import { READINESS_FLAG_HELP, REAL_JEV_FLAG_HELP, jevSetupFor } from "./catalog-cli.js";
import { TAG_FLAG, TAG_HELP, collectTag, taggedAction } from "./run-tags-cli.js";
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { Command } from "commander";
import { FsJourneyStore, JourneyRegistry, ParamValidationError, journeyStepCount, listJourneyAnchors, type JourneyLintFinding } from "@jevitate/journey";
import { MissingCredentialError, UsageTracker, type GenerationPort } from "@jevitate/ai-core";
import { journeyExitCode, safeRunPolicy, type SelfHealMode } from "@jevitate/domain";
import { makeEvidenceSelfHealer } from "./self-heal-adapter.js";
import { CLI_HEAL_NAMES, JourneyHealArgsError, journeyHealBudget, journeyRunSummary, readJourneyChangeScope, validateJourneyHeal, type JourneyHealRequest } from "./journey-heal.js";
import { ChangesArgsError, ChangesInputError } from "./change-context.js";
import { positiveIntArg } from "./cli-args.js";
import type { ChangeScope } from "@jevitate/runtime";
import { ok, fail } from "./envelope.js";
import { SiteGateRefusedError, type SelfHealer } from "@jevitate/runtime";
import { runJourneyProgrammatically, promoteJourney, lintJourneyById, WeakJourneyError, UnknownJourneyError, JourneyRequiresAuthError, StaleReviewError } from "./journey-api.js";
import { ReviewSheetError, renderReviewMarkdown, renderReviewText, reviewSheetHash } from "./journey-review.js";
import { reviewJourneyById } from "./journey-review-api.js";
import { NotImplementedError } from "./not-implemented.js";
import { listStaleJourneys, renderStaleJourneys } from "./journey-stale-api.js";
import { migrateStepIds, renderMigrateStepIds } from "./journey-migrate-api.js";
import { ReviewSidecarError } from "./journey-review-store.js";
import { JourneyProposalArgsError } from "./journey-api.js";
import { JourneyProposalInvalidError, JourneyProposalNotFoundError, JourneyProposalProofError, JourneyProposalStaleError, isProposalId } from "./journey-proposal-store.js";
import { rejectionProvenance } from "./approval-provenance.js";
import { UnvettedLinksError, resolveCatalogDir } from "./catalog-api.js";
import { CatalogInputError } from "./catalog.js";
import { ApprovalFindingsError } from "./pre-approval.js";
import { approvalRefusal, checkNonInteractiveReason, describeProvenance, makeApprovalConfirm } from "./approval-provenance.js";
import { TargetConfigError } from "./target-config.js";
import { ExtensionMismatchError } from "./browser-run-options.js";
import { parseScreenshotsArg, type ScreenshotsSpec } from "./run-screenshots.js";
import { withSiteGate } from "./site-gate-cli.js";
import { registerJourneyAnnotateCommand } from "./journey-annotate-cli.js";
import { registerJourneyDemoCommand } from "./journey-demo-cli.js";
import { journeyIntentCoverage } from "./journey-annotate-api.js";
import { buildMissionFixtures, checkSetupRefs, withFixtureFlags, type FixtureFlags } from "./fixture-cli.js";
import { FixtureSetupError, FixtureSpecError, UnboundSetupRefError } from "./mission-fixtures.js";
import { withEngine, currentEngineInfo } from "./engine.js";
import { renderJourneyLintSarif } from "./journey-lint-sarif.js";
import { verifyAssertionLine, verifyExitCode, verifyJourneyMutations } from "./journey-verify.js";
import { publishJourneyToSource, realGhPort, NotPromotedError, NoDeclaredOriginsError } from "./source-api.js";
import { UnknownSourceError, EmbeddedSecretError, UndeclaredOriginError } from "@jevitate/sources";
import { type EmulationSpec } from "@jevitate/playwright";
import { environmentFromFlags, isEnvironmentError, withEnvironmentFlags, type EnvironmentFlags, type ResolvedJourneyEnvironment } from "./environments.js";
import {
  type CliDeps,
  resolveDbPath,
  resolveJourneysDir,
  resolveSourceApiDeps,
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
  collectParam,
  emitJson,
  environmentSeams,
  writeRawResult,
  GatewaySelectionError,
  buildExploreGateways,
} from "./cli-shared.js";

/** #401: one human line per lint finding — level, step (when it has one), rule, message. */
/** #432: the targets.json a review sheet reads its site's safety config from (the CLI's own seam). */
function targetsOpts(deps: CliDeps): { targetsFile?: string } {
  const file = deps.explore?.targetsConfigPath;
  return file === undefined ? {} : { targetsFile: file };
}

function lintFindingLine(finding: JourneyLintFinding): string {
  const message = finding.message.replace(/^step \d+: /, "");
  return `${finding.level}  ${finding.step === undefined ? "" : `step ${finding.step}  `}${finding.rule}  ${message}${finding.fix === undefined ? "" : ` — fix: ${finding.fix}`}`;
}

/** Registers `jevitate journey`: `list|find|run|promote|lint|verify|anchors|annotate|demo|publish`. */
export function registerJourneyCommands(program: Command, deps: CliDeps): void {
  const journey = program.command("journey").description("manage and run promoted Journeys (regression-test replays)");

  /**
   * `journey list` = ALL journeys' metadata via the store directly
   * (promoted AND unpromoted) — a local/dev-facing listing of everything on
   * disk. `journey find` (below) = promoted-only, via `JourneyRegistry.find`
   * — the same promoted-only projection external callers (e.g. the
   * mcp-facade) see. Keeping these distinct means `list` is useful for
   * authoring/debugging while `find` genuinely reflects what's discoverable.
   */
  journey
    .command("list")
    .option("--dir <path>", "journeys directory (default: the repo's .jevitate/journeys; outside a repo ~/.jevitate/journeys)")
    .option("--json", "emit a JSON envelope")
    .action(async function (this: Command) {
      const { dir, json } = this.opts<{ dir?: string; json?: boolean }>();
      try {
        const store = new FsJourneyStore(resolveJourneysDir(deps, dir));
        const metas = await store.list();
        const envelope = ok(metas);
        if (json) {
          emitJson(program, envelope);
        } else {
          const out = program.configureOutput().writeOut;
          if (metas.length === 0) {
            out?.("no journeys yet — record one with `jevitate record` (see jevitate record --help)\n");
          } else {
            for (const m of metas) {
              // #437: how a promoted Journey's approval was made ("approved non-interactively (likely an agent: CLAUDECODE)").
              const how = m.promoted && m.approval !== undefined ? ` — ${describeProvenance(m.approval.provenance)}` : "";
              out?.(`${m.id}\t${m.name}${m.promoted ? "" : " (unpromoted)"}${how}\n`);
            }
          }
          process.exitCode = 0;
        }
      } catch (err) {
        emitJson(program, fail("E_JOURNEY_LIST", String(err)));
      }
    });

  // RULING 5: uses `JourneyRegistry.find` (from `@jevitate/journey`) directly —
  // NEVER `@jevitate/mcp-facade`'s `findCapabilities` — Slice 1 forbids the CLI
  // depending on `@jevitate/mcp-facade`. `JourneyRegistry.find` is already
  // promoted-only, so this is the same promoted-only view without the
  // forbidden dependency.
  journey
    .command("find <query>")
    .option("--dir <path>", "journeys directory (default: the repo's .jevitate/journeys; outside a repo ~/.jevitate/journeys)")
    .option("--json", "emit a JSON envelope")
    .action(async function (this: Command, query: string) {
      const { dir, json } = this.opts<{ dir?: string; json?: boolean }>();
      try {
        const store = new FsJourneyStore(resolveJourneysDir(deps, dir));
        const registry = new JourneyRegistry(store);
        const metas = await registry.find(query);
        const capabilities = metas.map((m) => ({
          id: m.id,
          name: m.name,
          description: m.description,
          params: m.params,
        }));
        const envelope = ok(capabilities);
        if (json) {
          emitJson(program, envelope);
        } else {
          const out = program.configureOutput().writeOut;
          for (const c of capabilities) {
            out?.(`${c.id}\t${c.name}\tparams=[${c.params.join(", ")}]\n`);
          }
          process.exitCode = 0;
        }
      } catch (err) {
        emitJson(program, fail("E_JOURNEY_FIND", String(err)));
      }
    });

  withScreenshotsFlag(withEnvironmentFlags(withDemoFlags(withBrowserLaunchFlags(withEmulationFlags(withFixtureFlags(journey.command("run <id>")))), { recordVideo: true })))
    .option("--dir <path>", "journeys directory (default: the repo's .jevitate/journeys; outside a repo ~/.jevitate/journeys)")
    .option("--param <kv>", "param as key=value (repeatable)", collectParam, {} as Record<string, string>)
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
    .option("--action-deltas", "opt-in (#303): record what each replayed step changed on the page (redacted, a code verdict per step) and compare it with the delta its Recording stored — returned as actionDeltas")
    .option("--json", "emit a JSON envelope")
    .option(TAG_FLAG, TAG_HELP, collectTag, [])
    .action(taggedAction(program, "journey run", async function (this: Command, id: string) {
      const { env: envName, baseUrl } = this.opts<EnvironmentFlags>();
      // #247: --env/--base-url choose where the Journey runs (unknown env / bad file → 64, nothing opened).
      let environment: ResolvedJourneyEnvironment | undefined;
      try {
        environment = environmentFromFlags({ ...(envName === undefined ? {} : { env: envName }), ...(baseUrl === undefined ? {} : { baseUrl }) }, environmentSeams(deps));
      } catch (err) {
        if (!isEnvironmentError(err)) throw err;
        emitJson(program, fail(err.code, err.message));
        return;
      }
      const ownFixtureFlags = this.opts<FixtureFlags>();
      // The environment's fixtures/hooks apply when the flags name none (hooks still need --allow-shell-hooks).
      const fixtureFlags: FixtureFlags = {
        ...ownFixtureFlags,
        ...(ownFixtureFlags.before === undefined && environment?.hooks?.before !== undefined ? { before: environment.hooks.before } : {}),
        ...(ownFixtureFlags.after === undefined && environment?.hooks?.after !== undefined ? { after: environment.hooks.after } : {}),
      };
      const {
        dir,
        param,
        storageState: storageStateFlag,
        selfHeal,
        real,
        fakeAi,
        jevProvider,
        json,
        screenshots: _screenshots,
        actionDeltas,
        changes,
        changeNote,
        healMaxAttempts,
        healMaxModelCalls,
        healMaxMs,
        healMaxRunAttempts,
        healMaxRunMs,
        ...emulationFlags
      } = this.opts<{
        changes?: string;
        changeNote: string[];
        healMaxAttempts?: number;
        healMaxModelCalls?: number;
        healMaxMs?: number;
        healMaxRunAttempts?: number;
        healMaxRunMs?: number;
        actionDeltas?: boolean;
        dir?: string;
        param: Record<string, string>;
        storageState?: string;
        selfHeal: string;
        real?: boolean;
        fakeAi?: boolean;
        jevProvider?: string;
        json?: boolean;
      } & EmulationFlags & ScreenshotsFlags>();
      // --storage-state wins; else the environment's own session (~/.jevitate/targets.json[<origin>]).
      const storageState = storageStateFlag ?? environment?.storageState;

      if (storageState !== undefined && !existsSync(storageState)) {
        emitJson(program, fail("E_JOURNEY_RUN_ARGS", `storage state not found: ${storageState}`));
        return;
      }
      // #245: demo mode, resolved (a headed run without a display refused) before any browser opens.
      let browser: ReturnType<typeof browserRunFromFlags>;
      try {
        browser = browserRunFromFlags(this.opts<BrowserLaunchFlags & DemoFlags>(), deps.explore?.env ?? process.env);
      } catch (err) {
        emitJson(program, fail("E_JOURNEY_RUN_ARGS", err instanceof Error ? err.message : String(err)));
        return;
      }
      // #251: an unusable --screenshots value is a usage error (64), before any browser opens.
      let screenshots: ScreenshotsSpec | undefined;
      try {
        screenshots = parseScreenshotsArg(this.opts<ScreenshotsFlags>().screenshots);
      } catch (err) {
        emitJson(program, fail("E_JOURNEY_RUN_ARGS", err instanceof Error ? err.message : String(err)));
        return;
      }
      let journeyRunEmulation: EmulationSpec | undefined;
      try {
        journeyRunEmulation = emulationFromFlags(emulationFlags);
      } catch (err) {
        emitJson(program, fail("E_JOURNEY_RUN_ARGS", err instanceof Error ? err.message : String(err)));
        return;
      }

      if (selfHeal !== "fail-closed" && selfHeal !== "hybrid" && selfHeal !== "full") {
        emitJson(program, fail("E_SELF_HEAL_MODE", `--self-heal must be one of fail-closed | hybrid | full (got '${selfHeal}')`));
        return;
      }
      const selfHealMode = selfHeal as SelfHealMode;
      // #453 Q1: a heal needs a change context, and the change/budget flags need a heal — refused
      // (64) before any Journey lookup, git read, model gateway or browser.
      const healRequest: JourneyHealRequest = {
        selfHeal: selfHealMode,
        ...(changes === undefined ? {} : { changes }),
        changeNotes: changeNote,
        ...(healMaxAttempts === undefined ? {} : { maxAttempts: healMaxAttempts }),
        ...(healMaxModelCalls === undefined ? {} : { maxModelCalls: healMaxModelCalls }),
        ...(healMaxMs === undefined ? {} : { maxMs: healMaxMs }),
        ...(healMaxRunAttempts === undefined ? {} : { maxRunAttempts: healMaxRunAttempts }),
        ...(healMaxRunMs === undefined ? {} : { maxRunMs: healMaxRunMs }),
      };
      let healScope: ChangeScope | undefined;
      try {
        validateJourneyHeal(healRequest, CLI_HEAL_NAMES);
        if (selfHealMode !== "fail-closed") healScope = await readJourneyChangeScope(healRequest, resolveJourneysDir(deps, dir));
      } catch (err) {
        if (err instanceof JourneyHealArgsError || err instanceof ChangesArgsError || err instanceof ChangesInputError) {
          emitJson(program, fail(err.code, err.message));
          return;
        }
        throw err;
      }

      // When a heal mode is requested, build the SelfHealer HERE (this action
      // owns `deps` + the credential preflight); a missing/unselected gateway
      // fails CLOSED before any browser launch, rather than silently running
      // with no healer. fail-closed needs no gateway (identical to today).
      let selfHealer: SelfHealer | undefined;
      let policy = safeRunPolicy();
      // #163: a self-healing run makes model calls — their usage (and full cost) lands on its result.
      let healUsage: UsageTracker | undefined;
      if (selfHealMode !== "fail-closed") {
        // #453: the healer is evidence-only — its model is an advisory ranker; judgment never decides a heal.
        let gen: GenerationPort;
        try {
          ({ gen, usage: healUsage } = await buildExploreGateways(deps, { real: real ?? false, fakeAi: fakeAi ?? false, jevProvider }));
        } catch (err) {
          if (err instanceof MissingCredentialError || err instanceof GatewaySelectionError) {
            emitJson(program, fail("E_AI_SETUP_REQUIRED", err.message));
          } else {
            emitJson(program, fail("E_JOURNEY_RUN", String(err instanceof Error ? err.message : err)));
          }
          return;
        }
        selfHealer = makeEvidenceSelfHealer(gen, healUsage === undefined ? {} : { usage: healUsage });
        policy = { ...policy, selfHeal: { mode: selfHealMode, budget: journeyHealBudget(healRequest) } };
      }

      try {
        // `runJourneyProgrammatically` validates params UP FRONT (before any
        // browser launch). The default policy stays `safeRunPolicy()`
        // (fail-closed secret mode) — only `selfHeal.mode` is threaded from
        // the flag; a `--secret-mode` override is a later slice's concern.
        const result = await withSiteGate(resolveDbPath(deps), (siteGate) => runJourneyProgrammatically({
          ...(siteGate === undefined ? {} : { siteGate }),
          dir: resolveJourneysDir(deps, dir),
          id,
          params: param,
          policy,
          selfHealer,
          ...(healScope === undefined ? {} : { heal: { scope: healScope } }),
          browserPortFactory: deps.explore?.browserPortFactory,
          ...(browser === undefined ? {} : { browser }),
          ...(journeyRunEmulation === undefined ? {} : { emulation: journeyRunEmulation }),
          ...(screenshots === undefined ? {} : { screenshots }),
          ...(storageState !== undefined ? { storageState } : {}),
          ...(actionDeltas === true ? { actionDeltas: true } : {}),
          ...(environment === undefined ? {} : { environment }),
          // #140: fixture HTTP steps may only reach the journey's own site (authenticated from --storage-state);
          // #247: under an environment, its allowed origins.
          fixtures: (site) => {
            const fx = buildMissionFixtures(fixtureFlags, {
              allowlist: environment === undefined ? [site] : environment.allowedOrigins,
              baseUrl: site,
              ...(storageState !== undefined ? { storageState } : {}),
              ...(environment?.fixtures === undefined ? {} : { targetFixtures: environment.fixtures }),
            });
            checkSetupRefs({ "--param": Object.values(param) }, fx);
            return fx;
          },
        })).then((r) => withEngine(healUsage === undefined ? r : { ...r, usage: healUsage.snapshot() }));
        // #246 (informational, never failing): how many steps say why — `journey annotate` drafts the rest.
        const intent = await journeyIntentCoverage(resolveJourneysDir(deps, dir), id);
        if (intent !== undefined && intent.withoutObjective > 0 && !json) {
          program.configureOutput().writeErr?.(
            `note: ${intent.withoutObjective} of ${intent.steps} step(s) have no objective — draft them with \`jevitate journey annotate ${id}\`\n`,
          );
        }
        const envelope = ok(intent === undefined ? result : { ...result, intent });
        if (json) {
          emitJson(program, envelope);
          // #453: ok → 0; healed-pending-review → 5 (a proposed revision, never a pass); else 1.
          const code = journeyExitCode(result.outcome);
          if (code !== 0) process.exitCode = code;
        } else {
          writeRawResult(program, envelope.data);
          // #453: a self-heal run also says, in words, what happened and what a person does next.
          if (selfHealMode !== "fail-closed") program.configureOutput().writeErr?.(journeyRunSummary(id, result));
          process.exitCode = journeyExitCode(result.outcome);
        }
      } catch (err) {
        if (err instanceof SiteGateRefusedError || isEnvironmentError(err)) {
          emitJson(program, fail(err.code, err.message));
        } else if (err instanceof UnknownJourneyError) {
          emitJson(program, fail("E_UNKNOWN_JOURNEY", String(err.message)));
        } else if (err instanceof JourneyRequiresAuthError) {
          emitJson(program, fail("E_JOURNEY_REQUIRES_AUTH", String(err.message)));
        } else if (err instanceof ExtensionMismatchError) {
          emitJson(program, fail(err.code, err.message));
        } else if (err instanceof FixtureSetupError) {
          // Never run on unknown state: inconclusive, a configuration error (exit 2).
          emitJson(
            program,
            ok(withEngine({ outcome: "inconclusive", reason: err.message, failure: { kind: "configuration", message: err.message }, attribution: "configuration" })),
          );
          process.exitCode = 2;
        } else if (err instanceof FixtureSpecError || err instanceof UnboundSetupRefError) {
          emitJson(program, fail(err.code, err.message));
        } else if (err instanceof ParamValidationError) {
          emitJson(program, fail("E_INVALID_PARAMS", String(err.message)));
        } else {
          emitJson(program, fail("E_JOURNEY_RUN", String(err)));
        }
      }
    }));

  // #124 — promote a local Journey so it becomes discoverable/runnable (journey
  // find / MCP find_capabilities / run_journey), mirroring `mission target
  // promote`'s human-approval-gate semantics: promoting is a deliberate,
  // explicit act, never automatic (an authored Journey's `metadata.promoted`
  // always starts `false` — see `explore-author-journey`/`jevitate record`).
  journey
    .command("promote <id>")
    .description("promote a local Journey (human-approval gate) so it becomes discoverable/runnable; shows its review sheet first and records the approval")
    .option("--dir <path>", "journeys directory (default: the repo's .jevitate/journeys; outside a repo ~/.jevitate/journeys)")
    .option("--accept-weak <reason>", "#401: promote a Journey whose assertions cannot prove its outcome, recording the reason")
    .option("--reviewed-hash <hash>", "#432: the content hash of the review sheet you read; refused (E_JOURNEY_REVIEW_STALE) if the Journey changed since")
    .option("--review-sheet <file>", "#432: the review sheet file you read (journey review --out); its content hash binds the approval like --reviewed-hash")
    .option("--accept-unvetted <reason>", "#433: promote although its linked job/persona is not approved (unknown, draft or stale), recording the reason in approval.waivers")
    .option("--accept-findings <reason>", "#433: promote although pre-approval findings need an acknowledgment, recording the reason in approval.acceptedFindings")
    .option("--real", `${REAL_JEV_FLAG_HELP}; a conflicting/duplicate pair classification at or above the documented threshold then needs --accept-findings`)
    .option("--jev-provider <provider>", JEV_PROVIDER_FLAG_HELP, jevProviderArg)
    .option(
      "--non-interactive-approval <reason>",
      "#437: approve without a terminal confirmation (a scripted setup), recorded as channel non-interactive (ci under a CI marker) with the reason — never as a person's; check --require-approvals fails it. A coding agent never uses this: it hands the approval to a person",
    )
    .option("--proposal <pid>", "#453: accept this pending self-heal proposal (journey review shows it): the Journey is replaced by the proposed revision through every gate, bound to its proposedHash")
    .option("--reject-proposal <pid>", "#453: reject this pending self-heal proposal (needs --reason); the stored Journey is untouched")
    .option("--reason <text>", "#453: why the proposal is rejected (recorded with the rejection)")
    .option("--json", "emit a JSON envelope")
    .action(async function (this: Command, id: string) {
      const { dir, json, acceptWeak, reviewedHash: hashFlag, reviewSheet, acceptUnvetted, acceptFindings, real, jevProvider, nonInteractiveApproval, proposal, rejectProposal, reason } = this.opts<{
        proposal?: string;
        rejectProposal?: string;
        reason?: string;
        nonInteractiveApproval?: string;
        dir?: string;
        json?: boolean;
        acceptWeak?: string;
        reviewedHash?: string;
        reviewSheet?: string;
        acceptUnvetted?: string;
        acceptFindings?: string;
        real?: boolean;
        jevProvider?: string;
      }>();
      try {
        checkNonInteractiveReason(nonInteractiveApproval);
        const journeysDir = resolveJourneysDir(deps, dir);
        // #453: the proposal flags, validated before anything is read (an id is 12 hex characters — never a path).
        for (const [flag, value] of [["--proposal", proposal], ["--reject-proposal", rejectProposal]] as const) {
          if (value !== undefined && !isProposalId(value)) {
            emitJson(program, fail("E_JOURNEY_PROPOSAL_ARGS", `${flag} needs a proposal id (12 hex characters, shown by \`journey review\`), not '${value}'`));
            return;
          }
        }
        if (proposal !== undefined && rejectProposal !== undefined) {
          emitJson(program, fail("E_JOURNEY_PROPOSAL_ARGS", "--proposal and --reject-proposal are exclusive: accept or reject, not both"));
          return;
        }
        if (rejectProposal !== undefined && (reason ?? "").trim() === "") {
          emitJson(program, fail("E_JOURNEY_PROPOSAL_ARGS", "--reject-proposal needs --reason <text> (it is recorded with the rejection)"));
          return;
        }
        if (reason !== undefined && rejectProposal === undefined) {
          emitJson(program, fail("E_JOURNEY_PROPOSAL_ARGS", "--reason belongs to --reject-proposal"));
          return;
        }
        if (proposal !== undefined && reviewSheet !== undefined) {
          emitJson(program, fail("E_JOURNEY_PROPOSAL_ARGS", "--review-sheet binds the stored Journey's hash; with --proposal bind with --reviewed-hash <proposedHash>"));
          return;
        }
        if (rejectProposal !== undefined) {
          const rejected = await promoteJourney(journeysDir, id, {
            rejectProposal,
            reason: reason ?? "",
            rejectProvenance: rejectionProvenance(deps.approval, reason ?? ""),
          });
          if (json) emitJson(program, ok({ ...rejected.metadata, rejectedProposal: rejectProposal }));
          else {
            program.configureOutput().writeOut?.(`rejected proposal ${rejectProposal} for journey '${rejected.metadata.id}'; the stored Journey is unchanged\n`);
            process.exitCode = 0;
          }
          return;
        }
        // #432: what the reviewer read — a hash, a sheet file, or (human mode) the sheet shown below.
        let reviewedHash = hashFlag?.trim().toLowerCase();
        if (reviewedHash !== undefined && !/^[0-9a-f]{64}$/.test(reviewedHash)) {
          emitJson(program, fail("E_JOURNEY_REVIEW_ARGS", "--reviewed-hash needs the 64-hex content hash a review sheet shows"));
          return;
        }
        if (reviewSheet !== undefined) {
          let text: string;
          try {
            text = await readFile(reviewSheet, "utf8");
          } catch (e) {
            emitJson(program, fail("E_JOURNEY_REVIEW_ARGS", `cannot read --review-sheet ${reviewSheet}: ${e instanceof Error ? e.message : String(e)}`));
            return;
          }
          const fromSheet = reviewSheetHash(text);
          if (reviewedHash !== undefined && reviewedHash !== fromSheet) {
            emitJson(program, fail("E_JOURNEY_REVIEW_ARGS", "--reviewed-hash and --review-sheet name different content hashes"));
            return;
          }
          reviewedHash = fromSheet;
        }
        // #434/#435: the readiness checks and the catalog analysis run before every approval; Jev only with --real.
        const jev = await jevSetupFor(deps, resolveCatalogDir(deps.catalogDir), { real, jevProvider });
        if (!json) {
          // Human mode: the sheet is shown before promoting, and the approval binds to what was shown.
          const { review } = await reviewJourneyById(journeysDir, id, { ...targetsOpts(deps), catalogDir: resolveCatalogDir(deps.catalogDir), readiness: true, jev, action: "journey promote" });
          program.configureOutput().writeOut?.(`${renderReviewText(review)}\n`);
          reviewedHash ??= proposal === undefined ? review.contentHash : review.proposal?.proposedHash;
        }
        const journeyResult = await promoteJourney(journeysDir, id, {
          jev,
          ...(proposal === undefined ? {} : { proposal }),
          ...(acceptWeak === undefined ? {} : { acceptWeak }),
          ...(reviewedHash === undefined ? {} : { reviewedHash }),
          ...(acceptUnvetted === undefined ? {} : { acceptUnvetted }),
          ...(acceptFindings === undefined ? {} : { acceptFindings }),
          catalogDir: resolveCatalogDir(deps.catalogDir),
          // #437: a typed confirmation on a TTY (or the escape hatch, or the MCP channel), recorded as provenance.
          confirm: makeApprovalConfirm(deps.approval, nonInteractiveApproval === undefined ? {} : { nonInteractiveReason: nonInteractiveApproval }),
        });
        const envelope = ok(journeyResult.metadata);
        if (json) {
          emitJson(program, envelope);
        } else {
          program.configureOutput().writeOut?.(
            `promoted journey '${journeyResult.metadata.id}' (approved content hash ${journeyResult.metadata.approval?.contentHash ?? ""}; ${describeProvenance(journeyResult.metadata.approval?.provenance)})\n`,
          );
          process.exitCode = 0;
        }
      } catch (err) {
        const refusal = approvalRefusal(err);
        if (refusal !== null) {
          emitJson(program, fail(refusal.code, refusal.message));
        } else if (err instanceof UnknownJourneyError) {
          emitJson(program, fail("E_UNKNOWN_JOURNEY", String(err.message)));
        } else if (
          err instanceof JourneyProposalArgsError ||
          err instanceof JourneyProposalNotFoundError ||
          err instanceof JourneyProposalStaleError ||
          err instanceof JourneyProposalProofError ||
          err instanceof JourneyProposalInvalidError
        ) {
          emitJson(program, fail(err.code, err.message));
        } else if (err instanceof StaleReviewError || err instanceof ReviewSheetError || err instanceof ReviewSidecarError || err instanceof TargetConfigError) {
          emitJson(program, fail(err instanceof TargetConfigError ? "E_TARGET_CONFIG" : err.code, err.message));
        } else if (err instanceof WeakJourneyError) {
          // #401: the findings printed before the refusal (human mode); the reason the gate is here.
          if (!json) {
            const out = program.configureOutput().writeOut;
            for (const finding of err.findings) out?.(`${lintFindingLine(finding)}\n`);
          }
          emitJson(program, fail("E_JOURNEY_WEAK", String(err.message)));
          process.exitCode = 1;
        } else if (err instanceof UnvettedLinksError || err instanceof ApprovalFindingsError) {
          // #433: a gate on the catalog — exit 1 (a gating finding), like E_JOURNEY_WEAK.
          emitJson(program, fail(err.code, err.message));
          process.exitCode = 1;
        } else if (err instanceof CatalogInputError) {
          emitJson(program, fail(err.code, err.message));
        } else if (err instanceof GatewaySelectionError || err instanceof MissingCredentialError) {
          emitJson(program, fail("E_AI_SETUP_REQUIRED", err.message));
        } else {
          emitJson(program, fail("E_JOURNEY_PROMOTE", String(err instanceof Error ? err.message : err)));
        }
      }
    });

  // #432 — the review sheet a reviewer reads before `journey promote`: what the Journey does, what it
  // changes, what it proves, what changed since its last approval, and the content hash to bind to.
  journey
    .command("review [id]")
    .description(
      "a human-readable review sheet for promotion sign-off: summary, steps, side effects, inputs (names only), proof, change since last approval, content hash. #467: --stale (no id) lists every promoted Journey whose approval is stale, labelling step-id-only changes",
    )
    .option("--dir <path>", "journeys directory (default: the repo's .jevitate/journeys; outside a repo ~/.jevitate/journeys)")
    .option("--markdown", "render the sheet as Markdown")
    .option("--out <file>", "write the sheet (JSON with --json, Markdown with --markdown, else text) to this file")
    .option("--readiness", READINESS_FLAG_HELP)
    .option("--real", REAL_JEV_FLAG_HELP)
    .option("--jev-provider <provider>", JEV_PROVIDER_FLAG_HELP, jevProviderArg)
    .option("--stale", "#467: instead of one sheet, list every promoted Journey whose approval is stale (needs re-approval), labelling the ones whose only change is minted step ids")
    .option("--json", "emit a JSON envelope (the schema-checked sheet)")
    .action(async function (this: Command, id: string | undefined) {
      const { dir, json, markdown, out: outFile, readiness, real, jevProvider, stale } = this.opts<{ dir?: string; json?: boolean; markdown?: boolean; out?: string; readiness?: boolean; real?: boolean; jevProvider?: string; stale?: boolean }>();
      if (json === true && markdown === true) {
        emitJson(program, fail("E_JOURNEY_REVIEW_ARGS", "--json and --markdown are exclusive: pick one rendering"));
        return;
      }
      if (stale === true) {
        // #467: the stale list — read-only; one sheet's flags do not apply to it.
        if (id !== undefined || markdown === true || outFile !== undefined || readiness === true || real === true || jevProvider !== undefined) {
          emitJson(program, fail("E_JOURNEY_REVIEW_ARGS", "--stale lists every stale Journey: it takes no <id> and none of --markdown/--out/--readiness/--real/--jev-provider"));
          return;
        }
        try {
          const result = await listStaleJourneys({ journeysDir: resolveJourneysDir(deps, dir), catalogDir: resolveCatalogDir(deps.catalogDir) });
          if (json) emitJson(program, ok(result));
          else program.configureOutput().writeOut?.(renderStaleJourneys(result));
          process.exitCode = 0;
        } catch (err) {
          emitJson(program, fail(err instanceof NotImplementedError ? err.code : "E_JOURNEY_REVIEW", String(err instanceof Error ? err.message : err)));
        }
        return;
      }
      if (id === undefined) {
        emitJson(program, fail("E_JOURNEY_REVIEW_ARGS", "journey review needs a Journey <id> (or --stale for the list of Journeys needing re-approval)"));
        return;
      }
      try {
        const jev = await jevSetupFor(deps, resolveCatalogDir(deps.catalogDir), { real, jevProvider });
        const { review } = await reviewJourneyById(resolveJourneysDir(deps, dir), id, { ...targetsOpts(deps), catalogDir: resolveCatalogDir(deps.catalogDir), readiness: readiness === true, jev });
        const rendered = json ? `${JSON.stringify(review, null, 2)}\n` : markdown ? renderReviewMarkdown(review) : renderReviewText(review);
        if (outFile !== undefined) await writeFile(outFile, rendered, { mode: 0o600 });
        if (json) {
          emitJson(program, ok(review));
        } else if (outFile !== undefined) {
          program.configureOutput().writeOut?.(`review sheet for journey '${review.id}' written to ${outFile} (content hash ${review.contentHash})\n`);
        } else {
          program.configureOutput().writeOut?.(rendered);
        }
        emitUsageLine(program, review.jev);
        // #434: a review never fails on its findings (readiness and Jev answers are advice).
        process.exitCode = 0;
      } catch (err) {
        if (err instanceof UnknownJourneyError) {
          emitJson(program, fail("E_UNKNOWN_JOURNEY", String(err.message)));
        } else if (err instanceof ReviewSidecarError || err instanceof CatalogInputError) {
          emitJson(program, fail(err.code, err.message));
        } else if (err instanceof TargetConfigError) {
          emitJson(program, fail("E_TARGET_CONFIG", err.message));
        } else if (err instanceof GatewaySelectionError || err instanceof MissingCredentialError) {
          emitJson(program, fail("E_AI_SETUP_REQUIRED", err.message));
        } else if (err instanceof Error && err.message.startsWith("Invalid journey id")) {
          emitJson(program, fail("E_JOURNEY_REVIEW_ARGS", err.message));
        } else {
          emitJson(program, fail("E_JOURNEY_REVIEW", String(err instanceof Error ? err.message : err)));
        }
      }
    });

  // #467b — the one-time step-id backfill: CLI only (a repo rewrite the operator runs and commits; no MCP tool).
  journey
    .command("migrate")
    .description(
      "#467: one-time repo rewrite — --step-ids mints a stable step id on every recorded step that has none (every Journey and recording in the project) and points anchors at them. Changes every promoted Journey's hash: re-approve them (journey review --stale). Never approves. CLI only",
    )
    .option("--step-ids", "mint missing step ids (the only migration today; required)")
    .option("--dry-run", "report what would change, write nothing")
    .option("--dir <path>", "journeys directory (default: the repo's .jevitate/journeys; outside a repo ~/.jevitate/journeys)")
    .option("--json", "emit a JSON envelope")
    .action(async function (this: Command) {
      const { stepIds, dryRun, dir, json } = this.opts<{ stepIds?: boolean; dryRun?: boolean; dir?: string; json?: boolean }>();
      if (stepIds !== true) {
        emitJson(program, fail("E_JOURNEY_MIGRATE_ARGS", "name the migration: --step-ids"));
        return;
      }
      try {
        const result = await migrateStepIds({ journeysDir: resolveJourneysDir(deps, dir), projectDir: resolveCatalogDir(deps.catalogDir), dryRun: dryRun === true });
        if (json) emitJson(program, ok(result));
        else program.configureOutput().writeOut?.(renderMigrateStepIds(result));
        process.exitCode = 0;
      } catch (err) {
        emitJson(program, fail(err instanceof NotImplementedError ? err.code : "E_JOURNEY_MIGRATE", String(err instanceof Error ? err.message : err)));
      }
    });

  // #401 — the assertion-strength lint: which assertions cannot prove the Journey's outcome. CI can
  // gate on it (`--json`/`--sarif`, exit 1 when any error); `promote` runs the same lint first.
  journey
    .command("lint <id>")
    .description("report a Journey's weak assertions (writes without an asserted effect, visibility-only claims, nothing after the last write, …)")
    .option("--dir <path>", "journeys directory (default: the repo's .jevitate/journeys; outside a repo ~/.jevitate/journeys)")
    .option("--sarif <file>", "also write a SARIF 2.1.0 log here")
    .option("--json", "emit a JSON envelope")
    .action(async function (this: Command, id: string) {
      const { dir, json, sarif } = this.opts<{ dir?: string; json?: boolean; sarif?: string }>();
      try {
        const result = await lintJourneyById(resolveJourneysDir(deps, dir), id, { catalogDir: resolveCatalogDir(deps.catalogDir) });
        if (sarif !== undefined) {
          const log = renderJourneyLintSarif({ id: result.id, findings: result.findings, version: currentEngineInfo().version });
          await writeFile(sarif, `${JSON.stringify(log, null, 2)}\n`);
        }
        if (json) {
          emitJson(program, ok({ id: result.id, findings: result.findings, errors: result.errors, warnings: result.warnings }));
        } else {
          const out = program.configureOutput().writeOut;
          for (const finding of result.findings) out?.(`${lintFindingLine(finding)}\n`);
          out?.(`${result.errors} error(s), ${result.warnings} warning(s) — journey '${result.id}'\n`);
        }
        process.exitCode = result.errors > 0 ? 1 : 0;
      } catch (err) {
        if (err instanceof UnknownJourneyError) {
          emitJson(program, fail("E_UNKNOWN_JOURNEY", String(err.message)));
        } else {
          emitJson(program, fail("E_JOURNEY_LINT_ARGS", String(err instanceof Error ? err.message : err)));
        }
      }
    });

  // #402 — the negative proof: replay the Journey once as recorded, then once per mutation (skip a
  // write step, abort its writes, type an empty value into a checked fill); each assertion must fail
  // under its paired mutation. `verify` is reserved for proofs: today only `--mutate` exists.
  withEnvironmentFlags(withBrowserLaunchFlags(withFixtureFlags(journey.command("verify <id>"))))
    .description("prove each assertion of a Journey can fail: --mutate replays it with each write step skipped or blocked, and each checked fill emptied")
    .option("--mutate", "run the mutation proof (required)")
    .option("--dir <path>", "journeys directory (default: the repo's .jevitate/journeys; outside a repo ~/.jevitate/journeys)")
    .option("--param <kv>", "param as key=value (repeatable)", collectParam, {} as Record<string, string>)
    .option("--storage-state <file>", "Playwright storageState JSON to start each replay authenticated (as journey run)")
    .option("--json", "emit a JSON envelope")
    .action(async function (this: Command, id: string) {
      const { mutate, dir, param, storageState: storageStateFlag, json, env: envName, baseUrl } = this.opts<
        { mutate?: boolean; dir?: string; param: Record<string, string>; storageState?: string; json?: boolean } & EnvironmentFlags
      >();
      if (mutate !== true) {
        emitJson(program, fail("E_JOURNEY_VERIFY_ARGS", "journey verify needs --mutate (the mutation proof is the only verification it runs today)"));
        return;
      }
      let environment: ResolvedJourneyEnvironment | undefined;
      try {
        environment = environmentFromFlags({ ...(envName === undefined ? {} : { env: envName }), ...(baseUrl === undefined ? {} : { baseUrl }) }, environmentSeams(deps));
      } catch (err) {
        if (!isEnvironmentError(err)) throw err;
        emitJson(program, fail(err.code, err.message));
        return;
      }
      const ownFixtureFlags = this.opts<FixtureFlags>();
      const fixtureFlags: FixtureFlags = {
        ...ownFixtureFlags,
        ...(ownFixtureFlags.before === undefined && environment?.hooks?.before !== undefined ? { before: environment.hooks.before } : {}),
        ...(ownFixtureFlags.after === undefined && environment?.hooks?.after !== undefined ? { after: environment.hooks.after } : {}),
      };
      const storageState = storageStateFlag ?? environment?.storageState;
      if (storageState !== undefined && !existsSync(storageState)) {
        emitJson(program, fail("E_JOURNEY_VERIFY_ARGS", `storage state not found: ${storageState}`));
        return;
      }
      let browser: ReturnType<typeof browserRunFromFlags>;
      try {
        browser = browserRunFromFlags(this.opts<BrowserLaunchFlags & DemoFlags>(), deps.explore?.env ?? process.env);
      } catch (err) {
        emitJson(program, fail("E_JOURNEY_VERIFY_ARGS", err instanceof Error ? err.message : String(err)));
        return;
      }
      try {
        const report = await withSiteGate(resolveDbPath(deps), (siteGate) =>
          verifyJourneyMutations({
            ...(siteGate === undefined ? {} : { siteGate }),
            dir: resolveJourneysDir(deps, dir),
            id,
            params: param,
            browserPortFactory: deps.explore?.browserPortFactory,
            ...(browser === undefined ? {} : { browser }),
            ...(storageState !== undefined ? { storageState } : {}),
            ...(environment === undefined ? {} : { environment }),
            // Fixtures run around EVERY replay, so each mutation starts from the same state as the base.
            fixtures: (site) => {
              const fx = buildMissionFixtures(fixtureFlags, {
                allowlist: environment === undefined ? [site] : environment.allowedOrigins,
                baseUrl: site,
                ...(storageState !== undefined ? { storageState } : {}),
                ...(environment?.fixtures === undefined ? {} : { targetFixtures: environment.fixtures }),
              });
              checkSetupRefs({ "--param": Object.values(param) }, fx);
              return fx;
            },
          }),
        );
        const code = verifyExitCode(report.verdict);
        if (json) {
          emitJson(program, ok(withEngine(report)));
        } else {
          const out = program.configureOutput().writeOut;
          for (const a of report.assertions) out?.(`${verifyAssertionLine(a)}\n`);
          const s = report.summary;
          out?.(
            `${report.verdict} — journey '${report.journeyId}': ${s.sensitive} sensitive, ${s.insensitive} insensitive, ${s.cascade} cascade, ${s.notApplied} not applied, ${s.error} error, ${s.unpaired} unpaired` +
              `${report.reason === undefined ? "" : ` (${report.reason})`}\n`,
          );
        }
        process.exitCode = code;
      } catch (err) {
        if (err instanceof SiteGateRefusedError || isEnvironmentError(err)) {
          emitJson(program, fail(err.code, err.message));
        } else if (err instanceof UnknownJourneyError) {
          emitJson(program, fail("E_UNKNOWN_JOURNEY", String(err.message)));
        } else if (err instanceof JourneyRequiresAuthError) {
          emitJson(program, fail("E_JOURNEY_REQUIRES_AUTH", String(err.message)));
        } else if (err instanceof ExtensionMismatchError) {
          emitJson(program, fail(err.code, err.message));
        } else if (err instanceof FixtureSpecError || err instanceof UnboundSetupRefError) {
          emitJson(program, fail(err.code, err.message));
        } else if (err instanceof ParamValidationError) {
          emitJson(program, fail("E_INVALID_PARAMS", String(err.message)));
        } else if (err instanceof FixtureSetupError) {
          emitJson(program, fail("E_JOURNEY_VERIFY", `fixture setup failed — nothing verified: ${err.message}`));
        } else {
          emitJson(program, fail("E_JOURNEY_VERIFY", String(err instanceof Error ? err.message : err)));
        }
      }
    });

  // #293 — the named states worth exploring from (`explore --from-journey <id> --at-step <name>`).
  journey
    .command("anchors <id>")
    .description("list a Journey's anchors (#293): named steps to branch a mission off with `explore --from-journey <id> --at-step <name>`, and their suggested probes")
    .option("--dir <path>", "journeys directory (default: the repo's .jevitate/journeys; outside a repo ~/.jevitate/journeys)")
    .option("--json", "emit a JSON envelope")
    .action(async function (this: Command, id: string) {
      const { dir, json } = this.opts<{ dir?: string; json?: boolean }>();
      try {
        const found = await new JourneyRegistry(new FsJourneyStore(resolveJourneysDir(deps, dir))).get(id);
        if (found === null) {
          emitJson(program, fail("E_UNKNOWN_JOURNEY", `unknown journey '${id}'`));
          return;
        }
        const data = { journeyId: found.metadata.id, promoted: found.metadata.promoted, steps: journeyStepCount(found), anchors: listJourneyAnchors(found) };
        if (json) {
          emitJson(program, ok(data));
        } else {
          const out = program.configureOutput().writeOut;
          if (data.anchors.length === 0) {
            out?.(`journey '${data.journeyId}' declares no anchors — branch off a step number instead (--at-step 1..${data.steps}), or add metadata.anchors\n`);
          }
          for (const a of data.anchors) {
            out?.(`${a.name}\tstep ${a.step}\tafter: ${a.afterStep}${a.description === undefined ? "" : `\t${a.description}`}${a.probes.length === 0 ? "" : `\tprobes: ${a.probes.join("; ")}`}\n`);
          }
          if (!data.promoted) out?.(`note: journey '${data.journeyId}' is not promoted — missions branch only off promoted Journeys\n`);
          process.exitCode = 0;
        }
      } catch (err) {
        emitJson(program, fail("E_JOURNEY_ANCHORS_ARGS", String(err instanceof Error ? err.message : err)));
      }
    });

  // #246 — draft a Journey's intent on playback; `--approve` is the human gate that writes it.
  registerJourneyAnnotateCommand(journey, program, deps);

  // #248 — replay a Journey as a narrated demo: video + subtitles and/or a step-by-step guide.
  registerJourneyDemoCommand(journey, program, deps);

  // #19 — publish a promoted local Journey to a registered distributed source.
  // Preserves every publish-side guard in `@jevitate/sources` (promoted-only,
  // secret-references-only, declared-origin coverage); writes onto a NEW
  // `publish/<id>` branch and degrades gracefully when `gh` is absent.
  journey
    .command("publish <id>")
    .requiredOption("--to <source>", "registered source name to publish into")
    .option("--dir <path>", "journeys directory (default: the repo's .jevitate/journeys; outside a repo ~/.jevitate/journeys)")
    .option("--declare-origin <origin>", "origin this Journey is authorized for (repeatable; default: derived from navigate steps)", (v: string, prev: string[]) => [...prev, v], [] as string[])
    .option("--as <id>", "publish under a different id than the local one")
    .option("--json", "emit a JSON envelope")
    .action(async function (this: Command, id: string) {
      const { to, dir, declareOrigin, as: asId, json } = this.opts<{
        to: string;
        dir?: string;
        declareOrigin: string[];
        as?: string;
        json?: boolean;
      }>();
      try {
        const apiDeps = resolveSourceApiDeps(deps);
        const gh = deps.sources?.gh ?? realGhPort;
        const result = await publishJourneyToSource(
          { ...apiDeps, gh },
          {
            journeysDir: resolveJourneysDir(deps, dir),
            id,
            toSource: to,
            declareOrigins: declareOrigin,
            asId,
          },
        );
        const envelope = ok(result);
        if (json) {
          emitJson(program, envelope);
        } else {
          const out = program.configureOutput().writeOut;
          out?.(`published '${id}' to '${to}' on branch ${result.branch}\n`);
          if (result.prUrl) out?.(`PR: ${result.prUrl}\n`);
          else if (result.instructions) out?.(`${result.instructions}\n`);
          process.exitCode = 0;
        }
      } catch (err) {
        if (err instanceof UnknownSourceError) {
          emitJson(program, fail("E_JOURNEY_PUBLISH_UNKNOWN_SOURCE", err.message));
        } else if (err instanceof UnknownJourneyError) {
          emitJson(program, fail("E_JOURNEY_PUBLISH_UNKNOWN_JOURNEY", err.message));
        } else if (err instanceof NotPromotedError) {
          emitJson(program, fail("E_JOURNEY_PUBLISH_NOT_PROMOTED", err.message));
        } else if (err instanceof NoDeclaredOriginsError) {
          emitJson(program, fail("E_JOURNEY_PUBLISH_NO_ORIGINS", err.message));
        } else if (err instanceof EmbeddedSecretError) {
          emitJson(program, fail("E_JOURNEY_PUBLISH_SECRET", err.message));
        } else if (err instanceof UndeclaredOriginError) {
          emitJson(program, fail("E_JOURNEY_PUBLISH_ORIGIN", err.message));
        } else {
          emitJson(program, fail("E_JOURNEY_PUBLISH", String(err instanceof Error ? err.message : err)));
        }
      }
    });
}
