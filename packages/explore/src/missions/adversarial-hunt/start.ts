/**
 * The hunt's per-run state set up once the seed page settled, and the step closures that read it
 * (the safety withholding, chrome, canary check, soft judgment, execute / record / observe-after),
 * moved out of `runAdversarialHunt` unchanged (#232). Installed at the same point of the run.
 */

import { redactUrl } from "@jevitate/ai-core";
import { Navigate } from "@jevitate/screenplay";
import { act, type ActResult } from "../../act.js";
import { affordedOp } from "../../actions.js";
import { normalizeRoute } from "../../adversarial/defect-fingerprint.js";
import type { MisuseStep } from "../../adversarial/form-misuse.js";
import { markupFingerprint, renderedCanaries } from "../../adversarial/markup-canary.js";
import type { MisuseStrategy } from "../../adversarial/misuse.js";
import { isAuthorizedExploreTarget } from "../../authorized-targets.js";
import { controlIdentity } from "../../coverage/fingerprint.js";
import { PROMPT_INJECTION_GUARD } from "../../decide.js";
import { ChromeTracker } from "../../feature/relevance.js";
import { outOfScopeHangNote } from "../../hang.js";
import { buildJudgmentState } from "../../redact.js";
import type { Control, Snapshot } from "../../snapshot.js";
import type { TranscriptJudgment } from "../../transcript.js";
import type { AdversarialMissionParams, AdversarialStop } from "../adversarial.js";
import type { HuntState } from "./context.js";
import { joinReasons, otherOption, type StepFinding } from "./helpers.js";

