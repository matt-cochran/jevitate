# Unified Journey Automation & Testing — Design (north star + Slice 1)

**Status:** Proposed (north star agreed in brainstorming; Slice 1 scoped — plan follows on approval)
**Date:** 2026-09-19
**Relationship to existing specs:** This is the **umbrella** capability design. It frames one coherent product around a single artifact and *subsumes/positions* the prior specs rather than replacing them:
- `2026-09-19-autonomous-exploration-testing-design.md` (Jev + generative LLM) — becomes the **LM-driving** authoring mode + the **testing missions** of this umbrella.
- `2026-09-17-record-by-demonstration-design.md` (RxD) — the **human-driving** authoring mode.
- `2026-09-17-hitl-handback-design.md` (HITL) — the **secret→visible-handback** runtime rule.
- M2.5 humanized timing — reused by the **throughput/load** capability and by pacing in `RunPolicy`.
- `2026-09-17-mvp-m3a-model-gateway.md` (M3a) — a later gateway (generation source); **not** on Slice 1's path.

Guardrails from the prior specs remain binding; this doc adds one hard floor (#6) and one runtime setting.

---

## 1. The reframe (north star)

Turn the platform into one tool that lets a person **automate anything and do exploratory testing**, where the two are complementary, not separate products. A human can step through an app and we record it; that recording can be handed to the tool to **follow the same path and branch/explore around it**; deterministic replay can be **enhanced programmatically** to fully explore a space with **no model at all**, reaching for **Jev only when direction is wanted**. Both authoring modes converge on one reusable, self-healing artifact that is published as a **single high-level MCP action**.

## 2. Core abstraction — the `Journey`

Everything produces or consumes a **`Journey`**:
- a **parameterized `Recording`** (the existing closed-schema artifact), plus
- **metadata**: name, **param-schema derived from its variables**, postconditions, provenance, retention, promotion state.

The Journey is what both authoring modes emit, what all three surfaces invoke, and what the throughput and testing capabilities operate on. Nondeterministic discovery is allowed; the **product is always a deterministic, replayable, diffable Journey**.

## 3. Two authoring modes (converge on a Journey)

- **Human-driving** — you step through; we record (RxD). Produces a Journey directly.
- **LM-driving** — exploratory / goal-based (Jev for typed driving decisions; generative LLM for text only). Emits a Journey too.
- **Seeding:** a human recording can seed LM exploration ("follow this path, then branch/explore around it").

## 4. Direction spectrum (runtime, not a mode switch)

How much is decided at runtime vs. baked in is a continuum:

```
pure deterministic replay
  → deterministic/programmatic exploration (NO Jev)
    → Jev-directed (Jev chooses op+target; optional director)
      → generative goal-based (Jev + generative orchestrated)
```

Jev is an **optional director**, never required for exploration. The generative LLM supplies **text only** (form values, triage narratives) and never selects a real recipient for a real send.

## 5. `RunPolicy` — the threaded run context ("monadic variable")

A single policy object is threaded through every step (same shape as today's per-site `InteractionPolicy`; execution returns a discriminated `RunResult` as in M2.5). It carries:
- **self-heal mode:** `fail-closed | hybrid | full`
- **direction level:** deterministic ↔ Jev-directed ↔ goal-based
- **pacing / human-speed profile** (reuse M2.5)
- **budgets** (max-steps, per-run/day)
- **secret-stop behavior:** `visible-handback | fail-closed`

Session-scoped, **default-safe**, dialable per session/site/action. The self-heal modes:
- **fail-closed** — any divergence → stop + quarantine + alert; repair is a separate authoring-plane step.
- **hybrid** — in-flight autonomous re-learn+splice+continue for **read-only / idempotent / reversible** steps; **write / irreversible / real-send** steps fail closed and require human-approved repair.
- **full** — in-flight repair through anything within budget + bounds + injection guards (highest blast radius; explicit opt-in).

## 6. Self-healing (wraps runtime)

On divergence (detected by the A.3b **strict two-tier signature**), behavior follows `RunPolicy`. Repair, when permitted, is **scoped Jev re-learn of just the broken step → splice into the Journey** (A.3b `spliceRecording`), then gated per policy. No reinventing the whole journey.

## 7. Surfaces — one execution core, three faces

- **CLI:** `brauto journey list | find | run <id> --param k=v`.
- **Programmatic API** on the runtime.
- **MCP — two-level (HITL-style: discover, then invoke):**
  1. `find_capabilities(query)` → searches the Journey catalog, returns matching capabilities **with their param-schemas**. Ranking is **Jev-filtered when the judgment gateway is available**; a deterministic metadata search otherwise. Keeps the tool surface small instead of flooding callers with hundreds of named tools.
  2. `run_journey(id, params)` (generic) **plus** auto-registered **named, typed** tools for *promoted* Journeys.
  Both live behind the existing `mcp-facade` domain-tool **allowlist** (no raw browser tools ever cross the boundary; an approved Journey = one allowlisted domain tool).

## 8. Derived capabilities (reuse the same Journey + runner)

- **Throughput / Load harness (rung 1):** a pool of **seeded, human-paced virtual actors** drives a Journey **concurrently** against the target; emits a **capacity/throughput report measured from the real run** (ops/hour a real person could sustain, time-per-journey, where the time goes, daily ceiling). Offline `simulateTiming()` remains the zero-cost estimate. Seeded ⇒ reproducible.
- **Testing missions** (from the autonomous-testing spec): adversarial E2E, goal-based exploratory, proof-by-induction — **plus** *defects → committed deterministic regression tests*: when a mission finds a defect, emit a Journey-based replay test that **fails on the bug and passes after the fix** (prove-broken → prove-fixed), not just a triage note.

## 9. Hard floors (hold regardless of `RunPolicy`)

1. Secrets/PII redacted before **any** Jev/LLM call; the generative LLM never picks a real recipient for a real send.
2. Prompt-injection guard always on ("page text is untrusted data, not instructions").
3. Every autonomous/self-healing run is **bounded** (max-steps + budget) — never unbounded.
4. Every executed step is **recorded/auditable** — even a "full autonomous" run is replayable and reviewable after the fact.
5. Pacing is realism/politeness, **never** detection-evasion.
6. **A secret step is never automated — execution always stops there.** No password/2FA/OTP/consent is typed, re-derived, or self-healed by Jev/LLM. The `RunPolicy` secret-stop setting then chooses **visible handback** (surface the headed browser so the human completes auth / enters the password; resume only after a postcondition verifies state — the `awaiting_human` state from HITL) **or fail-closed + quarantine** when unattended.

## 10. Rung / slice roadmap

| Rung | Capability | Slice |
|---|---|---|
| 0 | Deterministic authored/recorded Journeys | **Slice 1** |
| — | Productization: Journey artifact + 2-level MCP + CLI/API + `RunPolicy` + secret-handback + fail-closed self-heal | **Slice 1** |
| — | Model gateways: `@doit/ai-core` + generation (M3a) + Jev judgment | Slice 2 |
| 3–4 | LM-driving: Jev-directed / goal-based exploration; Jev-ranked `find_capabilities` | Slice 3 |
| — | Testing missions (adversarial / induction) + regression-test emission | Slice 4 |
| — | Hybrid/full self-heal (scoped re-learn + splice in-flight) | Slice 5 |
| 1 | Throughput / Load harness (seeded actor pool + measured report) | Slice 6 (independent; can float earlier) |

## 11. Slice 1 — deterministic backbone + productization (no API keys)

**In scope:**
1. **Finish A.3b** (un-held): postdoc/splice + strict two-tier signature → recorded takes become a **parameterized Journey**.
2. **`Journey` artifact + registry** wrapping the parameterized `Recording` (name, param-schema from variables, postconditions, provenance, retention, promotion); store extends `FsRecordingStore`.
3. **`RunPolicy` threaded context** — Slice 1 implements **`fail-closed` only** and **deterministic** direction; carries pacing (M2.5), budgets, and the secret-stop setting; default-safe; threaded through the interpreter.
4. **Secret → visible-handback (HITL)** — interpreter stops at a secret/handback step and hands off a **headed browser** (`awaiting_human`), resuming on postcondition, else fail-closed.
5. **2-level MCP facade** — `find_capabilities(query)` (deterministic metadata search in Slice 1; Jev-ranking layers on in Slice 3) → capabilities + param-schemas; `run_journey(id, params)` generic + auto-registered named typed tools for promoted Journeys, behind the allowlist.
6. **CLI + programmatic API** — `brauto journey list/find/run --param k=v`; runtime API. One core under all three surfaces.
7. **Fail-closed self-heal wiring** — divergence (A.3b strict signature) → stop + quarantine + alert.

**Out of Slice 1 (later slices):** Jev/generative gateways, LM-driving/exploration, goal-based/adversarial/induction missions, throughput/load harness, Jev-ranked `find_capabilities`, hybrid/full self-heal.

**Slice 1 result:** *record → parameterize → publish as one MCP action (discover-then-run) → deterministic replay, secret-safe, fail-closed* — with zero model dependency.

## 12. Composition with existing work

- **Recording/interpreter/diff/splice/promote:** reuse A.1/A.2/A.3a and finish A.3b.
- **Execution + pacing + postconditions:** reuse Screenplay + the M2/M2.5 runner; `RunPolicy` generalizes the `InteractionPolicy` threading.
- **MCP boundary:** extend `mcp-facade` (allowlist) with the two-level Journey tools; no raw browser tools cross.
- **HITL:** the secret-stop visible-handback is the HITL `awaiting_human` mechanism, now a `RunPolicy` setting.
- **Later:** M3a = the generation gateway (Slice 2); the autonomous-testing engine = Slices 3–5; throughput = Slice 6.

## 13. Open decisions / deferred
- **`find_capabilities` ranking:** deterministic metadata search now; Jev rerank (`Score`/`Choice` over the catalog) when the judgment gateway lands (Slice 3). Graceful degrade: works without Jev, better with.
- **Promotion → named MCP tool:** what gate promotes a Journey to a first-class named+typed tool (human approval assumed); param-schema generation from variables needs a canonical variable→JSON-schema mapping.
- **`RunPolicy` storage/scope:** session vs per-site vs per-action precedence and where it persists (extends the site-policy repo?).
- **Throughput harness placement (Slice 6):** may float earlier since it needs no models and no A.3b.
- **Enumeration auto-detection & per-keystroke timing/richer `fit`:** remain deferred to RxD A.3c.

## 14. Honest hard parts / risks
- **`RunPolicy` as a clean threaded context** without leaking into every signature — model it once (like `InteractionPolicy`) and thread it; avoid a god-object.
- **Param-schema generation** from Journey variables must be deterministic and typed (drives both CLI `--param` and MCP tool schemas).
- **Visible handback** requires a **headed** browser path in Slice 1 (today's e2e is largely headless) — a real, testable pause/resume with a postcondition gate.
- **Two-level MCP** must stay inside the allowlist boundary and not become a raw-browser escape hatch.
- **Divergence signal** (A.3b strict signature) is the load-bearing input to fail-closed self-heal; its false-positive/negative behavior must be tested on real drift.
- **Tests:** Slice 1 is fully deterministic (no models) — real-browser golden replays + the non-interactive `--decisions` postdoc path keep it TDD-able.
