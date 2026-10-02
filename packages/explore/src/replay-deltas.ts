import type { Page } from "playwright";
import type { Actor } from "@jevitate/screenplay";
import { BrowseTheWebToken } from "@jevitate/screenplay";
import type { StepObserver } from "@jevitate/interpreter";
import type { ActionDeltaRecord, RecordedStep, Step, TargetDescriptor } from "@jevitate/recording";
import { ActionDeltas, deltaRecord, type ActionDelta } from "./action-delta.js";
import { hangRoute } from "./hang.js";
import { monitorFor } from "./page-monitor.js";
import type { Control } from "./snapshot.js";

/**
 * #303 — action deltas DURING A REPLAY (`journey run|annotate|demo`, `verify-fix` with
 * `--action-deltas`): a step observer that records, per replayed step, what it changed on the page
 * (the same capture, redaction, noise control and code verdict as a goal run), and compares it with
 * the delta the Recording stored for that step when it was made. Observation only: it never changes
 * the replay (the interpreter swallows observer errors), and a mismatch is EVIDENCE, never a verdict.
 */

/** Bound (ms) on the settle wait after a replayed step, before its delta is read. */
const REPLAY_SETTLE_MS = 5_000;
/** Most stored changes compared per step. */
const COMPARE_CHANGES = 8;

/** How a replayed step's delta compares with the one its Recording stored. */
export interface DeltaComparison {
  /** Same verdict, and every stored change (digit-insensitive) seen again. */
  readonly matches: boolean;
  /** What differs (bounded, redacted): `verdict: stored relevant-change, now no-change`, `missing: + status: Saved`. */
  readonly differences: readonly string[];
}

export interface ReplayStepDelta {
  /** The step's flat index in the Recording. */
  readonly index: number;
  readonly delta: ActionDelta;
  /** The delta the Recording stored for this step, when it has one. */
  readonly recorded?: ActionDeltaRecord;
  /** The comparison, when the Recording stored a delta. */
  readonly comparison?: DeltaComparison;
}

const shape = (s: string): string => s.replace(/\d+/g, "#").replace(/\s+/g, " ").trim();

/** Code's comparison of a replayed delta with the stored one (never Jev). */
export function compareDeltas(recorded: ActionDeltaRecord, now: ActionDeltaRecord): DeltaComparison {
  const differences: string[] = [];
  if (recorded.verdict !== now.verdict) differences.push(`verdict: recorded ${recorded.verdict}, now ${now.verdict}`);
  const seen = new Set([...now.changes, ...(now.announcements ?? [])].map(shape));
  for (const c of recorded.changes.slice(0, COMPARE_CHANGES)) if (!seen.has(shape(c))) differences.push(`missing: ${c}`);
  if (recorded.url !== undefined && now.url !== undefined && shape(recorded.url.after) !== shape(now.url.after)) {
    differences.push(`navigated to ${now.url.after}, recorded ${recorded.url.after}`);
  } else if (recorded.url !== undefined && now.url === undefined) differences.push(`did not navigate (recorded: to ${recorded.url.after})`);
  return { matches: differences.length === 0, differences: differences.slice(0, 10) };
}

function targetOf(step: Step): TargetDescriptor | undefined {
  return "target" in step ? step.target : undefined;
}

/** A minimal control for a replayed step's target (what locality and the scoped view need). */
function controlOf(d: TargetDescriptor | undefined): Control | null {
  if (d === undefined) return null;
  const name = d.name ?? d.label ?? d.text ?? "";
  return { index: 0, descriptor: d, role: d.role ?? "", name, tag: "", inputType: null, enabled: true, summary: name } as unknown as Control;
}

function valueOf(step: Step): string | undefined {
  if (!("value" in step) || step.value === undefined) return undefined;
  const v = step.value;
  return typeof v === "object" && v !== null && "redacted" in v && v.redacted === false ? v.value : undefined;
}

/**
 * The replay's delta recorder. `observer()` is composed into the replay's interpreter; `steps()`
 * lists each replayed step's delta (and its comparison with the Recording's).
 */
export class ReplayDeltas {
  readonly #secrets: readonly string[];
  readonly #recorded: readonly RecordedStep[];
  #deltas: ActionDeltas | null = null;
  #page: Page | null = null;
  readonly #steps: ReplayStepDelta[] = [];

  /** `recorded`: the Recording's steps in flat order (their stored deltas are compared). */
  constructor(opts: { readonly secrets: readonly string[]; readonly recorded: readonly RecordedStep[] }) {
    this.#secrets = opts.secrets;
    this.#recorded = opts.recorded;
  }

