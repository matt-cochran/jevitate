import type { HealerCandidate, HealerProposal, HealerRequest, SelfHealer, ChangeEvidenceRef } from "@jevitate/runtime";
import { normalizeAnchor, sanitizeStep } from "@jevitate/runtime";
import { snapshot, type Control } from "@jevitate/explore";
import type { GenerationPort, UsageLedger } from "@jevitate/ai-core";
import type { Actor } from "@jevitate/screenplay";
import { BrowseTheWebToken } from "@jevitate/screenplay";
import { clock } from "@jevitate/domain";
import { describeStep } from "@jevitate/journey";
import type { Step, TargetDescriptor } from "@jevitate/recording";
import { redactSecretValues } from "./journey-api.js";

/**
 * #453: the CLI's `SelfHealer` — EVIDENCE-ONLY. It never acts on the page (`actsOnPage: false`), so
 * the runner may consult it for a guarded click/fill step too (whose probe runs under the write
 * blocker). Its whole input is:
 *  - the broken step (sanitised: `hideValue`),
 *  - a read-only snapshot of the page's controls (the observed inventory: role, name, test id, label),
 *  - the change evidence as `{kind, before, after}` facts only — never a raw hunk, never a credential
 *    (every string is scrubbed of the run's secret params, `redactSecretValues`).
 *
 * It proposes single-step RETARGETS of the broken step: the step with only its `target` changed, its
 * proof (`expect`, `value`, …) as recorded. Deterministic candidates come first: an inventory control
 * whose name / test id / label equals some evidence `after`. The model (`GenerationPort`, task
 * `heal.rank`) is only an advisory ranker of those candidates and may pick at most ONE more control
 * from the inventory — within the request's `maxModelCalls` and `deadlineAtMs`; past the deadline its
 * answer is dropped. The runner adjudicates every candidate (proof untouched, change evidence, the
 * floor, the probe): nothing here decides that a heal holds.
 */

/** One observed control: what the healer and the model see of the page. */
export interface InventoryControl {
  readonly role: string;
  readonly name: string;
  readonly testId?: string;
  readonly label?: string;
  readonly enabled: boolean;
  /** Model-facing one-liner (redacted page content). */
  readonly summary: string;
}

/** Reads the live page's controls without acting on it. */
export type ControlInventoryReader = (actor: Actor, secrets: readonly string[]) => Promise<readonly InventoryControl[]>;

export interface EvidenceSelfHealerOptions {
  /** Test seam; default: `snapshot()` of the actor's page (read-only). */
  readonly inventory?: ControlInventoryReader;
  /** The most inventory controls shown to the model. Default 80. */
  readonly maxControls?: number;
  /**
   * #453 review: the run's usage ledger (the gateway's `UsageTracker`). When given, the tokens a
   * ranker call reported (input + output) are charged to the heal budget (`usage.tokens`). A gateway
   * that reports none (the fake) charges none.
   */
  readonly usage?: UsageLedger;
}

/** Roles a fill step may target. */
const FIELD_ROLES = new Set(["textbox", "searchbox", "combobox", "spinbutton"]);
const DEFAULT_MAX_CONTROLS = 80;
const MAX_CANDIDATES = 8;

/** The default inventory: the explore snapshot's controls (read-only, already redacted). */
export const snapshotInventory: ControlInventoryReader = async (actor, secrets) => {
  let page;
  try {
    page = actor.ability(BrowseTheWebToken).session.page;
  } catch {
    return [];
  }
  const snap = await snapshot(page, { secrets, maxCandidates: 120 });
  return snap.controls.map(inventoryOf);
};

function inventoryOf(c: Control): InventoryControl {
  const d = c.descriptor;
  return {
    role: c.role,
    name: c.name,
    ...(d.testId === undefined ? {} : { testId: d.testId }),
    ...(d.label === undefined ? {} : { label: d.label }),
    enabled: c.enabled,
    summary: c.summary,
  };
}

