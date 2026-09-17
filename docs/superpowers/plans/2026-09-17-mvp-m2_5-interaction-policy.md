# M2.5 Interaction Policy & Humanized Timing — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add per-site humanized interaction timing (realistic typing cadence + pauses, think-time, reading dwell, inter-action gaps), inter-action throttling (min-interval, quiet hours), and persistent hourly/daily max-count budgets — all seeded/deterministic, DB-backed per site, with unconfigured sites running at full speed.

**Architecture:** Pure domain models (policy types, a seeded PRNG + Gaussian sampler, a most-restrictive throttle resolver, quiet-hours evaluation, a humanized `Pacer`, and an offline `simulateTiming`). SQLite gains `site_setting` (holds the policy), `budget_counter` (transactional hourly/daily reserve), and `action_activity` (min-interval last-seen). The `ActionRunner` (`@doit/runtime`) resolves the policy, runs a pure throttle gate, reserves budget, attaches a `PaceInteractions` ability to the actor, and returns a discriminated `outcome` (ok | throttled | denied). Screenplay interactions consult the pacer (typing char-by-char, inter-interaction gaps) through an injected `sleep` so tests never wait real time.

**Tech Stack:** builds on M1+M2. Adds `luxon` (timezone quiet-hours) to `@doit/domain`. Seeded PRNG is hand-rolled (mulberry32 + xmur3 + Box–Muller) — deterministic, no dependency.

**Spec:** `docs/superpowers/specs/2026-09-17-interaction-policy-design.md` (authoritative for this milestone) + CONOPS §5.5/§5.8. The plan argues from the spec; executors read both.

## Global Constraints

- **Node 20+**, ESM, **strict** TS project references; dependency direction inward toward `domain`/`application`.
- `domain` and site-integration modules must not import `playwright`/`better-sqlite3`/`kysely` (ESLint-enforced). `luxon` in `domain` is allowed (pure lib).
- **Determinism (binding):** all timing variation derives from a seeded PRNG (`seedFrom(runId, policyVersion)`); **no `Math.random`** in production code. Same inputs → identical delays.
- **Guardrail (binding, CONOPS §5.8):** timing is politeness/load-realism/UX, seeded & replayable, **not** detection evasion; hard limits (intervals, budgets, quiet hours) are enforced regardless; **timing never replaces a Playwright actionability/state assertion.**
- **Fast-path default:** a site with no policy → instant `fill()`, zero delays, no throttle overhead.
- New workspace deps → **stage `pnpm-lock.yaml`**. New packages/paths → add the vitest alias (`pkg()` for `packages/*`; explicit `fileURLToPath` for `apps/*` & `site-integrations/*`) and the root `tsconfig.json` reference.
- **All waiting goes through an injected `sleep(ms)`/`Clock`** so tests assert delay values without real time.
- Commit trailer: blank line then EXACTLY `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`. Stage explicit paths; never `git add -A` (untracked `graft/`, `.ignore`, `.gitignore` edits stay out).
- Keep M1+M2 green: `pnpm -r build && pnpm test && pnpm lint`.

---

### Task 1: Domain — policy types + schema

**Files:** Create `packages/domain/src/interaction-policy.ts`, `packages/domain/src/interaction-policy.test.ts`; modify `packages/domain/src/index.ts`.

**Interfaces — Produces:** `DistParams`, `TypingModel`, `InteractionPolicy`, `ThrottlePolicy`, `QuietHours`, `SitePolicy` (all from the design §1), and `SitePolicySchema` (zod) that parses a valid policy and rejects negatives.

