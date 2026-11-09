/**
 * 0.30.0 (#807, fm-nav-no-route-reads-as-defect): `goalReason: no-route-found`. A goal run that gave
 * up (or ran out of budget) after covering every control it could reach, with none leading toward the
 * goal, proved nothing about the app: it ends `inconclusive` (exit 2), `failure.kind: "no-route-found"`,
 * with a reason that lists what was searched. Never a wall, never a permission boundary.
 *
 * The coverage floor is decided by code from the run's own state, never by the model:
 *  - every top-level navigation destination was opened, and at least two distinct pages were seen
 *    (`absenceCoverage`, #238);
 *  - no page the run saw still offers an untried control (the return-to-start "untried" set, by name
 *    per page): a link counts as tried once its destination was opened (or it leaves the run's origins),
 *    and links to many pages of one shape (`/customer/1` … `/customer/30`) once three of them were;
 *  - no control the run saw names the goal, even in part (#826 `goalNamesPart`), enabled or disabled: a
 *    route that exists and is broken is a finding, not an absent route;
 *  - no page showed something a person could click that is no control the run perceives (an `onclick`
 *    or pointer-cursor element outside any control, a canvas, a frame, a closed shadow host), and no
 *    page's inventory was cut by the candidate limit: a route the run cannot see may be there.
 * Below the floor nothing changes: the run ends as it did before (`insufficient-coverage` while
 * controls remain untried, #237/#693).
 *
 * A role word the page shows ("Viewer", "Read-only", "Guest") is named in the reason as a hint only.
 */
import { redactUrl } from "../redact.js";
import { absenceCoverage } from "../answer.js";
import { CYCLE_REASON_PREFIX } from "../loop-cycle.js";
import type { Snapshot } from "../snapshot.js";
import type { RunContext } from "./context.js";
import { terms } from "./goal-focus.js";
import { goalNamesPart } from "./handle-blocked.js";

/** A control as the floor needs it. */
interface SeenControl {
  readonly name: string;
  readonly role: string;
  readonly enabled: boolean;
  readonly href: string | null;
}

interface SeenPage {
  readonly url: string;
  readonly controls: readonly SeenControl[];
  /** Clickable-looking things the run does not perceive as controls (labels, for the record). */
  readonly unperceived: readonly string[];
  readonly inventoryCut: boolean;
}

interface NoRouteState {
  readonly pages: Map<string, SeenPage>;
  role: string | null;
}

/** Value fields: typing into one opens no route. */
const FIELD_ROLES = new Set(["textbox", "searchbox", "combobox", "listbox", "spinbutton", "slider"]);
/** Links to this many pages of one shape cover that shape (a directory of 30 customers). */
export const FAMILY_COVERED_AT = 3;
/** The role words named as a hint, in the phrase the reason uses. */
const ROLE_WORDS: ReadonlyArray<readonly [RegExp, string]> = [
  [/\bviewer\b/i, "signed in as a Viewer"],
  [/\bread[- ]only\b/i, "signed in with Read-only access"],
  [/\bguest\b/i, "signed in as a Guest"],
];

const states = new WeakMap<object, NoRouteState>();
function stateOf(ctx: RunContext): NoRouteState {
  let s = states.get(ctx);
  if (s === undefined) {
    s = { pages: new Map(), role: null };
    states.set(ctx, s);
  }
  return s;
}

function pathOf(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return url;
  }
}

/** A link's shape: its origin and path with id-like segments (digits, hex, uuids) as `:id`. */
function shapeOf(href: string): string | null {
  try {
    const u = new URL(href);
    const segs = u.pathname.split("/").map((s) => (/^\d+$|^[0-9a-f]{8,}$|^[0-9a-f-]{32,36}$/i.test(s) ? ":id" : s));
    return segs.includes(":id") ? `${u.origin}${segs.join("/")}` : null;
  } catch {
    return null;
  }
}

/**
 * BROWSER CODE (passed to `evaluate`): what a person could click that is no control — an `onclick` or
 * pointer-cursor element outside every interactive element, a canvas, a frame, a closed shadow host.
 * Bounded: at most 4000 elements are looked at and 5 labels returned.
 */
function probeUnperceived(): string[] {
  const INTERACTIVE =
    'a[href],button,input,select,textarea,summary,label,[role=button],[role=link],[role=menuitem],[role=tab],[role=checkbox],[role=radio],[role=switch],[role=option],[tabindex]:not([tabindex="-1"]),[contenteditable=""],[contenteditable="true"]';
  const out: string[] = [];
  const all = document.body === null ? [] : Array.from(document.body.querySelectorAll("*")).slice(0, 4000);
  for (const el of all) {
    if (out.length >= 5) break;
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) continue;
    const tag = el.tagName.toLowerCase();
    if (tag === "canvas" || tag === "iframe" || tag === "embed" || tag === "object") {
      out.push(tag);
      continue;
    }
    if (tag.includes("-") && el.shadowRoot === null && el.childElementCount === 0 && (el.textContent ?? "").trim() === "") {
      out.push(tag);
      continue;
    }
    if (el.closest(INTERACTIVE) !== null) continue;
    const pointer = el.hasAttribute("onclick") || getComputedStyle(el).cursor === "pointer";
    if (!pointer) continue;
    const parent = el.parentElement;
    // Only the outermost of a clickable-looking group.
    if (parent !== null && parent !== document.body && (parent.hasAttribute("onclick") || getComputedStyle(parent).cursor === "pointer")) continue;
    out.push((el.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 40) || tag);
  }
  return out;
}

