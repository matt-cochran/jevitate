// check-cli-action.ts — the `check` command's action handler and its flag/input normalisation.
import type { Command } from "commander";
import { MissingCredentialError, formatUsageLine } from "@jevitate/ai-core";
import type { BrowserLaunchOptions, BrowserPort } from "@jevitate/playwright";
import { ok, fail, type JsonEnvelope } from "./envelope.js";
import { emitEnvelope } from "./cli-output.js";
import { CheckAiSetupError, CheckArgsError, CheckPreflightError, runCheck, type CheckGateways, type CheckRunners } from "./check-api.js";
import { SuiteError, loadSuite } from "./check-suite.js";
import { ReportInputError, defaultResultDirs } from "./report-api.js";
import { TargetConfigError, loadTargetsFile } from "./target-config.js";
import { ApprovalArgsError, parseAllowedChannels } from "./approval-provenance.js";
import { resolveCatalogDir } from "./catalog-api.js";
import { readFileSync, writeFileSync } from "node:fs";
import { brittleStepGate } from "./locator-health-api.js";
import { ChangesArgsError, ChangesInputError } from "./change-context.js";
import { CLI_HEAL_NAMES, JourneyHealArgsError, validateJourneyHeal, type JourneyHealRequest } from "./journey-heal.js";
import type { SelfHealMode } from "@jevitate/domain";
import { environmentsFilePath } from "./environments.js";
import { TrustCheckError, trustDrift, trustDriftMessage } from "./check-trust.js";
import { createEvidenceManifest, evidenceArtifactsReason, parseEvidenceKeyInput, parseEvidenceManifest, reuseDecision, sha256 } from "./check-evidence.js";
import { appVersionFlagProblem, envAppVersion } from "./app-version.js";

export interface CheckCliDeps {
  /** Builds the explore gateways for `--real` / `--fake-ai` (program.ts's `buildExploreGateways`). */
  readonly buildGateways: (sel: { real: boolean; fakeAi: boolean; jevProvider?: string | undefined }) => Promise<CheckGateways>;
  readonly journeysDir: string;
  /** The site-policy database (`jevitate site policy set`) Journey items are gated by. */
  readonly sitePolicyDbPath?: string;
  readonly targetsConfigPath?: string;
  /** #247: the environments file a Journey item's `env` names (default: the repo's `.jevitate/environments.json`). */
  readonly environmentsFile?: string;
  readonly browserPortFactory?: () => BrowserPort;
  /** Maps the command's browser launch flags to launch options (program.ts's `browserLaunchFromFlags`). */
  readonly browserLaunch?: (flags: object) => BrowserLaunchOptions | undefined;
  readonly baselinesDir?: string;
  /** #437: the catalog's directory `--require-approvals` reads (default: the project's `.jevitate/`). */
  readonly catalogDir?: string;
  /** #479: the environment `JEVITATE_APP_VERSION` is read from (default `process.env`); tests inject it. */
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** Test seam: replace the runners. */
  readonly runners?: Partial<CheckRunners>;
}

/** #210: the envelope with --json; a refusal without it is an `error <CODE>: …` line (exit-codes.ts class). */
export function emit(program: Command, envelope: JsonEnvelope<unknown>, json: boolean, exitCode?: number): void {
  emitEnvelope(program, envelope, { json, command: "check", ...(exitCode === undefined ? {} : { exitCode }) });
}