- [ ] **Step 1: Failing test** — `interaction-policy.test.ts`:
```ts
import { expect, test } from "vitest";
import { SitePolicySchema } from "./interaction-policy.js";

test("valid policy parses; negative cps rejected", () => {
  const p = { version: "1", interaction: { typing: { charsPerSecond: 6, perKeyJitter: 0.3 } },
    throttles: { write: { minIntervalSeconds: 90, dailyLimit: 10 } } };
  expect(SitePolicySchema.parse(p).version).toBe("1");
  expect(() => SitePolicySchema.parse({ version: "1", interaction: { typing: { charsPerSecond: -1, perKeyJitter: 0.3 } } })).toThrow();
});
```
- [ ] **Step 2: Verify fail** — `pnpm test packages/domain/src/interaction-policy.test.ts` → module not found.
- [ ] **Step 3: Implement** — `interaction-policy.ts` with the interfaces from design §1 and:
```ts
import { z } from "zod";
const Dist = z.object({ mean: z.number().min(0), sd: z.number().min(0), min: z.number().min(0).optional(), max: z.number().min(0).optional() });
const Typing = z.object({ charsPerSecond: z.number().positive(), perKeyJitter: z.number().min(0).max(1),
  wordPauseMs: Dist.optional(), sentencePauseMs: Dist.optional(),
  hesitation: z.object({ probability: z.number().min(0).max(1), pauseMs: Dist }).optional() });
const Interaction = z.object({ typing: Typing.optional(), thinkBeforeActionMs: Dist.optional(),
  readingMsPerChar: z.number().min(0).optional(), maxReadingMs: z.number().min(0).optional(), interInteractionMs: Dist.optional() });
const Throttle = z.object({ minIntervalSeconds: z.number().min(0).optional(), hourlyLimit: z.number().int().min(0).optional(), dailyLimit: z.number().int().min(0).optional() });
export const SitePolicySchema = z.object({ version: z.string().min(1), interaction: Interaction.optional(),
  throttles: z.record(z.string(), Throttle).optional(),
  quietHours: z.object({ timezone: z.string().min(1), windows: z.array(z.object({ start: z.string(), end: z.string() })) }).optional() });
export type SitePolicy = z.infer<typeof SitePolicySchema>;
export type InteractionPolicy = z.infer<typeof Interaction>;
export type TypingModel = z.infer<typeof Typing>;
export type ThrottlePolicy = z.infer<typeof Throttle>;
export type DistParams = z.infer<typeof Dist>;
export type QuietHours = NonNullable<SitePolicy["quietHours"]>;
```
Append `export * from "./interaction-policy.js";` to `index.ts`.
- [ ] **Step 4: Verify pass**; **Step 5: Commit** `feat(domain): interaction/throttle policy types and schema`.

---

### Task 2: Domain — seeded PRNG + Gaussian

**Files:** Create `packages/domain/src/rng.ts`, `packages/domain/src/rng.test.ts`; modify `index.ts`.

**Produces:** `seedFrom(runId, policyVersion): number`, `makeRng(seed): () => number`, `gaussian(rng, p: DistParams): number` (Box–Muller, clamped to `[min,max]`).

- [ ] **Step 1: Failing test** — determinism is the contract:
```ts
import { expect, test } from "vitest";
import { seedFrom, makeRng, gaussian } from "./rng.js";

test("same seed → identical stream; different seed → different", () => {
  const a = makeRng(seedFrom("run1", "1")); const b = makeRng(seedFrom("run1", "1")); const c = makeRng(seedFrom("run2", "1"));
  const seqA = [a(), a(), a()]; const seqB = [b(), b(), b()];
  expect(seqA).toEqual(seqB);
  expect([c(), c(), c()]).not.toEqual(seqA);
  seqA.forEach((x) => { expect(x).toBeGreaterThanOrEqual(0); expect(x).toBeLessThan(1); });
});

test("gaussian clamps to [min,max] and is deterministic for a seed", () => {
  const r1 = makeRng(42); const r2 = makeRng(42);
  const p = { mean: 100, sd: 50, min: 60, max: 140 };
  const v1 = gaussian(r1, p); const v2 = gaussian(r2, p);
  expect(v1).toBe(v2);
  for (let i = 0; i < 200; i++) { const v = gaussian(r1, p); expect(v).toBeGreaterThanOrEqual(60); expect(v).toBeLessThanOrEqual(140); }
});
```
- [ ] **Step 2: Verify fail.**
- [ ] **Step 3: Implement** — `rng.ts`:
```ts
import type { DistParams } from "./interaction-policy.js";

export function seedFrom(runId: string, policyVersion: string): number {
  const str = `${runId}:${policyVersion}`;
  let h = 1779033703 ^ str.length;
  for (let i = 0; i < str.length; i++) { h = Math.imul(h ^ str.charCodeAt(i), 3432918353); h = (h << 13) | (h >>> 19); }
  h = Math.imul(h ^ (h >>> 16), 2246822507); h = Math.imul(h ^ (h >>> 13), 3266489909);
  return (h ^= h >>> 16) >>> 0;
}

export function makeRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

export function gaussian(rng: () => number, p: DistParams): number {
  const u1 = Math.max(rng(), 1e-12); const u2 = rng();
  const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  let v = p.mean + z * p.sd;
  if (p.min !== undefined) v = Math.max(p.min, v);
  if (p.max !== undefined) v = Math.min(p.max, v);
  return v;
}
```
Append export to `index.ts`.
- [ ] **Step 4: Verify pass**; **Step 5: Commit** `feat(domain): seeded PRNG and Gaussian sampler`.

