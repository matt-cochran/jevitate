# Record-by-Demonstration (RxD) Authoring — Design

**Status:** Proposed (design only — no plan/code yet)
**Date:** 2026-09-17
**Builds on:** M1 + M2 (complete on `main`); M2.5 interaction-policy (designed/planned); depends on M3 model gateway for the LLM-assisted half.
**Companion spec:** [CONOPS](../../../Browser_Automation_CONOPS_and_Functional_Specification.md) §3.4 (authoring boundary), §5 (Screenplay), §5.7 (build/activation), §6.4 (integration build), §6.5 (bounded repair); [MVP design](2026-09-16-browser-automation-mvp-design.md); [Interaction policy](2026-09-17-interaction-policy-design.md).

## 1. Purpose

Let a human **demonstrate** a task in the real browser once (or a few times) and have the system capture *what was done* and *how it was paced*, so authoring an integration becomes **generalizing a known-good, human-grounded recording** rather than the LLM discovering the site from scratch. The recording seeds both the site behavior (Screenplay actions) and the realistic timing (an `InteractionPolicy`).

This inverts the expensive part of integration-building and produces the **most deterministic compiled projection possible**: the literal recording transpiles to Screenplay TypeScript with no LLM at all; the LLM only adds generalizations (variables, templates, enumeration) through a careful, staged, approved conversation.

## 2. Guardrails (binding)

- **Authoring plane only.** Recording runs in the isolated **authoring** browser profile (CONOPS §3.4), never a production profile. Production still executes only compiled, tested, content-addressed, **approved** artifacts (§5.7) — never data-driven browser ops from raw recordings.
- **Secrets never recorded.** Password/credential fields and the login flow are excluded from capture; the user logs in themselves. Typed values are captured **redacted by default** and only promoted to named variables deliberately.
- **Redaction before the LLM.** Page snapshots and captured values are redacted/minimized before any model call (CONOPS §6); example values for variables stay local.
- **Not detection evasion.** Timing derived from a demonstration yields **distribution parameters** for polite, load-realistic pacing (M2.5), seeded and replayable — not a keystroke-perfect human fingerprint replayed to defeat bot-detection. Timing never substitutes for a Playwright actionability/state assertion.
- **Careful and reversible.** Every generalization step is transpiled, typechecked, dry-run against the recording/fixture, and **human-approved** before it becomes executable; nothing irreversible runs during authoring.

## 3. Decisions taken (from brainstorming)

| Area | Decision |
|---|---|
| Capture | **Hybrid** — our in-page event recorder over the BrowserPort for events + precise timing + element metadata, using Playwright's role/label locator generation to synthesize `Target`s. |
| Generalization inputs | **1 recording** for a constant single-shot task; **2–3 recordings** of the same journey when variables exist, so a deterministic diff + the LLM separate variables from constants and detect enumerations. |
| Output | A **series** of Screenplay actions, chunked **per page**, composed into a workflow — aiming at the most deterministic compiled/declarative projection. Literal transpile is LLM-free; LLM adds variables/templates/loops. |
| Replay | A data-driven **interpreter** replays recordings during authoring/dry-run (incl. **replay-to-a-checkpoint**); production runs the transpiled, compiled, approved artifacts. |
| Review UX | **Post-hoc CLI/TUI** ("postdoc"): merge/combine steps, label, confirm diff-proposed variables/enumerations, redact; optional inline narration markers dropped during recording. |
| Iterative refinement | **Replay-to-point + record-a-patch**: replay up to an ambiguity, pause at that live state, record a small supplemental segment, **splice** it in — no full re-record. |
| Humanization | **On by default** (fit an `InteractionPolicy` from the recorded timing); `--fast`/`humanize:false` toggle for full speed; **delay-safety is explicitly tested + approved**. |

## 4. The Recording artifact

A versioned, redactable JSON document — the single source of truth the rest of the pipeline consumes.

```ts
interface Recording {
  version: string;
  site: string;
  startedAtIso: string;
  intent?: string;                // pre-recording natural language: "what I'm about to do"
  retro?: string;                 // post-recording natural language: "how it went"
  pages: PageSegment[];           // journey split at navigations/page boundaries
  timingSummary: TimingSummary;   // derived cadence stats (feeds InteractionPolicy)
}
interface PageSegment { url: string; title?: string; steps: RecordedStep[] }
interface RecordedStep {
  index: number;
  kind: "navigate" | "click" | "fill" | "select" | "press" | "assert" | "read";
  target?: TargetDescriptor;      // role/name/label/testid/text + a generated locator
  value?: RedactedValue;          // typed text etc., redacted by default
  timing: { atMs: number; durationMs: number; gapBeforeMs: number };
  label?: string;                 // human narration / name
  marker?: "narration" | "checkpoint";
  variableName?: string;          // set when promoted to a parameter
  enumerationId?: string;         // set when part of a detected repeated block
}
interface TargetDescriptor { role?: string; name?: string; label?: string; testId?: string; text?: string; locator: string; frameUrl?: string }
interface RedactedValue { redacted: true; length: number; sample?: string /* only if user opts in */ } | { redacted: false; value: string }
```