export function makeEvidenceSelfHealer(generation?: GenerationPort, opts: EvidenceSelfHealerOptions = {}): SelfHealer {
  const readInventory = opts.inventory ?? snapshotInventory;
  const maxControls = opts.maxControls ?? DEFAULT_MAX_CONTROLS;
  return {
    actsOnPage: false,
    async proposeCandidates(req: HealerRequest): Promise<HealerProposal> {
      const secrets = req.secrets ?? [];
      const broken = req.brokenStep;
      if (!("target" in broken) || broken.target === undefined) {
        return { candidates: [], usage: { modelCalls: 0 }, reason: `a ${broken.kind} step has no target to retarget onto a page control` };
      }
      // Only the change FACTS, scrubbed of the run's secrets.
      const evidence = redactSecretValues(req.evidence.map(factOf), secrets);
      let inventory: readonly InventoryControl[];
      try {
        inventory = redactSecretValues((await readInventory(req.actor, secrets)).filter((c) => c.enabled && fits(broken, c)), secrets);
      } catch {
        inventory = [];
      }
      const tried = new Set(req.tried.map((s) => JSON.stringify(s)));
      const fresh = (s: Step): boolean => !tried.has(JSON.stringify(sanitizeStep(s))) && JSON.stringify(s) !== JSON.stringify(broken);

      const deterministic = dedupe(evidenceRetargets(broken, inventory, evidence).filter((c) => fresh(c.step)));
      const ask = generation !== undefined && req.maxModelCalls >= 1 && clock.now() < req.deadlineAtMs && (deterministic.length > 0 || inventory.length > 0);
      if (!ask) {
        return deterministic.length === 0
          ? { candidates: [], usage: { modelCalls: 0 }, reason: "no observed control matches the change evidence" }
          : { candidates: deterministic.slice(0, MAX_CANDIDATES), usage: { modelCalls: 0 } };
      }

      const shown = inventory.slice(0, maxControls);
      const input = redactSecretValues(
        {
          step: describeStep(sanitizeStep(broken)).slice(0, 1000),
          evidence: evidence.slice(0, 40).map((e) => ({ kind: e.kind.slice(0, 40), before: clip(e.before), after: clip(e.after) })),
          candidates: deterministic.slice(0, 40).map((c, index) => ({ index, summary: c.hypothesis.slice(0, 300) })),
          controls: shown.map((c, index) => ({ index, summary: c.summary.slice(0, 300) })),
        },
        secrets,
      );
      const tokensSoFar = (): number => {
        const c = opts.usage?.snapshot();
        return c === undefined ? 0 : c.inputTokens + c.outputTokens;
      };
      const before = tokensSoFar();
      const usage: { modelCalls: number; tokens?: number } = { modelCalls: 1 };
      let ranked: { order: readonly number[]; control: number | null } | undefined;
      try {
        ranked = (await withDeadline(generation.generate("heal.rank", input), req.deadlineAtMs)).output;
      } catch {
        ranked = undefined;
      }
      const spent = tokensSoFar() - before;
      if (spent > 0) usage.tokens = spent;
      if (ranked === undefined) {
        return { candidates: deterministic.slice(0, MAX_CANDIDATES), usage, reason: "the model ranker gave no usable answer within the heal deadline" };
      }
      const seen = new Set<number>();
      const ordered: HealerCandidate[] = [];
      for (const i of ranked.order) {
        const c = deterministic[i];
        if (c === undefined || seen.has(i)) continue;
        seen.add(i);
        ordered.push(c);
      }
      // The ranker is advisory: an evidence candidate it left out is still tried, after its picks.
      deterministic.forEach((c, i) => {
        if (!seen.has(i)) ordered.push(c);
      });
      const picked = ranked.control === null ? undefined : shown[ranked.control];
      const extra = picked === undefined ? undefined : controlRetarget(broken, picked, `the model picked the page's ${picked.role || "control"} ${quote(picked.name)}`);
      const all = dedupe(extra === undefined || !fresh(extra.step) ? ordered : [...ordered, extra]);
      return { candidates: all.slice(0, MAX_CANDIDATES), usage };
    },
  };
}

interface Fact {
  readonly kind: string;
  readonly before?: string;
  readonly after?: string;
}

function factOf(e: ChangeEvidenceRef): Fact {
  return { kind: e.kind, ...(e.before === undefined ? {} : { before: e.before }), ...(e.after === undefined ? {} : { after: e.after }) };
}

