# Local Browser Automation Platform

## Concept of Operations and Functional Specification

**Status:** Proposed baseline  
**Version:** 0.4  
**Date:** 2026-09-17

This specification defines a local-first browser automation platform implemented in TypeScript and Node.js. It uses Playwright to control a dedicated browser profile after the user signs in, SQLite-backed command and incoming-message queues, Screenplay-inspired TypeScript automation modules, declarative YAML composition, and model-assisted integration authoring, repair, and content management.

The central design decision is that an LLM does **not** control the production browser. OpenRouter and other model providers operate in a bounded control plane: models may explore through a restricted Playwright MCP session and generate candidate TypeScript actions, tasks, questions, fixtures, patches, YAML compositions, classifications, and content. Production executes only compiled, tested, approved, and content-addressed TypeScript artifacts through direct Playwright.

The platform is intended for low-volume personal assistance on sites where the user has authority to act. It is not intended for bulk outreach, scraping, account farming, stealth automation, CAPTCHA bypass, or evasion of site controls. Each site integration must pass a terms and authorization review before its capabilities are enabled.

---

## 1. Key decisions

| Area | Baseline decision |
|---|---|
| Execution | Local TypeScript/Node.js daemon and CLI; one active UI action per site account |
| Browser identity | Dedicated, headed Chromium profile; the user performs login, MFA, consent, and challenges |
| Browser runtime | Playwright runs inside a private browser-worker process owned by the daemon |
| MCP boundary | Domain-level queue and retrieval operations only; no raw click, fill, evaluate, selector, or page tools |
| Automation model | Screenplay-inspired TypeScript actions composed from tasks, interactions, questions, and abilities |
| Composition model | YAML may compose registered high-level actions and model tasks; it never expresses raw browser calls |
| Discovery model | Restricted Playwright MCP supports supervised exploration and repair; production uses direct Playwright |
| Model role | Provider-agnostic model tasks use OpenRouter or another adapter; models never issue live browser commands |
| Persistence | SQLite in WAL mode with leases, idempotency keys, checkpoints, and an append-only event log |
| External writes | Draft-only by default; exact recipient, target, content, action artifact, settings revision, and expiry are bound to approval |
| Self-healing | Bounded patch proposal, offline tests, dry run, approval, canary, and rollback |
| Safety | Policy gates, conservative budgets, quiet hours, pause/takeover, kill switch, and fail-closed behavior |

---

## 2. Concept of operations

### 2.1 Purpose

The platform gives a local user or CRM a generic command queue and normalized incoming-message queue for authorized browser-based work. A site integration implements generic actions—such as `inbox.list`, `thread.get`, `message.draft`, and `message.reply`—with versioned TypeScript modules for a specific site.

### 2.2 Scope

In scope:

- Create and attach to a dedicated local browser profile.
- Allow the user to log in through the visible site UI.
- Synchronize a bounded set of recent incoming messages.
- Normalize site records into a common local schema.
- Draft replies and queue external actions.
- Require approval for consequential actions by default.
- Execute approved, version-pinned TypeScript actions through the Screenplay runtime.
- Record checkpoints, receipts, redacted evidence, and audit events.
- Generate and test candidate site integrations using configured models.
- Diagnose UI drift and propose bounded, reviewable repairs.

Out of scope:

- Password, cookie, token, or browser-storage extraction.
- CAPTCHA solving or automated handling of identity challenges.
- Browser fingerprint manipulation, proxy rotation, or anti-detection features.
- Unreviewed generated code, shell commands, or unrestricted filesystem and network access from integrations.
- Bulk scraping, bulk messaging, account farming, or unsolicited high-volume outreach.
- Treating browser automation as a way around a site's API restrictions or terms.

### 2.3 Operating principles

1. **User agency.** The user signs in, enables sites and capabilities, approves consequential actions, and can pause execution immediately.
2. **Deterministic execution.** A command resolves to an immutable integration, action, compiled artifact, settings revision, validated input, explicit preconditions, and recorded result.
3. **Least privilege.** Site integrations expose narrow domain actions rather than a general-purpose browser or scripting interface.
4. **Human-paced operation.** One foreground task runs at a time, with quiet hours, minimum intervals, conservative budgets, visible typing and scrolling where useful, and no attempt to evade bot detection or masquerade as a person.
5. **Fail closed.** Authentication prompts, CAPTCHA, consent dialogs, recipient ambiguity, unknown pages, budget exhaustion, and policy violations stop execution.
6. **Auditable adaptation.** An LLM may propose a patch from redacted evidence, but independent validation controls activation.
7. **Prefer supported interfaces.** Use official APIs when they provide the required authorized capability. Browser integrations are site-specific and conditional.

### 2.4 Actors

| Actor | Responsibility |
|---|---|
| End user | Creates profiles, signs in, configures policy, reviews drafts, approves actions, and handles challenges |
| TypeScript CLI | Provides setup, enqueue, inspect, approve, run, pause, diagnose, and site-integration lifecycle commands |
| Local daemon | Owns scheduling, queue leases, browser sessions, policy enforcement, and event recording |
| Screenplay runner | Resolves registered actions and executes TypeScript tasks, questions, and interactions without consulting an LLM |
| Model task runner | Invokes configured models for integration building, repair, classification, and content generation |
| Integration maintainer | Reviews targets, permissions, terms status, tests, signatures, and releases |

### 2.5 Normal operating sequence

