import type { Answer, JudgmentPort } from "@jevitate/ai-core";
import { CLAIM_VERDICTS, isDoneCheckIssues, parseDoneCheck, type ClaimResult, type ClaimVerdict, type DoneCheckSpec, type GuidanceClaim, type RunResultClaimVerdicts } from "@jevitate/journey";
import type { BrowserPort as SessionPort } from "@jevitate/playwright";
import { randomUUID } from "node:crypto";
import { readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { PlaywrightDoneCheckPort } from "./journey-done-check-hook.js";
import { readDoneCheck } from "./journey-done-check.js";

/**
 * #874: after an `explore --job <id> --job-context` run, every `guidance.claims[]` entry of the job
 * gets exactly one verdict and the basis that decided it. Claims are statements to CHECK: they are
 * never told to the model as fact during the run, and no verdict changes the run's exit code — a
 * `contradicted` claim is a divergence for a person to triage, not a defect.
 *
 *  - basis `check`: the claim's own `check` (a done-check shape) read by code in a fresh context;
 *    true → confirmed, false → contradicted, unreadable → not_observed.
 *  - basis `model`: no check; Jev judges the claim against what the run observed (its pages and
 *    controls). An answer outside the three verdicts is not_observed, never trusted.
 *  - basis `no-evidence`: no check and nothing observed (or no model allowed): not_observed, no call.
 *  - basis `model-error`: the judgment call failed; recorded with its reason, never hidden.
 */
export type { ClaimResult } from "@jevitate/journey";

/**
 * The claim-verdict fields a `--job-context` run adds to its result (`jobContext`, and `claims`
 * when the job has any), typed by the published run-result contract's source schema
 * (`RunResultClaimVerdictsSchema`, @jevitate/journey).
 */
export function claimVerdictFields(
  job: { readonly jobId: string; readonly contentHash: string },
  claims: readonly ClaimResult[] | undefined,
): Pick<RunResultClaimVerdicts, "jobContext" | "claims"> {
  return { jobContext: { job: job.jobId, contentHash: job.contentHash }, ...(claims === undefined ? {} : { claims: [...claims] }) };
}

/**
 * Adds the claim-verdict fields to a run's saved `<recording>.result.json` (written by the mission
 * journal before the claims were evaluated), so the saved `result` carries exactly what the `--json`
 * envelope's `data` does. Written through a temp file in the same directory and a rename, keeping
 * the journal's formatting. A file that is not a saved run result is refused, never overwritten.
 */
export function saveClaimVerdicts(resultPath: string, fields: Pick<RunResultClaimVerdicts, "jobContext" | "claims">): void {
  const saved: unknown = JSON.parse(readFileSync(resultPath, "utf8"));
  if (!isPlainObject(saved) || !isPlainObject(saved.result)) {
    throw new Error(`${resultPath} is not a saved run result ({missionOutcome, exitCode, result})`);
  }
  const updated = { ...saved, result: { ...saved.result, ...fields } };
  const tmp = join(dirname(resultPath), `.${basename(resultPath)}.${randomUUID()}.tmp`);
  try {
    writeFileSync(tmp, `${JSON.stringify(updated, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
    renameSync(tmp, resultPath);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** What the run observed, for model-judged claims: the pages it saw and the controls on them. */
export interface ClaimEvidence {
  readonly urls: readonly string[];
  readonly controls: readonly string[];
}

export interface ClaimEvaluationDeps {
  /** Reads a claim's check in a fresh context: true / false, or null when it cannot be read. */
  readonly readCheck: (spec: DoneCheckSpec) => Promise<boolean | null>;
  /** The run's judgment gateway; absent = no model verdicts (claims without a check read not_observed). */
  readonly judge?: JudgmentPort;
  readonly evidence: ClaimEvidence | null;
}

const MAX_EVIDENCE_URLS = 40;
const MAX_EVIDENCE_CONTROLS = 200;
const MAX_EVIDENCE_CHARS = 6000;

/** The run's observed pages and controls from its transcript entries, deduplicated and bounded. */
export function evidenceFromTranscript(entries: readonly { readonly url?: string; readonly controls?: readonly string[] }[]): ClaimEvidence | null {
  const urls: string[] = [];
  const controls: string[] = [];
  for (const e of entries) {
    if (e.url !== undefined && e.url !== "" && !urls.includes(e.url) && urls.length < MAX_EVIDENCE_URLS) urls.push(e.url);
    for (const c of e.controls ?? []) if (!controls.includes(c) && controls.length < MAX_EVIDENCE_CONTROLS) controls.push(c);
  }
  return urls.length === 0 && controls.length === 0 ? null : { urls, controls };
}

function evidenceText(claim: GuidanceClaim, evidence: ClaimEvidence): string {
  const text = [
    `CLAIM TO CHECK: ${claim.statement}`,
    "The claim comes from a document about the product and may be wrong or out of date. Judge it ONLY from what this run observed:",
    `PAGES SEEN: ${evidence.urls.join(" | ")}`,
    `CONTROLS SEEN: ${evidence.controls.join(" | ")}`,
  ].join("\n");
  return text.length > MAX_EVIDENCE_CHARS ? text.slice(0, MAX_EVIDENCE_CHARS) : text;
}

async function modelVerdict(claim: GuidanceClaim, judge: JudgmentPort, evidence: ClaimEvidence): Promise<ClaimResult> {
  const base = { id: claim.id, statement: claim.statement };
  let answer: Answer | undefined;
  try {
    const answers = await judge.systemOne({
      state: { goal: "Check a claim about the product against what a test run observed", url: evidence.urls.at(-1) ?? "about:blank", controls: [], history: [], visibleText: evidenceText(claim, evidence) },
      questions: {
        verdict: {
          kind: "choice",
          options: CLAIM_VERDICTS,
          descriptions: {
            confirmed: "what the run observed shows the claim holds",
            contradicted: "what the run observed shows the claim does not hold",
            not_observed: "the run did not observe enough to tell either way",
          },
          instructions: "Does what this run observed confirm or contradict the claim? Choose not_observed unless the observations decide it.",
        },
      },
    });
    answer = answers.verdict;
  } catch (err) {
    return { ...base, verdict: "not_observed", basis: "model-error", reason: err instanceof Error ? err.message : String(err) };
  }
  const value = answer?.kind === "choice" ? answer.value : undefined;
  const verdict = (CLAIM_VERDICTS as readonly string[]).includes(value ?? "") ? (value as ClaimVerdict) : "not_observed";
  return { ...base, verdict, basis: "model" };
}

/** One verdict per claim, in order. */
export async function evaluateClaims(claims: readonly GuidanceClaim[], deps: ClaimEvaluationDeps): Promise<ClaimResult[]> {
  const out: ClaimResult[] = [];
  for (const claim of claims) {
    const base = { id: claim.id, statement: claim.statement };
    if (claim.check !== undefined) {
      const reading = await deps.readCheck(claim.check).catch(() => null);
      out.push({ ...base, verdict: reading === null ? "not_observed" : reading ? "confirmed" : "contradicted", basis: "check" });
    } else if (deps.judge === undefined || deps.evidence === null) {
      out.push({ ...base, verdict: "not_observed", basis: "no-evidence" });
    } else {
      out.push(await modelVerdict(claim, deps.judge, deps.evidence));
    }
  }
  return out;
}

/**
 * The production `readCheck`: each claim's check read once, after the run, in a fresh browser
 * context on the run's own origin (the same reader as the job's done check, #800).
 */
export function claimCheckReader(req: {
  readonly startUrl: string;
  readonly storageState?: string | undefined;
  readonly params?: Readonly<Record<string, string>>;
  readonly sessionPortFactory?: (() => SessionPort) | undefined;
}): (spec: DoneCheckSpec) => Promise<boolean | null> {
  const params = req.params ?? {};
  let origin: string;
  try {
    origin = new URL(req.startUrl).origin;
  } catch {
    return async () => null;
  }
  const port = new PlaywrightDoneCheckPort({ origin, ...(req.sessionPortFactory === undefined ? {} : { sessionPortFactory: req.sessionPortFactory }) });
  const auth = req.storageState === undefined ? {} : { storageState: req.storageState };
  return async (raw) => {
    const spec = parseDoneCheck(raw, { bound: Object.keys(params) });
    if (isDoneCheckIssues(spec)) return null;
    const reading = await readDoneCheck({ spec, origin, auth, params, extracts: {}, browserPort: port, at: "post" }).catch(() => undefined);
    return reading !== undefined && reading.value.known ? reading.value.value : null;
  };
}
