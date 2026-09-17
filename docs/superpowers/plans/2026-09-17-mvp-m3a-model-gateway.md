# M3a — Model Gateway (OpenRouter) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** A provider-neutral `ModelGateway` that runs typed model tasks (`reply.draft`, `message.draft`) with **schema-constrained structured output**, input redaction/minimization, per-task cost/token/timeout ceilings, recorded provenance (model/route/prompt-version/tokens/cost/response-hash), and **immutable content-addressed drafts** — with a **deterministic fake adapter** for CI and a real **OpenRouter** adapter (opt-in, env-gated). No model ever drives a browser or bypasses validation.

**Why now / independence:** this is decoupled from RxD A.2 (different packages, no shared code) and builds only on **stable** interfaces (M1 `contentHash`, zod). It unblocks M3b (drafting for controlled writes), RxD Phase B (LLM parameterization), and self-healing LLM repair — so it's the highest-leverage safe head start.

**Architecture:** `@doit/model-gateway` defines the port + typed task schemas + `ModelProfile` config. `FakeModelGateway` returns deterministic drafts (all CI tests use it). `OpenRouterModelGateway` uses the Vercel **AI SDK** (`ai`) + `@openrouter/ai-sdk-provider` `generateObject` with the task's zod output schema, re-validates locally (model output is untrusted), and records provenance. Inputs are redacted/minimized before any send; ceilings are enforced. Drafts are immutable + content-addressed.

**Tech Stack:** builds on M1 (`@doit/domain` `contentHash`). New package `@doit/model-gateway`. `ai`, `@openrouter/ai-sdk-provider`, `zod`, Vitest.

**Spec:** MVP design (`2026-09-16-browser-automation-mvp-design.md` §5 model gateway) + CONOPS §6.1–6.3 (provider-independent tasks, OpenRouter profiles, structured output) + §9.1 (model boundary, redaction). Guardrails binding.

