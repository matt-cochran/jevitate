# Autonomous Exploration & Testing (Jev + Generative LLM) — Design

**Status:** Proposed (design only — plan follows on approval)
**Date:** 2026-09-19
**Inspired by:** browser-use/jev-ultrafast (Jev drives the browser via one typed decision per step; a small LLM writes text only on TYPE_TEXT).
**Builds on:** everything: M1 queue/state-machine/quarantine, M2 Screenplay+Playwright, M2.5 pacing/throttle, RxD A.1 interpreter + A.2 recorder/descriptor + A.3a diff/binding/fit + A.3b splice/postdoc, self-healing & HITL designs.
**Companion:** the model-gateway plan (`2026-09-17-mvp-m3a-model-gateway.md` = generation source) + CONOPS §3.4 (authoring plane), §6.5 (bounded repair). Guardrails binding.

## 1. The reframe

Turn the platform from "run authored automations" into that **plus an autonomous browser-testing/exploration engine**: **Jev** (TypeSafe System One) makes the fast, typed *driving decisions*; a **generative LLM** supplies only *text*; and every autonomous run emits our deterministic **`Recording`** — so discovery is nondeterministic but the **product is a reproducible, replayable, diffable script** you can hand to a coding model to fix.

Two AI sources, each doing what it's good at:
- **Judgment gateway — Jev/TypeSafe:** `Choice`/`Noul`/`Score` decisions (next operation, target, "goal met?", "new state or seen?", "is this a defect?", "blocked → human?"). Fast, calibrated, cheap. One `systemOne()` round-trip per step.
- **Generation gateway — OpenRouter/AI SDK (M3a):** free text only (form values on `TYPE_TEXT`, triage narratives). Small/cheap model for values.

Everything deterministic stays code: Screenplay execution, `Recording` capture, interpreter replay, diff/splice, self-healing, postconditions, budgets/pacing.

## 2. The core loop (perceive → decide → act → record)

```
loop (bounded by max-steps + budget, per mission):
  perceive: Playwright snapshot → indexed control table; EACH control i carries a durable
            TargetDescriptor (reuse A.2 descriptor computation) + role/name/value summary.
  decide:   Jev.systemOne({ state: {goal, url, controls[], history, missionContext},
              questions: { op: Choice{click|type|select|scroll_up|scroll_down|wait|done|blocked},
                           target: Choice over the indexed controls } })   // two heads, one round-trip
  generate: if op==type → GenerationGateway writes the value (redacted context; NEVER a real
            recipient for a real send); if op==select → choose among the control's real options.
  act:      execute via Screenplay interactions on control[target]'s Target; postcondition/actionability
            gates the step (timing never substitutes). done→exit; blocked→HITL handback (§HITL).
  record:   append a RecordedStep (durable descriptor + value redacted + timing) to the run Recording.
```
Jev targets by **index**; we record by **durable descriptor** — the snapshot bridges the two, so the emitted `Recording` is index-free and replays deterministically. Nondeterministic discovery → deterministic artifact.

## 3. Missions (prompt/config-driven — same loop, different judgments + stop rule)

1. **Adversarial E2E testing.** Mission = a goal + "try to break it." Run the loop; Jev `Noul` "is this an error/broken/unexpected state?" after each step; on a defect (assertion fail, error page, or Noul over threshold) → **stop, keep the run Recording as the exact repro**, and hand the Recording + failing state to the **generative LLM for triage** (summary + likely cause). The Recording is the reproducible hand-off to a coding model.
2. **Goal-based exploratory testing.** Mission = a goal. Jev drives to accomplish it (`Choice` best next op/target; `Noul` "goal accomplished?"). Record the successful path(s). Multiple runs → multiple takes → feed **A.3a diff** to generalize "the ways to do it" into a parameterized action. Exploration *authors* RxD recordings.
3. **Proof-by-induction (state coverage).** Enumerate a component/page's states: a **state fingerprint** (normalized control table + url-template) + a **frontier** of unexplored (state, action) pairs. Jev `Choice` picks the next unexplored action and judges "new state or already-seen?"; `Noul` "is this state a defect?" at each. Expand until the **frontier is exhausted** (all reachable states/actions from the seed visited within depth/budget) → **stop** with a coverage report + any proven defects. Bounded, terminating.

## 4. Outputs
- **A deterministic `Recording`** of every run (reproducible; replays via the A.1 interpreter).
- **Defect reports**: Recording (repro) + failing state + LLM triage → hand to a coding model.
- **Discovered scripts**: low-risk goals explored autonomously → recorded → reviewed/approved → deterministic replay (Jev discovers *how*; we keep the script).
- **Targeted self-healing** (the API/site-change case): when a production step breaks, run the exploration loop **scoped to just the broken step's sub-goal** (from the checkpoint before it to the expected postcondition after) → Jev re-learns that one step → **splice** the new segment into the Recording (A.3b) → gated repair. No reinventing the whole journey.