---

### Task 3: Domain — throttle resolver

**Files:** Create `packages/domain/src/throttle-resolver.ts`, `.test.ts`; modify `index.ts`.

**Produces:** `resolveThrottle(layers: ThrottlePolicy[]): ThrottlePolicy` — most-restrictive: `minIntervalSeconds` = max of provided; `hourlyLimit`/`dailyLimit` = min of provided; undefined fields ignored.

- [ ] **Step 1: Failing test:**
```ts
import { expect, test } from "vitest";
import { resolveThrottle } from "./throttle-resolver.js";
test("most-restrictive wins", () => {
  expect(resolveThrottle([{ minIntervalSeconds: 30, dailyLimit: 20 }, { minIntervalSeconds: 90, dailyLimit: 10, hourlyLimit: 5 }]))
    .toEqual({ minIntervalSeconds: 90, dailyLimit: 10, hourlyLimit: 5 });
  expect(resolveThrottle([])).toEqual({});
});
```
- [ ] **Step 2: Verify fail.**
- [ ] **Step 3: Implement:**
```ts
import type { ThrottlePolicy } from "./interaction-policy.js";
export function resolveThrottle(layers: ThrottlePolicy[]): ThrottlePolicy {
  const out: ThrottlePolicy = {};
  for (const l of layers) {
    if (l.minIntervalSeconds !== undefined) out.minIntervalSeconds = Math.max(out.minIntervalSeconds ?? 0, l.minIntervalSeconds);
    if (l.hourlyLimit !== undefined) out.hourlyLimit = Math.min(out.hourlyLimit ?? Infinity, l.hourlyLimit);
    if (l.dailyLimit !== undefined) out.dailyLimit = Math.min(out.dailyLimit ?? Infinity, l.dailyLimit);
  }
  return out;
}
```
Append export.
- [ ] **Step 4: Verify pass**; **Step 5: Commit** `feat(domain): most-restrictive throttle resolver`.

---

### Task 4: Domain — quiet-hours evaluation (luxon)

**Files:** Create `packages/domain/src/quiet-hours.ts`, `.test.ts`; modify `index.ts`, `packages/domain/package.json` (add `luxon` + `@types/luxon` devDep).

**Produces:** `isWithinQuietHours(nowIso: string, qh: QuietHours): boolean` and `nextOpenAfter(nowIso: string, qh: QuietHours): string` (RFC-3339 of when the current closed window ends; if not currently closed, returns `nowIso`). Windows are `"HH:MM"` in `qh.timezone`; a window with `start > end` wraps past midnight.

