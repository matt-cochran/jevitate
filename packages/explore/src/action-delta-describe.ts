import { clock } from "@jevitate/domain";
import {
  VALUE_ROLES,
  anchorOf,
  clip,
  digitMask,
  valueOf,
  type ActionDeltaStats,
  type AriaLine,
  type ExpectedChange,
  type RawChange,
  type TargetContext,
} from "./action-delta-aria.js";

export type DeltaVerdict = "no-change" | "relevant-change" | "inconclusive";

/** How close a change is to the action (ranked in this order). */
export type DeltaLocality = "target" | "container" | "dialog" | "live" | "page";

export interface DeltaChange {
  readonly kind: "added" | "removed" | "changed";
  /** The change as one redacted, bounded line: `+ status: Saved`, `~ textbox "Name": "" → "Bob"`. */
  readonly text: string;
  readonly where: DeltaLocality;
  /** Tied to the action (by locality, or by a Jev `relevant` label). */
  readonly tied: boolean;
  readonly by?: "locality" | "jev";
  /** Jev's advisory label, when it was asked. */
  readonly jev?: "relevant" | "irrelevant" | "changes-on-its-own";
  /** How many raw changes this line stands for (a summarised group); absent for one. */
  readonly count?: number;
}

export interface ActionDelta {
  /** The action, as the transcript names it (`click Save`). */
  readonly action: string;
  readonly verdict: DeltaVerdict;
  /** Why code decided the verdict. */
  readonly why: string;
  /** The kept changes, closest to the action first (bounded: `DELTA_MAX_CHANGES`). */
  readonly changes: readonly DeltaChange[];
  /** Kept changes past the cap (counted, not listed). */
  readonly omitted?: number;
  /** Announcements (toasts, banners, live-region updates) the page made after the action. */
  readonly announcements?: readonly string[];
  /** The requests the action set off: `POST /api/items → 201` (background polling excluded). */
  readonly requests?: readonly string[];
  readonly url?: { readonly before: string; readonly after: string };
  readonly title?: { readonly before: string; readonly after: string };
  /** Changes dropped as volatile (the page changes them on its own). */
  readonly volatileIgnored?: number;
  /** Changes dropped by a validated Jev ignore rule for this route. */
  readonly ruleIgnored?: number;
  /** Why the capture was partial (then an empty diff is never `no-change`). */
  readonly partial?: readonly string[];
  /** The stated expectation, and whether the delta met it (`null`: could not tell). */
  readonly expected?: { readonly description: string; readonly met: boolean | null; readonly by: "code" | "jev" };
  /** Ignore rules Jev proposed at this step: accepted (validated by code) and rejected. */
  readonly rules?: { readonly accepted: readonly string[]; readonly rejected: readonly string[] };
  /** Time this delta cost (ms): both captures and the comparison (Jev excluded — see `jevMs`). */
  readonly overheadMs: number;
  /** Time the advisory Jev relevance call took (ms), when one was made. */
  readonly jevMs?: number;
  /**
   * #303 persistence: for an action whose write went through, did its lasting changes survive a
   * reload (`no` after a 2xx write: saved but not stored — evidence, never a verdict on its own)?
   */
  readonly persisted?: "yes" | "no" | "inconclusive";
  readonly persistedWhy?: string;
}

/** Bound (chars) on the delta line in the model's step prompt. */
export const DELTA_PROMPT_CHARS = 400;
const LIVE_ROLES = new Set(["status", "alert", "log"]);
const DIALOG_ROLES = new Set(["dialog", "alertdialog"]);

/** BROWSER CODE — why the target itself cannot be seen by an accessibility snapshot, or null. */
export function targetOpacity(el: Element): string | null {
  if (el.tagName === "CANVAS" || el.closest("canvas") !== null) return "the target is a canvas";
  if (el.tagName === "IFRAME") return "the target is a frame";
  if (el.tagName.includes("-") && (el as HTMLElement).shadowRoot === null && el.children.length === 0) {
    const r = el.getBoundingClientRect();
    if (r.width > 0 && r.height > 0) return "the target renders in a closed shadow root";
  }
  return null;
}


/** Bounded race: the value, or `fallback` when `ms` passes first. */
export async function bounded<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([p.catch(() => fallback), new Promise<T>((r) => (timer = clock.setTimeout(() => r(fallback), Math.max(1, ms))))]);
  } finally {
    if (timer !== undefined) clock.clearTimeout(timer);
  }
}