1. The CLI creates a dedicated persistent browser profile and opens a headed browser.
2. The user signs in directly. The application never requests or stores the password.
3. The user enables a trusted site integration and selects actions, approval rules, budgets, and quiet hours.
4. The scheduler enqueues a bounded `inbox.list` command.
5. The runner verifies the origin, account, authenticated state, action artifact hash, site settings revision, and policy.
6. The action reads recent inbox items and upserts normalized messages using stable source identifiers.
7. A user or CRM requests a draft or reply with an idempotency key and expected recipient and thread.
8. The policy engine allows, denies, or requires approval. New recipients and sends require approval by default.
9. The runner acquires a lease, rechecks recipient and page identity, executes the registered action, verifies the result, and records a receipt.
10. Transient failures retry from safe checkpoints. Structural failures quarantine the action artifact and may start bounded repair.

### 2.6 Human operating envelope

Numeric limits are local safety policy, not claims about what a site permits. Site integrations may lower limits or disable an action.

| Control | Default behavior |
|---|---|
| Concurrency | One active UI action per account; reads do not overlap writes |
| New outbound contacts | Disabled until explicitly enabled; each action requires approval |
| Replies | Draft-only; optional approval policy may be enabled per thread or site |
| Daily write budget | Site-integration default no greater than 10; the user may lower it |
| Timing | Quiet hours, minimum intervals, and policy-seeded timing variation; timing reduces load and improves UX, never evades detection |
| Authentication challenges | Pause and notify the user |
| Global pause | Stop before the next browser step at a safe boundary |

---

## 3. System architecture

### 3.1 Logical components

| Component | Contract |
|---|---|
| CLI | Typed commands and versioned JSON output; no direct database editing |
| Daemon | Single coordinator that leases work, enforces schedules, and supervises adapters |
| SQLite repository | Commands, messages, approvals, integration/action versions, checkpoints, budgets, site state, and events |
| Policy engine | Pure function: context plus requested action produces `allow`, `require_approval`, or `deny` |
| Action registry | Resolves a site, action ID, and version to a compiled, content-addressed TypeScript artifact |
| Screenplay runtime | Supplies actors and abilities and executes actions composed from tasks, interactions, and questions |
| Composition engine | Validates YAML that invokes registered actions and model tasks with bounded control flow |
| Browser-worker supervisor | Starts and monitors isolated Node.js worker processes, dedicated Playwright contexts, and traces |
| Private Playwright adapter | Executes approved Screenplay interactions and questions through Playwright; not exposed through public MCP |
| Domain MCP facade | Enqueues typed actions, requests retrievals, reads normalized results, reports status, and cancels queued work |
| Site adapter | Registers site-specific actions and normalized records |
| Model gateway | Routes typed model tasks through OpenRouter or another provider adapter and validates structured output |
| Evidence store | Holds redacted accessibility/DOM snapshots, screenshots, traces, and failure fingerprints |

### 3.2 Recommended TypeScript packaging

```text
packages/
  domain/          # commands, messages, actions, policies, receipts
  application/     # use cases and ports
  screenplay/      # actor, abilities, activities, tasks, questions, runner
  composition/     # YAML schemas and high-level action composition
  storage-sqlite/  # migrations and repository adapters
  playwright/      # private driver, browser workers, contexts, and traces
  mcp-facade/      # domain queue/retrieval tools; never raw browser tools
  site-sdk/        # site, action, throttle, settings, and target contracts
  model-gateway/   # OpenRouter and other provider adapters
  authoring/       # integration builder, repair, evals, and content tasks
  daemon/          # scheduler, leases, budgets, and recovery
  cli/             # local administration and JSON/text presentation
site-integrations/  # manifests, TypeScript actions, tasks, targets, tests, YAML composition
```

Use strict TypeScript, schema validation at every package boundary, and project references or equivalent build boundaries. Dependency direction points inward toward `domain` and `application`. Playwright, SQLite, MCP, and model providers remain replaceable adapters. Site actions depend only on the site SDK and approved Screenplay abstractions. Domain policy imports neither Playwright nor the model gateway.

### 3.3 Playwright runtime

Use the official Playwright Node.js package behind a narrow internal `BrowserPort`. Run each active browser account in an isolated worker process so a browser crash, trace capture, or stuck page cannot block the queue coordinator.

The worker accepts only a registered action identifier, pinned artifact hash, validated input, and restricted execution context. It does not accept model prompts, arbitrary code from MCP callers, unrestricted URLs, or shell commands. The daemon remains the authority for queues, integration/action versions, site settings, policies, approvals, budgets, leases, and audit events.

Playwright is preferred because it supplies role- and label-based locators, actionability checks, browser contexts, tracing, screenshots, and deterministic waits. Use explicit state assertions rather than fixed sleeps. Enable traces for failed runs and bounded canaries, subject to redaction and retention policy.

### 3.4 Playwright MCP authoring boundary

Playwright MCP is an optional development-time instrument for integration building and repair. A model may use accessibility snapshots and supervised interactions to discover a successful path, but transient MCP element references are never stored as production automation. The authoring agent converts discoveries into semantic Playwright locators, Screenplay targets, TypeScript tasks/actions, and tests.

The authoring MCP profile is separate from production profiles. Disable or exclude arbitrary code execution, cookie/storage manipulation, unrestricted navigation, and network interception unless a trusted maintainer explicitly enables them in an isolated environment. Ordinary discovery stops before irreversible actions.

Production does not expose Playwright MCP. It runs compiled TypeScript action artifacts directly through the private Playwright worker.

### 3.5 Public MCP boundary

The public MCP server is a domain facade over the local queues. It must not expose Playwright's browser-control tools. This prevents an LLM or external MCP client from bypassing registered actions, approval, sequencing, throttles, or policy.

Permitted MCP tools:

| Tool | Behavior |
|---|---|
| `queue_retrieval` | Enqueue an approved read capability such as `inbox.list` or `thread.get` |
| `queue_action` | Enqueue a typed action such as `message.draft` or `message.reply`; it cannot skip approval policy |
| `get_command` | Return normalized command state, policy decision, and receipt references |
| `list_incoming` | Return normalized local messages using filters and pagination |
| `get_thread` | Return a normalized local thread; may optionally enqueue refresh |
| `approve_action` | Record explicit approval bound to the exact action hash, if caller identity is authorized |
| `cancel_command` | Cancel queued work or request stop at the next safe boundary |
| `get_site_health` | Return session, pack, queue, and quarantine status without browser internals |

Explicitly forbidden MCP surfaces include `browser_click`, `browser_fill`, `page_evaluate`, `run_selector`, `navigate_url`, raw DOM retrieval, cookie access, and arbitrary Playwright passthrough. A model task may call the domain facade to queue or retrieve authorized work, but cannot acquire the private Playwright worker capability.

### 3.6 Browser session model

- Use one dedicated persistent profile directory per local user and site group.
- Do not attach automation to the user's normal browsing profile.
- Launch a headed Chromium process with a local-only debugging endpoint and OS-restricted profile directory.
- Let the user complete login, MFA, consent, and challenges in the visible browser.
- Verify readiness using site-integration assertions; do not inspect or export session secrets.
- Display an automation indicator and expose pause, takeover, and close controls.
- Restrict each pack to declared origins. Cross-origin transitions must be declared or approved.
- Never send cookies, local storage, passwords, tokens, or raw session state to an LLM.

### 3.7 High-level data flow

```text
User, CRM, or LLM client
    -> domain MCP facade or TypeScript CLI
    -> command queue
    -> policy gate
    -> approval queue
    -> deterministic runner
    -> private Playwright adapter
    -> headed browser

Site inbox
    -> deterministic read action
    -> normalization
    -> incoming-message queue
    -> user or CRM

Failure evidence
    -> local redaction
    -> model task runner
    -> candidate patch
    -> build, static checks, and tests
    -> human approval or narrow read-only policy
    -> canary and activation
```

The control paths are intentionally asymmetric: MCP can request domain work and retrieve normalized results, while only the deterministic runner can reach the private Playwright adapter.

---

## 4. Data and queue specification

### 4.1 SQLite operating model

- Enable WAL mode, foreign keys, and a bounded busy timeout.
- Treat the daemon as the normal writer.
- Use short transactions to atomically lease eligible queue rows.
- Use an idempotency key for every externally visible command.
- Append an event for every state transition and policy decision.
- Store UTC timestamps as RFC 3339 strings or integer milliseconds.
- Use a monotonic clock for in-process timeouts and lease durations.
- Run database migrations before accepting work and test upgrade and rollback recovery paths.

### 4.2 Core records

| Record | Required data |
|---|---|
| `command` | ID, site, account, action ID/version, artifact hash, composition hash when applicable, payload JSON, idempotency key, priority, `not_before`, state, attempt count, lease, approval ID, timestamps |
| `incoming_message` | Site/account, source thread ID, source message ID, sender reference, received time, text, attachment metadata, first-seen time, processing status |
| `action_receipt` | Command, step, action kind, target fingerprint, start/end, outcome, evidence reference, external result reference |
| `approval` | Command, rendered summary, content hash, state, decider, decision time, expiry |
| `action_version` | Site, action ID, semantic version, compiled artifact hash, input/output schema hashes, state, creator, approver, activation time |
| `site_definition` | Site ID, display name, allowed origins, installed integration version, terms status, enabled flag |
| `site_setting` | Site/account, setting key, validated JSON value, source, updated time, policy revision |
| `action_definition` | Site, action ID, version, input/output schemas, artifact hash, risk class, permissions, throttle class, enabled flag |
| `model_profile` | Task kind, provider adapter, model route, parameters, privacy rules, cost ceiling, fallback policy, prompt version |
| `checkpoint` | Command, action artifact hash, named safe boundary, typed variables, page fingerprint, update time |
| `site_state` | Site/account, health, pause reason, last success, terms review date, integration version |
| `budget_counter` | Site/account, action class, window start, used, reserved, configured limit |
| `event` | Sequence, aggregate, event type, JSON payload, time, correlation ID; append-only |

Recommended uniqueness constraints:

```sql
UNIQUE (site, account_id, idempotency_key)
UNIQUE (site, account_id, source_message_id)
UNIQUE (site, capability, content_hash)
```

### 4.3 Command state machine

```text
queued -> validating -> awaiting_approval -> ready -> leased -> running -> succeeded
              |                 |                    |          |
              +-> denied        +-> expired          +-> retry  +-> failed
                                                     |
                                                     +-> quarantined
```

Only declared transitions are legal. A lease expiry may return an idempotent command to `ready` or `retry`. A command that may already have caused an external effect enters `reconciling`; it is never blindly retried.

### 4.4 Queue semantics

- Internal delivery is at least once.
- External effects are effectively once through idempotency, preflight checks, checkpoints, receipts, and reconciliation.
- The ordering key is `site + account + conversation` when applicable.
- Writes sharing an ordering key are serialized.
- Retry classes are `transient_transport`, `stale_page`, `authentication_required`, `policy_denied`, `ambiguous_target`, `structural_change`, and `unknown_external_outcome`.
- Exponential backoff applies only to transient failures and is capped.
- Structural failures do not spin; they quarantine the action artifact.
- Inbox polling uses a site cursor when available; otherwise it scans a bounded window and deduplicates by stable identifier plus a documented fallback fingerprint.

---

## 5. Screenplay automation and composition specification

### 5.1 Site integration package

A site integration contains declarative policy plus compiled TypeScript automation:

```text
manifest.yaml
schemas/
src/
  targets/
  questions/
  interactions/
  tasks/
  actions/
  compositions/
fixtures/
tests/
redaction.yaml
TERMS_REVIEW.md
```

