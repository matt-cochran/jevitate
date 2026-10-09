import type { HealBudget, SelfHealMode } from "@jevitate/domain";
import { DEFAULT_HEAL_BUDGET, EMPTY_CHANGE_SCOPE, type ChangeScope, type JourneyRunResult, type StepRiskClassifier } from "@jevitate/runtime";
import { describeStep } from "@jevitate/journey";
import { SafetyPolicy, controlRisk } from "@jevitate/explore";
import type { Step, TargetDescriptor } from "@jevitate/recording";
import { parseChangeRange, readChangeScope, validateChangeNotes, type GitExec } from "./change-context.js";
import { findGitRoot } from "./project-dir.js";

/**
 * #453: the change-aware self-heal inputs `journey run` and MCP `run_journey` share — the change
 * context (`--changes <range>`, `--change-note`), the heal budget flags, and their refusals. Every
 * refusal happens before any Journey is looked up or any browser opens.
 */

/** A self-heal argument combination that is unusable (exit 64). */
export class JourneyHealArgsError extends Error {
  readonly code = "E_JOURNEY_RUN_ARGS" as const;
  constructor(message: string) {
    super(message);
    this.name = "JourneyHealArgsError";
  }
}

/** What a caller asked for (CLI flags or MCP arguments). */
export interface JourneyHealRequest {
  readonly selfHeal: SelfHealMode;
  readonly changes?: string;
  readonly changeNotes: readonly string[];
  readonly maxAttempts?: number;
  readonly maxModelCalls?: number;
  readonly maxMs?: number;
  readonly maxRunAttempts?: number;
  readonly maxRunMs?: number;
}

/** How each budget input is named on a surface (CLI flags vs MCP argument names), for refusals. */
export interface JourneyHealNames {
  readonly selfHeal: string;
  readonly changes: string;
  readonly changeNote: string;
  readonly budget: string;
}

export const CLI_HEAL_NAMES: JourneyHealNames = { selfHeal: "--self-heal", changes: "--changes", changeNote: "--change-note", budget: "--heal-max-*" };
export const MCP_HEAL_NAMES: JourneyHealNames = { selfHeal: "'selfHeal'", changes: "'changes'", changeNote: "'changeNote'", budget: "'healMax*'" };

const hasBudget = (r: JourneyHealRequest): boolean =>
  r.maxAttempts !== undefined || r.maxModelCalls !== undefined || r.maxMs !== undefined || r.maxRunAttempts !== undefined || r.maxRunMs !== undefined;

/**
 * Q1: a heal mode needs a change context (`--changes` and/or `--change-note`) — every break would
 * otherwise be unexplained; the change and budget inputs need a heal mode. The range's syntax and the
 * notes are checked here too (`ChangesArgsError`). Pure: no git, no store, no browser.
 */
export function validateJourneyHeal(r: JourneyHealRequest, names: JourneyHealNames = CLI_HEAL_NAMES): void {
  const context = r.changes !== undefined || r.changeNotes.length > 0;
  if (r.selfHeal === "fail-closed") {
    if (context) throw new JourneyHealArgsError(`${r.changes !== undefined ? names.changes : names.changeNote} needs ${names.selfHeal} hybrid|full (a change context only explains a break a self-heal may repair)`);
    if (hasBudget(r)) throw new JourneyHealArgsError(`${names.budget} needs ${names.selfHeal} hybrid|full`);
    return;
  }
  if (!context) {
    throw new JourneyHealArgsError(
      `${names.selfHeal} ${r.selfHeal} needs a change context: ${names.changes} <git range> and/or ${names.changeNote} <text> (a self-heal repairs only a break the change explains)`,
    );
  }
  if (r.changes !== undefined) parseChangeRange(r.changes);
  validateChangeNotes(r.changeNotes);
}

/** The run's `HealBudget`: the defaults, with the given per-step and per-run limits (a run limit is never below its step limit). */
export function journeyHealBudget(r: JourneyHealRequest): HealBudget {
  const d = DEFAULT_HEAL_BUDGET;
  const perStep = {
    ...d.perStep,
    ...(r.maxAttempts === undefined ? {} : { maxAttempts: r.maxAttempts }),
    ...(r.maxModelCalls === undefined ? {} : { maxModelCalls: r.maxModelCalls }),
    ...(r.maxMs === undefined ? {} : { maxMs: r.maxMs }),
  };
  return {
    perStep,
    perRun: {
      ...d.perRun,
      maxAttempts: r.maxRunAttempts ?? Math.max(d.perRun.maxAttempts, perStep.maxAttempts),
      maxModelCalls: Math.max(d.perRun.maxModelCalls, perStep.maxModelCalls),
      maxMs: r.maxRunMs ?? Math.max(d.perRun.maxMs, perStep.maxMs),
    },
  };
}

