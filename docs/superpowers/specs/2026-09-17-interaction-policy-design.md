# Interaction Policy & Humanized Timing — Design (M2.5)

**Status:** Approved for planning
**Date:** 2026-09-17
**Scope:** Per-site interaction pacing (humanized typing + delays), inter-action throttling (min-interval, quiet hours), and persistent max-count budgets. Deterministic and seeded so runs replay and human load is modelable.
**Builds on:** M1 + M2 (both complete on `main`).
**Companion spec:** [`Browser_Automation_CONOPS_and_Functional_Specification.md`](../../../Browser_Automation_CONOPS_and_Functional_Specification.md) §5.5 (site settings/throttles) and §5.8 (deterministic sending & human-paced interaction). [`2026-09-16-browser-automation-mvp-design.md`](2026-09-16-browser-automation-mvp-design.md).

This document specifies *how* the humanized-interaction and throttling subsystem is built. Where it and the CONOPS could conflict, the CONOPS governs *what* must hold; this governs *how*.

---

## 0. Purpose and guardrail

The goal is to model, as realistically as configured, the **timing of a human operating a site** — typing cadence with natural pauses, think-time, reading dwell, and gaps between actions — plus hard **rate limits** (min-interval, quiet hours, hourly/daily max counts) per site. This exists so the platform can (a) be a polite, rate-respecting client of sites that need gentle pacing, (b) present understandable visible interaction, and (c) let us **measure/simulate what realistic human load looks like** against a site.

**Guardrail (from CONOPS §5.8, binding):** timing is *deterministic policy*, not random sleeps; the variation is seeded and replayable; it **must not be tuned to evade bot detection**; and **timing never substitutes for a postcondition** — Playwright actionability/state assertions still gate every step, and the hard limits (intervals, budgets, quiet hours) are enforced regardless of the realism model. Realism serves load-modeling and politeness, not stealth.

### Decisions taken
| Decision | Choice |
|---|---|
| Breadth | Full: humanized pacing + inter-action throttle + persistent max-count budgets |
| Config source | DB-backed `site_setting` (editable via CLI); resolver reads the DB |
| Variation | Seeded & deterministic (PRNG from run id + policy version); no `Math.random` |
| Default when a site has no policy | **Full speed** — instant `fill()`, zero delays, no throttle overhead |
| Realism aid | A pure `simulateTiming()` that computes the human-load timing profile of an interaction sequence offline (no browser) |

---

## 1. Domain model (pure — `@doit/domain`, no I/O)

```ts
// Humanized intra-action timing. Any absent sub-model = that behavior off.
export interface TypingModel {
  charsPerSecond: number;              // target mean cadence (e.g. 6 ≈ ~360 cpm)
  perKeyJitter: number;                // 0..1 relative SD of inter-key interval (e.g. 0.3)
  wordPauseMs?: DistParams;            // extra pause after a space
  sentencePauseMs?: DistParams;        // extra pause after . ! ?
  hesitation?: { probability: number; pauseMs: DistParams }; // occasional "thinking"
}
export interface DistParams { mean: number; sd: number; min?: number; max?: number } // Gaussian, clamped

export interface InteractionPolicy {
  typing?: TypingModel;                // absent → instant fill()
  thinkBeforeActionMs?: DistParams;    // pause before a click/navigate
  readingMsPerChar?: number;           // dwell ∝ visible text length (e.g. 48ms/char ≈ ~250 wpm)
  maxReadingMs?: number;               // cap on any single reading dwell
  interInteractionMs?: DistParams;     // gap between consecutive interactions
}

export type ThrottleClass = string;    // "read" | "write" | "new_contact" | ...
export interface ThrottlePolicy {
  minIntervalSeconds?: number;
  hourlyLimit?: number;
  dailyLimit?: number;
}
export interface QuietHours { timezone: string; windows: { start: string; end: string }[] } // "HH:MM"

export interface SitePolicy {
  version: string;                     // bumped on any edit; part of the replay seed
  interaction?: InteractionPolicy;
  throttles?: Record<ThrottleClass, ThrottlePolicy>;
  quietHours?: QuietHours;
}
```

- **`resolveThrottle(layers: ThrottlePolicy[]): ThrottlePolicy`** — most-restrictive-wins across global/site/account/class (min of intervals→max, min of limits). Pure. (CONOPS FR-027.)
- **`SitePolicySchema`** (zod) validates a stored policy; rejects negative/zero-nonsense values.

