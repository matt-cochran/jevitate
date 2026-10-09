import type { RecordedStep, Step } from "@jevitate/recording";
import { writeClassifier, type WriteClassifier } from "@jevitate/recording";
import type { Journey } from "./journey.js";
import { isNoClaimExpect, isOwnTargetVisible, journeyAssertions, type JourneyAssertionSite } from "./assertions.js";
import { anchorLintIssues, type AnchorRuleCode } from "./anchor-rules.js";

/**
 * #401: the assertion-strength rules this lint reports; #466: the 0.10 anchor rules (`AnchorRuleCode`,
 * always warnings here) and the catalog anchor/serves references the CLI adds (`anchor-job-step`,
 * `serves-outcome`, from catalog-refs.ts).
 */
export type JourneyLintRule =
  | "own-target-visible"
  | "write-without-effect"
  | "visibility-only"
  | "nothing-after-last-write"
  | "no-persistence-check"
  | "intent-uncovered"
  | AnchorRuleCode
  | "anchor-job-step"
  | "serves-outcome";

/** #401: one weak assertion in a Journey, with the 1-based step it belongs to when it has one. */
export interface JourneyLintFinding {
  rule: JourneyLintRule;
  level: "error" | "warning";
  step?: number;
  message: string;
  /** #466: what to change so the rule holds (the anchor rules always name one). */
  fix?: string;
}

export interface JourneyLintOptions {
  /** Read patterns for the write classifier (`--read-rpc`, target config `safety.readRequests`). */
  readonly readRequests?: readonly string[];
}

/** #401: a step kind whose `relevant-change` delta is state-changing even with no recorded request. */
const STATE_CHANGING: ReadonlySet<string> = new Set(["click", "submit", "press"]);

/** #401: a write request line, as `ActionDeltaRecord.requests` keeps it (`POST /api/items → 201`). */
interface WriteRequest {
  readonly method: string;
  readonly path: string;
  readonly line: string;
}

const REQUEST_LINE = /^(\S+)\s+(\S+)/;

function flattenSteps(journey: Journey): RecordedStep[] {
  const out: RecordedStep[] = [];
  for (const page of journey.recording.pages) for (const recorded of page.steps) out.push(recorded);
  return out;
}

/** #401: the registry's write requests among a step's delta lines. */
function writeRequestsOf(recorded: RecordedStep, classify: WriteClassifier): WriteRequest[] {
  const out: WriteRequest[] = [];
  for (const line of recorded.delta?.requests ?? []) {
    const m = REQUEST_LINE.exec(line.trim());
    if (m !== null && classify({ method: m[1]!, path: m[2]! })) out.push({ method: m[1]!, path: m[2]!, line });
  }
  return out;
}

function isWriteStep(recorded: RecordedStep, classify: WriteClassifier, requests: readonly WriteRequest[]): boolean {
  if (requests.length > 0) return true;
  // (b) a step's own request expectation names a write method for its path.
  if ((recorded.expectRequests ?? []).some((check) => classify({ method: check.method, path: check.pathGlob }))) return true;
  // (c) a state-changing step whose delta changed the page, even if the request was not recorded.
  return recorded.delta?.verdict === "relevant-change" && STATE_CHANGING.has(recorded.step.kind);
}

/**
 * #401: an EFFECT assertion is one that could prove the step did something — everything except an
 * `expect` that only restates the step's own target (`isOwnTargetVisible`), an explicit "no claim"
 * (`isNoClaimExpect`), or a bare `visible` page check.
 */
function isEffectSite(site: JourneyAssertionSite, step: Step | undefined): boolean {
  if (site.where === "step-request") return true;
  if (site.where === "end-state") {
    if (site.check.kind === "page" || site.check.kind === "reloadThen") return site.check.assertion.kind !== "visible";
    return true;
  }
  if (site.field === "expect" && step !== undefined && (isOwnTargetVisible(step) || isNoClaimExpect(step))) return false;
  return site.check.assertion.kind !== "visible";
}

function globMatch(glob: string, value: string): boolean {
  const src = glob
    .split("*")
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*");
  return new RegExp(`^${src}$`, "i").test(value);
}

function sameMethod(a: string, b: string): boolean {
  return a.toUpperCase() === b.toUpperCase();
}

/** #401: does the end state assert the effect of this (last) write step? */
function endStateCovers(requests: readonly WriteRequest[], endEffects: readonly JourneyAssertionSite[]): boolean {
  return endEffects.some((site) => {
    if (site.where !== "end-state") return false;
    const check = site.check;
    if (check.kind === "page" || check.kind === "reloadThen") return true; // an on-page outcome of the write
    return requests.some((req) => sameMethod(check.method, req.method) && globMatch(check.pathGlob, req.path));
  });
}

