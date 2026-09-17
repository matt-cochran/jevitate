# Human-in-the-Loop Handback (human-only steps) — Design

**Status:** Proposed (design only — no plan/code yet)
**Date:** 2026-09-17
**Builds on:** M1 (command state machine, global pause, events), M2 (headed Screenplay/Playwright), RxD (checkpoints, postdoc labeling); relates to self-healing ops and M2.5.
**Companion spec:** [CONOPS](../../../Browser_Automation_CONOPS_and_Functional_Specification.md) §2.6 (human operating envelope: pause/takeover), §3.6 (browser session: login/MFA/consent by the user), §2.2 (out of scope: no CAPTCHA solving / no credential capture); [RxD](2026-09-17-record-by-demonstration-design.md); [Self-healing ops](2026-09-17-self-healing-operations-design.md).

## 1. Purpose

Let a journey interleave automated steps with **human-only** steps. The automation drives to a point, **hands control to the human** in the headed browser (2FA, CAPTCHA, consent, a judgement call), the human completes that step directly, and the automation **verifies the expected state and resumes**. This generalizes the CONOPS "authentication challenge → pause and notify" into a first-class, per-step handback that any part of a journey can use.

## 2. Guardrails (binding)

- **The human does the sensitive act.** 2FA/CAPTCHA/consent/credentials happen in the human's hands in the real browser — never automated, never captured (CONOPS §2.2 out-of-scope, §3.6). **Recording/evidence capture is paused during a human-only step.**
- **Resume only on a verified postcondition.** The automation continues past a handback only after a Screenplay Question confirms the expected page/state; otherwise re-prompt or fail-closed.
- **Fail-closed on timeout.** A handback that isn't completed within its expiry pauses/quarantines the command and alerts — it never proceeds on assumption.
- **Determinism preserved around the gap.** The human step is a non-deterministic checkpoint boundary; the automated segments before/after stay deterministic and replayable, gated by the postcondition.

## 3. Model

- A step/action carries `humanOnly: true` with `{ prompt: string; resumeCheck: Question<boolean>; timeoutMs?: number }`. Set during RxD **postdoc** (mark a recorded step human-only) or declared in an action/workflow.
- New command/journey state **`awaiting_human`** (a takeover state, distinct from `awaiting_approval`). The runner:
  1. drives to the handback checkpoint (a safe boundary),
  2. **pauses capture**, surfaces `prompt` via the attention/notification surface (the headed browser is already on-screen for the user to act in),
  3. waits — either the user confirms "done" (CLI/UI) or the runner polls `resumeCheck` to auto-detect completion,
  4. on signal, evaluates `resumeCheck`: satisfied → resume from the checkpoint; not satisfied → re-prompt (bounded) then fail-closed,
  5. resumes capture/automation for the next segment.
- **Lease/ordering:** an `awaiting_human` command holds its ordering key but should not hog a single-active-action slot indefinitely — long waits convert to a `throttled`/parked state with a resume handle (aligns with M2.5's retry-after model and M1's queue), so other work can proceed.

## 4. Composition with the rest of the system

- **RxD:** postdoc lets you flag steps human-only; the transpiled action/interpreter emits a handback there. Handback points are natural checkpoints (reuse replay-to-checkpoint). During a demonstration, the recorder auto-suggests human-only for detected auth/CAPTCHA screens.
- **Self-healing ops:** a failing/uncertain step can **fall back to a live human handback** ("do this one manually now") as a repair path; repeated handbacks at the same step flag it as a **candidate to automate** later (feeds continual learning).
- **M2.5 timing:** the human drives the human-only step; our pacing doesn't apply during it. Automated segments keep their `InteractionPolicy`.
- **Auth:** the existing "auth challenge → pause" becomes a special, auto-detected case of human-only handback.

## 5. Honest hard parts / risks

- **Reliable completion detection** — designing a good `resumeCheck` Question per handback (and a sensible poll vs explicit-confirm default); a wrong check resumes too early.
- **Stale page on resume** — the human may navigate/refresh; resume must re-establish page identity before continuing (recipient/target rechecks, as in write preflight).
- **No secret leakage** — capture/evidence must be provably paused across the human-only window; assert this in tests.
- **Timeouts & UX** — expiry, reminders, and not blocking the queue; batching/prioritizing handback prompts.
- **Attended vs unattended** — some journeys assume a human is present; a policy must decide behavior when no human responds (park + alert, never guess).

## 6. Phasing

- Substrate: M1 global pause + CONOPS §2.6/§3.6; the state machine gains `awaiting_human`.
- Core feature (per-step `humanOnly`, pause/resume-with-postcondition, capture-pause) is buildable once the runner supports **checkpointed pause/resume** — the same capability RxD Phase A introduces, so it lands well alongside RxD Phase A. The auth-challenge special case can arrive earlier as a targeted pause.

## 7. Open decisions (for the plan stage)

- Default completion signal: explicit human confirm vs polling `resumeCheck` (per-step override).
- The attention/handback surface (CLI prompt now; richer UI later) and how a handback is presented alongside the live browser.
- Attended-vs-unattended policy per site/capability.
- Exact `awaiting_human` ↔ queue/lease interaction (hold vs park-with-resume-handle).
