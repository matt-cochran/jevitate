import { FsJourneyStore, describeStep, flatJourneySteps, secretParamValues, type Journey } from "@jevitate/journey";
import type { StepObserver } from "@jevitate/interpreter";
import { resolveTarget } from "@jevitate/interpreter";
import { displayOrRefusal, isSecretField, type DisplayRefusal } from "@jevitate/recorder";
import type { Step, TargetDescriptor, TargetDisplay } from "@jevitate/recording";
import { redactText } from "@jevitate/ai-core";
import { BrowseTheWebToken } from "@jevitate/screenplay";
import type { Locator } from "playwright";
import { runJourneyProgrammatically, type RunJourneyProgrammaticallyOptions } from "./journey-api.js";

/**
 * #497 — the opt-in label backfill: Journeys recorded before steps carried their visible label
 * (`TargetDescriptor.display`) are REPLAYED in a browser and, at each step, the resolved target
 * element's accessible role and name are read and stored as that step's `display`. Display metadata
 * only — it never changes how a step locates its element.
 *
 * The replay is a real `journey run` (`runJourneyProgrammatically`: same session, environment, site
 * policy, fixtures and fail-closed policy), observed before each step acts. The target is resolved
 * exactly as the replay resolves it (`resolveTarget`), so the label is read off the element the step
 * really acts on. A label is never stored for a credential field (password / one-time code) or when
 * it holds a secret parameter's value or a credential-shaped string (`displayOrRefusal`).
 *
 * A file is written only when a step gained a label (never on `dryRun`). The recording is inside the
 * content hash, so a promoted Journey's approval goes stale and is listed by
 * `jevitate journey review --stale` — as #467's step-id backfill. It never approves.
 *
 * Not yet wired: the CLI (`jevitate journey migrate --labels [--id <id>...] [--dry-run] [--param k=v]
 * [--env/--base-url] [--storage-state]`) arrives with a later deliverable; no MCP tool.
 */

export interface MigrateLabelsRequest {
  /** The journeys dir (`--dir`, else the repo's `.jevitate/journeys`). */
  readonly journeysDir: string;
  /** Only these Journeys (`--id`, repeatable). Absent: every local Journey. */
  readonly ids?: readonly string[];
  /** `--dry-run`: replay and report, write nothing. */
  readonly dryRun?: boolean;
  /**
   * `--param k=v`: the replays' parameters; each Journey gets only the ones it declares. Secret ones
   * are redacted from every label and the report.
   */
  readonly params?: Readonly<Record<string, string>>;
  /** How long a step's target may take to appear before it is left unlabelled. Default 5s. */
  readonly targetTimeoutMs?: number;
  /** Every other `journey run` option (environment, storage state, browser, site policy…). */
  readonly run?: Omit<RunJourneyProgrammaticallyOptions, "dir" | "id" | "params" | "observer" | "interpreter">;
}

/** Why a step was left without a label. */
export type UnlabelledReason =
  /** The replay stopped before this step. */
  | "not-reached"
  /** The step's target did not resolve to exactly one element. */
  | "target-not-found"
  /** The element has no accessible name. */
  | "no-label"
  /** The element is a password / one-time-code field: its label is never stored. */
  | "credential-field"
  /** The label holds a secret: it is never stored. */
  | "secret";

export interface UnlabelledStep {
  /** 1-based flat step number. */
  readonly step: number;
  readonly stepId?: string;
  /** The step as `describeStep` shows it (redacted). */
  readonly action: string;
  readonly reason: UnlabelledReason;
}

export interface LabelledJourney {
  readonly id: string;
  /** Steps that gained a label. */
  readonly labelled: number;
  /** Steps that already had one (left as they are). */
  readonly alreadyLabelled: number;
  readonly unlabelled: readonly UnlabelledStep[];
  /** The replay: `ok`, `stopped` early (with why), or `skipped` (no step needed a label). */
  readonly replay: { readonly outcome: "ok" | "stopped" | "skipped"; readonly reason?: string };
  /** True when the Journey file was rewritten. */
  readonly written: boolean;
  /** True when it is promoted and a label was added: its approval is now stale. */
  readonly needsReapproval: boolean;
}