The manifest declares allowed origins, site settings, registered action artifacts, input/output schemas, risk classes, permissions, throttle classes, approval policy, model profiles, minimum Playwright version, package hash, terms-review date, and expiration. Activation is atomic by content hash. Running commands retain their pinned integration and action artifacts.

### 5.2 Screenplay model

The automation model uses these concepts:

| Concept | Purpose |
|---|---|
| Actor | Represents one account executing in one browser profile |
| Ability | Grants a narrow capability such as browsing, reading site settings, or recording evidence |
| Target | Resolves a semantic Playwright locator for a named UI element |
| Interaction | Performs one low-level operation such as click, fill, or navigate |
| Question | Reads or asserts typed page state without causing an external effect |
| Task | Composes interactions and questions into a reusable operation |
| Action | Stable, versioned domain capability exposed to queues, MCP, and YAML composition |
| Composition | Bounded orchestration of registered actions and model tasks |

Site modules may use Playwright only through approved abilities and SDK abstractions. They cannot access SQLite, queues, credentials, arbitrary browser contexts, the model gateway, unrestricted filesystem/network APIs, or approval creation.

### 5.3 Action contract

Every registered action has typed input/output schemas, semantic version, compiled artifact hash, risk class, throttle class, approval rule, idempotency strategy, safe checkpoints, and reconciliation behavior.

```ts
export interface ActionDefinition<Input, Output> {
  readonly id: string;
  readonly version: string;
  readonly input: Schema<Input>;
  readonly output: Schema<Output>;
  readonly risk: RiskClass;
  readonly throttleClass: string;

  execute(actor: Actor, input: Input): Promise<Output>;
}

export interface ExternalWriteAction<Input, Output>
  extends ActionDefinition<Input, Output> {
  prepare(actor: Actor, input: Input): Promise<PreparedCommit>;
  commit(
    actor: Actor,
    input: Input,
    approval: ApprovedCommit,
  ): Promise<Output>;
  reconcile(
    actor: Actor,
    input: Input,
  ): Promise<ReconciliationResult>;
}
```

The `prepare`, `commit`, and `reconcile` split is mandatory for external writes. Approval binds the exact action ID/version, artifact hash, account, recipient, target, content, settings revision, and expiry.

### 5.4 Example TypeScript action

```ts
export const ReplyToMessage = defineExternalWriteAction({
  id: "message.reply",
  version: "1.0.0",
  input: MessageReplyInput,
  output: SendReceipt,
  risk: "external_write",
  throttleClass: "write",

  async prepare(actor, input) {
    await actor.attemptsTo(
      OpenThread.withId(input.threadId),
      VerifyRecipient.is(input.recipient),
      ComposeMessage.with(input.body),
    );

    return actor.asks(
      PreparedCommit.for("message.reply", input),
    );
  },

  async commit(actor, input, approval) {
    await actor.attemptsTo(
      VerifyApproval.matches(approval, input),
      VerifyRecipient.is(input.recipient),
      Click.on(SendButton),
    );

    await actor.asks(
      SentMessage.exists(input.threadId, hash(input.body)),
    );

    return actor.asks(CurrentActionReceipt.value());
  },

  async reconcile(actor, input) {
    return actor.asks(
      ExistingEffect.forMessage(input.threadId, hash(input.body)),
    );
  },
});
```

Targets use semantic locators such as roles, labels, accessible names, and stable test identifiers. CSS and XPath require justification and fixtures. Transient Playwright MCP snapshot references are never stored in production code.

### 5.5 Site settings, actions, and throttles

Site settings provide defaults and hard ceilings. Account overrides may become more restrictive unless an authorized user explicitly changes site policy. Action settings inherit from the site and may narrow them further.

```yaml
schema: site-integration/v1
site: example-network
version: 1.0.0

origins:
  - https://www.example.com

settings:
  timezone: America/New_York
  approval_mode: writes
  trace_mode: failures
  quiet_hours:
    - { start: "20:00", end: "08:00" }
  max_concurrency: 1
  content_profile: professional-default
  model_profiles:
    integration_builder: code-builder
    repair_agent: code-repair
    content_manager: content-default

throttles:
  read: { min_interval_seconds: 20, hourly_limit: 30, daily_limit: 100 }
  write: { min_interval_seconds: 90, hourly_limit: 5, daily_limit: 10 }
  new_contact: { enabled: false, approval: always, daily_limit: 0 }

actions:
  inbox.list:
    version: 1.2.0
    artifact: dist/actions/inbox-list.js
    risk: read
    throttle: read
    input_schema: schemas/inbox-list-input.json
    output_schema: schemas/incoming-thread.json

  message.reply:
    version: 1.0.0
    artifact: dist/actions/message-reply.js
    risk: external_write
    throttle: write
    approval: always
    input_schema: schemas/message-reply-input.json
    output_schema: schemas/send-receipt.json
```

The throttle resolver computes the most restrictive applicable policy across global, site, account, action, risk, rolling-window, and temporary-health limits. Reservations are transactional and occur before a command becomes runnable.

### 5.6 YAML composition

YAML may compose registered high-level actions and model tasks. It cannot contain raw Playwright locators, click/fill/navigation primitives, arbitrary TypeScript, or shell/network operations.

```yaml
schema: composition/v1
id: inbox.process-unread
version: 1.0.0

inputs:
  limit: { type: integer, minimum: 1, maximum: 10 }
  content_profile: { type: string }

steps:
  - invoke:
      action: inbox.list
      with: { unreadOnly: true, limit: $inputs.limit }
      save_as: messages

  - for_each:
      from: $messages.items
      as: message
      max: 10
      steps:
        - model_task:
            task: reply.draft
            with:
              message: $message
              contentProfile: $inputs.content_profile
            save_as: draft

        - invoke:
            action: message.reply
            with:
              threadId: $message.threadId
              recipient: $message.sender
              body: $draft.body
```

