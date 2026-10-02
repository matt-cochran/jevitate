import { existsSync } from "node:fs";
import { Command } from "commander";
import { FsJourneyStore, JourneyRegistry, ParamValidationError, journeyStepCount, listJourneyAnchors } from "@jevitate/journey";
import { MissingCredentialError, UsageTracker, type JudgmentPort, type GenerationPort } from "@jevitate/ai-core";
import { safeRunPolicy, type SelfHealMode } from "@jevitate/domain";
import { makeExploreSelfHealer } from "./self-heal-adapter.js";
import { ok, fail } from "./envelope.js";
import { SiteGateRefusedError, type SelfHealer } from "@jevitate/runtime";
import { runJourneyProgrammatically, promoteJourney, UnknownJourneyError, JourneyRequiresAuthError } from "./journey-api.js";
import { ExtensionMismatchError } from "./browser-run-options.js";
import { parseScreenshotsArg, type ScreenshotsSpec } from "./run-screenshots.js";
import { withSiteGate } from "./site-gate-cli.js";
import { registerJourneyAnnotateCommand } from "./journey-annotate-cli.js";
import { registerJourneyDemoCommand } from "./journey-demo-cli.js";
import { journeyIntentCoverage } from "./journey-annotate-api.js";
import { buildMissionFixtures, checkSetupRefs, withFixtureFlags, type FixtureFlags } from "./fixture-cli.js";
import { FixtureSetupError, FixtureSpecError, UnboundSetupRefError } from "./mission-fixtures.js";
import { withEngine } from "./engine.js";
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

/** Registers `jevitate journey`: `list|find|run|promote|anchors|annotate|demo|publish`. */
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
              out?.(`${m.id}\t${m.name}${m.promoted ? "" : " (unpromoted)"}\n`);
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
    .option("--self-heal <mode>", "self-heal policy mode: fail-closed | hybrid | full", "fail-closed")
    .option("--real", "use live Jev + OpenRouter gateways for self-heal (requires keys)", false)
    .option("--fake-ai", "use deterministic fake gateways for self-heal (pipeline smoke only)", false)
    .option("--action-deltas", "opt-in (#303): record what each replayed step changed on the page (redacted, a code verdict per step) and compare it with the delta its Recording stored — returned as actionDeltas")
    .option("--json", "emit a JSON envelope")
    .action(async function (this: Command, id: string) {
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
      const { dir, param, storageState: storageStateFlag, selfHeal, real, fakeAi, json, screenshots: _screenshots, actionDeltas, ...emulationFlags } = this.opts<{
        actionDeltas?: boolean;
        dir?: string;
        param: Record<string, string>;
        storageState?: string;
        selfHeal: string;
        real?: boolean;
        fakeAi?: boolean;
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

      // When a heal mode is requested, build the SelfHealer HERE (this action
      // owns `deps` + the credential preflight); a missing/unselected gateway
      // fails CLOSED before any browser launch, rather than silently running
      // with no healer. fail-closed needs no gateway (identical to today).
      let selfHealer: SelfHealer | undefined;
      let policy = safeRunPolicy();
      // #163: a self-healing run makes model calls — their usage (and full cost) lands on its result.
      let healUsage: UsageTracker | undefined;
      if (selfHealMode !== "fail-closed") {
        let judge: JudgmentPort;
        let gen: GenerationPort;
        try {
          ({ judge, gen, usage: healUsage } = await buildExploreGateways(deps, { real: real ?? false, fakeAi: fakeAi ?? false }));
        } catch (err) {
          if (err instanceof MissingCredentialError || err instanceof GatewaySelectionError) {
            emitJson(program, fail("E_AI_SETUP_REQUIRED", err.message));
          } else {
            emitJson(program, fail("E_JOURNEY_RUN", String(err instanceof Error ? err.message : err)));
          }
          return;
        }
        selfHealer = makeExploreSelfHealer(judge, gen);
        policy = { ...policy, selfHeal: { mode: selfHealMode } };
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
          // "ok" and "healed" (a recovered run) are both successes; only
          // "quarantined" is a non-zero exit.
          if (result.outcome === "quarantined") process.exitCode = 1;
        } else {
          writeRawResult(program, envelope.data);
          process.exitCode = result.outcome === "quarantined" ? 1 : 0;
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
    });

  // #124 — promote a local Journey so it becomes discoverable/runnable (journey
  // find / MCP find_capabilities / run_journey), mirroring `mission target
  // promote`'s human-approval-gate semantics: promoting is a deliberate,
  // explicit act, never automatic (an authored Journey's `metadata.promoted`
  // always starts `false` — see `explore-author-journey`/`jevitate record`).
  journey
    .command("promote <id>")
    .description("promote a local Journey (human-approval gate) so it becomes discoverable/runnable")
    .option("--dir <path>", "journeys directory (default: the repo's .jevitate/journeys; outside a repo ~/.jevitate/journeys)")
    .option("--json", "emit a JSON envelope")
    .action(async function (this: Command, id: string) {
      const { dir, json } = this.opts<{ dir?: string; json?: boolean }>();
      try {
        const journeyResult = await promoteJourney(resolveJourneysDir(deps, dir), id);
        const envelope = ok(journeyResult.metadata);
        if (json) {
          emitJson(program, envelope);
        } else {
          program.configureOutput().writeOut?.(`promoted journey '${journeyResult.metadata.id}'\n`);
          process.exitCode = 0;
        }
      } catch (err) {
        if (err instanceof UnknownJourneyError) {
          emitJson(program, fail("E_UNKNOWN_JOURNEY", String(err.message)));
        } else {
          emitJson(program, fail("E_JOURNEY_PROMOTE", String(err instanceof Error ? err.message : err)));
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