export interface MigrateLabelsResult {
  readonly dryRun: boolean;
  readonly journeys: readonly LabelledJourney[];
  readonly totals: {
    readonly journeys: number;
    readonly labelled: number;
    readonly unlabelled: number;
    readonly written: number;
    readonly needsReapproval: number;
  };
}

const DEFAULT_TARGET_TIMEOUT_MS = 5_000;

/** The single target a step acts on (the steps a label describes), or undefined. */
function targetOf(step: Step): TargetDescriptor | undefined {
  switch (step.kind) {
    case "click":
    case "fill":
    case "select":
    case "upload":
    case "editText":
    case "waitFor":
    case "extract":
      return step.target;
    default:
      return undefined;
  }
}

/** `- button "Import" [disabled]` → role + name (Playwright's aria snapshot of one element). */
export function parseAriaHead(snapshot: string): { role: string; name: string } | null {
  const first = snapshot.split("\n")[0] ?? "";
  const m = /^\s*- ([a-z][\w-]*)(?: "((?:[^"\\]|\\.)*)")?/.exec(first);
  if (m === null || m[2] === undefined) return null;
  let name: string;
  try {
    name = JSON.parse(`"${m[2]}"`) as string;
  } catch {
    name = m[2];
  }
  return { role: m[1]!, name };
}

/** Reads the label of the element `loc` resolved to; a credential field's is never read. */
async function readDisplay(loc: Locator, secrets: readonly string[], timeoutMs: number): Promise<{ display: TargetDisplay } | { refused: DisplayRefusal }> {
  const kind = await loc.evaluate((el) => ({
    type: el instanceof HTMLInputElement ? el.type : null,
    autocomplete: el.getAttribute("autocomplete"),
  }));
  if (isSecretField(kind.type, kind.autocomplete)) return { refused: "credential-field" };
  const head = parseAriaHead(await loc.ariaSnapshot({ timeout: timeoutMs }));
  return displayOrRefusal({ role: head?.role ?? null, name: head?.name ?? null }, { secrets });
}

/** The Journey with `displays` (by flat step index) set on those steps' targets. */
function withDisplays(journey: Journey, displays: ReadonlyMap<number, TargetDisplay>): Journey {
  let n = 0;
  const pages = journey.recording.pages.map((p) => ({
    ...p,
    steps: p.steps.map((rs) => {
      const display = displays.get(n++);
      const target = targetOf(rs.step);
      if (display === undefined || target === undefined) return rs;
      return { ...rs, step: { ...rs.step, target: { ...target, display } } as Step };
    }),
  }));
  return { ...journey, recording: { ...journey.recording, pages } };
}