- [ ] **Step 1: Failing test:**
```ts
import { expect, test } from "vitest";
import { isWithinQuietHours } from "./quiet-hours.js";
const qh = { timezone: "America/New_York", windows: [{ start: "20:00", end: "08:00" }] };
test("wrap-around midnight window", () => {
  expect(isWithinQuietHours("2026-09-17T02:00:00-04:00", qh)).toBe(true);  // 2am local → inside
  expect(isWithinQuietHours("2026-09-17T12:00:00-04:00", qh)).toBe(false); // noon → outside
});
```
- [ ] **Step 2: Verify fail** (module + luxon missing).
- [ ] **Step 3: Implement** — `pnpm add --filter @doit/domain luxon` and `pnpm add --filter @doit/domain -D @types/luxon`. `quiet-hours.ts` uses `DateTime.fromISO(nowIso, {zone: qh.timezone})`, compares minutes-of-day against each window (handling wrap when `startMin > endMin`), and `nextOpenAfter` returns the window `end` on the correct day as an ISO string. (Keep it pure; no `new Date()`.)
- [ ] **Step 4: Verify pass** (`pnpm test packages/domain/src/quiet-hours.test.ts`); **Step 5: Commit** `feat(domain): timezone quiet-hours evaluation` (stage `pnpm-lock.yaml`).

---

### Task 5: Domain — humanized Pacer (typing cadence + pauses)

**Files:** Create `packages/domain/src/pacer.ts`, `.test.ts`; modify `index.ts`.

**Produces:** `class Pacer { constructor(rng: () => number); typingDelays(text: string, m: TypingModel): number[]; think(m: InteractionPolicy): number; reading(nChars: number, m: InteractionPolicy): number; interInteraction(m: InteractionPolicy): number }`. `typingDelays` returns one delay (ms) per character: base `1000/charsPerSecond` sampled via `gaussian({mean:base, sd:base*perKeyJitter, min:base*0.4, max:base*3})`, plus `wordPauseMs` after a space, `sentencePauseMs` after `.?!`, plus a `hesitation.pauseMs` when `rng() < hesitation.probability`. `reading = min(nChars * (readingMsPerChar ?? 0), maxReadingMs ?? Infinity)`. `think`/`interInteraction` return `gaussian(...)` of their DistParams or 0 when absent.

- [ ] **Step 1: Failing test** (deterministic + shape):
```ts
import { expect, test } from "vitest";
import { makeRng } from "./rng.js";
import { Pacer } from "./pacer.js";

test("typingDelays: one per char, deterministic, ~ base cadence, pauses at boundaries", () => {
  const model = { charsPerSecond: 5, perKeyJitter: 0.2,
    wordPauseMs: { mean: 120, sd: 0, min: 120, max: 120 }, sentencePauseMs: { mean: 400, sd: 0, min: 400, max: 400 } };
  const d1 = new Pacer(makeRng(7)).typingDelays("Hi there.", model);
  const d2 = new Pacer(makeRng(7)).typingDelays("Hi there.", model);
  expect(d1).toEqual(d2);                         // deterministic
  expect(d1).toHaveLength("Hi there.".length);    // one per char
  const spaceIdx = "Hi there.".indexOf(" ");
  expect(d1[spaceIdx]).toBeGreaterThan(d1[0]);    // word pause adds time after the space
  expect(d1[d1.length - 1]).toBeGreaterThan(300); // sentence pause after "."
});
```
- [ ] **Step 2: Verify fail.**
- [ ] **Step 3: Implement** `pacer.ts` per the spec above (import `gaussian` from `./rng.js`, types from `./interaction-policy.js`). Append export.
- [ ] **Step 4: Verify pass**; **Step 5: Commit** `feat(domain): humanized Pacer (typing cadence, word/sentence/hesitation pauses)`.

---

### Task 6: Domain — offline timing simulator

**Files:** Create `packages/domain/src/simulate-timing.ts`, `.test.ts`; modify `index.ts`.

**Produces:** `PlannedStep = { kind:"type"; label:string; text:string } | { kind:"click"|"navigate"; label:string } | { kind:"read"; label:string; chars:number }`; `TimedStep = { kind:string; label:string; delayMs:number }`; `TimingProfile = { steps: TimedStep[]; totalMs:number }`; `simulateTiming(policy: InteractionPolicy, seed: number, script: PlannedStep[]): TimingProfile` — deterministically computes each step's delay (type → sum of `typingDelays`; click/navigate → `think` + `interInteraction`; read → `reading`) and the total. No browser, no I/O.

