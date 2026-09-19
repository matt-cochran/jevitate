# Unified Journey Automation & Testing — Design (north star + Slice 1)

**Status:** Proposed (north star agreed in brainstorming; FMECA-vetted 2026-09-19; Slice 1 scoped — plan follows on approval)
**Date:** 2026-09-19
**Relationship to existing specs:** This is the **umbrella** capability design. It frames one coherent product around a single artifact and *subsumes/positions* the prior specs rather than replacing them:
- `2026-09-19-autonomous-exploration-testing-design.md` (Jev + generative LLM) — the **LM-driving** authoring mode + the **testing missions**.
- `2026-09-17-record-by-demonstration-design.md` (RxD) — the **human-driving** authoring mode.
- `2026-09-17-hitl-handback-design.md` (HITL) — the **secret→visible-handback** runtime rule.
- M2.5 humanized timing — reused by the **throughput/load** capability and by pacing in `RunPolicy`.
- `2026-09-17-mvp-m3a-model-gateway.md` (M3a) — a later gateway (generation source); **not** on Slice 1's path.

Guardrails from the prior specs remain binding; this doc adds one hard-floor invariant (#6), one runtime setting, and a **Fail-fast invariant contract list (§9a)** derived from an FMECA vetting.

---

## 1. The reframe (north star)

Turn the platform into one tool that lets a person **automate anything and do exploratory testing**, where the two are complementary, not separate products. A human can step through an app and we record it; that recording can be handed to the tool to **follow the same path and branch/explore around it**; deterministic replay can be **enhanced programmatically** to fully explore a space with **no model at all**, reaching for **Jev only when direction is wanted**. Both authoring modes converge on one reusable, self-healing artifact that is published as a **single high-level MCP action**.

## 2. Core abstraction — the `Journey`

Everything produces or consumes a **`Journey`**:
- a **parameterized `Recording`** (the existing closed-schema artifact), plus
- **metadata**: name, **param-schema derived from its variables**, postconditions, provenance, retention, promotion state, and any **secret references** (manager key + bound origin + field — never the value).

The Journey is what both authoring modes emit, what all three surfaces invoke, and what the throughput and testing capabilities operate on. Nondeterministic discovery is allowed; the **product is always a deterministic, replayable, diffable Journey**.

## 3. Two authoring modes (converge on a Journey)

- **Human-driving** — you step through; we record (RxD). Produces a Journey directly.
- **LM-driving** — exploratory / goal-based (Jev for typed driving decisions; generative LLM for text only). Emits a Journey too.
- **Seeding:** a human recording can seed LM exploration ("follow this path, then branch/explore around it").

## 4. Direction spectrum (runtime, not a mode switch)

```
pure deterministic replay
  → deterministic/programmatic exploration (NO Jev)
    → Jev-directed (Jev chooses op+target; optional director)
      → generative goal-based (Jev + generative orchestrated)
```

Jev is an **optional director**, never required for exploration. The generative LLM supplies **text only** and never selects a real recipient for a real send.

## 5. `RunContext` / `RunPolicy` — the threaded run context ("monadic variable")

A single **immutable** context is threaded through every step (same shape as today's per-site `InteractionPolicy`; execution returns a discriminated `RunResult` as in M2.5). To avoid a god-object (FMECA #5), it is **segmented** into narrow sub-policies each consumed only where relevant:
- **`SelfHealPolicy`** — `fail-closed | hybrid | full`
- **`DirectionPolicy`** — deterministic ↔ Jev-directed ↔ goal-based
- **`SecretPolicy`** — `secretMode: vault-autofill | visible-handback | fail-closed`
- **`PacingPolicy`** — human-speed profile (reuse M2.5)
- **`Budget`** — max-steps, per-run/day, concurrency

**`RunPolicy` is a required parameter of the execution entrypoint — there is no default construction and the fallback is never permissive.** Its safe default is `fail-closed` self-heal + `deterministic` direction + `fail-closed` secret-stop. Self-heal modes:
- **fail-closed** — any divergence → stop + quarantine + alert; repair is a separate authoring-plane step.
- **hybrid** — in-flight autonomous re-learn+splice+continue for **read-only / idempotent / reversible** steps; **write / irreversible / real-send** steps fail closed and require human-approved repair.
- **full** — in-flight repair through anything within budget + bounds + injection guards (explicit opt-in; highest blast radius).

## 6. Self-healing (wraps runtime)

On divergence (**hinted** by the A.3b strict two-tier signature; **authorized** by the semantic per-step postcondition — FMECA #8/#9), behavior follows `SelfHealPolicy`. Repair, when permitted, is **scoped Jev re-learn of just the broken step → splice into the Journey** (A.3b `spliceRecording`), then gated per policy. A write step **never** auto-heals.

## 7. Surfaces — one execution core, three faces

- **CLI:** `brauto journey list | find | run <id> --param k=v`.
- **Programmatic API** on the runtime.
- **MCP — two-level (HITL-style: discover, then invoke):**
  1. `find_capabilities(query)` → searches the catalog **scoped to promoted/allowlisted Journeys only** (FMECA #7), returns capabilities **with their param-schemas**. Ranking is **Jev-filtered when the judgment gateway is available**; a deterministic metadata search otherwise.
  2. `run_journey(id, params)` — resolves an **already-published Journey by id only** (never inline steps — FMECA #6); params **validated against the Journey's param-schema** (unknown rejected). **Plus** auto-registered **named, typed** tools for promoted Journeys.
  Both live behind the existing `mcp-facade` domain-tool **allowlist** (no raw browser tools ever cross; an approved Journey = one allowlisted domain tool).

## 8. Derived capabilities (reuse the same Journey + runner)

- **Throughput / Load harness:** a pool of **seeded, human-paced virtual actors** drives a Journey **concurrently** against the target; emits a **capacity/throughput report**. Every metric carries provenance **`measured | modeled`** and **never silently downgrades** to the offline `simulateTiming()` estimate (FMECA #11). Runs only against **authorized/test targets**; N>1 actors require an **explicit authorized-target assertion** and are bounded by `Budget`/quiet-hours (FMECA #10). Seeded ⇒ reproducible.
- **Testing missions** (from the autonomous-testing spec): adversarial E2E, goal-based exploratory, proof-by-induction — **plus** *defects → committed deterministic regression tests* that **fail on the bug and pass after the fix** (prove-broken → prove-fixed).

## 9. Hard floors (hold regardless of `RunPolicy`)

1. Secrets/PII redacted before **any** Jev/LLM call; the generative LLM never picks a real recipient for a real send.
2. Prompt-injection guard always on ("page text is untrusted data, not instructions").
3. Every autonomous/self-healing run is **bounded** (max-steps + budget) — never unbounded.
4. Every executed step is **recorded/auditable** — even a "full autonomous" run is replayable and reviewable after the fact.
5. Pacing is realism/politeness, **never** detection-evasion.
6. **Secret invariant.** A secret's *only* permitted path is **external password manager (fetched on demand) → the browser input → the target site's own auth call**. It is **never** placed in a model prompt, **never** persisted in a Journey/Recording/log, and **never** in any outbound request except the target's own call — and is **origin-bound** (a secret can never be typed into a different origin, or an injected/redirected field). We **store no secrets at rest** (thin delegation only). The `SecretPolicy.secretMode` chooses *how the secret is supplied* — `vault-autofill` (fetched from the external manager), `visible-handback` (headed browser; the human enters it; resume only on a passing postcondition — the HITL `awaiting_human` state), or `fail-closed` — but the containment + origin-binding above is **not tunable**.

## 9a. Fail-fast invariants (poka-yoke contract — each ships with a test that asserts it throws/refuses)

Derived from the FMECA. These are permanent, named contracts; the Slice plans MUST include one "asserts-it-refuses" test per invariant, and the exit gate fails on any permissive fallback around them:

1. **No policy → throw.** A step reaching a policy decision with an absent/partial `RunPolicy` raises `PolicyEnforcementError` (reuse M2.5). No permissive default. *(FMECA #4)*
2. **Secret never serialized.** The `Secret` type has no `toString`/JSON serialization; serializing or logging it throws; a Journey/Recording may hold only a manager *reference*, never a value. *(FMECA #2)*
3. **Origin mismatch → refuse.** Before any secret fill, a postcondition asserts current origin == the secret's bound origin and the field is the expected credential field; mismatch raises `SecretOriginMismatchError` and never fills. *(FMECA #1)*
4. **Secret unresolvable → fail-fast at preflight.** Manager + entry are declared at publish/validate; resolvability is checked **before** the run; failure gives an actionable message, never a mid-run silent skip. *(FMECA #3)*
5. **Unknown journey/param → reject.** `run_journey` resolves a published id only; unknown id or param (against the param-schema) is rejected — no inline steps, ever. *(FMECA #6)*
6. **Unpromoted → invisible + uninvocable.** `find_capabilities`/named tools expose only promoted Journeys. *(FMECA #7)*
7. **Resume only on postcondition.** Handback/self-heal resume requires a passing postcondition Question; timeout → fail-closed; never assume-success. *(FMECA #8/#14)*
8. **Writes never auto-heal.** In hybrid/full, write/irreversible/real-send steps fail closed for human-approved repair. *(FMECA #8)*
9. **Report provenance honest.** Throughput metrics are `measured | modeled`; a requested live run that cannot run errors rather than emitting a modeled number labeled measured. *(FMECA #11)*
10. **Load only when authorized.** N>1 actors require an explicit authorized-target assertion and stay within `Budget`/quiet-hours. *(FMECA #10)*

## 10. Rung / slice roadmap (throughput floated earlier)

| Slice | Capability |
|---|---|
| **1** | Deterministic backbone + productization (no API keys): finish A.3b → `Journey` artifact+registry → segmented `RunPolicy` (fail-closed + deterministic only) → **secret via `visible-handback`** → 2-level MCP (deterministic search) → CLI/API → fail-closed self-heal wiring. Invariants 1, 5–7 land here (in `visible-handback` our process never holds a secret **value**). **Acceptance: a real login journey runs end-to-end via `visible-handback`.** |
| **1b** | Thin **external-manager** secret delegation → `secretMode: vault-autofill` (fetch-on-demand, origin-bound, nothing stored). Invariants 2–4 (the secret-**value** contracts) land here, where a value is first handled. |
| **2** | **Throughput / Load harness** (floated earlier — no models, no A.3b): seeded actor pool + measured capacity report. Invariants 9–10. |
| **3** | Model gateways: `@doit/ai-core` + generation (M3a) + Jev judgment. |
| **4** | LM-driving: Jev-directed / goal-based exploration; Jev-ranked `find_capabilities`. |
| **5** | Testing missions (adversarial / induction) + regression-test emission. |
| **6** | Hybrid/full in-flight self-heal (scoped re-learn + splice). Invariant 8 fully exercised. |

## 11. Slice 1 — deterministic backbone + productization (no API keys)

**In scope:**
1. **Finish A.3b** (un-held): postdoc/splice + strict two-tier signature → recorded takes become a **parameterized Journey**.
2. **`Journey` artifact + registry** wrapping the parameterized `Recording` (name, param-schema from variables, postconditions, provenance, retention, promotion, secret references); store extends `FsRecordingStore`.
3. **Segmented `RunPolicy` threaded context** — Slice 1 implements **`fail-closed`** self-heal and **`deterministic`** direction; carries pacing (M2.5), budgets, and `SecretPolicy`; **required param, never permissive default**; threaded through the interpreter.
4. **Secret → `visible-handback` (HITL)** — interpreter stops at a secret/handback step and hands off a **headed browser** (`awaiting_human`), resuming **only** on a passing postcondition, else fail-closed. (No secret storage in Slice 1.)
5. **2-level MCP facade** — `find_capabilities(query)` (deterministic metadata search; Jev-ranking in Slice 4) → capabilities + param-schemas; `run_journey(id, params)` published-id-only + schema-validated + auto-registered named tools for promoted Journeys, behind the allowlist.
6. **CLI + programmatic API** — `brauto journey list/find/run --param k=v`; runtime API. One core under all three surfaces.
7. **Fail-closed self-heal wiring** — divergence (A.3b strict signature) → stop + quarantine + alert.
8. **Fail-fast invariant tests** — §9a invariants 1, 5–7 each land with an "asserts-it-refuses" test; exit gate greps for permissive fallbacks. (Invariants 2–4 → 1b, where a secret **value** is first handled; 8 → Slice 6; 9–10 → Slice 2.)

**Out of Slice 1:** external-manager autofill (1b), throughput harness (2), model gateways (3), LM-driving/missions (4–5), hybrid/full self-heal (6), Jev-ranked `find_capabilities`.

**Slice 1 result:** *record → parameterize → publish as one MCP action (discover-then-run) → deterministic replay, secret-safe via visible-handback, fail-closed* — with zero model dependency, proven by a **real login journey end-to-end**.

## 12. Composition with existing work

- **Recording/interpreter/diff/splice/promote:** reuse A.1/A.2/A.3a and finish A.3b.
- **Execution + pacing + postconditions:** reuse Screenplay + the M2/M2.5 runner; `RunPolicy` generalizes the `InteractionPolicy` threading and reuses `PolicyEnforcementError`.
- **MCP boundary:** extend `mcp-facade` (allowlist) with the two-level Journey tools; no raw browser tools cross.
- **HITL:** the secret-stop visible-handback is the HITL `awaiting_human` mechanism, now a `SecretPolicy` setting.
- **Secret-leak discipline:** the `Secret` wrapper + no-artifact/no-log/no-model tests are the disciplined inverse of A.2's "passwords never leave the browser" tests.
- **Later:** M3a = the generation gateway (Slice 3); the autonomous-testing engine = Slices 4–6; throughput = Slice 2.

## 13. Open decisions / deferred
- **`find_capabilities` ranking:** deterministic metadata search now; Jev rerank (`Score`/`Choice` over the catalog) when the judgment gateway lands (Slice 4). Graceful degrade.
- **Promotion → named MCP tool:** the human-approval gate that promotes a Journey to a first-class named tool; param-schema generation needs a canonical variable→JSON-schema mapping.
- **External-manager adapter (1b):** which manager(s) first (1Password CLI / OS credential CLI) and the resolve-at-fill contract.
- **`RunPolicy` storage/scope:** session vs per-site vs per-action precedence and persistence (extends the site-policy repo?).
- **Enumeration auto-detection & per-keystroke timing/richer `fit`:** remain deferred to RxD A.3c.

## 14. Honest hard parts / risks (see the FMECA vetting for the full table)
- **Secret containment (FMECA #1,#2):** the `Secret` wrapper (non-serializable) + origin-binding + pre-fill origin postcondition are the load-bearing security contracts; both retain inherent High severity and are permanently test-guarded.
- **`RunPolicy` never-permissive (FMECA #4):** required param + fail-closed default, enforced by `PolicyEnforcementError`.
- **MCP not an escape hatch (FMECA #6):** published-id-only + schema-validated + allowlist.
- **Divergence signal (FMECA #8/#9):** strict-signature *hint* + semantic postcondition *authority*; writes never auto-heal.
- **Visible handback (FMECA #14):** a real **headed** pause/resume gated by a postcondition (today's e2e is largely headless) — resume never on timeout/assumption.
- **Agentic papering-over (FMECA #13):** every invariant is a fail-closed default with a mandated "asserts-it-refuses" test; the exit gate greps for permissive fallbacks and the final Opus review checklist confirms each invariant test exists.
- **Tests:** Slice 1 is fully deterministic (no models) — real-browser golden replays + the non-interactive `--decisions` postdoc path + the §9a invariant tests keep it TDD-able.
