# Browser Automation Platform — MVP Implementation Design

**Status:** Approved for planning
**Date:** 2026-09-16
**Scope:** MVP = Phases 1–3 of the CONOPS delivery plan
**Companion spec:** [`Browser_Automation_CONOPS_and_Functional_Specification.md`](../../../Browser_Automation_CONOPS_and_Functional_Specification.md) (v0.4)
**Architecture rationale:** [`approach.md`](../../../approach.md)

This document pins the concrete *realization* of the MVP: toolchain, the package
subset the MVP needs, third-party libraries, the local fixture target, and the
test strategy. It does **not** restate the architecture, functional requirements,
or data model — those live in the CONOPS and are authoritative. Where this
document and the CONOPS could conflict, the CONOPS wins on *what* the system must
do; this document governs *how* the MVP is built.

---

## 1. MVP boundary

Deliver the CONOPS "Recommended MVP boundary": one local user, one dedicated
production browser profile, and these registered actions against a single
example site:

- `session.status`
- `inbox.list`
- `thread.get`
- `message.draft`
- `message.reply` (approval mandatory)

Mapped to the CONOPS delivery plan, the MVP is **Phases 1–3** (Foundation,
Screenplay runtime, Controlled writes), with the **model gateway pulled forward**
from Phase 5 so `message.draft` is a real LLM call.

### Decisions taken during design

| Decision | Choice | Rationale |
|---|---|---|
| Depth of this build | Full MVP (Phases 1–3) | Agreed with owner. |
| Toolchain | pnpm workspaces · TypeScript project references · Vitest · zod | Strict TS monorepo baseline. |
| Automation target | **Local fixture site** (`apps/example-site`) | Zero terms/authorization risk; deterministic golden-fixture + headed-dry-run target the CONOPS test strategy assumes. |
| `message.draft` drafting | **Real OpenRouter** via the Vercel AI SDK, with a deterministic fake adapter for tests | Owner wants real drafting; fake adapter keeps CI keyless and free. |
| Build vs. buy | Buy commodity infrastructure; build only the domain/security glue | Hand-rolling an LLM client, arg parser, or SQL driver adds risk with no upside; the policy engine, approval binding, runner, and boundary *are* the product. |

### Explicitly deferred (out of MVP)

- YAML composition engine (CONOPS §5.6, Phase 4) — reads/writes are driven
  per-command via CLI/MCP in the MVP; `inbox.process-unread` does not exist yet.
- Authoring builder, bounded repair, and the restricted Playwright MCP (Phase 6).
- Integration signing and a curated registry (local trust only).
- Multi-user / multi-account orchestration and cloud execution.
- OS-keychain secret storage (env var in MVP; `keytar` noted as hardening).

---

## 2. Build vs. buy

The system's value and safety guarantees live in a small set of hand-built,
fully tested modules. Everything else is a mature dependency.

### Build (ours — no library substitutes)

- Screenplay contracts: actor, ability, target, interaction, question, task, action.
- The **deterministic runner** and its *exclusive* path to the Playwright worker.
- The **policy engine**: a pure function `(context, requested action) -> allow | require_approval | deny`.
- **Approval binding**: recipient + target + content hash + action id/version +
  artifact hash + settings revision + policy version + expiry.
- The command **state machine** and reconciliation logic.
- The **MCP domain-facade allowlist** — the security boundary (CONOPS §3.5, FR-021/022).
- The throttle resolver (most-restrictive-wins).
- Site-SDK contracts.

### Buy (dependencies)

| Concern | Package | Role |
|---|---|---|
| LLM / OpenRouter coordination | `ai` (Vercel AI SDK) + `@openrouter/ai-sdk-provider` | Provider-neutral routing; `generateObject` gives zod-schema-constrained structured output, retries, tool calling. OpenRouter is one provider swap. |
| CLI framework | `commander` | Nested subcommand parsing + help for the `brauto` surface. CLI stays a thin client to the daemon. |
| SQLite driver | `better-sqlite3` | Fast synchronous driver with first-class WAL. |
| Typed SQL + migrations | `kysely` (better-sqlite3 dialect) | Type-checked queries with escape-to-raw-SQL for atomic leases/idempotency; built-in ordered migrator. |
| MCP server | `@modelcontextprotocol/sdk` | Official protocol implementation; we write only the domain tools. |
| Structured logging | `pino` | Operational logs (distinct from the SQLite append-only domain event log). |
| Retry / serialization | `p-retry`, `p-queue` | Capped backoff + per-account "one active UI action" serialization. |
| Timezone / quiet hours | `luxon` | Timezone-aware quiet-hours and interval math. |
| IDs / hashing | `nanoid`, Node `crypto` | IDs and content hashes. |
| Env / config | `dotenv` + zod | Load and validate configuration. |
| Fixture site server | `fastify` | Minimal local `apps/example-site` (dev/test only). |
| Browser automation | `playwright` (official) | Browser control; worker isolation via Node `child_process`. |
| Test | `vitest`, `@playwright/test` | Unit/integration + browser tests. |