Composition validation rejects unknown actions or fields, incompatible schemas, unbounded loops, unsupported branches, risk escalation, secret interpolation, and attempts to bypass approvals or throttles. Each action invocation remains independently validated, authorized, leased, metered, and receipted.

### 5.7 Build and activation pipeline

```text
TypeScript source and YAML composition
  -> dependency and import allowlist
  -> schema and TypeScript checks
  -> formatting, linting, and static policy analysis
  -> unit, fixture, mutation, and integration tests
  -> headed dry run with writes disabled
  -> compile and bundle
  -> content hash and signature
  -> semantic diff and approval
  -> atomic activation
```

Generated TypeScript is never executed directly from model output. Integration code runs in isolated workers with locked dependencies, restricted environment/filesystem access, allowed origins, and time/memory limits.

### 5.8 Deterministic sending and human-paced interaction

External writes use a two-phase sequence:

1. **Prepare:** resolve the pinned action artifact, validate input, verify recipient and target, reserve the budget, render the final preview, and bind approval to the action hash.
2. **Commit:** reacquire the page, revalidate recipient/target/content, verify approval, execute the single commit interaction, and reconcile the visible result.

No model call occurs between approval and commit. The runner cannot rewrite content, choose another recipient, reorder commands sharing an ordering key, or substitute an action artifact.

Human-paced behavior is deterministic policy, not random sleeps embedded in actions:

```yaml
interaction_policy:
  quiet_hours:
    timezone: America/New_York
    windows:
      - { start: "20:00", end: "08:00" }
  min_interval_seconds:
    read: 20
    write: 90
  typing:
    mode: visible
    chars_per_second: { min: 5, max: 9 }
  scrolling:
    mode: incremental
    max_viewports_per_step: 3
  variation:
    mode: seeded
    seed_scope: command
    max_percent: 15
```

The command ID, policy version, and configured seed derive permitted variation, making a run replayable. Variation may smooth load and keep visible interaction understandable; it must not be tuned against detection systems. Budgets, ordering, quiet hours, and minimum intervals remain hard constraints. Playwright actionability checks and Screenplay questions determine readiness; timing never substitutes for a postcondition.

---

## 6. Model gateway, authoring, repair, and content management

### 6.1 Provider-independent task model

The application defines typed model tasks and routes them through a provider-neutral `ModelGateway`. OpenRouter is the initial adapter because it provides access to multiple models, provider routing, structured outputs, and provider privacy controls. Direct provider and local-model adapters can be added without changing domain contracts.

Supported task kinds:

| Task | Input | Output | Live execution authority |
|---|---|---|---|
| `integration.build` | Site goal, restricted Playwright MCP evidence, Screenplay SDK, schemas | Candidate manifest, TypeScript actions/tasks/questions, compositions, fixtures, tests | None |
| `integration.repair` | Failure fingerprint, exact artifact hash, redacted trace and snapshots | Minimal typed TypeScript/configuration patch | None |
| `content.draft` | Approved context, content profile, constraints | Draft content and rationale metadata | Draft only |
| `content.rewrite` | Existing draft and explicit editing instruction | Revised draft | Draft only |
| `message.classify` | Normalized message with minimized context | Typed labels, priority, routing suggestion | None |
| `reply.draft` | Thread context, site/content policy | Draft reply | Draft only |
| `summarize` | Normalized local records | Typed summary | None |

Models cannot activate integrations, approve actions, alter site settings, reserve throttle budgets, select recipients outside task inputs, or call the private Playwright adapter.

### 6.2 Model profiles and OpenRouter

Model profiles are versioned configuration, selected by task kind rather than hard-coded model names:

```yaml
model_profiles:
  code-builder:
    adapter: openrouter
    models:
      - vendor/model-a
      - vendor/model-b
    required_capabilities: [structured_outputs, tool_calling]
    temperature: 0.1
    max_output_tokens: 12000
    provider:
      require_parameters: true
      allow_fallbacks: true
      data_collection: deny
      zdr: true
    budget:
      max_cost_usd_per_task: 2.00

  content-default:
    adapter: openrouter
    models: [vendor/model-c]
    required_capabilities: [structured_outputs]
    temperature: 0.5
    provider:
      require_parameters: true
      data_collection: deny
```

The model gateway shall:

- Resolve only allowlisted model and provider routes.
- Require structured-output support for typed tasks and validate the response again locally.
- Record model route, provider route, prompt version, schema version, parameters, latency, token usage, cost, and response hash.
- Apply per-task cost, token, concurrency, and timeout limits.
- Redact and minimize inputs before transmission.
- Support provider settings such as required parameters, fallbacks, data-collection policy, and zero-data-retention routing where configured.
- Treat model fallbacks as nondeterministic authoring inputs; the resulting artifact becomes deterministic only after validation, hashing, approval, and version pinning.

### 6.3 Structured model output

```ts
interface PatchProposal {
  failureFingerprint: string;
  baseIntegrationHash: string;
  summary: string;
  changedFiles: FilePatch[];
  requestedPermissionChanges: PermissionChange[];
  riskChange?: RiskChange;
  assumptions: string[];
  testsAdded: string[];
  confidence: number;
}
```

Model output is untrusted input. The host independently validates it and computes the real diff, permissions, risk, and content hash. Structured output reduces parsing ambiguity but does not make the content safe or correct.

### 6.4 Integration build workflow