- [ ] **Step 1: Failing test:**
```ts
import { expect, test } from "vitest";
import { simulateTiming } from "./simulate-timing.js";
test("simulateTiming is deterministic and sums step delays", () => {
  const policy = { typing: { charsPerSecond: 5, perKeyJitter: 0 }, thinkBeforeActionMs: { mean: 300, sd: 0, min: 300, max: 300 }, readingMsPerChar: 50, maxReadingMs: 10000 };
  const script = [{ kind: "read", label: "inbox", chars: 100 }, { kind: "type", label: "reply", text: "hello" }, { kind: "click", label: "send" }] as const;
  const a = simulateTiming(policy, 123, script as any); const b = simulateTiming(policy, 123, script as any);
  expect(a).toEqual(b);
  expect(a.totalMs).toBe(a.steps.reduce((n, s) => n + s.delayMs, 0));
  expect(a.steps[0].delayMs).toBe(100 * 50); // reading dwell
});
```
- [ ] **Step 2: Verify fail**; **Step 3: Implement** (`makeRng(seed)` once, thread the rng through a `Pacer`); **Step 4: Verify pass**; **Step 5: Commit** `feat(domain): offline human-load timing simulator`.

---

### Task 7: Storage — migrations (site_setting, budget_counter, action_activity)

**Files:** Create `packages/storage-sqlite/src/migrations/2026-09-17-interaction-policy.ts`; modify `schema.ts` (+3 table types + `Database` entries), `migrator.ts` (append), `migrator.test.ts` (add a case).

**Produces:** `site_setting UNIQUE(site,account_id,key)`; `budget_counter UNIQUE(site,account_id,throttle_class,window_kind,window_start)` with `used INTEGER`; `action_activity` PK `(site,account_id,throttle_class)` with `last_at`. All `CREATE TABLE IF NOT EXISTS`.

- [ ] **Step 1: Failing test** (append): assert `budget_counter` rejects a duplicate `(site,account_id,throttle_class,window_kind,window_start)`.
- [ ] **Step 2: Verify fail**; **Step 3: Implement** the migration + `SiteSettingTable`/`BudgetCounterTable`/`ActionActivityTable` types + `Database` entries + append `[..., interactionPolicy]` in `migrator.ts`; **Step 4: Verify pass**; **Step 5: Commit** `feat(storage): site_setting, budget_counter, action_activity tables`.

---

### Task 8: Storage — SitePolicyRepository + port

**Files:** Create `packages/storage-sqlite/src/site-policy-repository.ts`, `.test.ts`; modify `packages/application/src/ports.ts`, `packages/storage-sqlite/src/index.ts`.

**Produces:** port `SitePolicyRepository { get(site, account): Promise<SitePolicy | null>; set(site, account, policy: SitePolicy): Promise<void> }`; `SqliteSitePolicyRepository` storing the policy JSON under key `"policy"`, validating with `SitePolicySchema` on read (throws on corrupt). `get` returns `null` when absent (→ full speed).

- [ ] **Step 1: Failing test** — set then get round-trips a policy; get on empty → null. **Step 2: Verify fail.** **Step 3: Implement** (upsert on `UNIQUE(site,account_id,key)`; `JSON.parse` → `SitePolicySchema.parse`). **Step 4: Verify pass.** **Step 5: Commit** `feat(storage): site policy repository`.

---

### Task 9: Storage — BudgetRepository + ActivityRepository

**Files:** Create `packages/storage-sqlite/src/budget-repository.ts`, `.test.ts`, `packages/storage-sqlite/src/activity-repository.ts`, `.test.ts`; modify `ports.ts`, `index.ts`.