  async #ready(actor: Actor): Promise<{ page: Page; deltas: ActionDeltas }> {
    const page = actor.ability(BrowseTheWebToken).session.page;
    if (this.#deltas === null || this.#page !== page) {
      this.#page = page;
      this.#deltas = new ActionDeltas(page, { secrets: this.#secrets, goal: "replay" });
      await monitorFor(page).instrument();
      await this.#deltas.enable();
    }
    return { page, deltas: this.#deltas };
  }

  observer(): StepObserver {
    return {
      beforeStep: async ({ actor, recorded }) => {
        const { page, deltas } = await this.#ready(actor);
        const route = hangRoute(page.url());
        await deltas.perceived(route);
        await deltas.beforeAction(route, recorded.step.kind, controlOf(targetOf(recorded.step)));
      },
      afterStep: async ({ actor, index, recorded, outcome }) => {
        const { page, deltas } = await this.#ready(actor);
        if (outcome !== "done") {
          deltas.discard();
          return;
        }
        const t = targetOf(recorded.step);
        const value = valueOf(recorded.step);
        deltas.acted({ label: `${recorded.step.kind} ${t?.name ?? t?.label ?? t?.text ?? ""}`.trim(), recordIndex: index, step: index, ...(value === undefined ? {} : { value }) });
        await monitorFor(page).waitSettled({ ceilingMs: REPLAY_SETTLE_MS }).catch(() => undefined);
        const d = await deltas.perceived(hangRoute(page.url()));
        if (d === null) return;
        const stored = this.#recorded[index]?.delta;
        this.#steps.push({
          index,
          delta: d.delta,
          ...(stored === undefined ? {} : { recorded: stored, comparison: compareDeltas(stored, deltaRecord(d.delta)) }),
        });
      },
    };
  }

  /** Each replayed step's delta, in replay order. */
  steps(): ReplayStepDelta[] {
    return [...this.#steps];
  }

  /** The replayed delta at flat index `index`, if that step was replayed. */
  at(index: number): ReplayStepDelta | undefined {
    return this.#steps.find((s) => s.index === index);
  }

  /** Steps whose delta differs from the Recording's. */
  mismatches(): ReplayStepDelta[] {
    return this.#steps.filter((s) => s.comparison?.matches === false);
  }
}

/** A replay's deltas as a result carries them (#303): per step its delta, and how it compares. */
export interface ReplayDeltaSummary {
  readonly steps: ReadonlyArray<{
    /** 1-based step number. */
    readonly step: number;
    readonly delta: ActionDeltaRecord;
    readonly matchesRecorded?: boolean;
    readonly differences?: readonly string[];
  }>;
  /** Steps whose delta differs from the one the Recording stored. */
  readonly mismatches: number;
}

export function replayDeltaSummary(rd: ReplayDeltas): ReplayDeltaSummary {
  const steps = rd.steps().map((s) => ({
    step: s.index + 1,
    delta: deltaRecord(s.delta),
    ...(s.comparison === undefined ? {} : { matchesRecorded: s.comparison.matches }),
    ...(s.comparison === undefined || s.comparison.matches ? {} : { differences: s.comparison.differences }),
  }));
  return { steps, mismatches: rd.mismatches().length };
}

/**
 * #303: a step's expected result drafted BY CODE from its observed delta (`journey annotate
 * --action-deltas`) — what the step visibly did: a navigation, an announcement, the closest changes.
 * Null when the delta shows no relevant change (the draft then falls back to the model).
 */
export function expectedResultFromDelta(d: ActionDeltaRecord): string | null {
  if (d.verdict !== "relevant-change") return null;
  const parts: string[] = [];
  if (d.url !== undefined) parts.push(`the page navigates to ${d.url.after}`);
  for (const a of (d.announcements ?? []).slice(0, 2)) parts.push(`the page announces ${JSON.stringify(a)}`);
  for (const c of d.changes.slice(0, 3)) {
    if (c.startsWith("+ ")) parts.push(`${c.slice(2)} appears`);
    else if (c.startsWith("- ")) parts.push(`${c.slice(2)} disappears`);
    else if (c.startsWith("~ ")) parts.push(`${c.slice(2)}`);
    else parts.push(c);
  }
  if (parts.length === 0) return null;
  const text = parts.join("; ");
  return text.length <= 500 ? text : `${text.slice(0, 499)}…`;
}