1. Start a dedicated, supervised Playwright MCP authoring profile.
2. Let the model inspect accessibility snapshots and explore only declared origins, stopping before irreversible actions.
3. Invoke `integration.build` with the semantic interaction trace, Screenplay SDK, site settings schema, and requested actions.
4. Write model output into an isolated candidate workspace.
5. Enforce imports, dependencies, schemas, type checking, origin restrictions, and risk rules.
6. Run unit, golden fixture, mutation, and browser tests.
7. Run a headed dry run in which external commits are replaced by assertions.
8. Present a semantic diff including actions, tasks, targets, selectors, compositions, settings, throttles, permissions, and risk changes.
9. Require maintainer or user approval.
10. Compile, hash, sign or locally trust, and atomically activate the artifacts.

### 6.5 Bounded repair workflow

Self-healing means proposing and validating a narrow patch—not improvising through a changed UI.

1. Group failures by integration hash, action ID/version, artifact hash, page fingerprint, and error signature.
2. Quarantine the failing action artifact after its structural-failure threshold.
3. Redact evidence locally and show the redaction result before a remote-model call.
4. Invoke `integration.repair` against the exact base hash.
5. Reject patches that add origins, permissions, forbidden imports, unbounded control flow, or secret access.
6. Run all existing tests plus generated mutation tests.
7. Perform a headed dry run with writes disabled.
8. Require approval for all write-path, origin, permission, throttle, recipient, and semantic-extraction changes.
9. Canary the first activation and monitor its exact hash.
10. Roll back automatically if the version produces a structural failure spike.

### 6.6 Content management workflow

Content generation is separate from browser execution:

1. A user, CRM rule, or normalized inbound event requests a typed content task.
2. The model gateway selects the site's configured content profile and model profile.
3. The model produces a structured draft with content, purpose, referenced inputs, and optional safety labels.
4. Local validators enforce length, required fields, forbidden data, link policy, and site-specific constraints.
5. The draft is stored and reviewed according to site settings.
6. Approval produces an immutable content hash.
7. A deterministic publish or reply action receives the approved content. No model call occurs after approval.

### 6.7 Repair gates and limits

| Gate | Required result |
|---|---|
| Scope | Only the quarantined action and declared fixtures/tests change |
| Static policy | No forbidden import/API, new origin, broader permission, weaker throttle, secret access, or unbounded flow |
| Regression | Existing golden fixtures pass and normalized output remains compatible |
| Mutation | Wrong recipient, duplicate buttons, missing labels, stale pages, and injected page instructions fail closed |
| Dry run | Navigation and observation pass; irreversible steps are assertions only |
| Canary | First run is one read or one explicitly approved write |
| Rollback | Previous content hash remains available and restores atomically |

Limits:

- Maximum two candidate rounds per failure fingerprint before human escalation.
- Prompts, provider route, model route, parameters, tool schemas, and output schemas are versioned inputs.
- Authentication, CAPTCHA, account restriction, consent, and site-policy failures are not repairable categories.
- A repair cannot alter outbound content, select another recipient, weaken throttles, or relax approval.
- Auto-activation is disabled for every write path.
- Read-only locator repair may be eligible for auto-activation only after explicit user opt-in and production hardening.

---

## 7. Functional requirements

| ID | Requirement |
|---|---|
| FR-001 | The CLI shall create and manage dedicated browser profiles and require authentication in a visible browser. |
| FR-002 | The daemon shall verify origin, account identity when available, and authenticated-state assertions before leasing site work. |
| FR-003 | The system shall enqueue typed commands with schema validation, idempotency key, immutable payload hash, and optional `not_before`. |
| FR-004 | The system shall retrieve a bounded recent inbox set and deduplicate messages by stable site identifier or documented fallback fingerprint. |
| FR-005 | Site adapters shall emit a common message schema while preserving source identifiers and retention-controlled evidence references. |
| FR-006 | Approval shall bind the exact recipient, target, content, action ID/version, artifact hash, settings revision, policy version, and expiry. |
| FR-007 | The runner shall execute only trusted, pinned integration and action artifacts with validated input/output schemas. |
| FR-008 | Every irreversible action shall have identity preconditions and a postcondition or reconciliation rule. |
| FR-009 | The policy engine shall atomically reserve and consume site/account budgets before writes. |
| FR-010 | Scheduling shall honor quiet hours, minimum intervals, account serialization, `not_before`, and user pauses. |
| FR-011 | The system shall append events for state transitions, approvals, policy decisions, browser actions, repairs, activation, and rollback. |
| FR-012 | Failure evidence shall be redacted, access controlled, retention limited, and referenced rather than embedded in queue rows. |
| FR-013 | Retries shall be category-specific, bounded, and resume only from safe checkpoints. |
| FR-014 | Unknown write outcomes shall enter reconciliation and shall not repeat the external action automatically. |
| FR-015 | The CLI shall install, validate, diff, approve, activate, quarantine, roll back, and remove site integrations by content hash. |
| FR-016 | Model tasks shall produce typed proposals or drafts; validation and activation gates shall be enforced independently of model output. |
| FR-017 | The user shall be able to pause automation and take control without losing the audit trail. |
| FR-018 | The CLI shall expose incoming messages and command results through stable, versioned JSON envelopes. |
| FR-019 | The user shall be able to delete a site profile, messages, evidence, and model artifacts with an exact scope preview. |
| FR-020 | The system shall be able to disable a site or capability and fail queued commands before browser execution. |
| FR-021 | The MCP facade shall expose only domain queue, retrieval, approval, cancellation, and health operations. |
| FR-022 | The MCP facade shall not expose raw Playwright, page, locator, selector, DOM, JavaScript, cookie, or navigation operations. |
| FR-023 | The runner shall derive permitted timing variation from recorded policy inputs so execution timing can be replayed. |
| FR-024 | No model call or content transformation shall occur between final approval and the irreversible commit step. |
| FR-025 | Each site integration shall declare a versioned action catalog with schemas, artifact hashes, risk, permissions, throttle class, approval, idempotency, and reconciliation policy. |
| FR-026 | Site settings shall control enabled actions, approvals, quiet hours, throttles, content profile, model profiles, tracing, and retention. |
| FR-027 | The throttle resolver shall enforce the most restrictive applicable global, site, account, action, risk, health, and rolling-window limit. |
| FR-028 | Model profiles shall be selected by task kind and shall define provider routing, required capabilities, privacy rules, limits, fallbacks, and prompt version. |
| FR-029 | Remote model inputs shall be minimized and redacted; credentials and browser session material shall never be included. |
| FR-030 | Content generation shall create immutable drafts and shall remain separate from deterministic browser publication. |
| FR-031 | The Screenplay runtime shall provide actors, capability-limited abilities, semantic targets, interactions, questions, reusable tasks, and registered actions. |
| FR-032 | YAML compositions shall invoke only registered actions and model tasks and shall not contain raw Playwright operations or executable code. |
| FR-033 | Model-generated TypeScript shall pass import, dependency, type, schema, static-policy, test, dry-run, review, and artifact-signing gates before activation. |
| FR-034 | Playwright MCP shall be restricted to supervised authoring and repair profiles and shall not be available to production command execution. |
| FR-035 | Transient Playwright MCP snapshot references shall not be persisted as production selectors. |

