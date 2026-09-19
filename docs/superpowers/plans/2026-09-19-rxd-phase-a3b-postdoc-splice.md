# RxD Phase A.3b — Postdoc, Patch/Splice & Trustworthy Signature — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Finish the human-facing RxD Phase A: a **postdoc** review that turns recorded take(s) + the A.3a diff into a parameterized action (per-value **constant / variable / human-only** decision, labeling, chunk-merging, redaction); **record-a-patch + splice** for incremental fixes; and a **strict two-tier signature** (+ `TargetDescriptor` ordinal/container) so `diffRecordings` can tell same-role/different-target clicks apart (a self-healing prerequisite).

**Why:** A.3a made recordings parameterizable/replayable programmatically; A.3b puts a human in the loop to confirm variables and constants, splice in fixes, and hardens the divergence signal self-healing depends on.

**Scope & deferrals:** Enumeration auto-detection and per-keystroke-timing capture + richer `fit` are **deferred to A.3c** (independent enhancements; per-keystroke needs a recorder/schema change). A.3b supports **manually** marking an enumeration in the postdoc.

**Architecture:** All decision logic is a **pure `postdoc` module** in `@doit/recording` (operates on the A.3a `AuthoringRecording` + `DiffResult` + a `PostdocDecision[]` → a parameterized `Recording`); a thin **clack TUI** shell drives it, with a non-interactive `--decisions <file>` mode so the logic is fully testable. Splice + signature work extend the existing pure modules.

**Tech Stack:** builds on RxD A.1/A.2/A.3a. Adds `@clack/prompts` to `@doit/cli`. zod, Vitest.

**Spec:** RxD design (`2026-09-17-record-by-demonstration-design.md`) §5c, §6/§6a, §7 (postdoc), §8b. Guardrails binding.