/** #402: a write step — 1-based, counted the way `--at-step` counts — with its recorded write request lines. */
export interface JourneyWriteStep {
  readonly step: number;
  /** The write requests its recorded delta names (`POST /api/items → 201`); empty when it is a write by other evidence. */
  readonly requests: readonly string[];
}

/**
 * #402: the Journey's write steps, by the SAME rule the lint's `write-without-effect` uses (a recorded
 * write request, a write `expectRequests`, or a state-changing step whose delta changed the page).
 * The mutation proof (`journey verify --mutate`) skips or blocks exactly these.
 */
export function journeyWriteSteps(journey: Journey, opts: JourneyLintOptions = {}): JourneyWriteStep[] {
  const classify = writeClassifier({ readRequests: opts.readRequests });
  const out: JourneyWriteStep[] = [];
  flattenSteps(journey).forEach((recorded, i) => {
    const requests = writeRequestsOf(recorded, classify);
    if (isWriteStep(recorded, classify, requests)) out.push({ step: i + 1, requests: requests.map((r) => r.line) });
  });
  return out;
}

/** #401: the pure assertion-strength lint for a Journey — no I/O, no clock, no globals. */
export function lintJourney(journey: Journey, opts: JourneyLintOptions = {}): JourneyLintFinding[] {
  const classify = writeClassifier({ readRequests: opts.readRequests });
  const recorded = flattenSteps(journey);
  const sites = journeyAssertions(journey);
  const stepOf = (n: number): Step => recorded[n - 1]!.step;
  const effects = sites.filter((site) => isEffectSite(site, site.where === "step" ? stepOf(site.step) : undefined));
  const endEffects = effects.filter((site) => site.where === "end-state");
  const effectAt = (n: number): boolean => effects.some((site) => (site.where === "step" || site.where === "step-request") && site.step === n);

  const writeRequests = recorded.map((r) => writeRequestsOf(r, classify));
  const isWrite = recorded.map((r, i) => isWriteStep(r, classify, writeRequests[i]!));
  const lastWrite = isWrite.lastIndexOf(true) + 1; // 0 when there is no write step

  const findings: JourneyLintFinding[] = [];

  for (let i = 0; i < recorded.length; i += 1) {
    const n = i + 1;
    if (isOwnTargetVisible(recorded[i]!.step)) {
      findings.push({
        rule: "own-target-visible",
        level: "error",
        step: n,
        message: `step ${n}: expect asserts the step's own target is visible — that holds before and after the step, so it proves nothing`,
      });
    }
  }

  for (let i = 0; i < recorded.length; i += 1) {
    const n = i + 1;
    if (!isWrite[i] || effectAt(n)) continue;
    if (n === lastWrite && endStateCovers(writeRequests[i]!, endEffects)) continue;
    const request = writeRequests[i]![0]?.line;
    findings.push({
      rule: "write-without-effect",
      level: "error",
      step: n,
      message: `step ${n}: write step has no effect assertion${request === undefined ? "" : ` (write request: ${request})`}`,
    });
  }

  if (effects.length === 0) {
    findings.push({
      rule: "visibility-only",
      level: "error",
      message: "Journey has no effect assertion at all — every assertion is vacuous",
    });
  }

  const effectAfterLastWrite = effects.some((site) => (site.where === "step" || site.where === "step-request") && site.step >= lastWrite);
  if (lastWrite > 0 && !effectAfterLastWrite && endEffects.length === 0) {
    findings.push({
      rule: "nothing-after-last-write",
      level: "error",
      message: `no effect assertion after the last write (step ${lastWrite}) — the write's outcome is unverified`,
    });
  }

  if (lastWrite > 0 && !sites.some((site) => site.where === "end-state" && site.check.kind === "reloadThen")) {
    findings.push({
      rule: "no-persistence-check",
      level: "warning",
      message: `write step (step ${lastWrite}) has no reloadThen end-state check — persistence is unverified`,
    });
  }

  for (let i = 0; i < recorded.length; i += 1) {
    const n = i + 1;
    const expected = recorded[i]!.expectedResult;
    if (expected !== undefined && expected.trim() !== "" && !effectAt(n)) {
      findings.push({
        rule: "intent-uncovered",
        level: "warning",
        step: n,
        message: `step ${n}: expectedResult is documented but no effect assertion checks it`,
      });
    }
  }

  // #466: the 0.10 anchor rules — warnings on a Journey as it is (promote enforces them on new content).
  for (const issue of anchorLintIssues(journey)) {
    findings.push({ rule: issue.code, level: "warning", ...(issue.step === undefined ? {} : { step: issue.step }), message: issue.message, fix: issue.fix });
  }

  return findings;
}