---

## 8. CLI specification

```text
brauto init

brauto profile create <name>
brauto profile login <name> --site <site>
brauto profile status <name> --site <site>

brauto site install <path>
brauto site validate <site>
brauto site diff <site>@<candidate>
brauto site activate <site>@<version>
brauto site quarantine <site> --capability <capability>
brauto site rollback <site>
brauto site settings get <site> [--account <account>]
brauto site settings set <site> <key> <value> [--account <account>]
brauto site actions list <site> [--json]
brauto site actions enable|disable <site> <action>
brauto site throttles show <site> [--account <account>]

brauto command enqueue <capability> \
  --site <site> \
  --account <account> \
  --input <json> \
  --idempotency-key <key>

brauto command list [--state <state>] [--json]
brauto command inspect <id> [--json]
brauto command cancel <id>

brauto approval list
brauto approval approve <id>
brauto approval deny <id> --reason <reason>

brauto inbox sync --site <site> --account <account>
brauto inbox list [--unread] [--json]

brauto run [--once]
brauto pause [--site <site>]
brauto resume [--site <site>]

brauto mcp serve
brauto mcp tools --json

brauto diagnose <command-id>
brauto author start <site> --action <action>
brauto author build <session-id>
brauto author test <candidate-id>
brauto repair propose <failure-id>
brauto repair test <proposal-id>
brauto repair activate <proposal-id>

brauto model profile list
brauto model profile validate <profile>
brauto model test <task-kind> --profile <profile> --input <json>

brauto audit export --since <timestamp> --format jsonl
```

Requirements:

- Mutating commands support `--dry-run` where meaningful.
- JSON output uses versioned envelopes and stable exit codes.
- CLI output never includes secrets or unredacted browser session material.
- Destructive deletion requires an explicit target, a scope preview, and confirmation.
- `approve` displays the bound recipient, target, final content, site, action ID/version, artifact hash, and expiry.
- `mcp serve` exposes only the domain facade and cannot proxy raw Playwright calls.

---

## 9. Security, privacy, and compliance

### 9.1 Required controls

- **Terms gate:** Every capability records its review status, allowed mode, reviewer, date, and expiration. Expired or prohibited capabilities fail closed.
- **Credential boundary:** Credentials and session data remain in the dedicated local browser profile and never enter the database, logs, or LLM context.
- **Local API boundary:** Use an owner-restricted Unix domain socket or Windows named pipe. Do not listen on TCP by default.
- **Origin boundary:** Site integrations operate only on declared origins and routes.
- **OS protection:** Protect profile directories, database, evidence, and local keys with user-only permissions.
- **Encryption:** Store sensitive configuration using OS key storage; encrypt selected database fields and evidence where required by the threat model.
- **Generated-code boundary:** Candidate integrations use import/dependency allowlists, locked dependencies, static analysis, isolated workers, restricted environment/filesystem access, origin controls, and resource limits.
- **Supply chain:** Lock dependencies, scan licenses and vulnerabilities, sign releases and site integrations, and verify hashes before loading.
- **Model boundary:** OpenRouter and other provider credentials live in OS key storage. Remote requests use minimized inputs, explicit provider/privacy policy, bounded cost, and locally validated structured outputs.
- **Prompt injection:** Treat all page content as untrusted data. Page text cannot change actions, code, tools, policy, recipient, origin, or capabilities.
- **Outbound content:** Scan for unexpected links, secrets, sensitive data, and policy violations before approval and again before execution.
- **Retention:** Keep raw screenshots and page snapshots for a short configurable period; keep structured receipts longer.

### 9.2 Site-specific authorization

LinkedIn is a representative integration target, not an authorization to automate it. Its current User Agreement prohibits bots and other unauthorized automated methods for accessing services, adding or downloading contacts, and sending or redirecting messages. A LinkedIn integration must remain disabled unless the exact intended capability is authorized by applicable terms, an approved product/interface, or written permission.

The same rule applies to every site: capability enablement is a product and compliance decision, not merely a technical one.

### 9.3 Threats to test explicitly

- Prompt injection embedded in messages, profiles, buttons, alt text, or page metadata.
- Wrong-recipient selection after page reflow or stale navigation.
- Duplicate send after timeout, crash, or lost postcondition.
- Malicious or compromised site integration.
- Local debugging endpoint exposure.
- Symlink or path traversal in pack installation and evidence writing.
- Sensitive-data leakage to model providers or logs.
- Approval replay after content, policy, artifact, settings, target, or recipient changes.

---

## 10. Nonfunctional requirements

