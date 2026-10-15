# `http:` end-state check: prove a write whose effect is off the app UI (#543)

Status: proposed. Assumes #542 (`metadata.allowedOrigins`, `--allow` on run/verify; effective allowlist =
site/env ∪ recorded ∪ `--allow`) and #544 (`--fixtures` on `explore-author-journey`, recorded on the Journey and
reused by run/verify) land first.

## Problem

A password reset's durable effect is an email. A dev outbox (Mailpit, MailHog) exposes sent mail as JSON on another
origin. `reloadThen:` reloads the app, author mode will not navigate to the outbox, and fixtures only do HTTP *setup*.
So `no-persistence-check` (`journey/src/lint.ts:272`) can only be waived with `--accept-weak`.

## Decisions

**1. Data shape.** A fifth `OutcomeCheck` kind (`recording/src/schema.ts:365`, zod at `:868`):

```ts
type HttpCheck = {
  kind: "http";
  method: "GET";                 // only GET: an end-state check reads, it never writes
  url: string;                   // absolute http(s); literal origin; `${name}` placeholders only after it
  status?: StatusSpec;           // absent: 2xx
  json?: { path: string; op: "equals" | "includes" | "exists"; value?: string }[]; // ≤10
  textIncludes?: string[];       // ≤10, over the raw body
  withinMs?: number;             // poll window, default 10000, max 60000
};
```

No `headers`, no `body`, no `auth` in v1 (see Q1). The request sends only `accept: application/json, */*;q=0.1`.
At least one of `status`/`json`/`textIncludes` must be given. The schema validates `path` with the JSON-path parser
and `url` with `navigateTemplateProblem` (`recording/src/navigate-params.ts`): the scheme, host, port and the path's
leading `/` are literal, so a value can never pick the origin.

**2. Spec grammar** (`parseSuccessSpec`, `cli/src/explore-specs.ts:258`):

```
http:GET <url>|<assertion>[|<assertion>…]
  assertion := status=<2xx|201> | jsonPath=<$expr>|equals=<v> | jsonPath=<$expr>|includes=<v>
             | jsonPath=<$expr>|exists | textIncludes=<t> | within=<ms>
```

e.g. `http:GET http://localhost:8025/api/v1/search?query=to:${email}|jsonPath=$.messages[*].Subject|includes=Reset your password`.
The kind is split at the first `:`, as now, so colons inside the URL do not matter. The URL runs to the first `|`.
A literal `|` in a URL must be written `%7C`, which a valid URL needs anyway. In assertion values, `\|` is a literal
pipe and `\\` a backslash. Each assertion is split at its first `=`. A `jsonPath=` must be followed by exactly one
operator. `describeCheck` writes the same grammar back, escaping as needed, and round-trip is tested.

**3. Substitution.** The check is stored as a template. `${name}` is resolved at evaluation time from the run's vars:
Journey params, which can already carry fixture outputs (`--param email='${setup.email}'`, `journey-api.ts:548`), and
`${setup.x}` directly from the recorded fixtures' bindings. Each value in the URL is percent-encoded as one
component (`resolveNavigateUrl`). Expected values are substituted verbatim. A **secret** param or secret setup
output is refused (`E_HTTP_CHECK_SECRET_REF`). The URL and the details are model-visible and persisted.
`explore-author-journey` must therefore stop baking the substituted text into this kind (`check-execute.ts:339`
substitutes before parsing). For `http:` checks it substitutes only to evaluate and keeps the template in `endState`.

**4. Operators and JSON path.** Move `parseJsonPath`/`selectJsonPath` (`cli/src/mission-fixtures.ts:391,:411`)
to `packages/recording/src/json-path.ts`, because the schema needs it and recording is the lowest layer. cli
re-exports them and wraps errors in `FixtureSpecError`. Add `[*]` (array fan-out) for checks only, through a new
`selectJsonValues(doc, path): unknown[]`. Fixture outputs keep scalar-only `selectJsonPath`, which refuses `[*]`.
A check holds when **any** selected value satisfies the operator:
- `equals`: the scalar's string form `===` v.
- `includes`: substring of a string scalar, or an array containing a scalar equal to v.
- `exists`: not undefined/null.