async function migrateOne(store: FsJourneyStore, journey: Journey, req: MigrateLabelsRequest): Promise<LabelledJourney> {
  const id = journey.metadata.id;
  // The request's params serve every Journey: each replay gets only the ones it declares.
  const declared = new Set([...journey.metadata.params, ...(journey.metadata.parameters ?? []).map((p) => p.name)]);
  const params = Object.fromEntries(Object.entries(req.params ?? {}).filter(([k]) => declared.has(k)));
  const secrets = secretParamValues(journey, params);
  const timeoutMs = req.targetTimeoutMs ?? DEFAULT_TARGET_TIMEOUT_MS;
  const flat = flatJourneySteps(journey);
  const need = flat.filter((s) => {
    const t = targetOf(s.recorded.step);
    return t !== undefined && t.display === undefined;
  });
  const alreadyLabelled = flat.filter((s) => targetOf(s.recorded.step)?.display !== undefined).length;
  if (need.length === 0) {
    return { id, labelled: 0, alreadyLabelled, unlabelled: [], replay: { outcome: "skipped" }, written: false, needsReapproval: false };
  }

  const wanted = new Set(need.map((s) => s.index));
  const displays = new Map<number, TargetDisplay>();
  const refused = new Map<number, UnlabelledReason>();
  const observer: StepObserver = {
    beforeStep: async ({ actor, index, recorded }) => {
      const target = targetOf(recorded.step);
      if (!wanted.has(index) || target === undefined) return;
      const page = actor.ability(BrowseTheWebToken).session.page;
      let loc: Locator;
      try {
        loc = await resolveTarget(page, target, { timeoutMs });
      } catch {
        refused.set(index, "target-not-found");
        return;
      }
      try {
        const r = await readDisplay(loc, secrets, timeoutMs);
        if ("display" in r) displays.set(index, r.display);
        else refused.set(index, r.refused);
      } catch {
        refused.set(index, "target-not-found");
      }
    },
  };

  let replay: LabelledJourney["replay"];
  try {
    const run = await runJourneyProgrammatically({ ...(req.run ?? {}), dir: req.journeysDir, id, params, observer });
    replay = run.outcome === "ok" || run.outcome === "healed-pending-review"
      ? { outcome: "ok" }
      : { outcome: "stopped", reason: redactText(run.reason, secrets).slice(0, 2000) };
  } catch (e) {
    replay = { outcome: "stopped", reason: redactText(e instanceof Error ? e.message : String(e), secrets).slice(0, 2000) };
  }

  const unlabelled: UnlabelledStep[] = need
    .filter((s) => !displays.has(s.index))
    .map((s) => ({
      step: s.index + 1,
      ...(s.recorded.stepId === undefined ? {} : { stepId: s.recorded.stepId }),
      action: redactText(describeStep(s.recorded.step), secrets),
      reason: refused.get(s.index) ?? "not-reached",
    }));
  const changed = displays.size > 0;
  if (changed && req.dryRun !== true) await store.put(withDisplays(journey, displays));
  return {
    id,
    labelled: displays.size,
    alreadyLabelled,
    unlabelled,
    replay,
    written: changed && req.dryRun !== true,
    needsReapproval: changed && journey.metadata.promoted,
  };
}

/** Backfills step labels by replaying each Journey (see the module doc). Journeys run one at a time. */
export async function migrateLabels(req: MigrateLabelsRequest): Promise<MigrateLabelsResult> {
  const store = new FsJourneyStore(req.journeysDir);
  const ids = req.ids ?? (await store.list()).map((m) => m.id);
  const journeys: LabelledJourney[] = [];
  for (const id of ids) {
    const journey = await store.get(id);
    if (journey === null) throw new Error(`unknown journey '${id}'`);
    journeys.push(await migrateOne(store, journey, req));
  }
  return {
    dryRun: req.dryRun === true,
    journeys,
    totals: {
      journeys: journeys.length,
      labelled: journeys.reduce((n, j) => n + j.labelled, 0),
      unlabelled: journeys.reduce((n, j) => n + j.unlabelled.length, 0),
      written: journeys.filter((j) => j.written).length,
      needsReapproval: journeys.filter((j) => j.needsReapproval).length,
    },
  };
}

/** The human rendering (no `--json`) — for the CLI deliverable that wires `journey migrate --labels`. */
export function renderMigrateLabels(r: MigrateLabelsResult): string {
  const verb = r.dryRun ? "would label" : "labelled";
  const lines = [`${verb} ${r.totals.labelled} step(s) in ${r.totals.journeys} Journey(s); ${r.totals.unlabelled} left unlabelled; ${r.totals.needsReapproval} promoted Journey(s) need re-approval`];
  for (const j of r.journeys) {
    for (const u of j.unlabelled) lines.push(`  ${j.id} step ${u.step}: ${u.action} — ${u.reason}`);
    if (j.replay.outcome === "stopped") lines.push(`  ${j.id}: replay stopped: ${j.replay.reason ?? "unknown"}`);
  }
  if (r.totals.needsReapproval > 0) lines.push("next: jevitate journey review --stale");
  return `${lines.join("\n")}\n`;
}
