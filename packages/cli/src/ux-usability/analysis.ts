// ux-usability/analysis.ts — phase 3 of `runUsabilityMission` (#500): signals, probes, evidence sidecar, claim analysis.
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { a11yChecks, analyzeClaims, detectFriction, detectSignals, loadV1Rubric, persistableScreen, type AnalysisOutcome, type GuardProbe, type UxEvidenceFile } from "@jevitate/ux";
import { captureFindingShots, planGuardProbes, runGuardProbes, skippedProbes, withProbePage } from "../ux-claim-probe.js";
import { DEFAULT_JUDGMENT_BUDGET, extractTypedValues } from "../ux-evidence.js";
import type { UsabilitySetup } from "./setup.js";
import type { UsabilityLoop } from "./loop.js";

/**
 * Phase 3 — evidence & analysis: the run's signal findings and friction, the guard probes, the
 * evidence sidecar (written before analysis) and the claim analysis with its finding screenshots.
 */
export async function analyzeUsabilityRun(ctx: UsabilitySetup, loop: UsabilityLoop) {
  const { opts, collected, overflowFindings, capture, secrets, session, outDir, stamp, product } = ctx;
  const { run } = loop;
  // #85 item 1: the live run's own typed values (from its emitted Recording's fill/select
  // steps — never a secret), so the vocabulary/jargon tier can tell the app's own copy apart
  // from user-authored content it merely echoed back (same mechanism as the offline pass).
  const typedValues = extractTypedValues(run.recording);
  const screens = typedValues.length > 0 ? collected.map((ev) => ({ ...ev, typedValues })) : collected;
  // #96: findings from the run's own measurements (hung request, duplicate write, internal id,
  // inert control) — independent code, no model — reported alongside the rubric's.
  const signalCapture = await capture.signalCapture(run.transcript, typedValues);
  // A gRPC-web/Connect read is never a duplicate write (#110); `--read-rpc` marks more reads.
  const readRequests = opts.target?.safety?.readRequests;
  const signalFindings = [
    ...detectSignals(signalCapture, readRequests === undefined ? opts.signals : { ...opts.signals, readRequests }),
    // #149: horizontal-overflow, computed live during the run (never from the captured timeline).
    ...overflowFindings,
  ];
  // #132: the friction the run walked into — what grounds (or not) each rubric finding.
  const friction = detectFriction(signalCapture, run.outcome);
  // #198: every destructive control on an analyzed screen is clicked once with its writes blocked
  // (ux-claim-probe.ts) — the code evidence `destructive-unguarded` claims are verified against.
  // On a dedicated page in the run's context, after the loop: the run's oracles never see it.
  // A screen that cannot be redacted means no probes at all (destructive claims: unverifiable).
  let probes: GuardProbe[] | undefined;
  try {
    const plan = planGuardProbes(screens, secrets, opts.target?.safety);
    probes = [...plan.refused];
    // Clicking is opt-in (--probe-guards): without it every destructive control is `skipped`, and
    // its guard claim is reported unverifiable — never asserted, never silently dropped.
    if (opts.probeGuards !== true) probes.push(...skippedProbes(plan.targets));
    else if (plan.targets.length > 0) {
      try {
        probes.push(...(await runGuardProbes(session.page, plan.targets, { allowlist: opts.allowlist, secrets })));
      } catch (err) {
        const why = `the guard probe could not open a page: ${err instanceof Error ? err.message.split("\n")[0] : String(err)}`;
        probes.push(...plan.targets.map((t): GuardProbe => ({ screenId: t.screen.screenId, route: t.route, control: t.label, controlKey: t.key, status: "failed", detail: why })));
      }
    }
  } catch {
    probes = undefined;
  }
  // #134: the evidence sidecar, written through the redaction door BEFORE analysis (so it exists
  // even when analysis fails). Fail-closed: if any screen cannot be redacted, no file is written.
  const evidencePath = join(outDir, `usability-${stamp}.evidence.json`);
  let evidenceWritten: string | null = null;
  try {
    const file: UxEvidenceFile = {
      version: 1,
      appContext: opts.appContext,
      job: opts.job,
      screens: screens.map((ev) => persistableScreen(ev, secrets)),
      signals: signalCapture,
      outcome: run.outcome,
      ...(probes === undefined ? {} : { probes }),
    };
    await mkdir(outDir, { recursive: true });
    await writeFile(evidencePath, `${JSON.stringify(file, null, 2)}\n`, "utf8");
    evidenceWritten = evidencePath;
  } catch {
    evidenceWritten = null;
  }
  // #198: findings are claims verified by code (claims.ts) — guard probes, product facts and the
  // friction the run walked into — categorized and graded by Jev, written from templates.
  const claimed = await analyzeClaims(
    {
      screens,
      rubric: loadV1Rubric(),
      appContext: opts.appContext,
      secrets,
      judgmentBudget: opts.judgmentBudget ?? DEFAULT_JUDGMENT_BUDGET,
      friction,
      steps: signalCapture.steps,
      signalFindings,
      ...(probes === undefined ? {} : { probes }),
      ...(product.facts === undefined ? {} : { facts: product.facts }),
    },
    { judge: opts.judge, gen: opts.gen, a11yChecker: a11yChecks, ...(opts.polish === true ? { polish: true } : {}) },
  );
  // #198: a cropped, masked screenshot with the cited control boxed, per verified claim finding.
  let outcome: AnalysisOutcome = claimed;
  if (claimed.kind === "analyzed" && claimed.findings.some((f) => f.claim !== undefined)) {
    const byScreen = new Map(screens.map((ev) => [ev.screenId, ev]));
    const dir = join(outDir, `usability-${stamp}.findings`);
    try {
      const findings = await withProbePage(session.page, (p) => captureFindingShots(p, claimed.findings, byScreen, { dir, allowlist: opts.allowlist, secrets }));
      outcome = { ...claimed, findings };
    } catch {
      outcome = claimed; // presentation only: findings without screenshots are still the findings
    }
  }
  return { signalFindings, friction, outcome, evidenceWritten };
}

export type UsabilityAnalysis = Awaited<ReturnType<typeof analyzeUsabilityRun>>;