/** Remember the page just decided on: its controls, what it shows that the run cannot click, a role word. */
export async function noteRoutePage(ctx: RunContext, snap: Snapshot, visibleText: string): Promise<void> {
  const s = stateOf(ctx);
  // A page that cannot be probed counts as one that may hide a route (the floor is then not met).
  const unperceived = await Promise.resolve()
    .then(() => ctx.page.evaluate(probeUnperceived))
    .catch(() => ["(the page could not be probed)"]);
  s.pages.set(pathOf(snap.url), {
    url: snap.url,
    controls: snap.controls.map((c) => ({ name: c.name.trim(), role: c.role, enabled: c.enabled, href: typeof c.href === "string" && c.href !== "" ? c.href : null })),
    unperceived,
    inventoryCut: snap.truncated || (snap.dropped?.length ?? 0) > 0,
  });
  if (s.role === null) s.role = ROLE_WORDS.find(([re]) => re.test(visibleText))?.[1] ?? null;
}

/** Why the floor is not met (the first reason found), or null when it is. Exported for unit tests. */
export function floorShortfall(ctx: RunContext): string | null {
  const s = stateOf(ctx);
  const c = absenceCoverage(ctx.observed.pages(), ctx.observed.topNavigation());
  if (c.unseen.length > 0) return `navigation not opened: ${c.unseen.join(", ")}`;
  const visited = new Set([...s.pages.keys(), ...ctx.observed.pages().map((p) => pathOf(p.url))]);
  if (visited.size < 2) return "fewer than 2 pages seen";
  const goalTerms = terms(ctx.goalText);
  const authorized = ctx.livenessOf().authorized;
  // Links of one shape: how many distinct destinations, and how many of them were opened.
  const family = new Map<string, { all: Set<string>; open: Set<string> }>();
  for (const p of s.pages.values()) {
    for (const ctl of p.controls) {
      const shape = ctl.href === null ? null : shapeOf(ctl.href);
      if (shape === null || ctl.href === null) continue;
      const f = family.get(shape) ?? { all: new Set<string>(), open: new Set<string>() };
      const dest = pathOf(ctl.href);
      f.all.add(dest);
      if (visited.has(dest)) f.open.add(dest);
      family.set(shape, f);
    }
  }
  for (const [path, p] of s.pages) {
    if (p.inventoryCut) return `the page ${path} had more controls than the run was shown`;
    if (p.unperceived.length > 0) return `the page ${path} shows something clickable the run cannot use (${p.unperceived.join(", ")})`;
    for (const ctl of p.controls) {
      if (ctl.name !== "" && goalTerms.size > 0 && goalNamesPart(ctl.name, goalTerms)) return `a control names the goal ("${ctl.name}" on ${path})`;
      if (!ctl.enabled || FIELD_ROLES.has(ctl.role)) continue;
      if (ctl.href !== null && /^https?:/i.test(ctl.href)) {
        if (!authorized(ctl.href) || visited.has(pathOf(ctl.href))) continue;
        const shape = shapeOf(ctl.href);
        const f = shape === null ? undefined : family.get(shape);
        if (f !== undefined && f.open.size >= Math.min(FAMILY_COVERED_AT, f.all.size)) continue;
        return `"${ctl.name}" on ${path} leads to a page not opened`;
      }
      if (ctl.name === "" || !ctx.depth.tried(p.url, ctl.name)) return `"${ctl.name || ctl.role}" on ${path} was not tried`;
    }
  }
  return null;
}

/**
 * The run's `no-route-found` ending, when it applies: the run gave up, stalled or ran out of budget with
 * no answer, no other cause, no write and no 5xx, the success checks do not hold, and the floor is met.
 */
export async function noRouteFound(ctx: RunContext): Promise<string | null> {
  if (ctx.answer !== undefined || ctx.failure !== undefined || ctx.boundary !== undefined || ctx.hang !== undefined) return null;
  if (ctx.stop !== "blocked" && ctx.stop !== "no-progress" && ctx.stop !== "exhausted") return null;
  // Another named cause stands: a policy refusal, a rejected answer or done, a find-out "not found",
  // a form message, an unanswered message, the budget spent on a refused give-up.
  if (ctx.lastRefusal !== null || ctx.reportRejections > 0 || ctx.endedOnRejectedDone || ctx.lastReportNotFound) return null;
  if (ctx.formMessage !== null || ctx.awaitingReply || (ctx.stop === "exhausted" && ctx.refusedTurn)) return null;
  // A stop that named the loop the run went round (#367) keeps that cause.
  if (ctx.stop === "no-progress" && (ctx.incomplete ?? "").startsWith(CYCLE_REASON_PREFIX)) return null;
  // A write changed the app, or a page answered 5xx: that run is not "nothing leads anywhere".
  if (ctx.effectLog.entries().sideEffects.length > 0) return null;
  if ([...ctx.documentStatus.values()].some((st) => st >= 500)) return null;
  if (floorShortfall(ctx) !== null) return null;
  if (await (ctx.cfg.successChecksHoldNow?.() ?? Promise.resolve(false)).catch(() => true)) return null;
  const s = stateOf(ctx);
  const pages = [...new Set([...s.pages.keys(), ...ctx.observed.pages().map((p) => pathOf(redactUrl(p.url)))])];
  const shown = pages.slice(0, 12).join(", ") + (pages.length > 12 ? `, and ${pages.length - 12} more` : "");
  const hint = s.role === null ? "" : `; the page says you're ${s.role}; a person with another role may see more`;
  return `no route found: the run opened ${pages.length} page(s) (${shown}) and tried every control they offer (${ctx.tracker.actions} action(s)); none leads toward the goal${hint}`;
}