## 5. Composition with what exists
- **Snapshot/descriptor:** reuse A.2's Node-side descriptor computation to build the indexed controls with durable descriptors.
- **Execution:** reuse Screenplay interactions + the deterministic runner (M2/M2.5); pacing/throttle apply; postconditions gate.
- **Recording/replay/diff/splice:** reuse A.1/A.2/A.3a/A.3b — the exploration engine is just another producer of `Recording`s and a consumer of the diff/splice/interpreter.
- **Self-healing & HITL:** `blocked` → HITL handback; a broken production step → scoped exploration + splice repair (extends the self-healing design).
- **AI core:** shared redaction/minimization, ceilings, provenance, confidence thresholds, and deterministic fake adapters for CI (both Jev and OpenRouter faked; live needs `TYPESAFE_API_KEY` + `OPENROUTER_API_KEY`).

## 6. Guardrails (binding)
- **Authoring/test plane only.** Autonomous exploration runs in the isolated authoring/test profile (CONOPS §3.4), against test targets or sites the user is authorized to test — **never production writes**. Production still runs only compiled/approved deterministic Recordings.
- **Bounded + fail-closed.** Every mission has a hard max-steps + budget; unknown/ambiguous → `wait`/`blocked`/stop, never guess an irreversible action. `done`/`blocked`/exhausted are the only terminations besides the cap.
- **No real sends / no secrets to models.** The generative LLM never selects a real recipient for a real external write; secrets/PII are redacted before any Jev/LLM call; form values on real targets follow the existing approval/human-only rules.
- **Not detection-evasion.** This is authorized testing/automation; pacing stays politeness/realism; timing never substitutes for a postcondition.
- **Nondeterministic discovery, deterministic product.** Exploration decisions aren't seeded, but the emitted `Recording` is replayable and, once reviewed/approved, runs deterministically via the interpreter — the CONOPS "production = compiled/approved artifacts" line holds.

## 7. Honest hard parts / risks
- **State fingerprinting & termination (induction):** deciding "new vs seen" and a bounded frontier that actually terminates — needs a robust, tunable fingerprint (control table + url-template + maybe a Jev "same state?" `Noul`), depth/budget caps, and cycle detection.
- **Index→descriptor bridge:** the snapshot must compute a durable descriptor per control *and* keep Jev's index stable within a step; stale-frontier/re-snapshot discipline (jev-ultrafast's "freshness guards").
- **Jev calibration for defects:** "is this a defect?" is a judgment — validate thresholds on real cases; a false "defect" wastes triage, a missed one is worse. Postconditions/assertions remain the hard signal; Jev augments.
- **Loop safety:** bounding, no-progress detection (repeated states → stop), and never taking an irreversible action autonomously on a real site.
- **Nondeterminism in tests:** the engine's own tests use fake Jev/LLM adapters returning scripted decisions (deterministic); real Jev/LLM behind opt-in env-gated tests.

## 8. Phasing (proposed)
- **P0 — AI core + two gateways:** `@doit/ai-core` (redaction/ceilings/provenance/confidence/fakes) + **generation gateway** (M3a, OpenRouter) + **judgment gateway** (Jev adapter: `systemOne`, `TYPESAFE_API_KEY`, Choice/Noul/Score task types, fake adapter). Prerequisite for everything below.
- **P1 — Exploration engine:** indexed snapshot (durable descriptors) + the perceive→decide→act→record loop + bounded budget + emit a `Recording`; a **goal-based** mission first (simplest: drive to a goal on the fixture, emit a replayable Recording).
- **P2 — Testing missions:** adversarial E2E (defect Noul + triage handoff) and proof-by-induction (state fingerprint + frontier + termination + coverage report).
- **P3 — Targeted self-healing:** scoped exploration to re-learn a broken step + splice (extends self-healing ops).

RxD A.3b (postdoc/splice) and M3a (generation gateway) remain useful and feed this — A.3b's splice is P3's repair mechanism; M3a is P0's generation source. Sequencing of this vs finishing A.3b is the open call below.

## 9. Open decisions (for your review before planning)
- **Sequencing:** finish **A.3b** (postdoc/splice — human-demo authoring) first, then P0→P1; or pause A.3b and start P0 (the gateways) now since it's the prerequisite for the autonomous dimension?
- **First mission to build (P1):** goal-based exploratory (recommended — simplest, and it *produces* recordings) vs adversarial E2E vs induction.
- **Snapshot fidelity:** how rich the indexed control table is (visible interactive controls only, vs including state/text for defect judgments) — affects Jev cost and defect sensitivity.
- **Scope of P0 judgment tasks:** just op+target (driving) first, or also the classify/verify/defect judgments up front.
- **`TYPESAFE_API_KEY` availability** for opt-in live tests (CI uses fakes regardless).
