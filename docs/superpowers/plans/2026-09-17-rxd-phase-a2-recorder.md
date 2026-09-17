# RxD Phase A.2 — Recorder + Always-On Recording + Retention — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Capture a real human demonstration into the A.1 `Recording` artifact (durable semantic `TargetDescriptor`s, timing, redacted values, auto-inserted postconditions), make **automated runs record themselves in the same format** (apples-to-apples), and add a **retention/GC lifecycle** (success-prune, failure-retain, TTL) — proven by a Playwright-driven **capture → Recording → interpret round-trip** on the fixture.

**Architecture:** A new `@doit/recorder` drives a headed `BrowserSession` (M2's BrowserPort): an injected in-page listener temp-tags each acted element and reports events via `page.exposeBinding`; Node computes + validates a `TargetDescriptor` against the real element handle using the selector ladder (so it resolves the way Playwright will). The A.1 interpreter gains an optional `RecordingSink` so an automated run emits its own `Recording`. A filesystem `RecordingStore` + a pure retention policy govern lifecycle. First close two A.1 gaps: the `select` primitive (design §8) and interpreter postcondition-retry / step-index-on-error.

**Tech Stack:** builds on M1+M2+M2.5+A.1. New package `@doit/recorder`. Playwright (via BrowserPort), zod, Vitest.

**Spec:** `docs/superpowers/specs/2026-09-17-record-by-demonstration-design.md` §4, §5, §5b, §5c (recorder mechanics), §8/§8b — authoritative; guardrails binding.

## Global Constraints
- Node 20+, ESM, strict TS project refs; inward deps. Closed schema (no arbitrary code); every acting step keeps a required postcondition; fail-closed.
- **Secrets never captured:** password / one-time-code / sensitive fields → record the action, redact the value, suggest `human-only`. **All fill values redacted by default.** Our own recorder UI/tags excluded from capture.
- **Redaction before persistence and before any LLM.** Recordings are redacted, access-controlled, size-capped, TTL-GC'd (CONOPS §9).
- `@doit/recorder` may use `playwright` + `@doit/recording` + `@doit/playwright` + `@doit/screenplay` (infra, not a domain/site module). `@doit/recording` stays a leaf.
- New package → vitest `pkg()` alias + root tsconfig ref; **stage `pnpm-lock.yaml`** on dep changes; explicit-path staging (never `git add -A`; graft artifacts stay out).
- Commit trailer: blank line then EXACTLY `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.
- Keep the suite green: `pnpm -r build && pnpm test && pnpm lint`. Playwright chromium is installed.

---

### Task 1: Close the vocabulary gap — `select` (+ `press`) primitives

**Files:** modify `packages/recording/src/schema.ts` (+test), `packages/interpreter/src/run-step.ts` (+test).

**Produces:** two new `Step` variants (design §8): `{ kind:"select"; label?; target; value: ValueOrVar; expect }` and `{ kind:"press"; label?; key: string; expect }`. Interpreter: `select` → resolve target, `locator.selectOption(value)`, then check `expect`; `press` → `locator`-less `page.keyboard.press(key)` (or the focused element), then `expect`. Both fail-closed on a false postcondition. A `select` with a redacted-constant value errors (same Poka-Yoke as `fill`).
- [ ] Step 1: failing tests (schema accepts select/press with `expect`, rejects without; interpreter selects an option / presses a key against a fake page and verifies the postcondition). Step 2: verify fail. Step 3: implement. Step 4: verify pass + build. Step 5: commit `feat(recording,interpreter): select and press primitives`.

---

### Task 2: Interpreter hardening — postcondition retry + step-index on error

**Files:** modify `packages/interpreter/src/assertion.ts`, `run-step.ts`, `interpreter.ts` (+tests).

**Produces:** `checkAssertion(actor, a, opts?: { timeoutMs?; pollMs? })` **polls** the assertion up to a bounded timeout (default 5000ms / 100ms) so async UI doesn't false-fail (web-first-assertion style) — but still **fails closed** when the timeout elapses. `PostconditionFailed` carries the step's global index. `RecordingInterpreter` wraps any thrown error so `InterpretResult.failed.at` is the correct global index for **all** error kinds (not only `PostconditionFailed`) — closing an A.1 deferred note.
- [ ] Step 1: failing tests (an assertion that becomes true after a delay passes within timeout; one that never becomes true fails closed after ~timeout; a non-`PostconditionFailed` throw still yields `failed{at:<correct index>}`). Step 2–4. Step 5: commit `fix(interpreter): bounded postcondition polling and accurate failure index`.

---

### Task 3: `@doit/recorder` — capture transport

**Files:** Create `packages/recorder/package.json`, `tsconfig.json`, `src/inject.ts` (the in-page listener source as a string/function), `src/recorder.ts`, `src/recorder.test.ts`, `src/index.ts`; modify root tsconfig + vitest.

**Produces:** a `Recorder` that, given a `BrowserSession` (from `@doit/playwright`), installs capture: `page.exposeBinding("__doitRecord", handler)` + `page.addInitScript(injectSource)`. The injected script (runs in every frame) listens for `click`, `input`/`change`, `keydown`, and form `submit`; on a user action it assigns the target a unique `data-doit-eid` and calls `window.__doitRecord({ eid, kind, tag, typeAttr, rawText, ts })` (values for password/otp fields are omitted in-page — never leave the browser). Navigation is captured Node-side via `page.on("framenavigated")`. Events buffer in Node with timestamps.
- [ ] Step 1: failing test — attach the recorder to a real headless session, `setContent` a small form, drive `locator.fill`/`click` via Playwright (which dispatches real DOM events), and assert the Node handler received the events with an `eid` and the right `kind` (no descriptor computation yet). Step 2: verify fail. Step 3: implement (package.json deps `@doit/playwright`,`@doit/recording`,`playwright`; the inject source as a stringified function; exposeBinding wiring; buffer). Step 4: verify pass + build. Step 5: commit `feat(recorder): in-page capture transport (addInitScript + exposeBinding)` (stage lockfile).

> Pre-flight risk: this is the highest-uncertainty task (in-page injection + event coverage). Use a standard/strong model; keep the injected script tiny and defensive (ignore events on elements marked `data-doit-recorder`/inside our overlay).

---

### Task 4: Recorder — Node-side descriptor computation + validation

**Files:** Create `packages/recorder/src/descriptor.ts`, `descriptor.test.ts`; modify `recorder.ts`.

**Produces:** `computeDescriptor(page, handle): Promise<{ descriptor: TargetDescriptor; stability: "high"|"medium"|"low"; alternates: TargetDescriptor[] }>`. Walk the ladder building candidates from the handle (evaluate to read: `data-testid`/`data-test` → testId; explicit `role` or tag→implicit-role + accessible-name approximation (`aria-label` ‖ trimmed text ‖ `alt` ‖ `title`) → role+name; associated `<label>` → label; visible text → text; a minimal CSS path → css). For each candidate, **build the locator and verify it uniquely resolves to THIS handle** (`count()===1` and the resolved element equals `handle`); pick the highest rung that passes. Stability: testId/role+name = high; label/text = medium; css or a generated-looking id = low (flag). Keep the passing lower rungs as `alternates` (for self-healing). Remove the temp `data-doit-eid` after computing.
- [ ] Step 1: failing tests against real DOM (headless): an element with `data-testid` → testId, high; a `<button>Send</button>` → role+name, high; an input with a `<label>Username` → label; an element with only a dynamic id → css/low with the id avoided; ambiguous (two identical buttons) → falls to a uniquely-resolving rung or css. Step 2–4. Step 5: commit `feat(recorder): descriptor computation validated against the handle`.

---

### Task 5: Recorder — assemble a redacted `Recording` (postconditions, pages, redaction)

**Files:** modify `packages/recorder/src/recorder.ts`, `recorder.test.ts`.

**Produces:** `Recorder.stop(): Promise<Recording>` that turns the buffered events into a schema-valid `Recording`: map each event → a `RecordedStep` (kind + computed descriptor + value); **redact fill values by default** (`{ redacted:true, length }`; password/otp fields carry no value and are marked for `human-only`); split into `PageSegment`s on navigation; attach per-step timing (`atMs`/`durationMs`/`gapBeforeMs`, and inter-keystroke intervals retained for A.3's fit); **auto-insert a postcondition** per acting step inferred from the observed change (URL changed → `urlIncludes`; a new element visible → `visible`; else a `visible` on the acted target). Validate the result through `RecordingSchema` before returning (fail if it doesn't). `Recorder.start(intent?)`/`stop(retro?)` carry the NL framing.
- [ ] Step 1: failing test — record a scripted 3-action sequence (navigate, fill a normal field, fill a password field, click) → assert the returned Recording parses `RecordingSchema`, the password value is absent/redacted and its step flagged, pages split on navigation, and every acting step has an `expect`. Step 2–4. Step 5: commit `feat(recorder): assemble redacted, self-verifying Recording`.

---

### Task 6: Golden round-trip — capture → Recording → interpret (A.2 exit criterion)

**Files:** Create `packages/recorder/src/round-trip.test.ts`; devDeps `@doit/example-site`, `@doit/interpreter`, `@doit/screenplay`.

**Produces:** the proof the recorder yields a re-executable artifact. Start `apps/example-site`; attach a `Recorder`; **drive** the login→inbox→open-thread journey with Playwright `locator` calls (dispatching real DOM events the recorder captures); `stop()` → a `Recording`; assert it validates and that the Sign-in button/inbox link chose **role+name (not css)**; then, in a fresh session, `new RecordingInterpreter().run(actor, recording)` and assert it reproduces (reaches the thread; an `extract` reads the message text). (Login username is a normal field here; the fixture has no real password — note that real auth would be `human-only`.)
- [ ] Step 1: failing test. Step 2: verify fail. Step 3: implement (read `apps/example-site/src/server.ts` for exact markup). Step 4: verify pass + full `pnpm test`. Step 5: commit `test(recorder): capture→Recording→interpret round-trip on the fixture` (stage lockfile).

---

### Task 7: Always-on recording — interpreter emits a run `Recording`

**Files:** modify `packages/interpreter/src/interpreter.ts` (+test); add `packages/interpreter/src/sink.ts`.

**Produces:** `interface RecordingSink { step(rec: RecordedStep): void }`; `RecordingInterpreter.run(actor, rec, vars?, sink?)` writes each executed step (with the actual resolved descriptor + measured timing) to the sink, so an **automated interpreter run yields a `Recording` in the same format as a human demo** (apples-to-apples). A `BufferingSink` collects into a `Recording`. (Instrumenting M2's code-based Screenplay actions to also emit steps is deferred to a follow-on; the interpreter path gives always-on recording for Recording-backed runs now.)
- [ ] Step 1: failing test — run a small recording through the interpreter with a `BufferingSink`; assert the emitted run-Recording has one step per executed step with resolved descriptors + timing and validates against `RecordingSchema`. Step 2–4. Step 5: commit `feat(interpreter): emit a run Recording via a RecordingSink`.

---

### Task 8: RecordingStore + retention lifecycle

**Files:** Create `packages/recording/src/store.ts`, `store.test.ts`, `src/retention.ts`, `retention.test.ts`; modify `packages/recording/src/index.ts`. (Filesystem store keeps `@doit/recording` leaf — Node fs only, no sqlite.)

**Produces:**
- `interface RecordingStore { put(id, rec): Promise<void>; get(id): Promise<Recording|null>; prune(id): Promise<void>; list(): Promise<{id,savedAtIso}[]>; gcOlderThan(iso): Promise<number> }` + `FsRecordingStore(dir)` writing redacted JSON, user-only perms, size-capped.
- Pure `applyRetention(outcome: "ok"|"failed", opts): RetentionAction` = `{ kind:"prune" } | { kind:"keep"; reason:"failure"|"human" }` — success → prune; failure → keep (attach fingerprint); human demo → keep until TTL. A background `gcOlderThan(now - ttl)` sweeps.
- [ ] Step 1: failing tests — put/get/prune round-trip; `applyRetention("ok",…)` → prune, `("failed",…)` → keep; `gcOlderThan` removes stale, keeps fresh. Step 2–4. Step 5: commit `feat(recording): filesystem recording store + retention policy`.

---

### Task 9: A.2 exit gate
- [ ] Step 1 `pnpm -r build` (no cycle). Step 2 `pnpm test` (all green incl. the real-browser round-trip). Step 3 `pnpm lint`; confirm `@doit/recording` still a leaf (no playwright), recorder redaction holds (grep the round-trip proves password value absent). Step 4 commit only if config changed: `chore(rxd-a2): exit gate green`.

---

## Self-Review
**Spec coverage (RxD §5/§5b/§5c):** select/press vocab (design §8) → T1; interpreter robustness (A.1 deferrals) → T2; capture transport → T3; durable descriptor validated against the handle + stability + alternates → T4; redacted self-verifying Recording (secrets excluded, auto-postconditions, pages) → T5; capture→interpret round-trip → T6; always-on run-recording (apples-to-apples) → T7; store + retention (success-prune/failure-retain/TTL) → T8. ✅
**Deferred to A.3 / later (not gaps):** multi-take **diff** + `diffRecordings` reference-localizer, patch/splice, **humanization fit** (derive `InteractionPolicy` from recorded timing), postdoc TUI; **running recordings as paced production actions through the runner** + instrumenting code-based Screenplay actions for always-on recording; closed-shadow/canvas capture (flag→human-only).
**Placeholders:** none — redaction, descriptor validation, retention are concrete.
**Type consistency:** reuses A.1's `TargetDescriptor`/`RecordedStep`/`Recording`/`RecordingSchema`/`RecordingInterpreter`; new `computeDescriptor`, `Recorder`, `RecordingSink`, `RecordingStore`, `applyRetention` defined once.
**Risks for the pre-flight scan:** (1) **Task 3/4 are the highest-uncertainty** (in-page injection + accessible-name approximation + uniqueness validation) — budget a standard/strong model and expect iteration; keep the injected script tiny. (2) Confirm `@doit/recorder` deps don't cycle (it's leafward: recorder → recording/playwright/screenplay). (3) Redaction must be provable — the round-trip test asserts no password value is persisted. (4) `computeDescriptor`'s "resolved element equals handle" check needs a reliable handle-equality (`page.evaluate` identity or `elementHandle()` comparison) — the trickiest correctness point; test with ambiguous elements.