**Produces:**
- port `BudgetRepository { reserve(site, account, cls, limits: {hourlyLimit?; dailyLimit?}, nowIso): Promise<{ allowed: boolean }> }` — ONE transaction: for each defined window (`hour` bucket = `nowIso` truncated to the hour; `day` = truncated to the day), `INSERT(…,used=1) ON CONFLICT DO UPDATE SET used=used+1 WHERE used < limit`; if any window has no applied change (already at limit) roll back → `{allowed:false}`; else `{allowed:true}`. Undefined limit → that window not checked.
- port `ActivityRepository { lastAt(site, account, cls): Promise<string | null>; stamp(site, account, cls, nowIso): Promise<void> }`.

- [ ] **Step 1: Failing tests** — budget: with `dailyLimit:2`, two reserves allowed, third denied; `hour` vs `day` tracked independently. activity: stamp then lastAt returns it. **Step 2: Verify fail.** **Step 3: Implement** (bucket helpers truncate the ISO string; use `executeTakeFirst().numUpdatedRows` to detect the at-limit no-op and roll back the transaction). **Step 4: Verify pass.** **Step 5: Commit** `feat(storage): transactional budget reserve + action activity`.

---

### Task 10: Domain — throttle gate decision (pure)

**Files:** Create `packages/domain/src/throttle-gate.ts`, `.test.ts`; modify `index.ts`.

**Produces:** `type GateDecision = { kind:"proceed" } | { kind:"wait"; ms:number } | { kind:"throttled"; reason:"quiet_hours"|"min_interval"; retryAfter:string }`; `evaluateGate(input: { nowIso:string; resolved: ThrottlePolicy; lastAtIso: string | null; quietHours?: QuietHours; maxInlineWaitMs:number }): GateDecision`. Order: quiet-hours (closed → throttled w/ `nextOpenAfter`), then min-interval (shortfall ≤ maxInlineWaitMs → `wait{ms}`; larger → `throttled{min_interval, retryAfter}`), else `proceed`. (Budget is reserved separately by the runner because it mutates.) Pure — no I/O, uses `isWithinQuietHours`/`nextOpenAfter`.

- [ ] **Step 1: Failing test** — quiet window → throttled(quiet_hours); recent lastAt within maxInlineWait → wait{ms>0}; old lastAt → proceed; large shortfall → throttled(min_interval). **Step 2: Verify fail.** **Step 3: Implement.** **Step 4: Verify pass.** **Step 5: Commit** `feat(domain): pure throttle gate decision`.

---

### Task 11: Runtime — runner enforcement + outcome

**Files:** modify `packages/runtime/src/runner.ts`, `packages/runtime/src/runner.test.ts`, `packages/runtime/package.json` (deps: `@doit/domain`, `@doit/application`; devDep `@doit/storage-sqlite` for tests), `tsconfig.json` refs.

**Interfaces — Consumes:** `evaluateGate`, `resolveThrottle`, `seedFrom` from `@doit/domain`; `SitePolicyRepository`/`BudgetRepository`/`ActivityRepository` ports from `@doit/application`; `PaceInteractions` from `@doit/screenplay` (Task 12).
**Produces:** `RunResult = { outcome:"ok"; output:unknown } | { outcome:"throttled"; reason:string; retryAfter:string } | { outcome:"denied"; reason:string; retryAfter:string }`. `RunRequest` gains `runId: string` and optional injected `sleep?: (ms:number)=>Promise<void>` (default real). `ActionRunner` constructor gains optional `{ policies, budgets, activity }` repos + `maxInlineWaitMs`. Flow: resolve policy (repos); no policy → **fast path** (today's behavior, `outcome:"ok"`). Else: `evaluateGate` → `throttled` returns without running; `wait` → `await sleep(ms)`; reserve budget (hourly+daily from resolved throttle for the action's `throttleClass`) → denied returns without running; open browser, build actor **with `PaceInteractions`** (policy + `Pacer(makeRng(seedFrom(runId, policy.version)))` + `sleep`), execute, parse output, stamp `activity`, `outcome:"ok"`; always close session.