## Global Constraints
- Node 20+, ESM, strict TS project refs; inward deps. `@doit/model-gateway` depends only on `@doit/domain` (for `contentHash`) + `ai`/`@openrouter/ai-sdk-provider`/`zod`. It must NOT import playwright/sqlite/kysely or the runner (models never touch the browser or the queue).
- **Model boundary (binding, CONOPS §9.1):** inputs are minimized + redacted before any network send; **credentials/browser-session material never leave**; the model cannot activate integrations, approve actions, alter settings, reserve budgets, choose recipients outside task inputs, or reach a browser.
- **Untrusted output:** structured output is re-validated locally with the task's zod schema; a validation failure is an error, not a silent pass.
- **Determinism in CI:** all automated tests use `FakeModelGateway`. The real OpenRouter path is exercised only by an **opt-in, env-gated** test (`OPENROUTER_API_KEY` + `RUN_OPENROUTER_TESTS=1`), never in the default suite.
- Drafts are **immutable + content-addressed** (`contentHash`); a produced draft is never mutated.
- New package → vitest `pkg()` alias + root tsconfig ref; **stage `pnpm-lock.yaml`**; explicit-path staging (never `git add -A`; graft artifacts stay out).
- Commit trailer: blank line then EXACTLY `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.
- Keep the suite green: `pnpm -r build && pnpm test && pnpm lint`.

---

### Task 1: `@doit/model-gateway` — typed task schemas + port

**Files:** Create `packages/model-gateway/package.json`, `tsconfig.json`, `src/tasks.ts`, `src/tasks.test.ts`, `src/port.ts`, `src/index.ts`; modify root tsconfig + vitest.

**Produces:**
```ts
// tasks.ts — closed set of typed model tasks (zod in + out)
export const ReplyDraftInput = z.object({
  thread: z.object({ subject: z.string(), messages: z.array(z.object({ sender: z.string(), text: z.string() })) }),
  contentProfile: z.string().optional(),
  maxChars: z.number().int().positive().max(4000).optional(),
});
export const ReplyDraftOutput = z.object({ body: z.string().min(1), rationale: z.string().optional() });
export const MessageDraftInput = z.object({ context: z.string(), contentProfile: z.string().optional() });
export const MessageDraftOutput = z.object({ body: z.string().min(1) });
export const TASKS = {
  "reply.draft": { input: ReplyDraftInput, output: ReplyDraftOutput, promptVersion: "1" },
  "message.draft": { input: MessageDraftInput, output: MessageDraftOutput, promptVersion: "1" },
} as const;
export type ModelTaskKind = keyof typeof TASKS;
export type TaskInput<K extends ModelTaskKind> = z.input<(typeof TASKS)[K]["input"]>;
export type TaskOutput<K extends ModelTaskKind> = z.output<(typeof TASKS)[K]["output"]>;
```
```ts
// port.ts
export interface ModelProfile {
  name: string;
  adapter: "openrouter" | "fake";
  models: string[];
  requiredCapabilities?: string[];
  temperature?: number;
  maxOutputTokens?: number;
  provider?: { dataCollection?: "deny" | "allow"; zdr?: boolean; allowFallbacks?: boolean };
  budget?: { maxCostUsdPerTask?: number };
  timeoutMs?: number;
}
export interface ModelRunProvenance { model: string; promptVersion: string; schemaVersion: string; tokensIn: number; tokensOut: number; costUsd: number; latencyMs: number; responseHash: string }
export interface ModelResult<K extends ModelTaskKind> { output: TaskOutput<K>; provenance: ModelRunProvenance }
export interface ModelGateway { runTask<K extends ModelTaskKind>(kind: K, input: TaskInput<K>, profile: ModelProfile): Promise<ModelResult<K>> }
export const ModelProfileSchema: import("zod").ZodType<ModelProfile>;
```
- [ ] Steps: failing test (a valid `reply.draft` input parses; missing `thread` rejected; `ModelProfileSchema` rejects a bad adapter) → verify fail → implement (package.json dep `zod`, `@doit/domain`) → verify pass + build → commit `feat(model-gateway): typed task schemas and gateway port` (stage lockfile).

---

### Task 2: Deterministic `FakeModelGateway`

**Files:** Create `packages/model-gateway/src/fake.ts`, `fake.test.ts`; modify `index.ts`.

**Produces:** `class FakeModelGateway implements ModelGateway` — deterministic: for `reply.draft` returns `{ body: "Re: "+thread.subject+" — thanks, noted." }` (or an injected template), truncated to `maxChars`; validates its own output against the task schema; provenance is fixed (`model:"fake"`, `costUsd:0`, `responseHash = contentHash(output)`). Same input → same output.
- [ ] Steps: failing test (two calls with equal input → equal output + equal responseHash; output validates against `ReplyDraftOutput`; honors `maxChars`) → implement → verify → commit `feat(model-gateway): deterministic fake adapter`.

---

### Task 3: Input redaction / minimization

**Files:** Create `packages/model-gateway/src/redact.ts`, `redact.test.ts`; modify `index.ts`.

**Produces:** `redactTaskInput<K>(kind: K, input: TaskInput<K>): TaskInput<K>` — minimizes context and strips obvious secrets/PII before any send (e.g., redact email addresses/phone/long digit runs in message text to placeholders unless the task needs them; cap message history length/size). A `assertNoSecrets(input)` that throws if a banned pattern (API key/token shapes) survives. Pure.
- [ ] Steps: failing test (an input containing an `sk-…`/token-looking string throws via `assertNoSecrets`; emails in thread text are redacted; history is capped) → implement → verify → commit `feat(model-gateway): input redaction and minimization`.

> Note: redaction here is defense-in-depth for the *gateway*; callers still pass only task-appropriate, already-minimized context. Keep the redactor conservative (never over-strip the actual content the draft needs — cap/placeholder, don't drop the subject/body being replied to).

---

### Task 4: Ceilings — cost / tokens / timeout wrapper

**Files:** Create `packages/model-gateway/src/ceilings.ts`, `ceilings.test.ts`; modify `index.ts`.

**Produces:** helpers the adapters use: `withTimeout(promise, ms)` (aborts + throws `ModelTimeoutError`); `enforceBudget(costUsd, profile)` (throws `ModelBudgetExceeded` if `> maxCostUsdPerTask`); `capMaxTokens(profile)` → the value passed to the model. Pure/thin.
- [ ] Steps: failing test (a never-resolving promise rejects with `ModelTimeoutError` after the timeout using a fake timer; `enforceBudget(3, {budget:{maxCostUsdPerTask:2}})` throws) → implement → verify → commit `feat(model-gateway): cost/token/timeout ceilings`.

---

### Task 5: Draft immutability + content addressing

**Files:** Create `packages/model-gateway/src/draft.ts`, `draft.test.ts`; modify `index.ts`.

**Produces:** `interface Draft<K> { id: string; taskKind: K; contentHash: string; output: TaskOutput<K>; provenance: ModelRunProvenance; createdAtIso: string }`; `makeDraft(kind, result, clock): Draft` freezing the output (`Object.freeze` deep) and setting `contentHash = contentHash(result.output)` (reuse `@doit/domain`). `draftsMatch(a,b)` compares content hashes. Immutable — no setter.
- [ ] Steps: failing test (two drafts from equal output share `contentHash`; the frozen output can't be mutated; `id` unique) → implement → verify → commit `feat(model-gateway): immutable content-addressed drafts`.

---

### Task 6: OpenRouter adapter (via AI SDK)

**Files:** Create `packages/model-gateway/src/openrouter.ts`, `openrouter.test.ts` (unit, mocked), modify `index.ts`, `package.json` (deps `ai`, `@openrouter/ai-sdk-provider`).

**Produces:** `class OpenRouterModelGateway implements ModelGateway` using the AI SDK's `generateObject({ model, schema: TASKS[kind].output, prompt, temperature, maxTokens })` with the `@openrouter/ai-sdk-provider` model, provider options set from `profile.provider` (data-collection deny, zdr, fallbacks) and the allowlisted `profile.models`. It: redacts input (Task 3) → builds the task prompt (a small per-task prompt template) → `withTimeout`/token cap (Task 4) → `generateObject` → **re-validate** the returned object with the task's zod schema locally → `enforceBudget` on the reported cost → return `{ output, provenance }` (provenance from the SDK usage + `responseHash = contentHash(output)`). Key from `process.env.OPENROUTER_API_KEY` (throw a clear error if absent when this adapter is used).
- [ ] Step 1: failing **unit** test with the AI SDK **mocked** (inject a fake `generateObject` via a constructor seam / dependency) returning a canned object → assert the adapter redacts, re-validates, records provenance, and enforces the budget; a returned object that fails the schema → throws. **Do NOT hit the network in this test.**
- [ ] Step 2–4: implement (put the `generateObject` call behind an injectable function so the unit test mocks it and production uses the real AI SDK); verify pass + build.
- [ ] Step 5: commit `feat(model-gateway): OpenRouter adapter via AI SDK with local re-validation` (stage lockfile).

> Pre-flight risk: pin `ai` + `@openrouter/ai-sdk-provider` versions and confirm the `generateObject` signature against the installed version (the SDK API shifts across majors). Keep the real call behind one injectable seam so tests never need the network.

---

### Task 7: Model profiles resolution

**Files:** Create `packages/model-gateway/src/profiles.ts`, `profiles.test.ts`; modify `index.ts`.

**Produces:** `resolveProfile(taskKind, profiles: Record<string, ModelProfile>, selection: Record<ModelTaskKind, string>): ModelProfile` (select a profile by task kind from a config map; validate via `ModelProfileSchema`; throw on unknown). A `GatewayRouter` that, given a resolved profile's `adapter`, dispatches to `FakeModelGateway` or `OpenRouterModelGateway` — so callers depend only on `ModelGateway` + a profile.
- [ ] Steps: failing test (selection maps `reply.draft`→"content-default"; router with adapter "fake" returns the fake's output; adapter "openrouter" without a key surfaces the clear error) → implement → verify → commit `feat(model-gateway): profile resolution and adapter router`.

---

### Task 8: CLI — model profile + test

**Files:** modify `packages/cli/src/program.ts` (+test), `bin.ts`, `package.json` (dep `@doit/model-gateway`).

**Produces:** `brauto model profile list [--json]` (lists configured profiles), `brauto model profile validate <name>` (via `ModelProfileSchema`), `brauto model test <task> --input <json> [--profile <name>] [--real]` — runs the task through the gateway; **defaults to the fake adapter** (deterministic, no key); `--real` uses OpenRouter (requires `OPENROUTER_API_KEY`). Versioned JSON envelope + exit codes (M1 pattern).
- [ ] Steps: failing test (`model test reply.draft --input …` prints a draft envelope using the fake; `model profile validate` rejects a bad profile) → implement → verify + built-binary smoke → commit `feat(cli): model profile and model test commands` (stage lockfile).

---

### Task 9: Opt-in real-OpenRouter integration test

**Files:** Create `packages/model-gateway/src/openrouter.integration.test.ts`.

**Produces:** a test gated on `RUN_OPENROUTER_TESTS=1 && OPENROUTER_API_KEY` (otherwise `test.skip`) that runs a real `reply.draft` against a cheap allowlisted model and asserts the output validates + provenance is populated + cost within the ceiling. Never runs in the default CI suite.
- [ ] Steps: write the gated test; verify it **skips** cleanly when the env isn't set (so `pnpm test` stays green without a key); commit `test(model-gateway): opt-in real OpenRouter integration (env-gated)`.

---

### Task 10: M3a exit gate
- [ ] `pnpm -r build` (no cycle) → `pnpm test` (all green; real-OpenRouter test skipped) → `pnpm lint`; confirm `@doit/model-gateway` imports no playwright/sqlite/kysely/runner (grep) and the redactor/`assertNoSecrets` are wired into the OpenRouter path. Commit only if config changed: `chore(m3a): exit gate green`.

---

## Self-Review
**Spec coverage (MVP §5 / CONOPS §6.1–6.3, §9.1):** typed task model + port → T1; deterministic fake → T2; redaction/minimization + no-secrets → T3; cost/token/timeout ceilings → T4; immutable content-addressed drafts → T5; OpenRouter structured output + local re-validation + provenance → T6; profile resolution/routing → T7; CLI → T8; opt-in real test → T9. ✅
**Deferred to M3b (not gaps):** the **controlled write path** (see outline) and DB-backed model-profile storage (M3a uses a config map; wiring profiles into `site_setting` folds into M3b/settings).
**Placeholders:** none — schemas, adapters, ceilings, redaction are concrete; the OpenRouter call sits behind one injectable seam so tests are network-free.
**Type consistency:** `ModelTaskKind`/`TaskInput`/`TaskOutput`, `ModelProfile`/`ModelRunProvenance`/`ModelResult`, `ModelGateway`, `FakeModelGateway`/`OpenRouterModelGateway`, `redactTaskInput`/`assertNoSecrets`, `Draft`/`makeDraft`, `resolveProfile`/`GatewayRouter` defined once, reused across tasks.
**Risks for the pre-flight scan:** (1) AI SDK / OpenRouter provider **version drift** — pin versions, confirm `generateObject` signature, keep the real call behind an injectable seam (tests never hit the network). (2) The default `pnpm test` MUST stay green with no key — the real test must `skip` cleanly (T9). (3) Redactor must not over-strip the content the draft needs (cap/placeholder, never drop the subject/body).

## Outline — M3b (Controlled Writes) — next plan
- **Fixture write capability:** extend `apps/example-site` with a compose/reply → send flow (a thread gets a new message), so an external-write action has something to drive.
- **ExternalWriteAction (CONOPS §5.3/§5.4):** `prepare(actor,input) → PreparedCommit` (open thread, verify recipient/target, render final preview, bind content hash), `commit(actor,input,approval) → SendReceipt` (re-verify recipient/target/content + approval, single Send interaction, assert `SentMessage.exists`), `reconcile(actor,input) → ReconciliationResult`. Implement `message.reply` with **mandatory approval**.
- **Approval store + flow:** SQLite `approval` table + repository; `brauto approval list/approve/deny` (M1 CLI stubs) showing the bound recipient/target/content/artifact/settings/expiry; approval binds the exact content hash + expiry (M1 `approval.ts` domain).
- **Runner two-phase integration:** the runner drives prepare → (gate: policy `require_approval`, budget reserve via M2.5, quiet-hours/min-interval) → await approval → commit, with **no model call between approval and commit** (FR-024), idempotency key, and `reconciling` on unknown outcome (never blind-retry). Command state machine states `awaiting_approval`/`reconciling` (M1).
- **Drafting wired to writes:** `message.draft`/`reply.draft` (this gateway) produces an immutable draft; the deterministic `message.reply` commit consumes the **approved** content; no model call after approval (FR-030).
- **MCP facade handlers:** wire `queue_action`/`approve_action` bodies to the queue/approval store (M1 allowlist already enforces the boundary).
- **Exit criterion:** fault-injection proves no duplicate send (crash-after-Send → reconcile, never re-Send); approval-expired/content-changed invalidate; write budget denies past the cap.