### Seeded, deterministic randomness
```ts
export function seedFrom(runId: string, policyVersion: string): number; // xmur3 hash → 32-bit
export function makeRng(seed: number): () => number;                    // mulberry32, uniform [0,1)
export function gaussian(rng: () => number, p: DistParams): number;     // Box–Muller, clamped to [min,max]
```
Every delay is a pure function of `(policy, seed, step index, text)`. Same inputs → identical sequence → replayable and unit-testable to exact values.

### The humanized timing model (the realism core)
Given a `TypingModel` and a `Pacer` (holds the seeded rng), typing `text` yields a per-character delay array:
1. base inter-key interval `b = 1000 / charsPerSecond` ms;
2. each key: `gaussian({mean:b, sd:b*perKeyJitter, min:b*0.4, max:b*3})`;
3. after a space: `+ gaussian(wordPauseMs)`; after `.?!`: `+ gaussian(sentencePauseMs)`;
4. with `hesitation.probability`: `+ gaussian(hesitation.pauseMs)`.
Other delays: `thinkBeforeAction = gaussian(thinkBeforeActionMs)`; `reading(nChars) = min(nChars * readingMsPerChar, maxReadingMs)`; `interInteraction = gaussian(interInteractionMs)`. All omitted models → 0.

### Offline load simulator (serves "test realistic human load")
```ts
export interface TimedStep { kind: "type" | "click" | "navigate" | "read" | "gap"; label: string; delayMs: number }
export interface TimingProfile { steps: TimedStep[]; totalMs: number }
export function simulateTiming(policy: InteractionPolicy, seed: number, script: PlannedStep[]): TimingProfile;
```
A pure function that computes the exact human-load timing of a scripted interaction sequence **without a browser** — so realistic human load (per-action time, actions/hour, total wall-clock) can be measured, compared across policies, and asserted in tests deterministically.

---

## 2. Storage (`@doit/storage-sqlite`)

- **`site_setting`** (site, account_id, key, value_json, updated_at) with `UNIQUE(site, account_id, key)`. Holds the `SitePolicy` JSON under a known key. `SitePolicyRepository.get(site, account) → SitePolicy | null` / `set(...)`. **`null` → full speed.**
- **`budget_counter`** (site, account_id, throttle_class, window_kind `hour|day`, window_start, used) with `UNIQUE(site, account_id, throttle_class, window_kind, window_start)`. `BudgetRepository.reserve(site, account, class, limits, now)` runs ONE transaction that, for each applicable window, computes the bucket (`window_start` = truncated hour/day of `now`), and `INSERT … ON CONFLICT DO UPDATE SET used = used + 1 WHERE used < limit`; if any window is at its limit, the whole reservation rolls back → `{ allowed: false, retryAfter }`. Else `{ allowed: true }`. (CONOPS §5.5 "transactional … before a command becomes runnable".)
- **`action_activity`** (site, account_id, throttle_class, last_at) — one row per (site,account,class); `min-interval` compares `now - last_at`. Updated after a successful run.

All timestamps RFC-3339 UTC; a `Clock` is injected. Migrations appended to the ordered array (`IF NOT EXISTS`, per the M1 convention).

---

## 3. Enforcement in the runner (`@doit/runtime`)

Before executing an action (after input parse, before/around `browser.open`), the runner consults a **`ThrottleGate`** (pure decision) + repos:

1. **Resolve** the site policy (DB). No policy → skip all of this (fast path).
2. **Quiet hours:** if `now` is inside a closed window → **do not run**; return `{ outcome: "throttled", reason: "quiet_hours", retryAfter }`.
3. **Min-interval:** effective `minIntervalSeconds` vs `now - last_at`. If the shortfall is ≤ a configured `maxInlineWaitMs` (default e.g. 5 s) → wait it out (via injected `sleep`); if larger → return `{ outcome: "throttled", reason: "min_interval", retryAfter }` (the daemon/caller reschedules rather than blocking).
4. **Budget:** `BudgetRepository.reserve(...)` transactionally. Exhausted → **do not run**; return `{ outcome: "denied", reason: "budget", retryAfter }`.
5. **Run** the action (with pacing, §4). On success, stamp `action_activity.last_at`. (Reserved budget stays consumed; §7 notes reconciliation for failures is deferred to M3's write path — reads are idempotent.)

`RunResult` gains a discriminated `outcome: "ok" | "throttled" | "denied"` (with `retryAfter?` and, for ok, the existing `output`). Callers/daemon treat throttled/denied as "try later," not failure. Fast path returns `ok` with zero added latency.

---

## 4. Screenplay pacing integration (`@doit/screenplay`)

- New ability **`PaceInteractions`** (holds the resolved `InteractionPolicy`, a seeded `Pacer`, and an injected `sleep(ms)`), with `PaceInteractionsToken`. The runner attaches it to the actor **only when a policy is present**.
- **`Enter.theText`**: if the actor has `PaceInteractions` with a `typing` model → type char-by-char via `locator.pressSequentially(text, { delay })` (or a per-char loop awaiting `pacer` delays); else today's `fill()` (fast path). A pre-type `thinkBeforeAction` delay applies when configured.
- **`Click`/`Navigate`**: apply `thinkBeforeAction` (and, for navigate targets with visible content, an optional `reading` dwell) when a pacer is present.
- **`CastActor.attemptsTo`**: between activities, if the actor has `PaceInteractions`, await `pacer.interInteractionDelay()`. When the ability is absent, `attemptsTo` is unchanged (no overhead).
- **All waiting goes through the injected `sleep`** so tests never consume real time and delays are asserted by value. Pacing never replaces an actionability check.

---

## 5. Determinism, replay & observability
- Seed = `seedFrom(runId, policy.version)`. The runner records `policyVersion` and `seed` on the run/receipt so the exact timing sequence replays.
- The runner emits (to the event log) the computed timing summary (per-class counts, total paced ms, budget reservations) for load analysis. `simulateTiming` (§1) gives the same numbers offline.

## 6. CLI (`@doit/cli`)
- `brauto site policy get <site> [--account a] [--json]` and `brauto site policy set <site> --file policy.json` (validated by `SitePolicySchema`) → DB `site_setting`. This realizes the M1 CLI's stubbed `site settings` surface for the policy.
- `brauto site simulate <site> --script script.json [--seed n]` → prints a `TimingProfile` (offline human-load estimate) so realistic load can be inspected without running a browser.

## 7. Testing strategy
- **Pure/deterministic:** exact-value tests of `makeRng`/`gaussian` (fixed seed → fixed sequence), the typing model (a known text+seed → known per-char delays incl. word/sentence/hesitation pauses), `resolveThrottle` (most-restrictive), quiet-hours evaluation (tz windows incl. wrap-around midnight), and `simulateTiming` totals.
- **Storage:** `budget_counter` transactional reserve (at-limit denies; concurrent reserve can't exceed limit on the single connection; hour vs day buckets independent); `site_setting` upsert; `action_activity` min-interval.
- **Runner (fake sleep + fake clock):** quiet-hours → throttled(no run); min-interval short → waits (fake sleep advanced), long → throttled; budget exhausted → denied(no run); happy path → ok + last_at stamped + budget reserved; **fast path (no policy) → ok, zero sleep calls**.
- **Screenplay (fake page + fake sleep):** typing policy → `pressSequentially`/per-char delays invoked with the seeded values; no policy → `fill()` and no sleeps.
- **Statistical realism check (seeded, deterministic):** over a fixed seed+text, assert the mean inter-key interval ≈ `1000/charsPerSecond` within tolerance and that word/sentence pauses land where expected — proving the model produces realistic-shaped timing, reproducibly.
- **E2E (opt-in):** an example-network policy drives a real paced `auth.login`/read and asserts the run stays `ok` and (via the timing summary) that paced time > 0; kept fast/headless.

## 8. Deferred
- Reconciliation/refund of reserved budget on failed writes (folds into M3's write path).
- A daemon scheduling loop that consumes `throttled/denied` retry-after (M1 has the command queue + `not_before`; wiring the gate into that loop is a later step — M2.5 returns the decision; the direct `ActionRunner` caller honors it).
- Cross-process budget correctness beyond the single better-sqlite3 connection (matches M1's current model).
- Scrolling realism beyond `maxViewportsPerStep` (basic increment only for now).

## 9. Self-review
- **Guardrail preserved:** deterministic/seeded, hard limits enforced, explicitly not evasion, postconditions still gate. ✅
- **Fast-path default:** no policy → instant, zero overhead, no storage reads on the pacing path beyond the single policy lookup (which returns null quickly). ✅
- **Realism + testability reconciled:** distributions are seeded so "realistic" and "deterministically testable" coexist; `simulateTiming` makes human load measurable offline. ✅
- **No placeholder decisions:** defaults given for every model parameter; DB schema and reserve semantics specified. ✅
- **Ambiguity:** "how realistic" is bounded by the configured `TypingModel`/`DistParams`; the model is intentionally a small, legible set of distributions rather than an open-ended behavioral emulator (keeps it testable and on the right side of the guardrail).