A body that is not JSON fails each `json` assertion with "response is not JSON". `textIncludes` is a substring
match on the raw body text. `status` is evaluated even when the body is ignored.

**5. Timing.** These checks are polled. Each attempt runs status and all assertions. The check passes on the first
attempt where everything holds. Otherwise attempts repeat every 500 ms until `withinMs` has passed. All waits go
through `clock` (`@jevitate/domain`): `clock.setTimeout`, plus the per-request `AbortController` timeout of
`min(5000, remaining)`, as in fixtures (`mission-fixtures.ts:848`). The mutation proof pays the full window once per
mutated end-state site. That is acceptable, and documented with `within=` as the knob.

**6. Authorization.**
- The check's origin must be in the effective allowlist (`isAuthorizedExploreTarget`). It is re-checked after
  substitution, so a bound value can never widen it.
- Parse/launch: `explore`/`explore-author-journey` refuse before launch (usage exit) when the origin is not in
  `--allow`.
- Lint: new error rule `http-check-off-allowlist` when the origin is not in `site` ∪ `metadata.allowedOrigins`.
- Run/verify: refused before launch, like the `--env` origin refusal (`environments.ts:383`).
- The author adds each `http:` origin to `metadata.allowedOrigins`. The human passed it with `--allow`, and the
  promote review shows it.
- `redirect: "manual"`: a 3xx is the answer, never followed. It fails the default 2xx.
- No extra private-network or loopback rule. This matches fixtures: the allowlist alone decides, and a dev outbox
  on `localhost:8025` is the main use.