- [ ] **Step 1: Failing tests** (fake repos + fake sleep + fake BrowserPort + Echo action): (a) no policy → ok, zero sleeps; (b) quiet-hours policy → `throttled`, action NOT executed; (c) budget exhausted → `denied`, not executed; (d) min-interval shortfall → `sleep` called then ok; (e) happy paced path → ok + activity stamped + budget reserved.
- [ ] **Step 2: Verify fail.** **Step 3: Implement** (keep input-parse before browser.open; keep the trace-on-error + finally-close from M2; PaceInteractions attached only when policy present). **Step 4: Verify pass** + `pnpm -r build` (no cycle). **Step 5: Commit** `feat(runtime): policy resolution, throttle gate, budget reserve, paced outcome` (stage lockfile).

---

### Task 12: Screenplay — PaceInteractions ability + paced typing

**Files:** Create `packages/screenplay/src/pace-interactions.ts`; modify `packages/screenplay/src/interactions.ts`, `packages/screenplay/src/cast-actor.ts`, `packages/screenplay/src/index.ts`, and their tests.

**Produces:** `class PaceInteractions implements Ability { kind="pace-interactions"; constructor(policy: InteractionPolicy, pacer: Pacer, sleep:(ms:number)=>Promise<void>) }` + `PaceInteractionsToken`. `Enter.theText`: if the actor has `PaceInteractions` with a `typing` model → type char-by-char (`locator.pressSequentially(text, { delay: 0 })` per char OR loop `await sleep(delay); locator.pressSequentially(char)`), awaiting the pacer's `typingDelays` between characters; else `fill()` (fast path). A pre-type `think` delay applies when configured. `CastActor.attemptsTo`: if the actor has `PaceInteractions`, `await sleep(pacer.interInteraction(policy))` between activities. `@doit/screenplay` gains `@doit/domain` as a dep (for `Pacer`/`InteractionPolicy` types).

- [ ] **Step 1: Failing test** (fake page/locator + fake sleep): with a `PaceInteractions` ability, `Enter.theText("hi")` records per-char pacing sleeps and types char-by-char; without it, `fill()` is called and no sleeps occur; `attemptsTo` inserts an inter-interaction sleep only when paced. **Step 2: Verify fail.** **Step 3: Implement** (guard everything on ability presence; all waits via injected `sleep`). **Step 4: Verify pass** + build. **Step 5: Commit** `feat(screenplay): PaceInteractions ability and humanized typing` (stage lockfile).

> Cross-package note (pre-flight): `@doit/screenplay` gaining `@doit/domain` must NOT create a cycle — domain depends on nothing internal, so screenplay→domain is safe. Confirm `pnpm -r build` has no cycle.

---

### Task 13: CLI — site policy + simulate

**Files:** modify `packages/cli/src/program.ts`, `packages/cli/src/program.test.ts`, `packages/cli/src/bin.ts`, `packages/cli/package.json` (deps: `@doit/domain`, `@doit/storage-sqlite`).

**Produces:** `brauto site policy get <site> [--account <a>] [--json]` and `brauto site policy set <site> --file <policy.json>` (validated by `SitePolicySchema`, written via `SqliteSitePolicyRepository`); `brauto site simulate <site> --script <script.json> [--seed <n>]` → prints a `TimingProfile` from `simulateTiming` using the site's stored `interaction` policy (or the file's). Wire a DB path (reuse the daemon/app db location; a `--db` override for tests). Envelope + exit codes as in M1.

- [ ] **Step 1: Failing test** — `site policy set` then `site policy get --json` round-trips via a temp `--db`; `site simulate` prints a profile with `totalMs`. **Step 2: Verify fail.** **Step 3: Implement.** **Step 4: Verify pass** + build + built-binary smoke. **Step 5: Commit** `feat(cli): site policy get/set and human-load simulate` (stage lockfile).

---

### Task 14: E2E — paced run + realism assertion

**Files:** Create `site-integrations/example-network/src/paced-e2e.test.ts`; modify its `package.json` devDeps if needed.