/**
 * Reads the change context (read-only git, `readChangeScope`) in the repository that holds the
 * Journeys directory (its git root; the directory itself when it is in none — a range then fails
 * `E_CHANGES_INPUT`). Notes only: no git at all. A fail-closed run has the empty scope.
 */
export async function readJourneyChangeScope(r: JourneyHealRequest, journeysDir: string, exec?: GitExec): Promise<ChangeScope> {
  if (r.selfHeal === "fail-closed") return EMPTY_CHANGE_SCOPE;
  const cwd = findGitRoot(journeysDir) ?? journeysDir;
  return readChangeScope({ cwd, notes: r.changeNotes, ...(r.changes === undefined ? {} : { range: r.changes }), ...(exec === undefined ? {} : { exec }) });
}

/**
 * #453 (Q2): the risky/irreversible classification of a click/fill step's control, from explore's
 * `SafetyPolicy` (the built-in session-end / destructive / paid vocabulary). Every anchor the target
 * carries is checked — its accessible name, label, text, and its test id / css tokens read as words —
 * so a control addressed only by `data-testid="delete-account"` is still classified. A control with
 * no readable anchor at all is treated as risky: it cannot be classified, so it is never healed.
 */
export function journeyStepRisk(policy: SafetyPolicy = new SafetyPolicy()): StepRiskClassifier {
  return (step: Step): string | null => {
    if (!("target" in step) || step.target === undefined) return null;
    const names = anchorWords(step.target);
    if (names.length === 0) return "unclassifiable";
    const role = step.target.role;
    for (const name of names) {
      const risk = policy.riskOf({ name, role: role ?? "", descriptor: step.target }) ?? controlRisk(name, role)?.risk ?? null;
      if (risk !== null) return risk;
    }
    return null;
  };
}

function anchorWords(t: TargetDescriptor): string[] {
  const out: string[] = [];
  for (const v of [t.name, t.label, t.text]) if (v !== undefined && v.trim() !== "") out.push(v.trim());
  for (const v of [t.testId, t.css]) {
    if (v === undefined) continue;
    const words = v.replace(/[^A-Za-z0-9]+/g, " ").replace(/([a-z])([A-Z])/g, "$1 $2").trim();
    if (words !== "") out.push(words);
  }
  if (t.container !== undefined) out.push(...anchorWords(t.container));
  return out;
}

/**
 * #453: the human summary of a self-heal `journey run` (stderr; stdout keeps the JSON result). A
 * proposed revision names each retargeted step and — once the run wrote a proposal (its `proposal.id`
 * on the result) — the review and accept commands; an exhausted or unexplained break names the step.
 */
export function journeyRunSummary(id: string, result: JourneyRunResult & { proposal?: { id?: unknown } }): string {
  const lines: string[] = [];
  switch (result.outcome) {
    case "ok":
      lines.push(`journey ${id}: ok${result.heal === undefined ? "" : " (no heal was needed)"}`);
      break;
    case "healed-pending-review": {
      const n = result.revision.steps.length;
      lines.push(`journey ${id}: healed-pending-review — the run completed only after ${n} step retarget(s); nothing passes until a person accepts the proposed revision`);
      for (const c of result.revision.steps) {
        lines.push(`  step ${c.index + 1}: ${describeStep(c.before)} → ${describeStep(c.after)}`);
        lines.push(`    because ${c.hypothesis}${c.anchorNotInChange === true ? " (the new anchor appears in no change evidence)" : ""}`);
      }
      const pid = typeof result.proposal?.id === "string" ? result.proposal.id : undefined;
      if (pid !== undefined) {
        lines.push(`next: jevitate journey review ${id}`);
        lines.push(`next: jevitate journey promote ${id} --proposal ${pid}`);
      }
      break;
    }
    case "heal-exhausted":
      lines.push(`journey ${id}: heal-exhausted — ${result.reason}`);
      break;
    case "quarantined":
      lines.push(`journey ${id}: quarantined — ${result.reason}`);
      break;
  }
  const attempts = result.heal?.attempts.length ?? 0;
  if (attempts > 0) lines.push(`  heal attempts: ${attempts} (verdict ${result.heal?.verdict ?? "unknown"})`);
  return `${lines.join("\n")}\n`;
}
