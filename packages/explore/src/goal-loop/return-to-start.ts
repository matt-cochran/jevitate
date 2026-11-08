/**
 * #807 return-to-start: the loop remembers pages that still offer untried controls; when the current
 * branch dead-ends (no progress on the last-chance turn, or the model's `blocked`) the decision becomes
 * a navigation back to the most recent such page, recorded as a navigate step in the Recording.
 * State is kept per run in a WeakMap, so `RunContext` is untouched.
 */
import type { Snapshot } from "../snapshot.js";
import type { RunContext } from "./context.js";

/** A page the run saw, with the controls it offered that were still untried when last seen. */
export interface RememberedPage {
  readonly path: string;
  readonly url: string;
  readonly signature: string;
  readonly untried: readonly string[];
}

interface ReturnState {
  readonly pages: Map<string, RememberedPage>;
  readonly returnsByPath: Map<string, number>;
  returns: number;
}

/** The same page is returned to at most this often. */
export const MAX_RETURNS_PER_PAGE = 2;
/** Returns in one run, all pages together. */
export const MAX_RETURNS_PER_RUN = 3;

const states = new WeakMap<object, ReturnState>();

function stateOf(ctx: RunContext): ReturnState {
  let s = states.get(ctx);
  if (s === undefined) {
    s = { pages: new Map(), returnsByPath: new Map(), returns: 0 };
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

/** Remember the page just seen (most recent last); a page with no untried controls is forgotten. */
export function notePage(ctx: RunContext, snap: Snapshot): void {
  const s = stateOf(ctx);
  const path = pathOf(snap.url);
  const untried = snap.controls
    .filter((c) => c.enabled && c.name.trim() !== "" && c.role !== "textbox" && !ctx.depth.tried(snap.url, c.name))
    .map((c) => c.name);
  s.pages.delete(path);
  if (untried.length > 0) s.pages.set(path, { path, url: snap.url, signature: snap.signature, untried });
}

/** The most recent other page that still has untried controls and is under its return cap, else null. */
export function returnTarget(ctx: RunContext, currentUrl: string): RememberedPage | null {
  const s = stateOf(ctx);
  if (s.returns >= MAX_RETURNS_PER_RUN) return null;
  const current = pathOf(currentUrl);
  for (const p of [...s.pages.values()].reverse()) {
    if (p.path === current || (s.returnsByPath.get(p.path) ?? 0) >= MAX_RETURNS_PER_PAGE) continue;
    const untried = p.untried.filter((n) => !ctx.depth.tried(p.url, n));
    if (untried.length > 0) return { ...p, untried };
  }
  return null;
}

/**
 * Return to the remembered page: navigate, record the step, reset the stall counters. Returns the
 * page returned to, or null when there is none, the budget is spent, or the target is off-allowlist.
 */
export async function returnToStart(ctx: RunContext, currentUrl: string): Promise<RememberedPage | null> {
  const target = returnTarget(ctx, currentUrl);
  if (target === null || !ctx.tracker.mayAct() || !ctx.livenessOf().authorized(target.url)) return null;
  const s = stateOf(ctx);
  s.returns += 1;
  s.returnsByPath.set(target.path, (s.returnsByPath.get(target.path) ?? 0) + 1);
  ctx.tracker.countAction();
  await ctx.page.goto(target.url);
  ctx.recorder.navigate(target.url, ctx.now());
  ctx.noProgress.progress("returned");
  ctx.lastChanceGiven = false;
  ctx.lastChanceTurn = false;
  ctx.noControls = false;
  ctx.lastActedOp = null;
  ctx.history.push(
    `that branch was a dead end, so the run returned to ${target.path}, which still has untried controls: ${target.untried
      .slice(0, 8)
      .map((n) => JSON.stringify(n))
      .join(", ")}`,
  );
  return target;
}