| Area | Target |
|---|---|
| Reliability | No blind repeat of irreversible actions; recover queue processing within 30 seconds after daemon restart |
| Determinism | The same plan hash, inputs, observations, and policy version produce the same step sequence and decision |
| Performance | Local CLI reads under 250 ms p95 and enqueue under 500 ms p95, excluding browser latency |
| Observability | Correlation IDs plus metrics for queue age, success, failure class, approval age, budget use, and pack health |
| Portability | macOS, Windows, and Linux where headed Chromium and the selected adapter are supported |
| Accessibility | CLI and approval summaries remain usable without screenshots |
| Testability | Pure domain/policy tests plus action unit tests, golden fixtures, mutation tests, browser tests, and headed dry runs |
| Maintainability | Forward migrations, semantic schema versioning, stable ports, and replaceable infrastructure adapters |

---

## 11. Verification and acceptance

| Scenario | Acceptance criterion |
|---|---|
| Duplicate command | Two requests with the same idempotency key produce one executable command and the same result reference |
| Recipient changed | The action fails before text entry or commit |
| Crash after Send | Restart enters reconciliation and never clicks Send again without proving the first action absent |
| Approval expired | Execution is denied and a new approval is required |
| Content changed | Existing approval is invalid because its content hash no longer matches |
| UI label changed | The action artifact is quarantined after bounded attempts; no broad fallback selector is used |
| Prompt injection | Injected page instructions remain data and cannot alter actions, code, or policy |
| Authentication challenge | Execution pauses and requests user takeover |
| Repair proposal | Candidate cannot activate until compile, policy, regression, mutation, and dry-run gates pass |
| Budget exhausted | Further writes remain queued or denied until the configured window resets |
| Global pause | No new browser step begins after pause acknowledgement |
| Malicious integration | Signature, schema, import, dependency, permission, origin, or static-policy validation rejects it before activation |

---

## 12. Delivery plan

| Phase | Deliverable | Exit condition |
|---|---|---|
| 1. Foundation | TypeScript monorepo, domain model, SQLite migrations, CLI, MCP facade, event log, profile manager | Queue, MCP-boundary, migration, and crash-recovery tests pass |
| 2. Screenplay runtime | Actor/ability framework, targets, questions, tasks, action registry, Playwright worker | Headed login and a versioned `inbox.list` action work with deduplication and traces |
| 3. Controlled writes | Approval binding, budgets, reply preview, receipt, and reconciliation | Fault injection proves no duplicate send |
| 4. Site configuration | Action catalog, inherited settings, transactional throttles, YAML composition, and policy editor | Limits and overrides resolve to the most restrictive effective policy |
| 5. Model tasks | OpenRouter adapter, model profiles, structured outputs, content drafts, and cost/privacy controls | Model output cannot execute browser actions or bypass validation |
| 6. Authoring and repair | Restricted Playwright MCP, TypeScript integration builder, `PatchProposal`, tests, quarantine, canary, and rollback | Generated code and UI repairs activate only through declared gates |
| 7. Hardening | Threat model, signing, packaging, privacy controls, migration tests | Security review and site-specific terms review complete |

### Recommended MVP boundary

The MVP should support one local user, one dedicated production browser profile, one separate Playwright MCP authoring profile, one example site that permits the intended use, and these registered actions:

- `session.status`
- `inbox.list`
- `thread.get`
- `message.draft`
- `message.reply` with mandatory approval

Defer multi-user orchestration, cloud execution, bulk campaigns, automatic write-path repair, and unattended authentication.

---

## 13. Risks and open decisions

| Risk or decision | Recommended disposition |
|---|---|
| Site authorization | Treat as a launch blocker per capability; prefer supported APIs |
| Playwright worker | Pin Playwright and browser versions, isolate account workers, restrict IPC, and keep the driver private |
| Generated TypeScript | Treat it as an untrusted candidate until compiled, tested, reviewed, signed, and activated |
| Playwright MCP authority | Restrict it to isolated authoring/repair; exclude unsafe code, storage, and unrestricted network tools by default |
| MCP surface creep | Enforce a tool allowlist and contract tests proving raw browser operations are unreachable |
| Remote models | Require explicit configuration, redaction preview, allowlisted routes, privacy settings, and cost ceilings |
| Auto-activation | Disable for all write paths; consider only low-risk read locators after hardening |
| Multi-account scale | Defer; the one-user, one-active-action model is a deliberate safety boundary |
| Message generation | Keep drafting separate from UI execution and apply content policy before enqueueing a send |
| Integration distribution | Start with local trust; add signing and a curated registry only after the permission model is stable |

---

## 14. References

- [Playwright documentation](https://playwright.dev/) — official browser automation documentation.
- [Playwright MCP](https://playwright.dev/docs/getting-started-mcp) — accessibility-snapshot-based model interaction, profiles, and MCP tool capabilities.
- [Playwright locators](https://playwright.dev/docs/locators) — resilient role-, label-, and test-ID-based element targeting.
- [Playwright Trace Viewer](https://playwright.dev/docs/trace-viewer) — trace capture and failure diagnosis.
- [OpenRouter structured outputs](https://openrouter.ai/docs/guides/features/structured-outputs) — JSON Schema-constrained model responses and endpoint capability requirements.
- [OpenRouter provider routing](https://openrouter.ai/docs/guides/routing/provider-selection) — provider selection, fallbacks, data-collection controls, and zero-data-retention routing.
- [LinkedIn User Agreement](https://www.linkedin.com/legal/user-agreement) — current restrictions must be reviewed before enabling any LinkedIn capability.
- [SQLite Write-Ahead Logging](https://sqlite.org/wal.html) — WAL behavior and operational considerations.

These references are architecture inputs, not legal advice. Site terms and product interfaces change and must be reviewed at implementation time and before each site-integration release.