**Native-build note:** `better-sqlite3` and `playwright` (and later `keytar`)
require native builds via `node-gyp`/prebuilds. Supported on macOS/Windows/Linux;
CI must have a toolchain available.

---

## 3. Package layout (Phase 1–3 subset)

```
packages/
  domain/          # commands, messages, actions, policy(pure), receipts, state machine, events
  application/     # use cases + ports (repositories, browser, model, clock)
  storage-sqlite/  # Kysely schema, migrations, WAL, leases, idempotency, checkpoints, event log
  screenplay/      # actor, abilities, targets, interactions, questions, tasks, action registry, runner
  playwright/      # BrowserPort, isolated worker process, contexts, traces
  site-sdk/        # site / action / target / settings / throttle contracts
  model-gateway/   # ModelGateway port + AI-SDK/OpenRouter adapter + deterministic fake
  mcp-facade/      # domain tools only (queue_*, get_command, list_incoming, get_thread,
                   #   approve_action, cancel_command, get_site_health)
  daemon/          # scheduler, leases, budgets, policy enforcement, crash recovery
  cli/             # brauto commands (commander), versioned JSON envelopes, stable exit codes
site-integrations/
  example-network/ # session.status, inbox.list, thread.get, message.draft, message.reply(approval:always)
apps/
  example-site/    # local fixture inbox web app Playwright drives (dev/test only)
```

Dependency direction points inward toward `domain` and `application` (TypeScript
project references enforce build boundaries). An ESLint rule fails the build on
forbidden imports — site modules and `domain` may not import Playwright, SQLite,
or the model gateway directly (CONOPS §3.2, §5.2).

---

## 4. Control-plane boundaries (enforced, not just documented)

The control paths are deliberately asymmetric (CONOPS §3.7):

- The **deterministic runner** is the only code path that can reach the private
  Playwright worker. The CLI and MCP facade can enqueue and retrieve domain work
  but cannot obtain a browser capability.
- The Playwright worker accepts only `{ action id, pinned artifact hash,
  validated input, restricted execution context }`. It rejects prompts,
  arbitrary URLs, and code.
- The **local API boundary** (daemon ↔ CLI, and the MCP server) is a Unix domain
  socket / Windows named pipe. No TCP listener by default (CONOPS §9.1).

**Boundary contract test (mandatory):** an automated test asserts the MCP tool
list contains exactly the permitted domain tools and none of the forbidden
surfaces (`browser_click`, `browser_fill`, `page_evaluate`, `run_selector`,
`navigate_url`, raw DOM/cookie/navigation). This test is the executable form of
FR-021/FR-022 and must pass in CI.

---

## 5. External writes: prepare / commit / reconcile

`message.reply` is an `ExternalWriteAction` (CONOPS §5.3). The two-phase sequence:

1. **Prepare** — resolve the pinned artifact, validate input, open the thread,
   verify recipient and target, reserve the write budget, render the final
   preview, and produce a `PreparedCommit` whose content hash binds the approval.
2. **Commit** — reacquire the page, re-verify recipient/target/content against
   the approval, verify the approval has not expired, perform the single commit
   interaction (click Send), and assert the postcondition (`SentMessage.exists`).

Guarantees:

- **No model call occurs between approval and commit.** The runner cannot rewrite
  content, choose another recipient, reorder same-ordering-key commands, or
  substitute an artifact (CONOPS §5.8, FR-024).
- An unknown outcome (crash/timeout after Send) transitions the command to
  `reconciling` and never blindly repeats the external action (FR-014). `reconcile`
  proves the effect present or absent before any further attempt.
- Idempotency key + `UNIQUE(site, account, idempotency_key)` guarantees one
  executable command per request.

---

## 6. Model gateway

`ModelGateway` is a thin **typed-task** layer over the AI SDK:

- Exposes typed tasks `message.draft` and `reply.draft` (the MVP subset of CONOPS §6.1).
- Owns model profiles, per-task cost/token/timeout ceilings, input
  redaction/minimization, and recording of model route, prompt version, schema
  version, token usage, cost, and response hash (FR-028/029).
- Delegates transport, provider routing, structured output, and retries to the
  AI SDK + `@openrouter/ai-sdk-provider`. `generateObject` enforces the zod output
  schema at the provider; the gateway re-validates locally (structured output
  reduces parsing ambiguity but is still untrusted — CONOPS §6.3).
- Drafts are immutable; approval produces a content hash; a deterministic publish
  path consumes the approved content. No model call after approval (FR-030).

Two adapters implement the same port:

- **OpenRouter adapter** (real) — key from `OPENROUTER_API_KEY` (env in MVP; OS
  key storage is post-MVP hardening).
- **Deterministic fake adapter** — used by all automated tests so CI needs no key
  and incurs no spend.

Models cannot activate integrations, approve actions, alter site settings,
reserve budgets, select recipients outside task inputs, or reach the Playwright
worker (FR-016, CONOPS §6.1).

---

## 7. Local fixture site (`apps/example-site`)

A minimal Fastify app serving a mock messaging UI (inbox list, thread view,
compose box, send button) with stable, accessible roles and labels so Screenplay
targets use role/label locators rather than CSS/XPath (CONOPS §5.4). It exposes
just enough state (a few seeded threads/messages) to exercise every MVP action
and every §11 acceptance scenario deterministically. It is a dev/test artifact,
never shipped as a product surface. The `example-network` site integration
automates it.

Because the target is local and owned by us, there is no terms-review blocker for
the MVP; the terms-gate machinery (CONOPS §9.1) is still implemented and the
fixture integration records a benign review status, so the gate is exercised.

---

## 8. Test strategy

Per CONOPS §10 (Testability) and §11 (acceptance):

- **Pure domain/policy tests** — policy engine, state-machine transitions,
  throttle resolver, approval binding/expiry.
- **Action unit tests** — Screenplay actions with a fake browser port.
- **Golden fixtures** — normalization of inbox/thread records to the common schema.
- **Storage integration** — Kysely migrations up/down, WAL, atomic lease
  acquisition, idempotency conflict, checkpoint recovery.
- **Browser tests** — `@playwright/test` driving `apps/example-site`.
- **Headed dry run** — external commits replaced by assertions (writes disabled).
- **Boundary contract test** — the MCP allowlist assertion from §4.
- **Acceptance scenarios as executable tests** — duplicate command, recipient
  changed, crash-after-Send (fault injection → no duplicate send), approval
  expired, content changed, prompt-injection-remains-data, budget exhausted,
  global pause.

The deterministic fake model adapter is used throughout so tests are
hermetic. The real OpenRouter path is exercised manually / behind an opt-in
env-gated test, not in CI.

---

## 9. Milestones

1. **M1 — Foundation.** Monorepo + toolchain, `domain` model, `storage-sqlite`
   (Kysely schema, migrations, repositories, event log), profile manager, full
   `brauto` CLI surface wired to stubbed handlers, MCP facade skeleton with the
   boundary contract test, crash-recovery test.
   *Exit:* queue, MCP-boundary, migration, and crash-recovery tests pass.
2. **M2 — Screenplay + reads.** Actor/ability framework, targets/questions/tasks,
   action registry, Playwright worker, `apps/example-site`, and the
   `session.status` / `inbox.list` / `thread.get` actions with dedup and traces;
   headed login flow.
   *Exit:* a versioned `inbox.list` works against the fixture with deduplication
   and trace capture.
3. **M3 — Controlled writes + drafting.** Approval binding, transactional
   budgets/throttles, `message.draft` via the OpenRouter gateway, and
   `message.reply` with the two-phase send + reconciliation.
   *Exit:* fault injection proves no duplicate send; acceptance scenarios pass.

---

## 10. Open items (non-blocking)

- **`OPENROUTER_API_KEY`** is required to exercise real drafting; tests do not
  need it. Owner to provide when convenient.
- Model profile defaults (model routes, temperature, cost ceiling) for
  `message.draft` will be set to conservative values and confirmed during M3.
- Whether the fixture site should also model an auth/login screen to exercise the
  "authentication challenge → pause" scenario, or whether that scenario is tested
  via injected state. Default: model a simple login screen.
