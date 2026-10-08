/**
 * Pure helpers of the induction (coverage) frontier (`runInductionFrontier`), moved out of
 * `induction.ts` unchanged (#232): failure classification, the frontier's enqueue rule, control
 * re-resolution, and the replayable-path builders. Not part of the public API.
 */

import { redactUrl } from "@jevitate/ai-core";
import type { PageSegment, RecordedStep, Recording, Step, TargetDescriptor } from "@jevitate/recording";
import { actionKey, type FrontierOp } from "../../coverage/fingerprint.js";
import { Frontier } from "../../coverage/frontier.js";
import { targetCandidates, toPath, type Control, type Snapshot, type TargetOp } from "../../index.js";

/** A failed act whose reason names a timeout, or a target this gate refused as not actionable
 *  (a visually-hidden skip link, an occluded target) — never re-chosen for the rest of the run. */
/** A failure that is a timeout (#203) — retried once before it counts (#213). */
export function isTimeoutFailure(reason: string | undefined): boolean {
  return /timeout/i.test(reason ?? "");
}

export function isUnactionableFailure(reason: string | undefined): boolean {
  if (reason === undefined) return false;
  return /timeout|not actionable|no longer present/i.test(reason);
}

/**
 * Which ops the frontier enqueues for a control. RULING (deviation from the
 * plan's literal `type`/`select` inclusion): the coverage fingerprint is a
 * function of url-template + control role/name/enabled — a control's VALUE is
 * deliberately excluded. `type`/`select` only mutate a value, so they can never
 * expand the state frontier; enqueuing them would only burn the action budget
 * against guardrail #2 (bounded). Clicks (navigations / control toggles) are
 * the only fingerprint-affecting transitions, so the frontier enqueues the
 * controls whose SHARED afforded op (`affordedOp`, ./actions.ts) is `click`.
 */
export const FRONTIER_OPS: ReadonlySet<TargetOp> = new Set<TargetOp>(["click"]);

export function enqueueFrom(
  frontier: Frontier,
  fingerprint: string,
  pathPrefix: Recording,
  controls: readonly Control[],
  withheld: (control: Control) => boolean,
): void {
  // A disabled control can never be acted on — never enqueue it; nor one the safety policy refuses (#186).
  for (const { control } of targetCandidates(controls, { ops: FRONTIER_OPS, enabledOnly: true })) {
    if (withheld(control)) continue;
    frontier.push({ key: actionKey(fingerprint, control, "click"), fromFingerprint: fingerprint, pathPrefix, control, op: "click" });
  }
}

/**
 * Re-resolves a frontier item's control in the CURRENT snapshot by its stable
 * identity (role + name + enabled) — the `index` is snapshot-local and useless
 * across re-snapshots. A control that has vanished returns null and the item is
 * dropped, never guessed at (fail-closed).
 */
export function resolveControl(snap: Snapshot, want: Control): Control | null {
  return (
    snap.controls.find((c) => c.role === want.role && c.name === want.name && c.enabled === want.enabled) ?? null
  );
}

/**
 * Immutable "append one executed step to a replayable path", mirroring
 * `RunRecorder`'s discipline: a step whose action changed the URL gets a
 * `urlIncludes` postcondition (and opens the next page segment); one that did
 * not keeps a `visible` postcondition on its target. Returns a NEW Recording.
 */
export function extendPath(
  prefix: Recording,
  op: FrontierOp,
  descriptor: TargetDescriptor,
  value: string | null,
  afterUrl: string,
): Recording {
  const pages: PageSegment[] = prefix.pages.map((p) => ({ ...p, steps: [...p.steps] }));
  let current = pages[pages.length - 1];
  if (current === undefined) {
    current = { url: "/", steps: [] };
    pages.push(current);
  }
  const target: TargetDescriptor = { ...descriptor };
  let step: Step;
  if (op === "click") {
    step = { kind: "click", target, expect: { kind: "visible", target } };
  } else if (op === "type") {
    step = { kind: "fill", target, value: { redacted: false, value: value ?? "" }, expect: { kind: "visible", target } };
  } else {
    step = { kind: "select", target, value: { redacted: false, value: value ?? "" }, expect: { kind: "visible", target } };
  }
  const recorded: RecordedStep = { step };
  current.steps.push(recorded);

  const path = toPath(afterUrl);
  if (path !== current.url) {
    step.expect = { kind: "urlIncludes", text: path };
    pages.push({ url: path, steps: [] });
  }
  return { version: prefix.version, site: prefix.site, pages };
}

/** A frontier path as a replayable Recording: the seed navigate, then the path's non-empty pages. */
export function withSeed(branch: Recording, seedUrl: string): Recording {
  const seed = seedPath(seedUrl);
  return {
    ...branch,
    pages: [
      { url: seed, steps: [{ step: { kind: "navigate", url: seed, expect: { kind: "urlIncludes", text: seed } } }] },
      ...branch.pages.filter((p) => p.steps.length > 0),
    ],
  };
}

/** Joins the non-empty parts of a transcript reason. */
export function joinReasons(parts: ReadonlyArray<string | undefined>): string {
  return parts.filter((p): p is string => p !== undefined && p !== "").join("; ");
}

export function pathOf(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return url;
  }
}

/** The seed's path WITH its query (`/workspace?inquiry=…`) — `toPath` drops the query, and a seed that
 *  needs it replays to a different page (#114). Sensitive query values stay masked. (`induction.ts`
 *  exports it as `seedPath`.) */
export function seedPath(seedUrl: string): string {
  try {
    const u = new URL(seedUrl);
    return redactUrl(`${u.pathname || "/"}${u.search}`);
  } catch {
    return toPath(seedUrl);
  }
}