`TargetDescriptor.locator` is Playwright's generated role/label selector (our `Target` shape). Same element across takes should resolve to the same descriptor (aids alignment).

## 5. The recorder (hybrid)

- Drives a **headed** session through the existing `BrowserPort` in the **authoring profile**; injects an in-page event listener (via `addInitScript` + CDP) that, per user action, records the semantic `TargetDescriptor` (using Playwright's selector generation), the action kind, the (redacted) value, and precise timestamps.
- **Page boundaries** split the journey into `PageSegment`s (on navigation/URL change).
- **Narration/checkpoint markers**: a hotkey/console command drops a `marker` inline (a note, or a checkpoint the interpreter can later replay-to).
- **Start-from-state**: the recorder can attach to an already-open session (e.g. one the interpreter paused at a checkpoint) and capture a **delimited supplemental segment** for splicing (§7).
- **Never captures**: password inputs / fields marked sensitive / the login sequence.

## 6. Multiple recordings & variable inference

- The user records the **same journey 1–3 times**. For a constant single-shot task, one recording suffices. For variable tasks, 2–3 takes with *different* values.
- A deterministic **trace aligner** matches steps across takes by step signature (kind + target descriptor + page), tolerating minor path differences via sequence alignment (edit-distance on signatures).
- **Classification** from the aligned traces:
  - **Constant** — value identical across all takes → fixed in the artifact.
  - **Variable candidate** — value differs across takes at an aligned step → a parameter slot.
  - **Enumeration candidate** — a sub-sequence repeats within a take (per list row) → a loop over an extracted list.
  - **Incidental/noise** — differs but looks like a session id/timestamp → flagged low-confidence, resolved by user/LLM.
- The diff is a *proposal*; the human confirms in review and/or the LLM interviews to name and type each variable.

## 7. "Postdoc" — review & interactive authoring

The post-recording workspace (CLI/TUI + LLM conversation) turns the merged, annotated trace into chunked, generalized, tested actions. **Careful and staged; nothing irreversible.**

0. **Natural-language framing:** before recording the user types an **intent** ("what I'm about to do"); after, a **retro** ("how it went" — what was tricky, what varied, what to watch). Both are stored on the `Recording` and given to the LLM as first-class context for chunking, naming variables/enumerations, and explaining failures — cheap human signal that sharpens the breakdown.
1. **Review (LLM-free):** walk the merged trace — rename/label steps, **combine/merge** consecutive low-level steps into a named higher-level chunk (a Screenplay Task/Action), confirm the diff's variable/enumeration proposals, redact values, drop steps.
2. **Chunk per page → actions:** segment the journey into a **series** of Screenplay actions (one or more per page), composed into a workflow.
3. **Staged LLM conversation** (needs M3 gateway): the LLM ingests the redacted, annotated trace + variable/enumeration candidates and proposes, one chunk at a time: chunk boundaries, parameter **templates** (e.g. a message-body template, a recipient drawn from an enumerated list, a detail **extracted** from a row), and loops. **Each proposal is transpiled → typechecked → dry-run (writes disabled) against the recording/fixture → you approve** before continuing to the next chunk.
4. **Replay-to-point + record-a-patch:** when a chunk is ambiguous or under-determined, the **interpreter replays the recording up to that checkpoint**, pausing at the live browser state; the human **records a small supplemental segment** from there (§5 start-from-state), which is **spliced** into the trace at that position (insert/replace, with re-alignment). Then authoring resumes. This lets you clarify with small recordings instead of redoing the journey.
5. **Iterate** chunk-by-chunk until the whole journey is chunked, parameterized, and each piece dry-run-approved.

## 8. Chunking & transpilation

- **Deterministic literal transpile (LLM-free):** a recording (or a confirmed chunk) compiles directly to Screenplay TypeScript — `Target`s from the descriptors, `Interaction`s from the steps, grouped into a `Task`/`Action`. The constant single-shot case needs no LLM at all.
- **LLM generalization:** variables/templates/enumeration become typed action inputs and loops layered onto the literal transpile.
- **Authoring interpreter:** a data-driven runtime replays a `Recording` (and replays-to-a-checkpoint) for dry-runs and golden tests — authoring-only, never production.
- **Production:** the transpiled, bundled, content-addressed, **approved** artifacts run through the normal Screenplay runner (CONOPS §5.7). The workflow composes the per-page actions.

## 9. Humanization integration (reuses M2.5)

- The recording's `timingSummary` is **fit to an `InteractionPolicy`** (mean chars/sec, per-key jitter, word/sentence pauses, think-time, reading dwell) — measured, not guessed — and attached to the generated actions as the site's default policy.
- **On by default; `--fast`/`humanize:false` disables it** (instant `fill()`, no delays).
- **Delay-safety testing (explicit user concern):** the build/dry-run validates that injected delays don't race the site — every wait remains gated on a Playwright actionability/state assertion, never a bare sleep — and the LLM/tests flag any step where a delay could break the flow. Approved before the final artifact.

## 10. Gates & activation

Recording → literal transpile / LLM generalization → **build → typecheck → unit + golden-replay tests (replay the recording as the fixture) → headed dry-run (writes disabled) → semantic diff → human approval → content-hash + activate** (CONOPS §5.7/§6.4). Recordings and candidate artifacts are quarantined until approved; activation is atomic by content hash; rollback available.

## 11. Storage / data model

- A **recordings store** (redacted `Recording` JSON, retention-limited, access-controlled — CONOPS §9) keyed by site + capture session.
- Candidate artifacts + their provenance (which recording(s), diff results, approvals) tracked like other `action_version` candidates.
- Raw screenshots/snapshots kept short-term and redacted; structured recordings kept longer.

## 12. Phasing

- **Phase A — LLM-free RxD core (buildable on M2 + M2.5):** recorder + `Recording` artifact + multi-trace aligner/differ + CLI/TUI review (merge/label/confirm/redact) + deterministic literal transpiler + authoring interpreter (incl. replay-to-checkpoint) + patch-recording/splice + humanization fit + golden-replay tests + gates. Delivers real value immediately: record → confirm → literal compiled action, human-paced, no LLM.
- **Phase B — LLM generalization (needs M3 model gateway):** the staged conversation for variable naming/typing, templates, enumeration/extraction, and chunk suggestions — layered on Phase A's artifact and validation loop.

## 13. Honest hard parts / risks

- **Trace alignment** across slightly different takes (extra scroll, reordering) — needs robust sequence alignment on step signatures; the interesting engineering.
- **Variable vs incidental** — a differing value may be a real parameter or noise (session id/timestamp); resolved by diff confidence + user/LLM confirmation, not assumed.
- **Enumeration/extraction detection** — recognizing "repeated sub-sequence per row" and "extract this detail from a row"; pattern detection + confirmation.
- **Locator durability** — generated locators can be fragile (dynamic ids, shadow DOM, canvas); the recording is a strong *starting* locator, hardened by the tested build step and repairable later (CONOPS §6.5).
- **Delay safety** — humanized delays must not introduce races; enforced by keeping waits on actionability + explicit testing/approval.
- **Splice re-alignment** — inserting a patch segment must re-index/re-align cleanly; the aligner must be idempotent over splices.

## 14. Testing strategy

- **Deterministic core:** aligner/differ (known takes → known constants/variables/enumerations), literal transpiler (recording → expected Screenplay code), timing fit (recording → expected `InteractionPolicy` within tolerance), interpreter replay incl. replay-to-checkpoint, splice re-alignment.
- **Against the fixture:** record a journey on `apps/example-site`, transpile, and golden-replay it headless; assert the generated action reproduces the outcome; assert `--fast` vs humanized both succeed and differ in timing.
- **Redaction:** values/snapshots are redacted by default; secrets/login never captured (asserted).
- **Phase B (LLM):** parameterization proposals are always transpiled + dry-run + gated; model output is untrusted until validated.

## 15. Self-review

- **Guardrails preserved:** authoring-plane only; production = compiled/approved; secrets never recorded; redaction before LLM; not evasion; timing never replaces postconditions. ✅
- **Captures all brainstormed requirements:** hybrid recorder; 1 vs 2–3 recordings for constant vs variable; per-page chunking into multiple actions; staged, approved LLM chunk-and-test conversation; variables/templates/enumeration/extraction; **step merging**; **replay-to-point + record-a-patch splice**; humanize default + toggle; delay-safety testing; most-deterministic projection. ✅
- **Buildable path:** Phase A is entirely LLM-free and rests on shipped M2 + designed M2.5; Phase B cleanly layers on the M3 gateway. ✅
- **Ambiguity bounded:** generalization is always a *proposal* validated by transpile + dry-run + human approval — the system never silently guesses a variable into production.

## 16. Open decisions (for the plan stage)

- Exact **trace-alignment algorithm** and signature/confidence thresholds.
- **Recording transport**: reuse `PlaywrightBrowserPort` with an added record mode vs a dedicated authoring adapter.
- **Interpreter vs transpiler reuse**: how much the authoring interpreter and the transpiled output share (a common step-execution core).
- Whether **Phase A** ships as its own milestone before or alongside **M3** (writes), given both want parts of the authoring pipeline.
