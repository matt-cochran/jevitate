# Self-Healing Operations & Continual Learning — Design

**Status:** Proposed (design only — no plan/code yet)
**Date:** 2026-09-17
**Builds on:** M1 (queue, state machine, quarantine, events), RxD authoring, M2.5 timing; depends on the M3 model gateway for LLM repair.
**Companion spec:** [CONOPS](../../../Browser_Automation_CONOPS_and_Functional_Specification.md) §4.3–4.4 (command state machine, retry classes), §6.5 (bounded repair), §6.7 (repair gates/limits); [Record-by-Demonstration](2026-09-17-record-by-demonstration-design.md); [Interaction policy](2026-09-17-interaction-policy-design.md).

## 1. Purpose

Turn an activated integration into a **living** one: run it from the queue, detect when reality diverges from the recording, **stop safely and alert**, and repair by an LLM bounded-patch attempt and/or a **human re-record** — with every pass accumulating variations so the workflow gets **more reliable over time** and **relearns when the site changes**.

This is the operational lifecycle around RxD: RxD builds the integration; this keeps it working.

## 2. Guardrails (binding)

- **Fail closed.** Unexpected state, ambiguous target, failed postcondition, or a delay-induced race → stop at a safe boundary and **quarantine** the action artifact (CONOPS §4.4: structural failures don't spin). Never blind-retry an irreversible action; unknown write outcomes enter `reconciling`.
- **No auto-activation on write paths** (CONOPS §6.7). Every repair — LLM patch or human re-record — goes through build → tests → dry-run → **human approval** → canary → activation, and is reversible (rollback to the prior content hash).
- **Human re-record runs in the authoring plane** (§3.4), never production.
- **Bounded repair.** Max repair rounds per failure fingerprint (§6.7); escalate to the human when exceeded. Continual learning improves confidence; it never relaxes gates.

## 3. The loop

1. **Operate.** The LLM/CRM enqueues interactions (M1 command queue); the deterministic runner executes activated actions with the site's `InteractionPolicy` (M2.5) and throttles.
2. **Detect & classify.** On divergence, classify with M1's retry classes (`transient_transport`, `stale_page`, `authentication_required`, `ambiguous_target`, `structural_change`, `unknown_external_outcome`, …). Transient → retry from a safe checkpoint. Structural → **quarantine** the artifact; capture a redacted **failure fingerprint** (page fingerprint + failing step + evidence).
3. **Alert.** Raise the failure to an **attention queue** the user sees (redacted evidence, which step, which variable, the fingerprint). This is the "continual alert" — the system asks for help rather than silently degrading.
4. **Repair (two gated paths).**
   - **(a) LLM bounded patch** (CONOPS §6.5): from the redacted fingerprint + the exact artifact, propose a minimal locator/step patch; validate (imports/type/schema/static-policy → tests + generated mutation tests → headed dry-run writes-disabled) → approve → canary → activate; rollback on a structural-failure spike.
   - **(b) Human re-record (RxD)** — the "inquiry": the interpreter **replays to the failure checkpoint**, pauses at the broken live state, the user **demonstrates the corrected segment**, and it **splices in** as a new trace; the affected **chunk re-transpiles** through the same gates. The LLM *sets up* this re-record (opens the session at the right point, states what it couldn't resolve).
   - Policy: the LLM may attempt (a) first and fall back to (b), or ask the user which — configurable per site/capability. Write-path and locator/permission/recipient changes always require approval (§6.7).
5. **Learn.** Each pass — a successful run, a repair patch, or a human re-record — contributes a **trace/variation**. The RxD aligner folds it into the variation history for that step, which:
   - strengthens **variable vs constant** inference (more takes = clearer),
   - hardens **locators** (observed alternatives),
   - refines the **timing** distribution,
   - and tracks a per-step **confidence/flakiness** score.
   More passes → higher confidence. A variation introduced by a **site update** is just a new demonstration that relearns the changed step.

## 4. Data model

- **Failure fingerprint** + quarantine state on the command/action (M1 `site_state`, command states `quarantined`/`reconciling`).
- **Attention queue** — open failures needing human input, with redacted evidence and the proposed repair path.
- **Variation store** — extends the RxD recordings store: per (site, action, step) history of observed traces/variations with confidence scores and which recording/run produced each.
- **Repair provenance** — which recording(s)/patch, tests, approvals, canary result, activation/rollback per `action_version` (§6.4).

## 5. Reliability model

Confidence per step rises with corroborating variations and successful runs, and drops on failures/flakiness. Low-confidence steps are surfaced proactively (candidates for a pre-emptive re-record) — so reliability is *observable* and improves with use rather than silently eroding.

## 6. Phasing & dependencies

- **Substrate exists (M1):** queue, state machine, quarantine, event log, retry classes.
- **Needs RxD Phase A:** record/replay-to-checkpoint/patch/splice + variation store.
- **Needs RxD Phase B + M3 gateway:** LLM bounded-patch repair and the "set up the re-record" inquiry.
- **Needs the §6.5/§6.7 pipeline:** build/test/dry-run/canary/rollback for repairs (CONOPS Phase 6).
- So this lands **after** RxD Phase A and the M3 gateway; the alerting/quarantine substrate can be exercised earlier on M1.

## 7. Honest hard parts / risks

- **Failure classification accuracy** — mislabeling structural drift as transient (spins) or vice-versa (over-quarantines). Conservative default: unknown → quarantine + alert.
- **Repair-vs-re-record routing** — when to trust an LLM patch vs ask the human; write/locator/recipient changes always need approval; cap rounds (§6.7) to avoid loops.
- **Variation vs regression** — a new variation might be a genuine site change or a one-off anomaly; confidence scoring + gates prevent a single odd trace from rewriting a good artifact.
- **Alert fatigue** — batch/prioritize by confidence and impact; don't alert on transient noise.
- **Drift detection latency** — a silently changed site may pass a step but do the wrong thing; postconditions/reconciliation (not timing) remain the real guard.

## 8. Self-review

- Reuses M1 queue/quarantine/state-machine, §6.5/§6.7 repair, RxD replay-to-point/patch/variation, M2.5 timing — minimal new surface. ✅
- New ideas captured: **human-re-record as a first-class, gated repair path**, and **variation accumulation → per-step confidence → reliability that improves with use and survives site changes.** ✅
- Guardrails intact: fail-closed, no write-path auto-activation, bounded rounds, authoring-plane re-record, postconditions over timing. ✅
- Bounded: continual learning strengthens confidence and inference; it never relaxes the activation gates.

## 9. Open decisions (for the plan stage)

- Per-site/capability **repair routing policy** (LLM-first vs human-first vs ask).
- **Confidence scoring** formula and the low-confidence pre-emptive-record threshold.
- **Attention-queue** surface (CLI/notifications) and how re-record sessions are launched from an alert.
- Where this sits relative to CONOPS Phase 6 (authoring/repair) vs earlier partial delivery of alerting/quarantine on M1.