## Global Constraints
- Node 20+, ESM, strict TS refs; inward deps. Closed schema; fail-closed; secrets never captured.
- **Constant-vs-variable ruling (binding):** a fill/select value **identical across all takes and non-sensitive** MAY be materialized as a literal constant (only via an explicit postdoc decision); a value that **varies** → variable; a **secret/PII** value → NEVER materialized (variable or `human-only` handback). Redaction-by-default holds: nothing is materialized without an explicit decision, and a secret can never be materialized (enforced + tested).
- **Authoring values stay local** (A.3a): the postdoc reads `AuthoringRecording.values` locally; the produced artifact carries only variable names + explicitly-kept non-secret constants + redacted values — never secrets, never sent to a model.
- Pure logic is deterministic + exact-value tested; the TUI shell is thin and driven through the same tested functions (non-interactive `--decisions` mode).
- New dep → stage `pnpm-lock.yaml`; explicit-path staging (never `git add -A`; graft `.gitignore`/`.ignore` stay out). Commit trailer: blank line then EXACTLY `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.
- Keep the suite green: `pnpm -r build && pnpm test && pnpm lint`.

---

### Task 1: `TargetDescriptor` ordinal/container + recorder populates it

**Files:** modify `packages/recording/src/schema.ts` (+test); `packages/recorder/src/descriptor.ts` (+test).

**Produces:** `TargetDescriptor` gains optional `ordinal?: number` (0-based index among same-signature siblings) and `container?: TargetDescriptor` (a nearest stable ancestor descriptor). The recorder populates `ordinal` when role+name+label+text+testId don't uniquely resolve (i.e. it fell to nth-match), recording which match it was. Backward compatible (both optional).
- [ ] Steps: failing test (schema accepts ordinal/container; recorder, given two identical `<button>OK</button>`, records `ordinal:0`/`1` for the one clicked) → verify fail → implement → verify + build → commit `feat(recording,recorder): TargetDescriptor ordinal/container`.

---

### Task 2: Strict two-tier signature + `diffRecordings` fix

**Files:** modify `packages/recording/src/signature.ts` (+test), `packages/recording/src/reference-diff.ts` (+test).

**Produces:** keep `stepSignature` (structural, value/name-independent — used for **alignment**); add `strictSignature(step, url)` that ALSO includes accessible `name`/`text` and `ordinal` (used for **divergence detection**). `diffRecordings(run, reference)` aligns on `stepSignature` but reports a column as `kind:"changed"` when the aligned cells' **strict** signatures differ — so "clicked a structurally-identical but wrong same-role control" is now detected (closes A.3a gap 3).
- [ ] Steps: failing test (two runs that click different same-role/different-name buttons at the same position → `diffRecordings` returns `divergedAt` with `kind:"changed"`, where A.3a returned `null`; identical runs still `null`) → verify fail → implement → verify → commit `fix(recording): strict two-tier signature so diffRecordings catches same-role divergence`.

---

### Task 3: `spliceRecording` (insert/replace + re-align)

**Files:** Create `packages/recording/src/splice.ts`, `splice.test.ts`; modify `index.ts`.

**Produces:** `spliceRecording(base: Recording, at: { page: number; step: number }, segment: Recording, mode: "insert" | "replace-from"): Recording` — inserts `segment`'s steps at the checkpoint (`insert`) or replaces everything from `at` onward with `segment` (`replace-from`), re-computing page segmentation and step indices. Idempotent shape (re-splicing a well-formed result stays valid). Pure; returns a schema-valid Recording.
- [ ] Steps: failing test (insert a 2-step segment mid-recording → indices/pages re-flow, validates; replace-from truncates then appends; result parses `RecordingSchema`) → verify fail → implement → verify → commit `feat(recording): spliceRecording insert/replace with re-alignment`.

---

### Task 4: Record-a-patch orchestration (replay-to-checkpoint → capture → splice)

**Files:** Create `packages/recorder/src/patch.ts`, `patch.test.ts` (real browser); devDeps as needed.

**Produces:** `recordPatch({ base, checkpoint, browser, … }): Promise<Recording>` — uses the A.1 interpreter `runToCheckpoint(base, checkpoint)` to drive to the live state, attaches the recorder (start-from-state, A.2 §5c) to capture a delimited supplemental segment, then `spliceRecording(base, checkpoint, segment, "insert")`. Returns the spliced Recording.
- [ ] Steps: failing test (real browser on the fixture: replay base to a checkpoint, record a small extra action, splice → the combined recording interprets end-to-end) → verify fail → implement (read fixture markup) → verify + full suite → commit `feat(recorder): record-a-patch via replay-to-checkpoint + splice`.

---

### Task 5: Postdoc decisions module (pure)

**Files:** Create `packages/recording/src/postdoc.ts`, `postdoc.test.ts`; modify `index.ts`.

**Produces:** `type PostdocDecision = { step: StepRef } & ({ classify: "constant" } | { classify: "variable"; name: string } | { classify: "handback"; prompt: string }) & { label?: string; chunk?: string }`; `applyPostdoc(authoring: AuthoringRecording, diff: DiffResult, decisions: PostdocDecision[]): Recording` — produces the parameterized action: `variable` → `{var}` (A.3a `promoteToVariable`); `constant` → materialize the local authoring value as a literal **iff non-secret** (else throw — see Task 6); `handback` → convert to a `handback` step; apply labels/chunk names. Unlisted fill/select steps default to redacted-variable-suggested-or-left-redacted per the diff (never silently materialized). Pure.
- [ ] Steps: failing tests (a `variable` decision yields `{var}`; a `constant` decision on a non-secret value materializes the literal; labels/chunks applied; an unlisted step is not materialized) → verify fail → implement → verify → commit `feat(recording): postdoc decisions → parameterized action`.

---

### Task 6: Secret-materialization guard (binding ruling)

**Files:** modify `packages/recording/src/postdoc.ts` (+test).

**Produces:** `applyPostdoc` throws `SecretMaterializationError` if a `constant` decision targets a step whose authoring value is absent (secret fields carry no authoring value) or is flagged sensitive — a secret can NEVER become a literal constant. Also: a value that varied across takes cannot be silently materialized as a constant (require the decision to acknowledge it).
- [ ] Steps: failing test (a `constant` decision on a secret/handback step throws `SecretMaterializationError`; a `constant` on a non-secret constant value succeeds) → verify fail → implement → verify → commit `feat(recording): forbid materializing secret values as constants`.

---

### Task 7: Postdoc TUI (clack shell) + non-interactive decisions mode

**Files:** modify `packages/cli/src/program.ts` (+test), `bin.ts`, `package.json` (dep `@clack/prompts`, `@doit/recording`, `@doit/recorder`).

**Produces:** `brauto recording postdoc <take.json> [<take2.json> …] [--decisions <file>] [--out <file>]` — loads the local `AuthoringRecording` take(s), runs `diffTakes` (A.3a), and EITHER (interactive) walks the steps with `@clack/prompts` — showing each diff proposal and prompting per-step constant/variable/handback + optional label/chunk — OR (non-interactive, `--decisions <file>`) reads a `PostdocDecision[]` JSON. Then `applyPostdoc` → writes the parameterized action to `--out`. The clack UI is a thin adapter; ALL logic is `diffTakes`/`applyPostdoc` (tested in Tasks 5–6).
- [ ] Steps: failing test — the **non-interactive** path: given take file(s) + a decisions file, `postdoc` writes the expected parameterized action (assert the output recording matches). (Interactive prompting is a thin shell; test the decisions path, not the TTY.) → verify fail → implement → verify + built-binary smoke → commit `feat(cli): postdoc review (clack TUI + --decisions mode)` (stage lockfile).

---

### Task 8: A.3b exit gate
- [ ] `pnpm -r build` (no cycle) → `pnpm test` (all green incl. real-browser patch test) → `pnpm lint`; confirm the secret-materialization guard holds and no authoring value/secret reaches a persisted artifact except an explicitly-decided non-secret constant. Commit only if config changed: `chore(rxd-a3b): exit gate green`.

---

## Self-Review
**Spec coverage (RxD §5c/§6a/§7/§8b + A.3a gap 3 + constant-vs-variable):** ordinal/container → T1; strict two-tier signature fixing `diffRecordings` → T2; splice → T3; record-a-patch → T4; postdoc decisions (constant/variable/handback, label, chunk) → T5; secret-materialization guard → T6; postdoc TUI + testable decisions mode → T7. ✅
**Deferred to A.3c (not gaps):** enumeration **auto**-detection (postdoc supports manual marking); per-keystroke timing capture + richer `fit` (word/sentence/hesitation/reading) — needs a recorder/schema change. Also carried: escalation-C (`computeDescriptor` reference-impl role) and LLM-mediated confirmation of *ambiguous* columns (Phase B).
**Placeholders:** none — pure functions have concrete signatures + exact-value tests; the TUI's untestable TTY layer is deliberately thin over tested logic.
**Type consistency:** `TargetDescriptor(+ordinal/container)`, `stepSignature`/`strictSignature`, `diffRecordings`, `spliceRecording`, `recordPatch`, `PostdocDecision`/`applyPostdoc`, `SecretMaterializationError` defined once, reused.
**Risks for the pre-flight scan:** (1) **secret-materialization guard is the load-bearing safety check** — any path that materializes a secret/absent value as a constant is Critical (T6 asserts). (2) TUI is hard to TDD — keep ALL logic in `applyPostdoc`/`diffTakes` (pure, tested) and the clack layer a thin adapter tested via `--decisions`. (3) `spliceRecording` re-alignment must keep the result schema-valid and interpretable (T4's real-browser test is the end-to-end proof). (4) `strictSignature` must not break alignment (alignment still uses the structural `stepSignature`; only divergence uses strict).

## Note on sequencing
Per the user's direction, **M3a (model gateway) runs next, after A.3b's gate is green** — the controller for M3a is dispatched separately (serial on `main`, never concurrent, to avoid root-config/lockfile collisions).