/** The multiset difference of two snapshots; a removed and an added node with one anchor pair up as `changed`. */
export function diffAria(before: readonly AriaLine[], after: readonly AriaLine[]): RawChange[] {
  const key = (l: AriaLine): string => `${l.path} >> ${l.content}`;
  const counts = new Map<string, number>();
  for (const l of before) counts.set(key(l), (counts.get(key(l)) ?? 0) + 1);
  const added: AriaLine[] = [];
  for (const l of after) {
    const n = counts.get(key(l)) ?? 0;
    if (n > 0) counts.set(key(l), n - 1);
    else added.push(l);
  }
  const removed: AriaLine[] = [];
  const left = new Map(counts);
  for (const l of before) {
    const n = left.get(key(l)) ?? 0;
    if (n > 0) {
      left.set(key(l), n - 1);
      removed.push(l);
    }
  }
  const byAnchor = new Map<string, AriaLine[]>();
  for (const l of removed) {
    const a = anchorOf(l);
    byAnchor.set(a, [...(byAnchor.get(a) ?? []), l]);
  }
  const out: RawChange[] = [];
  for (const l of added) {
    const a = anchorOf(l);
    const pool = byAnchor.get(a);
    const was = pool?.shift();
    if (was !== undefined) out.push({ kind: "changed", line: l, before: was, anchor: a });
    else out.push({ kind: "added", line: l, anchor: a });
  }
  for (const [a, pool] of byAnchor) for (const l of pool) out.push({ kind: "removed", line: l, anchor: a });
  return out;
}

/** A raw change as one line: `+ status: Saved`, `- dialog "Confirm"`, `~ textbox "Name": "" → "Bob"`. */
export function describeChange(c: RawChange): string {
  if (c.kind === "added") return clip(`+ ${c.line.content}`);
  if (c.kind === "removed") return clip(`- ${c.line.content}`);
  const head = c.line.name === null ? c.line.role : `${c.line.role} "${c.line.name}"`;
  const v = (l: AriaLine): string => {
    const x = valueOf(l.content);
    if (x !== null) return JSON.stringify(x);
    const rest = l.content.slice(head.length).trim();
    return rest === "" ? '""' : rest;
  };
  return clip(`~ ${head}: ${v(c.before!)} → ${v(c.line)}`);
}

/** What one route's no-action windows showed changing on their own. */
export class RouteNoise {
  /** anchor → content shapes seen in place-changes. */
  readonly changed = new Map<string, Set<string>>();
  /** `anchor || shape` → seen added / removed with no action. */
  readonly addRemove = new Map<string, { added: boolean; removed: boolean }>();
  /** Every anchor seen changing with no action (what a Jev ignore rule may cover). */
  readonly selfChanged = new Set<string>();
  /** Announcements' digit-masked text the page made with no action. */
  readonly announcements = new Set<string>();
  /** Validated Jev ignore rules (anchors). */
  readonly rules = new Set<string>();
  /** Jev labels by `anchor || shape`. */
  readonly labels = new Map<string, "relevant" | "irrelevant" | "changes-on-its-own">();
  baselined = false;

  learn(changes: readonly RawChange[], announcements: readonly string[]): void {
    for (const c of changes) {
      this.selfChanged.add(c.anchor);
      if (c.kind === "changed") {
        const set = this.changed.get(c.anchor) ?? new Set<string>();
        set.add(digitMask(c.before!.content));
        set.add(digitMask(c.line.content));
        this.changed.set(c.anchor, set);
      } else {
        const k = `${c.anchor} || ${digitMask(c.line.content)}`;
        const e = this.addRemove.get(k) ?? { added: false, removed: false };
        if (c.kind === "added") e.added = true;
        else e.removed = true;
        this.addRemove.set(k, e);
      }
    }
    for (const a of announcements) this.announcements.add(digitMask(a));
  }

  volatile(c: RawChange): boolean {
    if (c.kind === "changed") {
      const shapes = this.changed.get(c.anchor);
      return shapes !== undefined && shapes.has(digitMask(c.before!.content)) && shapes.has(digitMask(c.line.content));
    }
    const e = this.addRemove.get(`${c.anchor} || ${digitMask(c.line.content)}`);
    return e !== undefined && e.added && e.removed;
  }
}

export function localityOf(c: RawChange, t: TargetContext | null): DeltaLocality {
  const l = c.line;
  if (t !== null && t.name !== "") {
    const quoted = `"${digitMask(t.name)}"`;
    if (l.name === t.name || (c.before !== undefined && c.before.name === t.name) || l.path.includes(quoted)) return "target";
  }
  if (t !== null && (t.scoped.has(l.content) || (c.before !== undefined && t.scoped.has(c.before.content)))) return "container";
  if (DIALOG_ROLES.has(l.role) && c.kind !== "changed") return "dialog";
  if (LIVE_ROLES.has(l.role) || l.ancestorRoles.some((r) => LIVE_ROLES.has(r))) return "live";
  return "page";
}


