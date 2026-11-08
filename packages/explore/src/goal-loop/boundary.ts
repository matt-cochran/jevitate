/**
 * 0.30.0 (#807): the boundaries a goal run may not or cannot cross, detected by code from observed
 * facts only — a 401/403 document or same-origin write (`wall`, `http-401`/`http-403`), a refused
 * paid control where the goal's own control would be (`wall`, `paid-control`), and a settled step on
 * a sign-in page the goal never asked for (`session`, `login-url`). A boundary proves nothing about
 * the app: the run ends `goalOutcome: "boundary"` (folds to `inconclusive`, exit 2).
 *
 * The result is shaped like the adjudicator's `BoundaryEvidence` (§6.2); explore does not depend on
 * that package, so the shape is restated here and checked structurally by the cli.
 */
import { isLoginLikeUrl } from "../seed-redirect.js";
import type { RunContext } from "./context.js";

export interface BoundaryEvidence {
  readonly kind: "wall" | "session";
  /** 1-based step the boundary was met at. */
  readonly step: number;
  readonly signal: "http-401" | "http-403" | "paid-control" | "login-url";
}

/** The signals this deliverable can name; each is also a `goalReason`. */
export type BoundarySignal = BoundaryEvidence["signal"];

/** A write the run sent: only its method, path (or origin + path when off the run's origins) and status. */
export interface ObservedWrite {
  readonly method: string;
  /** A bare path for a same-origin request; `https://other/…` when the request left the run's origins. */
  readonly endpoint: string;
  readonly status: number | null;
  readonly thirdParty?: boolean;
}

export interface ObservedControl {
  readonly name: string;
  readonly landmark?: string | null;
}

/** A sign-in word in the goal: such a goal is about the sign-in page, so landing there is no boundary. */
const SIGN_IN_GOAL = /\b(sign(ed)?[ -]?(in|up|on)|log(ged)?[ -]?in|authenticate|register)\b/i;

const sameOrigin = (w: ObservedWrite): boolean => w.thirdParty !== true && !/^[a-z][a-z0-9+.-]*:\/\//i.test(w.endpoint);
const denial = (status: number | null | undefined): "http-401" | "http-403" | null =>
  status === 401 ? "http-401" : status === 403 ? "http-403" : null;

/** `wall`: a 401/403 on the current document or a same-origin write, or only a paid control where the goal's would be. */
export function detectWall(input: {
  readonly step: number;
  /** The status the current document answered, when known. */
  readonly documentStatus?: number | undefined;
  readonly writes: readonly ObservedWrite[];
  readonly controls: readonly ObservedControl[];
  readonly goal: string;
  /** True when the safety policy refuses this control as a paid action. */
  readonly isPaid: (c: ObservedControl) => boolean;
}): (BoundaryEvidence & { readonly reason: string }) | null {
  const step = Math.max(1, input.step);
  const doc = denial(input.documentStatus);
  if (doc !== null) return { kind: "wall", step, signal: doc, reason: `the page answered ${input.documentStatus}: this account may not go here` };
  const denied = input.writes.find((w) => sameOrigin(w) && denial(w.status) !== null);
  if (denied !== undefined) {
    return { kind: "wall", step, signal: denial(denied.status) as "http-401" | "http-403", reason: `${denied.method} ${denied.endpoint} answered ${denied.status}: this account may not do this` };
  }
  const words = input.goal.toLowerCase().match(/[a-z0-9]{2,}/g) ?? [];
  const names = (c: ObservedControl): boolean => words.some((w) => w.length > 3 && c.name.toLowerCase().includes(w.replace(/s$/, "")));
  const main = input.controls.filter((c) => (c.landmark ?? null) !== "navigation" && (c.landmark ?? null) !== "banner");
  const paid = main.find((c) => input.isPaid(c));
  if (paid !== undefined && !names(paid) && !main.some((c) => c !== paid && names(c))) {
    return { kind: "wall", step, signal: "paid-control", reason: `the page offers only a paid control ("${paid.name}") where the goal's control would be` };
  }
  return null;
}

/** `session`: a settled step, after actions and none of them signing in, on a sign-in URL the goal never asked for. */
export function detectSession(input: {
  readonly step: number;
  readonly url: string;
  readonly goal: string;
  readonly actions: number;
  readonly authAttempted: boolean;
}): (BoundaryEvidence & { readonly reason: string }) | null {
  if (input.actions <= 0 || input.authAttempted || !isLoginLikeUrl(input.url) || SIGN_IN_GOAL.test(input.goal)) return null;
  let path = input.url;
  try {
    path = new URL(input.url).pathname;
  } catch {
    /* keep the raw url */
  }
  return { kind: "session", step: Math.max(1, input.step), signal: "login-url", reason: `the session ended mid-run: the app sent the run to its sign-in page (${path})` };
}

/** Detect a wall or a session boundary from the run's own observed state. */
export function detectRunBoundary(
  ctx: RunContext,
  snap: { readonly url: string; readonly controls: readonly (ObservedControl & { readonly role?: string; readonly descriptor?: unknown })[] },
): (BoundaryEvidence & { readonly reason: string }) | null {
  const step = ctx.tracker.actions + 1;
  const writes = ctx.effectLog.entries().sideEffects.map((e) => ({ method: e.request.method, endpoint: e.request.endpoint, status: e.request.status, ...(e.thirdParty === true ? { thirdParty: true } : {}) }));
  const wall = detectWall({
    step,
    documentStatus: ctx.documentStatus.get(ctx.docKey(snap.url)),
    writes,
    controls: snap.controls,
    goal: ctx.cfg.goal,
    isPaid: (c) => ctx.safety.refuses(c as Parameters<typeof ctx.safety.refuses>[0])?.risk === "paid",
  });
  return wall ?? detectSession({ step, url: snap.url, goal: ctx.cfg.goal, actions: ctx.tracker.actions, authAttempted: ctx.auth.attempted });
}

/** End the run at a boundary: `finish.ts` reads `ctx.boundary` and ends it `goalOutcome: "boundary"`. */
export function endAtBoundary(ctx: RunContext, found: BoundaryEvidence & { readonly reason: string }): void {
  const { reason, ...evidence } = found;
  ctx.boundary = evidence;
  ctx.incomplete = reason;
  ctx.stop = "blocked";
}