export function readEvidenceJson(path: string, kind: "input" | "manifest"): ReturnType<typeof parseEvidenceKeyInput> | ReturnType<typeof parseEvidenceManifest> {
  try {
    const value: unknown = JSON.parse(readFileSync(path, "utf8"));
    return kind === "input" ? parseEvidenceKeyInput(value) : parseEvidenceManifest(value);
  } catch (error) {
    throw new CheckArgsError(`--evidence-${kind} ${JSON.stringify(path)} is invalid: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * #479: `--app-version` (validated, refused before anything runs), else `JEVITATE_APP_VERSION`; an
 * invalid env value is ignored with a warning on stderr. The flag wins over the environment.
 */
export function resolveAppVersion(flag: string | undefined, env: Readonly<Record<string, string | undefined>>, warn: (line: string) => void): string | undefined {
  if (flag !== undefined) {
    const problem = appVersionFlagProblem(flag);
    if (problem !== undefined) throw new CheckArgsError(problem);
    return flag;
  }
  return envAppVersion(env, warn);
}

/** The `check` action handler body, moved verbatim out of `registerCheckCommand`. */
export async function runCheckCommandAction(this: Command, program: Command, deps: CheckCliDeps): Promise<void> {
  const o = this.opts<{
    suite: string;
    targetBuild?: string;
    appVersion?: string;
    baseline?: string;
    baselineDir: string[];
    changedRoutes: string[];
    evidenceInput?: string;
    evidenceManifest?: string;
    evidenceOut?: string;
    evidenceDecisionOut?: string;
    out: string;
    junit?: string;
    sarif?: string;
    jsonOut?: string;
    real?: boolean;
    fakeAi?: boolean;
    jevProvider?: string;
    json?: boolean;
    requireApprovals?: boolean;
    requireTrust?: boolean;
    allowChannels?: string;
    selfHeal: string;
    changes?: string;
    changeNote: string[];
    healMaxAttempts?: number;
    healMaxModelCalls?: number;
    healMaxMs?: number;
    healMaxRunAttempts?: number;
    healMaxRunMs?: number;
    maxBrittleSteps?: number;
    doneCheck: boolean;
    requireDoneCheck?: boolean;
  }>();
  try {
    // H5: the done-check flags, refused together (64) before anything runs, as `journey run` refuses them.
    if (!o.doneCheck && o.requireDoneCheck === true) throw new CheckArgsError("--no-done-check and --require-done-check cannot be used together");
    // #453: refused (64) before the suite is read or anything runs.
    if (o.selfHeal !== "fail-closed" && o.selfHeal !== "hybrid" && o.selfHeal !== "full") {
      throw new CheckArgsError(`--self-heal must be one of fail-closed | hybrid | full (got '${o.selfHeal}')`);
    }
    const healRequest: JourneyHealRequest = {
      selfHeal: o.selfHeal as SelfHealMode,
      ...(o.changes === undefined ? {} : { changes: o.changes }),
      changeNotes: o.changeNote,
      ...(o.healMaxAttempts === undefined ? {} : { maxAttempts: o.healMaxAttempts }),
      ...(o.healMaxModelCalls === undefined ? {} : { maxModelCalls: o.healMaxModelCalls }),
      ...(o.healMaxMs === undefined ? {} : { maxMs: o.healMaxMs }),
      ...(o.healMaxRunAttempts === undefined ? {} : { maxRunAttempts: o.healMaxRunAttempts }),
      ...(o.healMaxRunMs === undefined ? {} : { maxRunMs: o.healMaxRunMs }),
    };
    try {
      validateJourneyHeal(healRequest, CLI_HEAL_NAMES);
    } catch (e) {
      throw e instanceof JourneyHealArgsError ? new CheckArgsError(e.message) : e;
    }
    if (o.allowChannels !== undefined && o.requireApprovals !== true) throw new ApprovalArgsError("--allow-channels needs --require-approvals");
    const allowedChannels = o.requireApprovals === true ? parseAllowedChannels(o.allowChannels) : undefined;
    if ((o.evidenceManifest !== undefined || o.evidenceOut !== undefined || o.evidenceDecisionOut !== undefined) && o.evidenceInput === undefined) {
      throw new CheckArgsError("--evidence-manifest, --evidence-out, and --evidence-decision-out each require --evidence-input");
    }
    const evidenceInput = o.evidenceInput === undefined ? undefined : parseEvidenceKeyInput(readEvidenceJson(o.evidenceInput, "input"));
    const evidenceManifest = o.evidenceManifest === undefined ? undefined : parseEvidenceManifest(readEvidenceJson(o.evidenceManifest, "manifest"));
    const evidenceArtifactReason = evidenceManifest === undefined ? undefined : evidenceArtifactsReason(evidenceManifest, (path) => readFileSync(path, "utf8"));
    if (o.evidenceDecisionOut !== undefined && evidenceInput !== undefined) {
      const decision = evidenceArtifactReason === undefined ? reuseDecision(evidenceInput, evidenceManifest) : { decision: "run" as const, reasons: [evidenceArtifactReason] };
      const data = { kind: "jevitate-evidence-decision", decision: decision.decision, reasons: decision.reasons, changedInputs: decision.decision === "run" ? decision.reasons : [] };
      writeFileSync(o.evidenceDecisionOut, `${JSON.stringify(data, null, 2)}\n`, "utf8");
      if (o.json === true) emit(program, ok(data), true, 0);
      else program.configureOutput().writeOut?.(`${decision.decision.toUpperCase()} ${decision.reasons.join(", ")} · ${o.evidenceDecisionOut}\n`);
      return;
    }
    // #799: a trust that is not the committed one fails before the suite is read or anything runs.
    if (o.requireTrust === true) {
      const drift = await trustDrift(deps.environmentsFile ?? environmentsFilePath());
      if (drift.length > 0) {
        emit(program, fail("E_TRUST_DRIFT", trustDriftMessage(drift)), o.json === true, 1);
        return;
      }
    }
    // #470: the opt-in brittle-step gate, resolved before the suite is read or anything runs.
    const gate = o.maxBrittleSteps === undefined ? undefined : brittleStepGate(o.maxBrittleSteps);
    // #479: the app version is resolved (and an invalid one refused) before anything runs.
    const appVersion = resolveAppVersion(o.appVersion, deps.env ?? process.env, (line) => this.configureOutput().writeErr?.(line));
    const suite = loadSuite(o.suite);
    const real = o.real === true || (o.fakeAi !== true && suite.ai === "real");
    const fakeAi = o.fakeAi === true || (o.real !== true && suite.ai === "fake");
    const aiMode = real ? "real" : fakeAi ? "fake" : undefined;
    const jevProvider = o.jevProvider;
    const browser = deps.browserLaunch?.(this.opts());
    const result = await runCheck({
      suite,
      suiteUri: o.suite,
      outDir: o.out,
      journeysDir: deps.journeysDir,
      ...(deps.sitePolicyDbPath === undefined ? {} : { sitePolicyDbPath: deps.sitePolicyDbPath }),
      targetsConfig: loadTargetsFile(deps.targetsConfigPath),
      ...(deps.environmentsFile === undefined ? {} : { environmentsFile: deps.environmentsFile }),
      ...(o.targetBuild === undefined ? {} : { targetBuild: o.targetBuild }),
      ...(appVersion === undefined ? {} : { appVersion }),
      ...(o.baseline === undefined ? {} : { baseline: o.baseline }),
      ...(o.baselineDir.length > 0 ? { baselineDirs: o.baselineDir } : o.baseline === undefined ? {} : { baselineDirs: [`${o.out}/results`, ...defaultResultDirs()] }),
      ...(deps.baselinesDir === undefined ? {} : { baselinesDir: deps.baselinesDir }),
      ...(o.changedRoutes.length > 0 ? { changedRoutes: o.changedRoutes } : {}),
      ...(evidenceInput === undefined ? {} : { evidence: { input: evidenceInput, ...(evidenceManifest === undefined ? {} : { manifest: evidenceManifest }), ...(evidenceArtifactReason === undefined ? {} : { refusalReasons: [evidenceArtifactReason] }) } }),
      ...(o.junit === undefined ? {} : { junitPath: o.junit }),
      ...(o.sarif === undefined ? {} : { sarifPath: o.sarif }),
      ...(o.jsonOut === undefined ? {} : { jsonPath: o.jsonOut }),
      ...(aiMode === undefined ? {} : { aiMode, gateways: () => deps.buildGateways({ real, fakeAi, jevProvider }) }),
      ...(deps.browserPortFactory === undefined ? {} : { browserPortFactory: deps.browserPortFactory }),
      ...(browser === undefined ? {} : { browser }),
      ...(deps.runners === undefined ? {} : { runners: deps.runners }),
      ...(healRequest.selfHeal === "fail-closed" ? {} : { selfHeal: healRequest }),
      ...(allowedChannels === undefined ? {} : { requireApprovals: { allowedChannels, catalogDir: resolveCatalogDir(deps.catalogDir) } }),
      ...(gate === undefined ? {} : { maxBrittleSteps: gate.maxBrittleSteps }),
      projectDir: resolveCatalogDir(deps.catalogDir),
      ...(!o.doneCheck || o.requireDoneCheck === true ? { doneCheck: { ...(!o.doneCheck ? { skip: true } : {}), ...(o.requireDoneCheck === true ? { policy: "require" as const } : {}) } } : {}),
    });
    if (o.evidenceOut !== undefined && result.exitCode === 0 && evidenceInput !== undefined) {
      const resultDigests = Object.fromEntries(result.results.map((path) => [path, `sha256:${sha256(readFileSync(path, "utf8"))}`]));
      writeFileSync(o.evidenceOut, `${JSON.stringify(createEvidenceManifest(evidenceInput, resultDigests), null, 2)}\n`, "utf8");
    }
    if (o.json) emit(program, ok(result), true, result.exitCode);
    else {
      const out = program.configureOutput().writeOut;
      const findingTitle = new Map(result.findings.map((f) => [f.key, f.title]));
      for (const i of result.items) {
        const reason =
          i.error !== undefined
            ? ` — ${i.error.message}`
            : i.verdict === "failed" && i.gating.length > 0
              ? ` — ${i.gating.map((k) => findingTitle.get(k) ?? k).join("; ")}`
              : "";
        // H5: a job that is not achieved (or not verified) is named on its item's line.
        const job = i.job === undefined || i.job.attainment === "achieved" ? "" : ` · job ${i.job.attainment} (${i.job.basis})`;
        out?.(`${i.verdict.toUpperCase().padEnd(7)} ${i.target} ${i.kind} ${i.name}${reason}${job}\n`);
      }
      // #213: 0 calls is nothing to report (not $0 vs "unpriced" noise) — omit the line entirely.
      if (result.usage !== undefined && result.usage.judgments + result.usage.generations > 0) {
        out?.(`COST    ${formatUsageLine(result.usage)}\n`);
      }
      if (result.budget.exceeded !== undefined) out?.(`BUDGET  ${result.budget.exceeded}\n`);
      // #470: locator health (advisory unless --max-brittle-steps), and its trend against --baseline.
      const lh = result.locatorHealth;
      if (lh?.line !== undefined) {
        const gateNote = lh.maxBrittleSteps === undefined ? " (advisory)" : lh.exceeded === true ? ` — exceeds --max-brittle-steps ${lh.maxBrittleSteps}` : ` (within --max-brittle-steps ${lh.maxBrittleSteps})`;
        out?.(`LOCATOR ${lh.line}${gateNote}\n`);
      }
      if (lh?.trend !== undefined) out?.(`LOCATOR ${lh.trend.line}\n`);
      // #213: exit 2 (an item errored, or the budget ran out, but no gating finding) is never
      // headed FAIL — that reads as a defect was found when the run simply proved nothing.
      const headline =
        result.exitCode === 0
          ? `PASS: ${result.summary.gatingFindings} gating finding(s)`
          : result.exitCode === 5
            ? `PENDING REVIEW: ${result.summary.pendingReview} Journey revision(s) proposed by self-heal await a person`
          : result.exitCode === 1
            ? `FAIL: ${result.summary.gatingFindings} gating finding(s)`
            : result.summary.errors > 0
              ? `ERROR: ${result.summary.errors} item(s) errored${result.budget.exceeded === undefined ? "" : " · budget exceeded"}`
              : result.budget.exceeded === undefined && result.summary.unverified > 0
                ? `INCONCLUSIVE: ${result.summary.unverified} Journey item(s) passed but their job is unverified (no done check, or one already true) under doneCheckPolicy require`
                : `INCONCLUSIVE: ${result.budget.exceeded ?? "the budget was exceeded before every item ran"}`;
      out?.(`${headline} · ${result.jsonPath}\n`);
      if (result.exitCode === 5) for (const p of result.proposals) out?.(`next: jevitate journey review ${p.journeyId}${p.proposalId === undefined ? "" : ` · jevitate journey promote ${p.journeyId} --proposal ${p.proposalId}`}\n`);
      out?.(result.summary.gatingFindings > 0 ? "next: jevitate report (the findings by fingerprint) · jevitate verify-fix <fp> after a fix\n" : "next: jevitate report\n");
      process.exitCode = result.exitCode;
    }
  } catch (err) {
    if (
      err instanceof SuiteError ||
      err instanceof CheckPreflightError ||
      err instanceof CheckAiSetupError ||
      err instanceof ReportInputError ||
      err instanceof TargetConfigError ||
      err instanceof ApprovalArgsError ||
      err instanceof CheckArgsError ||
      err instanceof ChangesArgsError ||
      err instanceof ChangesInputError ||
      err instanceof TrustCheckError
    ) {
      emit(program, fail(err.code, err.message), o.json === true);
    } else if (err instanceof MissingCredentialError || (err instanceof Error && err.name === "GatewaySelectionError")) {
      emit(program, fail("E_AI_SETUP_REQUIRED", err.message), o.json === true);
    } else {
      emit(program, fail("E_CHECK", err instanceof Error ? err.message : String(err)), o.json === true);
    }
  }
}