/** Sets the hunt's loop state and installs its step closures on `ctx` (after the seed load, before the loop). */
export function startHunt(ctx: HuntState, params: AdversarialMissionParams): void {
  ctx.last = null;
  ctx.lastRecordedTarget = null;
  ctx.actions = 0;
  ctx.strategySteps = 0;
  ctx.idleStreak = 0;
  ctx.visitedLinks = new Set<string>();
  /**
   * Control identities (#161, a regression of #75) that failed as not-actionable / timed out:
   * never re-chosen by any strategy for the rest of the run. The adversarial strategies pick
   * their own candidates from the live snapshot every step (no shared frontier of #75's own to
   * consult), so the mission loop tracks this itself.
   */
  ctx.unactionable = new Set<string>();
  /**
   * Controls found disabled when last planned (#188). Filling a form over several episodes may
   * enable its submit, so a disabled plan is never blacklisted — but it is recorded once per
   * disabled streak, not once per episode (a disabled "Create key" read as 7 clicks in one run).
   * An enabled plan ends the streak.
   */
  ctx.disabledNow = new Set<string>();
  /**
   * Controls the safety policy refused (#116) — never re-planned by any strategy (#193), so a
   * denied submit is attempted (and its refusal recorded) once, not every turn.
   */
  ctx.refusedIds = new Set<string>();
  /** #300: controls whose action switched the signed-in identity — never acted on again. */
  ctx.identitySwitchers = new Set<string>();
  /**
   * A click-afforded control the safety policy refuses (#116: `--deny`, paid, destructive) is never
   * offered as a target (#193) — withheld at planning, its refusal recorded once, like the
   * frontier missions do (#186).
   */
  ctx.refuses = (c: Control): boolean => {
    // #300: a control that switched the signed-in identity is never offered again (silently: its
    // switch is already in the transcript and in `identityChanges`).
    if (ctx.identitySwitchers.has(controlIdentity(c))) return true;
    if (affordedOp(c) !== "click") return false;
    const withheld = ctx.safety.withholds("click", c, (reason) =>
      ctx.transcript.record({
        op: null,
        control: c,
        confidence: null,
        chosenBy: "strategy",
        strategy: "safety-policy",
        actOk: false,
        reason,
        snapshot: ctx.snap,
      }),
    );
    // #209: the coverage shortfall names what the policy refused (and how to permit it).
    const risk = withheld ? ctx.safety.policy.refuses(c)?.risk : undefined;
    if (risk !== undefined) ctx.cov.refused(ctx.snap.url, c, risk);
    return withheld;
  };
  /** Page chrome (#115/#193): a landmark control, or one seen unchanged on 2+ in-scope pathnames. */
  ctx.chrome = new ChromeTracker();
  ctx.isChrome = (c: Control): boolean => (c.landmark ?? null) !== null || ctx.chrome.isChrome(c);
  /** What clicks revealed (#193): a control that made a form appear, and disclosures that showed none. */
  ctx.revealed = new Map<string, readonly string[]>();
  ctx.barren = new Set<string>();
  /** Whether the run hunts with `exercise-controls` — then no strategy idles while controls remain (#193). */
  ctx.exercises = params.strategies.includes("exercise-controls");
  ctx.observeTarget = (on: Snapshot): void => {
    ctx.cov.observe(on);
    if (ctx.inScope(on.url)) ctx.chrome.observe(new URL(on.url).pathname, on.controls);
  };
  /** How many episodes each strategy has run (rotates its form, field and value). */
  ctx.rounds = new Map<MisuseStrategy, number>();
  ctx.stop = null;
  /** Why the run stopped, when that stop is itself the failure (#300 `identity-changed`). */
  ctx.stopFailure = undefined;
  /** Wall-clock time the first action since the last adjudication fired (#300: auth requests since then). */
  ctx.chainStart = null;
  /** #301: canary tokens submitted since the last adjudicated step (checked after it, and after a reload). */
  ctx.chainCanaries = new Set<string>();

  /**
   * #301 — after a settled step: is any canary of this run rendered as MARKUP? When this step's
   * chain submitted one, the page is loaded again (a GET of the same in-scope URL — never a re-sent
   * form) and checked again: seen after that ⇒ stored, seen only before ⇒ reflected. A canary first
   * seen on a later page is stored. DOM inspection only — the payload is inert.
   */
  ctx.checkCanaries = async (): Promise<"ok" | "reloaded"> => {
    const submitted = [...ctx.chainCanaries];
    ctx.chainCanaries.clear();
    const authorized = (u: string): boolean => isAuthorizedExploreTarget(u, params.allowlist);
    const afterSubmit = await renderedCanaries(ctx.sessions.page, ctx.canaries.prefix, authorized);
    const submittedOn = redactUrl(ctx.sessions.page.url());
    let afterReload = new Set<string>();
    let reloadedOn = submittedOn;
    const reload = submitted.length > 0 && ctx.inScope(ctx.sessions.page.url());
    if (reload) {
      const url = ctx.sessions.page.url();
      await Navigate.to(url).performAs(ctx.sessions.actor);
      ctx.recorder.navigate(url, ctx.now());
      ctx.lastRecordedTarget = null;
      await ctx.perceiveNow().catch(() => undefined);
      afterReload = await renderedCanaries(ctx.sessions.page, ctx.canaries.prefix, authorized);
      reloadedOn = redactUrl(ctx.sessions.page.url());
    }
    const found: StepFinding[] = [];
    for (const token of new Set([...afterSubmit, ...afterReload])) {
      const sub = ctx.submittedCanaries.get(token);
      if (sub === undefined || ctx.reportedCanaries.has(token)) continue;
      ctx.reportedCanaries.add(token);
      const justSubmitted = submitted.includes(token);
      const seenAfterSubmit = afterSubmit.has(token);
      const seenAfterReload = afterReload.has(token);
      const stored = seenAfterReload || !justSubmitted;
      const renderedOn = seenAfterSubmit ? submittedOn : reloadedOn;
      const route = normalizeRoute(sub.submittedOn);
      const what = sub.payload === "html" ? "unescaped HTML" : "an unescaped attribute value";
      found.push({
        fingerprint: markupFingerprint(route, sub.field, sub.payload),
        related: [markupFingerprint(route, sub.field, sub.payload)],
        kind: "markup-injection",
        title: `Input "${sub.field}" rendered as markup (${what}) on ${normalizeRoute(renderedOn)} — ${stored ? "stored" : "reflected"}`,
        route,
        url: sub.submittedOn,
        signals: [],
        markupInjection: {
          field: sub.field,
          payload: sub.payload,
          submittedOn: sub.submittedOn,
          renderedOn,
          afterSubmit: seenAfterSubmit,
          afterReload: seenAfterReload,
          stored,
        },
      });
    }
    if (reload || found.length > 0) {
      const at = ctx.transcript.nextStep;
      ctx.transcript.record({
        op: null,
        control: null,
        confidence: null,
        chosenBy: "strategy",
        strategy: "canary-check",
        actOk: true,
        reason:
          found.length === 0
            ? `inert canary not rendered as markup${reload ? " (checked after submit and after reloading the page)" : ""}`
            : `defect: ${found.map((f) => f.title).join("; ")}`,
        snapshot: ctx.snap,
      });
      if (found.length > 0) await ctx.fold(at, found);
    }
    return reload ? "reloaded" : "ok";
  };

  /**
   * SOFT augment only (guardrail #4). Jev's "looks broken?" is consulted and recorded in the
   * transcript — it is never read into the defect decision. Wiring this answer into the defect
   * condition would be the single most dangerous regression this mission can suffer. The state is
   * redacted and carries the prompt-injection guard like every other prompt. It is advisory, so an
   * unavailable judgment is recorded and the run goes on.
   */
  ctx.softJudgment = async (
    on: Snapshot,
  ): Promise<{ judgments?: Record<string, TranscriptJudgment>; note?: string }> => {
    try {
      const answers = await params.judgment.systemOne({
        state: buildJudgmentState({
          goal: "try to break it",
          url: ctx.sessions.page.url(),
          controls: [PROMPT_INJECTION_GUARD, ...on.controls.map((c) => c.summary)],
          history: [],
        }),
        questions: { looksBroken: { kind: "noul" } },
      });
      const looksBroken = answers.looksBroken;
      return looksBroken?.kind === "noul"
        ? { judgments: { looksBroken: { value: looksBroken.value, probability: looksBroken.probability } } }
        : {};
    } catch (e) {
      return { note: `advisory judgment unavailable: ${e instanceof Error ? e.message.split("\n")[0] : String(e)}` };
    }
  };

  /**
   * One planned step through the gated act(). A select with no chosen option takes another
   * option. `send` (a chat composer: #121) is given the CURRENT page's controls as its submit
   * candidates, so it finds its own nearest Send button (or falls back to Enter) exactly as the
   * goal loop's composer handling does — never a separate detected submit control to plan around.
   */
  ctx.execute = async (s: MisuseStep, candidates: readonly Control[]): Promise<{ result: ActResult; value?: string }> => {
    if (s.op === "select" && s.control !== null && s.fillText === undefined) {
      const option = await otherOption(ctx.sessions.page, s.control);
      if (option === null) return { result: { ok: false, mutated: false, reason: "no other option to choose" } };
      return { result: await act(ctx.sessions.actor, { op: "select", control: s.control, value: option }), value: option };
    }
    const result = await act(ctx.sessions.actor, {
      op: s.op,
      control: s.control,
      value: s.fillText ?? null,
      ...(s.op === "send" ? { candidates } : {}),
    });
    return s.fillText === undefined ? { result } : { result, value: s.fillText };
  };

  /** Appends an executed step to the Recording (the defect's repro path). */
  ctx.recordAction = (s: MisuseStep, value: string | undefined, at: number, submittedVia?: ActResult["submittedVia"]): void => {
    if (s.control === null) {
      if (s.op === "reload") {
        ctx.recorder.navigate(ctx.sessions.page.url(), at);
        ctx.lastRecordedTarget = null;
      }
      return;
    }
    if (s.op === "click") ctx.recorder.click(s.control.descriptor, at);
    else if (s.op === "type") {
      // A password field's typed value is synthetic (never a real secret), but it is still kept
      // out of the Recording — `{redacted:true}` with only its length, never the text itself.
      const v = value ?? "";
      ctx.recorder.fill(s.control.descriptor, s.redacted === true ? { redacted: true, length: v.length } : v, at);
    } else if (s.op === "select") ctx.recorder.select(s.control.descriptor, value ?? "", at);
    else if (s.op === "send") {
      ctx.recorder.fill(s.control.descriptor, value ?? "", at);
      if (submittedVia !== undefined && submittedVia.kind === "click") ctx.recorder.click(submittedVia.control.descriptor, at);
      else ctx.recorder.press("Enter", s.control.descriptor, at);
    } else return;
    ctx.lastRecordedTarget = JSON.stringify(s.control.descriptor);
  };

  /**
   * Perceives what an action produced and checks it: a hang is recorded, then the mission resets
   * to a known state and hunts on; an off-origin page sends it back to the seed. "reset" means the
   * page the episode was planned on is gone; "stop" means the mission cannot continue.
   */
  ctx.observeAfter = async (
    step: number,
    action: string,
  ): Promise<{ kind: "ok" } | { kind: "reset" } | { kind: "stop"; stop: AdversarialStop }> => {
    const next = await ctx.perceiveNow();
    await ctx.drainLate(step);
    ctx.snap = next.snapshot;
    ctx.snapTiming = next.timing;
    const target = ctx.lastRecordedTarget;
    ctx.recorder.observed(
      ctx.snap.url,
      ctx.now(),
      next.timing,
      target === null ? undefined : { lastTargetStillPresent: ctx.snap.controls.some((c) => JSON.stringify(c.descriptor) === target) },
    );
    ctx.lastRecordedTarget = null;
    let restarted: Awaited<ReturnType<typeof ctx.restartAtSeed>>;
    // Only IN-SCOPE pages are hang-checked (#193): a page reached by a departure is outside the
    // target, so its hang signal is advisory (noted on the departure), never a finding.
    if (next.hang !== null && ctx.inScope(ctx.snap.url)) {
      await ctx.recordHang(next.hang, next.snapshot, next.timing);
      // Keep hunting: reset to a known state (a fresh page at the start URL) and go on, within
      // budget. The hung route is not followed again (visit-route remembers it).
      restarted = await ctx.resetAfterHang(next.hang);
    } else if (!ctx.inScope(ctx.snap.url)) {
      // Scope containment (#64; guardrail #1 for another origin): the action left the target.
      // Record the departure, then reset to the start URL in a fresh page and hunt on there.
      // The step spent out of scope counts as out-of-scope, never as coverage.
      ctx.outOfScopeSteps += 1;
      const landed = redactUrl(ctx.snap.url);
      ctx.departures.push({ step, url: landed, action });
      const fresh = params.openFreshSession !== undefined;
      ctx.transcript.record({
        op: null,
        control: null,
        confidence: null,
        chosenBy: "strategy",
        strategy: "scope-reset",
        actOk: true,
        reason: joinReasons([
          `left the target scope (landed on ${landed}); reset to the start URL${fresh ? " in a fresh page" : ""}`,
          next.hang === null ? undefined : outOfScopeHangNote(next.hang),
        ]),
        snapshot: ctx.snap,
        ...(ctx.snapTiming === undefined ? {} : { timing: ctx.snapTiming }),
      });
      ctx.snapTiming = undefined;
      // A page that still looked hung is left the way a hang is (a fresh page, or — when none can
      // be opened — a stop if it is unresponsive); any other departure just moves to a fresh page.
      if (next.hang === null) await ctx.sessions.fresh();
      else if (!(await ctx.sessions.reset(next.hang))) {
        ctx.last = null;
        return { kind: "stop", stop: "hang" };
      }
      restarted = await ctx.restartAtSeed();
    } else {
      return { kind: "ok" };
    }
    ctx.last = null;
    if (!restarted.ok) return { kind: "stop", stop: restarted.stop };
    ctx.snap = restarted.snapshot;
    ctx.snapTiming = restarted.timing;
    return { kind: "reset" };
  };
}