**Produces:** an opt-in real-browser test: set a site policy (typing cps + small think-time) for `example-network`, run `auth.login`/`inbox.list` through the `ActionRunner` with repos wired, assert `outcome:"ok"` and that a paced run takes measurably longer than an unpaced one (compare elapsed, or assert the recorded timing summary > 0). Plus a **deterministic realism assertion** (pure, no browser): over a fixed seed+text, the mean of `Pacer.typingDelays` ≈ `1000/charsPerSecond` within tolerance, and word/sentence pause positions carry extra delay.

- [ ] **Step 1: Failing test.** **Step 2: Verify fail.** **Step 3: Implement** (headless; generous timeout; no fixed sleeps in the browser path — pacing waits are the injected policy delays). **Step 4: Verify pass** + full `pnpm test`. **Step 5: Commit** `test(example-network): paced run and deterministic realism check` (stage lockfile if deps change).

---

### Task 15: M2.5 exit gate

- [ ] **Step 1:** `pnpm -r build` (no project-reference cycle).
- [ ] **Step 2:** `pnpm test` — all green incl. paced e2e.
- [ ] **Step 3:** `pnpm lint`; confirm no `Math.random` in production code (`grep -rn "Math.random" packages/ site-integrations/ --include=*.ts | grep -v test` → none) and no direct `playwright` import in `domain`/site packages.
- [ ] **Step 4:** Commit only if a config change was needed: `chore(m2.5): exit gate green — build, test, lint`.

---

## Self-Review

**1. Spec coverage (design 2026-09-17-interaction-policy):**
- Policy types + schema → T1 ✅; seeded PRNG → T2 ✅; resolver → T3 ✅; quiet hours → T4 ✅; humanized Pacer → T5 ✅; offline simulator → T6 ✅ (design §1, §"realism").
- Storage site_setting/budget_counter/action_activity → T7 ✅; policy repo → T8 ✅; transactional budget reserve + activity → T9 ✅ (design §2).
- Runner enforcement + outcome (quiet/min-interval/budget, fast path, PaceInteractions attach) → T10–T11 ✅ (design §3).
- Screenplay paced typing + inter-interaction + injected sleep → T12 ✅ (design §4).
- CLI policy + simulate → T13 ✅ (design §6); determinism/observability recorded via runner → T11 (design §5).
- Testing (deterministic exact-value, transactional budget, fake-sleep runner, statistical realism) → T2/T5/T6/T9/T11/T14 ✅ (design §7).

**2. Placeholder scan:** every model parameter and DB semantics is concrete; no "TBD". The "record timing summary to the event log" (design §5) is implemented minimally in T11 (counts + total paced ms) — not deferred.

**3. Type consistency:** `DistParams`, `TypingModel`, `InteractionPolicy`, `ThrottlePolicy`, `QuietHours`, `SitePolicy`, `seedFrom`/`makeRng`/`gaussian`, `resolveThrottle`, `isWithinQuietHours`/`nextOpenAfter`, `Pacer`, `simulateTiming`, `SitePolicyRepository`/`BudgetRepository`/`ActivityRepository`, `evaluateGate`/`GateDecision`, `PaceInteractions`/`PaceInteractionsToken`, `RunResult.outcome` — each defined once, reused verbatim downstream.

**4. Risks flagged for the controller's pre-flight scan:**
- **`RunResult` shape change** (adding the `outcome` discriminant) ripples to M2's `runner.test.ts` and the example-network e2e (which today read `res.output`). T11 must update those call sites (or keep `output` present on the `ok` variant so existing reads still compile) — controller should rule on keeping `output` on the ok variant to minimize churn.
- **`@doit/screenplay` → `@doit/domain`** new dependency (T12): safe (domain is a leaf) but confirm no cycle and add the tsconfig reference.
- **`luxon` in `@doit/domain`** (T4): allowed (pure), but it's the domain's first third-party runtime dep beyond zod/nanoid — confirm the forbidden-import ESLint rule doesn't flag it (it only restricts playwright/better-sqlite3/kysely).
- **Budget reserve rollback detection** (T9): relies on `numUpdatedRows`/`changes` to detect the at-limit no-op; verify the Kysely+better-sqlite3 return value distinguishes 0 updates, and roll back the whole transaction if any window fails.