**7. Credentials and redaction.**
- No credentials in v1: no cookies, no auth headers, `credentials` unused.
- The body is read through a stream with a **1 MiB cap**. Past the cap the check is unevaluable ("response exceeds
  1 MiB"). The JSON is never parsed partially.
- The body is never persisted or logged. A result `detail` quotes at most 200 chars: the selected values for a
  failed `json` assertion, or the body head for a failed `textIncludes`. It is run through `redactText` with the
  run's secrets.
- The URL is shown as the template (`describeNavigateUrl`: `<email>`, never the value).

**8. Where it runs, and the seam.** The explore package must not import cli. So:
- `packages/explore/src/http-check.ts` holds the pure judge: `judgeHttpResponse(check, {status, bodyText})` and the
  poll loop.
- It takes an injected port:
  `HttpProbe = (url: string, timeoutMs: number) => Promise<{ status: number; bodyText: string } | { error: string }>`.
- `OutcomeCheckContext` gets `httpProbe?` and `resolveRef?`. Without a probe, an `http` check fails closed:
  "unevaluable: this context cannot make HTTP checks".
- `evaluateOutcomeChecks` runs `http` checks last, after `reloadThen`, so the write has had the settle and reload
  time.
- `packages/cli/src/http-probe.ts` builds the probe (global fetch or injected `fetchImpl`, allowlist re-check,
  manual redirect, cap). It is wired into:
  - the goal mission config (explore, author takes, `check` suite goals)
  - `JourneyOutcomeChecks` (`journey-network-checks.ts:231`), and so run, verify and `--mutate`.
- Goal loop:
  - `http` checks are deferred to the final oracle like `reloadThen` (`goal-based/act.ts:163,:169`). They are never
    polled after each step.
  - **Vacuity:** the mission probes each `http` check once (no poll) before the first action. If it already holds,
    it is vacuous, with the same refusal and `--allow-vacuous-checks` downgrade as #202. A fixture reset makes it
    not hold.
- `SuccessCheckResult` gains `unevaluable?: true` for transport errors, timeouts, over-cap bodies and refusals.
  `JourneyOutcomeChecks` maps it to an `{ where: "unevaluable" }` failure.

**9. Lint.** An `http` end-state check is an effect site (`isEffectSite`, `lint.ts:160`). It satisfies
`no-persistence-check`, whose message changes to "no reloadThen or http end-state check". New warning
`http-check-without-reset`: an `http` check on a Journey with no recorded fixtures has no reset, so earlier mail can
make it pass.

**10. Mutation proof.** No rule change. If the write is skipped, the outbox stays empty after the fixture reset, the
check fails at `end-state` with its index, and `classifyMutation` (`mutation-proof.ts:296`) reports `sensitive`. If
the outbox is unreachable, the result is `unevaluable` → `cascade`, never false proof. verify `--mutate` must run the
recorded fixture setup (the reset) before **each** mutated replay. Confirm in #544 and test it here.

**11. MCP.** No new tool, and the allowlist boundary is unchanged. The authoring tool's `success` strings accept
`http:`. run_journey and verify need nothing new. The mcp-cli parity test needs only the help text.

## Open questions (maintainer)

- **Q1 Credentials for an authenticated outbox.** Default: none in v1. Later, opt in to a fixture `auth`
  (`secretField`/named identity) through the same `authHeaders`, with values never logged.
- **Q2 Method set.** Default: GET only. HEAD adds nothing. POST would make a "check" a write.
- **Q3 Default `withinMs`.** Default: 10 s, matching `DEFAULT_ORACLE_SETTLE_MS`, max 60 s.
- **Q4 Body cap.** Default: 1 MiB. A large outbox should be queried by a search URL, not listed.

## Test plan (atomic)

1. Schema: valid `http` check accepted; POST, a templated origin, a bad JSON path, `withinMs>60000` and an empty
   assertion set rejected.
2. `parseSuccessSpec`: grammar cases (`status`, `jsonPath`+each op, `textIncludes`, `within`, `\|` escape,
   `jsonPath` without an operator rejected); `describeCheck` round-trip.
3. `selectJsonValues`: `[*]` fan-out, nested, missing → `[]`; `selectJsonPath` still refuses `[*]`.
4. `judgeHttpResponse`: each operator, any-of semantics, non-JSON body, status default 2xx, 3xx not followed.
5. Poll on FakeClock: holds on the 3rd attempt → pass; never holds → fail after `withinMs`; transport error
   throughout → `unevaluable`.
6. Probe: off-allowlist (incl. after substitution) refused with no fetch; `redirect:"manual"`; over 1 MiB →
   unevaluable; secret ref refused.
7. Redaction: a secret in the body never appears in the detail; detail ≤200 chars; URL shows `<name>`.
8. `evaluateOutcomeChecks`: no probe → fail closed; `http` evaluated after `reloadThen`; order of results kept.
9. Goal mission: `http` deferred (no per-step probe); held before the first action → vacuous refusal.
10. Lint: `http` satisfies `no-persistence-check`; `http-check-off-allowlist`; `http-check-without-reset`.
11. Mutation: write skipped → `http` fails → `sensitive`; probe unevaluable → `cascade`; reset runs per replay.
12. Run/verify: off-allowlist `http` refused before launch; `--allow` admits it.
13. Real-browser e2e (`useSkippingTime`): fixture app plus an outbox server on a second port; author → promote
    without `--accept-weak` → `verify --mutate` sensitive.

## Implementation tasks (one Opus implementer, ~6 h)

1. `recording/src/json-path.ts` (move, add `[*]`/`selectJsonValues`); `recording/src/schema.ts` (`HttpCheck`,
   zod); cli `mission-fixtures.ts` re-export. Tests 1, 3.
2. `cli/src/explore-specs.ts` (grammar, help in `explore-cli/options.ts:74`); `explore/src/success-checks.ts`
   (`describeCheck`). Test 2.
3. `explore/src/http-check.ts` (judge, poll on `clock`); `outcome-checks.ts` (`httpProbe`, `resolveRef`,
   ordering, `unevaluable`). Tests 4, 5, 8.
4. `cli/src/http-probe.ts` (fetch, allowlist, cap, redact, ref resolution). Tests 6, 7.
5. Wiring:
   - `goal-based/act.ts` (defer) and `goal-based/checks.ts` (vacuity seed probe)
   - `explore-goal.ts`, `explore-author.ts` (keep templates; add origins to `allowedOrigins`), `check-execute.ts`
   - `journey-network-checks.ts`, `journey-api.ts` (preflight refusal), `journey-verify.ts` (`unevaluable` mapping)

   Tests 9, 11, 12.
6. `journey/src/lint.ts` (effect site, persistence, two new rules); `review-schema`/`readiness` text. Test 10.
7. E2E (13); `docs/` (success-check reference, safety.md: allowlist + no credentials); changeset;
   `pnpm lint` (`check-clock`), `pnpm check:no-fallback`.