export function describeExpected(e: ExpectedChange): string {
  switch (e.kind) {
    case "navigation":
      return "the page navigates";
    case "value":
      return `the field shows ${JSON.stringify(clip(e.text ?? "", 60))}`;
    case "appears":
      return `${JSON.stringify(clip(e.text ?? "", 60))} appears on the page`;
    case "state":
      return "the target's state changes";
    default:
      return "a visible change";
  }
}

/** The delta as one bounded line for the model's step prompt (history): `effect of click "Save": …`. */
export function deltaPromptLine(d: ActionDelta): string {
  const parts: string[] = [];
  if (d.url !== undefined) parts.push(`navigated to ${d.url.after}`);
  for (const a of d.announcements ?? []) parts.push(`announced ${a}`);
  for (const c of d.changes.filter((x) => x.tied)) parts.push(c.text);
  for (const c of d.changes.filter((x) => !x.tied).slice(0, 2)) parts.push(c.text);
  for (const r of (d.requests ?? []).slice(0, 3)) parts.push(r);
  if (d.expected?.met === false) parts.push(`expected ${d.expected.description} — it did not happen`);
  const body = parts.length === 0 ? d.why : `${d.why} — ${parts.join("; ")}`;
  return clip(`effect of ${d.action}: ${d.verdict}: ${body}`, DELTA_PROMPT_CHARS);
}

/** The delta as the Recording keeps it (a measurement beside the step, never replayed). */
export function deltaRecord(d: ActionDelta): {
  verdict: DeltaVerdict;
  why: string;
  changes: string[];
  announcements?: string[];
  requests?: string[];
  url?: { before: string; after: string };
  expected?: { description: string; met: boolean | null };
  partial?: string[];
  persisted?: "yes" | "no" | "inconclusive";
  overheadMs: number;
} {
  return {
    verdict: d.verdict,
    why: d.why,
    changes: d.changes.map((c) => c.text),
    ...(d.announcements === undefined ? {} : { announcements: [...d.announcements] }),
    ...(d.requests === undefined ? {} : { requests: [...d.requests] }),
    ...(d.url === undefined ? {} : { url: { ...d.url } }),
    ...(d.expected === undefined ? {} : { expected: { description: d.expected.description, met: d.expected.met } }),
    ...(d.partial === undefined ? {} : { partial: [...d.partial] }),
    ...(d.persisted === undefined ? {} : { persisted: d.persisted }),
    overheadMs: d.overheadMs,
  };
}

/**
 * #303 grounding: the page text a delta carries that a report may quote — the announcements the
 * page made (a toast gone before the report) and the text of lasting changes. Redacted already.
 * Never a form field's value: a field holding the run's own typed input grounds nothing (#239).
 */
export function deltaQuotableText(d: ActionDelta): string {
  const out: string[] = [];
  const textOf = (line: string): string | null => {
    const body = line.replace(/^[+~-] /, "");
    const role = /^[A-Za-z/][\w/-]*/.exec(body)?.[0] ?? "";
    if (VALUE_ROLES.has(role) || role.startsWith("/")) return null;
    const after = body.includes(" → ") ? body.slice(body.lastIndexOf(" → ") + 3) : body;
    const i = after.indexOf(": ");
    const named = /^[A-Za-z][\w-]* "((?:[^"\\]|\\.)*)"/.exec(after)?.[1];
    const t = (i >= 0 ? after.slice(i + 2) : (named ?? after)).replace(/^"|"$/g, "").trim();
    return t === "" ? null : t;
  };
  for (const a of d.announcements ?? []) {
    const i = a.indexOf(": ");
    const t = (i >= 0 ? a.slice(i + 2) : a).trim();
    if (t !== "") out.push(t);
  }
  for (const c of d.changes) {
    if (c.kind === "removed" || (c.count ?? 1) > 1) continue;
    const t = textOf(c.text);
    if (t !== null) out.push(t);
  }
  return [...new Set(out)].join("\n");
}

/** #303: verdict counts and per-action overhead over a list of deltas (missions that keep their own). */
export function deltaStatsOf(deltas: readonly ActionDelta[]): ActionDeltaStats {
  const sorted = deltas.map((d) => d.overheadMs).sort((a, b) => a - b);
  return {
    actions: deltas.length,
    noChange: deltas.filter((d) => d.verdict === "no-change").length,
    relevantChange: deltas.filter((d) => d.verdict === "relevant-change").length,
    inconclusive: deltas.filter((d) => d.verdict === "inconclusive").length,
    overheadMs: {
      p50: sorted.length === 0 ? 0 : sorted[Math.floor((sorted.length - 1) / 2)]!,
      max: sorted.length === 0 ? 0 : sorted[sorted.length - 1]!,
      total: sorted.reduce((a, b) => a + b, 0),
    },
    jevCalls: 0,
    baselineWaitMs: 0,
  };
}