function clip(s: string | undefined): string | null {
  return s === undefined ? null : s.slice(0, 300);
}

/** Can `broken` (a click/fill/extract) target this control at all? */
function fits(broken: Step, c: InventoryControl): boolean {
  if (broken.kind === "fill") return FIELD_ROLES.has(c.role);
  if (broken.kind === "click") return !FIELD_ROLES.has(c.role);
  return true;
}

type Via = "testId" | "name" | "label";

/** Inventory controls whose name / test id / label equals an evidence `after` → a retarget onto that anchor. */
function evidenceRetargets(broken: Step, inventory: readonly InventoryControl[], evidence: readonly Fact[]): HealerCandidate[] {
  const out: HealerCandidate[] = [];
  for (const e of evidence) {
    if (e.after === undefined || e.kind === "inserted-ui") continue;
    const after = normalizeAnchor(e.after);
    for (const c of inventory) {
      const via: Via | undefined =
        c.testId !== undefined && normalizeAnchor(c.testId) === after && (e.kind === "test-id" || e.kind === "note")
          ? "testId"
          : normalizeAnchor(c.name) === after
            ? "name"
            : c.label !== undefined && normalizeAnchor(c.label) === after
              ? "label"
              : undefined;
      if (via === undefined) continue;
      const cand = controlRetarget(broken, c, `${e.kind} ${quote(e.before)} → ${quote(e.after)} matches the page's ${c.role || "control"} ${quote(c.name)}`, via);
      if (cand !== undefined) out.push(cand);
    }
  }
  return out;
}

/** `broken` retargeted onto control `c` by one anchor (its frame and container kept, everything else as recorded). */
function controlRetarget(broken: Step, c: InventoryControl, why: string, via?: Via): HealerCandidate | undefined {
  if (!("target" in broken) || broken.target === undefined) return undefined;
  const old: TargetDescriptor = broken.target;
  const by: Via = via ?? (c.name.trim() === "" ? (c.testId !== undefined ? "testId" : "label") : "name");
  const anchor: TargetDescriptor | undefined =
    by === "testId"
      ? c.testId === undefined
        ? undefined
        : { testId: c.testId }
      : by === "label"
        ? c.label === undefined
          ? undefined
          : { label: c.label }
        : c.name.trim() === ""
          ? undefined
          : { ...(c.role === "" ? {} : { role: c.role }), name: c.name.trim() };
  if (anchor === undefined) return undefined;
  const target: TargetDescriptor = { ...anchor, ...(old.frameUrl === undefined ? {} : { frameUrl: old.frameUrl }), ...(old.container === undefined ? {} : { container: old.container }) };
  return { step: { ...broken, target } as Step, hypothesis: `${why}: retarget to ${describeTarget(target)}` };
}

function describeTarget(t: TargetDescriptor): string {
  if (t.testId !== undefined) return `test id ${quote(t.testId)}`;
  if (t.label !== undefined) return `label ${quote(t.label)}`;
  return `${t.role ?? "control"} ${quote(t.name)}`;
}

function quote(s: string | undefined): string {
  return s === undefined ? "(none)" : JSON.stringify(s);
}

function dedupe(cs: readonly HealerCandidate[]): HealerCandidate[] {
  const seen = new Set<string>();
  return cs.filter((c) => {
    const k = JSON.stringify(c.step);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/** `p`, or a rejection once the `clock.now()` instant `deadlineAtMs` passes. */
function withDeadline<T>(p: Promise<T>, deadlineAtMs: number): Promise<T> {
  const left = deadlineAtMs - clock.now();
  if (left <= 0) return Promise.reject(new Error("heal deadline passed"));
  return new Promise<T>((resolve, reject) => {
    const timer = clock.setTimeout(() => reject(new Error("heal deadline passed")), left);
    p.then(
      (v) => {
        clock.clearTimeout(timer);
        resolve(v);
      },
      (e: unknown) => {
        clock.clearTimeout(timer);
        reject(e instanceof Error ? e : new Error(String(e)));
      },
    );
  });
}
