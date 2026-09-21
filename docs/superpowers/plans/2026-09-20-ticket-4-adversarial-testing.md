# Adversarial Testing Mission — Implementation Plan (Ticket #4)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Status:** Proposed (plan — for review before execution)
**Date:** 2026-09-20
**Ticket:** [matt-cochran/jevitate#4](https://github.com/matt-cochran/jevitate/issues/4) — "Adversarial testing surfaces defects via trusted hard oracles and bounded misuse strategies." Paired site ticket: [#13](https://github.com/matt-cochran/jevitate/issues/13) ("the site presents adversarial testing as Available once it ships," `--strategy adversarial` as a live flag).

**Goal:** Add a `runAdversarialMission` to `@jevitate/explore`: a goal + "try to break it" run that checks a **trusted hard-signal defect oracle** (console errors, HTTP 5xx/failed requests, unhandled page exceptions, a user-supplied invariant) after every step, applies **bounded misuse strategies** (ordering violations, repeated/rapid actions, navigation during pending async, boundary/contradictory inputs) with input values chosen by field semantics, and — on a defect — stops, keeps the run `Recording` as the exact repro, and produces a triage narrative via the generation gateway. Jev's `Noul` "looks broken?" is a soft augment only; it never gates the stop decision.

**Architecture:** Reuses `@jevitate/explore`'s P1 primitives (`snapshotPage`, `executeAction`, `recordStep`, `assertAuthorizedExploreTarget`) plus a `PageSignalCollector` that attaches Playwright `console`/`pageerror`/`response` listeners **before** the mission navigates anywhere (so no signal window is missed) and drains them after each step. A misuse-strategy module picks the next `Decision` by deliberately violating normal flow (skip a required step, repeat the last action, navigate mid-async, or fill a field with a boundary/invalid value chosen by its role/name) instead of Jev's usual free-form op+target choice — Jev is only consulted for a *soft* "does this look broken?" signal that's attached to the triage context, never used to decide whether to stop.

**Tech Stack:** TypeScript (strict, ES2022, NodeNext), Vitest, pnpm workspaces, Playwright (via `@jevitate/playwright`), the real `@jevitate/example-site` fixture (Fastify) for browser-backed tests.

**Spec:** `docs/superpowers/specs/2026-09-19-autonomous-exploration-testing-design.md` §3.1 ("Adversarial E2E testing"), §6 (guardrails), §9 ("the oracle question" — adversarial: hard signals + Jev `Noul` as soft augment). Builds on `docs/superpowers/plans/2026-09-20-testing-missions-exploration-engine.md` (P1 engine + its P2 outline for `missions/adversarial.ts`).

## Global Constraints

- Node 20+, ESM, `strict: true`, project references (`tsc --build`) — mirror `tsconfig.base.json`.
- Dependency direction inward only: this plan only adds files under `packages/explore/` (a leaf package) and one additive touch to `packages/cli/`. Nothing depends on `@jevitate/explore`.
- **Repo gotcha:** packages have NO `"test"` script — run `pnpm exec vitest run <path>`, never `pnpm --filter <pkg> test` (that is a no-op).
- Git staging is explicit-path only (`git add <exact files>`), never `-A`/`.`.
- Commit trailer for every commit: `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.
- CI runs on **fake** gateways only (`FakeJudgmentGateway`/scripted local fakes + `FakeGenerationGateway`); no live Jev/OpenRouter test in this plan.
- Gitflow: branch from `dev`, land via a feature branch, merge back to `dev` (never commit straight to `main`).

## Assumed `@jevitate/explore` public API (Ticket #1 — for reconciliation)

Ticket #1 is being built concurrently; `packages/explore/` does not exist in the tree yet (verified: `ls packages/` has no `explore` entry). This plan is written against the planned surface from `docs/superpowers/plans/2026-09-20-testing-missions-exploration-engine.md`:

```ts
// bounds.ts
export interface Bounds { maxActions: number; maxDecisions: number; maxCandidates: number; }
export function defaultBounds(): Bounds;

// authorized-targets.ts
export class UnauthorizedExploreTargetError extends Error {}
export function assertAuthorizedExploreTarget(url: string, allowlist: readonly string[]): void;

// snapshot.ts
export interface Control {
  index: number; descriptor: TargetDescriptor; role?: string; name?: string; value?: string;
  visible: boolean; enabled: boolean;
}
export interface Snapshot { url: string; controls: Control[]; freshnessSignature: string; }
export async function snapshotPage(page: Page, opts: { maxCandidates: number }): Promise<Snapshot>;

// decide.ts
export type Op = "click" | "type" | "select" | "scroll_up" | "scroll_down" | "wait" | "done" | "blocked";
export interface Decision { op: Op; targetIndex?: number; }

// fill.ts
export async function fillValue(params: {
  generation: GenerationPort; goal: string; control: Control; history: HistoryEntry[];
}): Promise<{ text: string } | { text: null }>;

// act.ts
export interface ActResult { ok: boolean; reason?: string; }
export async function executeAction(params: {
  actor: Actor; page: Page; snapshot: Snapshot; decision: Decision; fillText?: string;
}): Promise<ActResult>;

// record.ts
export function recordStep(recording: Recording, params: {
  decision: Decision; snapshot: Snapshot; fillText?: string; timing: StepTiming;
}): Recording;
```

**Additive extension this plan assumes beyond the P1 plan's literal text** (flag for reconciliation with the ticket #1 owner): this mission does **not** call `fillValue` for its adversarial field values (it deliberately overrides with a boundary/invalid/empty value chosen by field semantics — never a generative guess); it only reuses `fillValue`'s discipline as a reference (never a real recipient, never invented PII) when deciding what a "contradictory" fill looks like. The only ticket-#1 surface this plan truly depends on is `assertAuthorizedExploreTarget`, `snapshotPage`, `executeAction`, `recordStep`, `defaultBounds`, `Control`, `Decision`, `Op`. If ticket #1 reshapes any of these, only Tasks 5–7 (the mission loop) need adjustment — Tasks 1–4 (`input-strategy.ts`, `defect-oracle.ts`, `misuse.ts`) are pure/Playwright-listener-only and independent of ticket #1's decide/fill internals.

## Guardrails (binding — from spec §6; each ships an "asserts-it-refuses" test in Task 8)

1. **Authoring/test plane only.** `assertAuthorizedExploreTarget` is called before any navigation.
2. **Bounded + fail-closed.** Hard `maxActions` cap; unknown/ambiguous never guesses an irreversible action — misuse strategies are restricted to `click`/`type`/`select`/`wait`/`navigate-within-allowlist`.
3. **No real sends / no secrets to models.** Adversarial input values are synthetic (never a real recipient, never real PII); the triage-narrative generation call only ever receives a redacted failure summary + URL, never raw form state.
4. **Independent/hard oracle; model-verdict-advisory-only.** The stop decision comes exclusively from `PageSignalCollector`'s hard signals or a user-supplied invariant — **never** from Jev's `Noul` "looks broken?" alone. This is the mission's single most important guardrail and gets a dedicated proof test (Task 7).
5. **Prompt-injection guard.** Every Jev/generation prompt this mission issues carries the injection-guard string.
6. **Not detection-evasion.** Misuse strategies stress the app's own logic (ordering, timing, boundary values) — never attempt to bypass rate limiting, spoof identity, or evade monitoring.

## File Structure

```
packages/explore/src/
  adversarial/
    input-strategy.ts          # chooseInputStrategy(control) + valueFor(strategy, control) — pure
    input-strategy.test.ts
    defect-oracle.ts           # PageSignalCollector — hard-signal listener/drain
    defect-oracle.test.ts
    misuse.ts                  # pickMisuseAction(snapshot, strategy, rng) — pure
    misuse.test.ts
  missions/
    adversarial.ts              # runAdversarialMission — the mission
    adversarial.test.ts
  adversarial-invariants.test.ts  # guardrail refusal contract (#1-#6)

apps/example-site/src/
  server.ts                    # ONE additive route: GET /boom -> 500 (Task 2, for a deterministic 5xx fixture)

packages/cli/src/
  explore-api.ts                # + runAdversarialCliMission wiring
  program.ts                    # + `explore --strategy adversarial`
  explore-api.test.ts           # + adversarial-strategy wiring test (no browser)
```

---

## Task 1: `input-strategy.ts` — field-semantics value selection (pure)

**Files:**
- Create: `packages/explore/src/adversarial/input-strategy.ts`
- Test: `packages/explore/src/adversarial/input-strategy.test.ts`

**Interfaces:**
- Consumes: `Control` (ticket #1, `@jevitate/explore`).
- Produces: `type InputStrategy = "normal" | "empty" | "boundary" | "long" | "unicode" | "invalid"`; `chooseInputStrategy(control: Control, tried: readonly InputStrategy[]): InputStrategy | null`; `valueFor(strategy: InputStrategy, control: Control): string` — consumed by Tasks 5–7.

- [ ] **Step 1: Write the failing test**

```ts
// packages/explore/src/adversarial/input-strategy.test.ts
import { describe, expect, test } from "vitest";
import { chooseInputStrategy, valueFor } from "./input-strategy.js";
import type { Control } from "../index.js";

function control(over: Partial<Control>): Control {
  return { index: 0, descriptor: {}, visible: true, enabled: true, ...over };
}

describe("chooseInputStrategy", () => {
  test("picks 'empty' first for any textbox not yet tried with it", () => {
    const c = control({ role: "textbox", name: "Username" });
    expect(chooseInputStrategy(c, [])).toBe("empty");
  });

  test("advances to the next untried strategy in a fixed order", () => {
    const c = control({ role: "textbox", name: "Username" });
    expect(chooseInputStrategy(c, ["empty"])).toBe("boundary");
    expect(chooseInputStrategy(c, ["empty", "boundary"])).toBe("long");
  });

  test("returns null once every strategy has been tried (bounded — never repeats forever)", () => {
    const c = control({ role: "textbox", name: "Username" });
    expect(chooseInputStrategy(c, ["empty", "boundary", "long", "unicode", "invalid", "normal"])).toBeNull();
  });
});

describe("valueFor", () => {
  test("an email-named field gets a syntactically-invalid value under 'invalid'", () => {
    const c = control({ role: "textbox", name: "Email address" });
    expect(valueFor("invalid", c)).toBe("not-an-email");
  });

  test("a numeric/quantity-named field gets a negative value under 'invalid'", () => {
    const c = control({ role: "textbox", name: "Quantity" });
    expect(valueFor("invalid", c)).toBe("-1");
  });

  test("'empty' always yields the empty string regardless of field semantics", () => {
    expect(valueFor("empty", control({ name: "Anything" }))).toBe("");
  });

  test("'long' yields a value far past typical field length limits", () => {
    expect(valueFor("long", control({ name: "Username" })).length).toBeGreaterThan(1000);
  });

  test("'unicode' includes multi-byte/RTL characters, never invents real PII", () => {
    const v = valueFor("unicode", control({ name: "Username" }));
    expect(v).toMatch(/[^\x00-\x7F]/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run packages/explore/src/adversarial/input-strategy.test.ts`
Expected: FAIL — `Cannot find module './input-strategy.js'`.

- [ ] **Step 3: Write minimal implementation**

```ts
// packages/explore/src/adversarial/input-strategy.ts
import type { Control } from "../index.js";

export type InputStrategy = "empty" | "boundary" | "long" | "unicode" | "invalid" | "normal";

const ORDER: readonly InputStrategy[] = ["empty", "boundary", "long", "unicode", "invalid", "normal"];

/** Bounded: returns null once every strategy in ORDER has been tried for this
 *  control, so a misuse loop can never cycle forever on one field. */
export function chooseInputStrategy(_control: Control, tried: readonly InputStrategy[]): InputStrategy | null {
  return ORDER.find((s) => !tried.includes(s)) ?? null;
}

function isEmailLike(name: string): boolean {
  return /e-?mail/i.test(name);
}
function isNumericLike(name: string): boolean {
  return /quantity|qty|amount|count|price|age/i.test(name);
}

/** Field-semantics value selection — NEVER blind fuzz (spec §3.1). */
export function valueFor(strategy: InputStrategy, control: Control): string {
  const name = control.name ?? "";
  switch (strategy) {
    case "empty": return "";
    case "boundary": return isNumericLike(name) ? "0" : "x";
    case "long": return "x".repeat(2000);
    case "unicode": return "مرحبا 😀 тест";
    case "invalid": return isEmailLike(name) ? "not-an-email" : isNumericLike(name) ? "-1" : "\u0000invalid\u0000";
    case "normal": return isEmailLike(name) ? "test@example.test" : "test-value";
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm exec vitest run packages/explore/src/adversarial/input-strategy.test.ts`
Expected: PASS (8 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/explore/src/adversarial/input-strategy.ts packages/explore/src/adversarial/input-strategy.test.ts
git commit -m "$(cat <<'EOF'
feat(explore): add adversarial input-strategy (field-semantics value choice)

Selects boundary/empty/long/unicode/invalid values BY FIELD SEMANTICS
(spec §3.1: "never blind fuzz"), bounded to a fixed strategy order per
control so a misuse loop can never cycle a single field forever.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: `PageSignalCollector` — trusted hard-signal oracle

**Files:**
- Create: `packages/explore/src/adversarial/defect-oracle.ts`
- Test: `packages/explore/src/adversarial/defect-oracle.test.ts`
- Modify: `apps/example-site/src/server.ts` (additive: one 500-returning route)

**Interfaces:**
- Consumes: Playwright `Page` (`page.on("console"|"pageerror"|"response", ...)`).
- Produces: `type DefectSignal = { kind: "console-error" | "http-5xx" | "failed-request" | "page-error"; detail: string; url?: string; status?: number }`; `class PageSignalCollector { constructor(page: Page); drain(): DefectSignal[]; }` — consumed by Tasks 5–7.

- [ ] **Step 1: Add a deterministic 5xx fixture route (additive)**

```ts
// apps/example-site/src/server.ts — add, alongside the other app.get(...) routes:
  app.get("/boom", async (_req, reply) => {
    reply.code(500).send("internal error");
  });
```

- [ ] **Step 2: Write the failing test**

```ts
// packages/explore/src/adversarial/defect-oracle.test.ts
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { chromium, type Browser, type Page } from "playwright";
import { startServer } from "@jevitate/example-site";
import { PageSignalCollector } from "./defect-oracle.js";

let site: { url: string; close(): Promise<void> };
let browser: Browser;
let page: Page;

beforeAll(async () => {
  site = await startServer();
  browser = await chromium.launch();
  page = await browser.newPage();
});
afterAll(async () => {
  await browser.close();
  await site.close();
});

describe("PageSignalCollector", () => {
  test("captures a real console.error", async () => {
    const collector = new PageSignalCollector(page);
    await page.goto(`${site.url}/login`);
    await page.evaluate(() => console.error("synthetic-boom"));
    await page.waitForTimeout(50);
    const signals = collector.drain();
    expect(signals.some((s) => s.kind === "console-error" && s.detail.includes("synthetic-boom"))).toBe(true);
  });

  test("captures a real HTTP 5xx response", async () => {
    const collector = new PageSignalCollector(page);
    await page.goto(`${site.url}/boom`).catch(() => undefined); // navigation itself 500s; ignore nav error
    const signals = collector.drain();
    expect(signals.some((s) => s.kind === "http-5xx" && s.status === 500)).toBe(true);
  });

  test("drain() clears the buffer — signals are never double-counted", async () => {
    const collector = new PageSignalCollector(page);
    await page.evaluate(() => console.error("only-once"));
    await page.waitForTimeout(50);
    collector.drain();
    const second = collector.drain();
    expect(second).toEqual([]);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm exec vitest run packages/explore/src/adversarial/defect-oracle.test.ts`
Expected: FAIL — `Cannot find module './defect-oracle.js'`.

- [ ] **Step 4: Write minimal implementation**

```ts
// packages/explore/src/adversarial/defect-oracle.ts
import type { Page } from "playwright";

export type DefectSignal =
  | { kind: "console-error"; detail: string }
  | { kind: "page-error"; detail: string }
  | { kind: "http-5xx"; detail: string; url: string; status: number }
  | { kind: "failed-request"; detail: string; url: string };

/**
 * Trusted hard-signal oracle (spec §3.1/§9): JS console errors, HTTP 5xx,
 * failed requests, unhandled exceptions. Listeners are attached at
 * construction time (before any navigation) so no signal window is missed.
 * `drain()` returns everything buffered since the last drain and clears the
 * buffer — never double-counts a signal across two checks.
 */
export class PageSignalCollector {
  private buffer: DefectSignal[] = [];

  constructor(page: Page) {
    page.on("console", (msg) => {
      if (msg.type() === "error") this.buffer.push({ kind: "console-error", detail: msg.text() });
    });
    page.on("pageerror", (err) => {
      this.buffer.push({ kind: "page-error", detail: err.message });
    });
    page.on("response", (response) => {
      const status = response.status();
      if (status >= 500) {
        this.buffer.push({ kind: "http-5xx", detail: `${status} ${response.url()}`, url: response.url(), status });
      }
    });
    page.on("requestfailed", (request) => {
      this.buffer.push({
        kind: "failed-request",
        detail: request.failure()?.errorText ?? "request failed",
        url: request.url(),
      });
    });
  }

  drain(): DefectSignal[] {
    const out = this.buffer;
    this.buffer = [];
    return out;
  }
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm exec vitest run packages/explore/src/adversarial/defect-oracle.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 6: Commit**

```bash
git add apps/example-site/src/server.ts packages/explore/src/adversarial/defect-oracle.ts packages/explore/src/adversarial/defect-oracle.test.ts
git commit -m "$(cat <<'EOF'
feat(explore): add PageSignalCollector — trusted hard-signal defect oracle

Console errors, HTTP 5xx, failed requests, unhandled page exceptions
(spec §3.1's "trusted hard signals"). Listeners attach at construction,
before any navigation, so no signal window is missed.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: `misuse.ts` — ordering-violation + repeat-rapid strategies (pure)

**Files:**
- Create: `packages/explore/src/adversarial/misuse.ts`
- Test: `packages/explore/src/adversarial/misuse.test.ts`

**Interfaces:**
- Consumes: `Control`, `Snapshot`, `Decision`, `Op` (ticket #1).
- Produces: `type MisuseStrategy = "ordering-violation" | "repeat-rapid" | "nav-during-pending" | "boundary-input" | "contradictory-actions"`; `pickMisuseAction(params: { snapshot: Snapshot; strategy: MisuseStrategy; lastDecision?: Decision; rng: () => number }): Decision | null` — consumed by Tasks 4, 5–7.

- [ ] **Step 1: Write the failing test**

```ts
// packages/explore/src/adversarial/misuse.test.ts
import { describe, expect, test } from "vitest";
import { pickMisuseAction } from "./misuse.js";
import type { Snapshot } from "../index.js";

const snapshot: Snapshot = {
  url: "https://x.test/checkout",
  freshnessSignature: "s",
  controls: [
    { index: 0, descriptor: {}, role: "textbox", name: "Username", visible: true, enabled: true },
    { index: 1, descriptor: {}, role: "button", name: "Submit", visible: true, enabled: true },
    { index: 2, descriptor: {}, role: "button", name: "Cancel", visible: true, enabled: true },
  ],
};

describe("pickMisuseAction — ordering-violation", () => {
  test("prefers a terminal-looking control (Submit/Confirm/Pay) BEFORE any required field is filled", () => {
    const decision = pickMisuseAction({ snapshot, strategy: "ordering-violation", rng: () => 0 });
    expect(decision).toEqual({ op: "click", targetIndex: 1 });
  });

  test("returns null when no terminal-looking control exists", () => {
    const noTerminal: Snapshot = { ...snapshot, controls: [snapshot.controls[0]!] };
    expect(pickMisuseAction({ snapshot: noTerminal, strategy: "ordering-violation", rng: () => 0 })).toBeNull();
  });
});

describe("pickMisuseAction — repeat-rapid", () => {
  test("re-issues the last decision verbatim", () => {
    const last = { op: "click" as const, targetIndex: 2 };
    const decision = pickMisuseAction({ snapshot, strategy: "repeat-rapid", lastDecision: last, rng: () => 0 });
    expect(decision).toEqual(last);
  });

  test("returns null when there is no last decision to repeat", () => {
    expect(pickMisuseAction({ snapshot, strategy: "repeat-rapid", rng: () => 0 })).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run packages/explore/src/adversarial/misuse.test.ts`
Expected: FAIL — `Cannot find module './misuse.js'`.

- [ ] **Step 3: Write minimal implementation**

```ts
// packages/explore/src/adversarial/misuse.ts
import type { Control, Decision, Op, Snapshot } from "../index.js";

export type MisuseStrategy =
  | "ordering-violation" | "repeat-rapid" | "nav-during-pending" | "boundary-input" | "contradictory-actions";

const TERMINAL_NAME = /submit|confirm|pay|complete|checkout|send/i;

function terminalControl(controls: readonly Control[]): Control | undefined {
  return controls.find((c) => c.role === "button" && TERMINAL_NAME.test(c.name ?? "") && c.enabled && c.visible);
}

export function pickMisuseAction(params: {
  snapshot: Snapshot;
  strategy: MisuseStrategy;
  lastDecision?: Decision;
  rng: () => number;
}): Decision | null {
  switch (params.strategy) {
    case "ordering-violation": {
      const terminal = terminalControl(params.snapshot.controls);
      return terminal ? { op: "click" as Op, targetIndex: terminal.index } : null;
    }
    case "repeat-rapid":
      return params.lastDecision ?? null;
    default:
      return null; // Tasks 4 fills in nav-during-pending / boundary-input / contradictory-actions
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm exec vitest run packages/explore/src/adversarial/misuse.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/explore/src/adversarial/misuse.ts packages/explore/src/adversarial/misuse.test.ts
git commit -m "$(cat <<'EOF'
feat(explore): add misuse strategies (ordering-violation, repeat-rapid)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: `misuse.ts` — boundary-input, contradictory-actions, nav-during-pending

**Files:**
- Modify: `packages/explore/src/adversarial/misuse.ts`
- Modify: `packages/explore/src/adversarial/misuse.test.ts`

**Interfaces:**
- Consumes: `chooseInputStrategy`/`valueFor` (Task 1) — `boundary-input` composes with `input-strategy.ts`.
- Produces: extends `pickMisuseAction` to handle the remaining three strategies; adds `type MisuseDecision = Decision & { fillText?: string }`.

- [ ] **Step 1: Write the failing test**

```ts
// packages/explore/src/adversarial/misuse.test.ts — add:
describe("pickMisuseAction — boundary-input", () => {
  test("targets the first enabled textbox with an 'invalid'-strategy value", () => {
    const decision = pickMisuseAction({ snapshot, strategy: "boundary-input", rng: () => 0 });
    expect(decision).toMatchObject({ op: "type", targetIndex: 0 });
    expect((decision as { fillText?: string }).fillText).toBeTruthy();
  });

  test("returns null when there is no textbox to target", () => {
    const noText: Snapshot = { ...snapshot, controls: snapshot.controls.filter((c) => c.role !== "textbox") };
    expect(pickMisuseAction({ snapshot: noText, strategy: "boundary-input", rng: () => 0 })).toBeNull();
  });
});

describe("pickMisuseAction — contradictory-actions", () => {
  test("picks Cancel when the last decision targeted Submit (or vice versa) — a same-step contradiction", () => {
    const decision = pickMisuseAction({
      snapshot, strategy: "contradictory-actions", lastDecision: { op: "click", targetIndex: 1 }, rng: () => 0,
    });
    expect(decision).toEqual({ op: "click", targetIndex: 2 });
  });

  test("returns null when there is no opposing control to pick", () => {
    const onlyOne: Snapshot = { ...snapshot, controls: [snapshot.controls[1]!] };
    expect(
      pickMisuseAction({ snapshot: onlyOne, strategy: "contradictory-actions", lastDecision: { op: "click", targetIndex: 1 }, rng: () => 0 }),
    ).toBeNull();
  });
});

describe("pickMisuseAction — nav-during-pending", () => {
  test("returns a scroll_down as a stand-in 'do something else while X is pending' action", () => {
    // The real "during pending async" timing is orchestrated by the mission
    // loop (Task 6), which fires this action WITHOUT awaiting the prior
    // action's network settle. Here we only verify the pure action choice.
    const decision = pickMisuseAction({ snapshot, strategy: "nav-during-pending", rng: () => 0 });
    expect(decision).toEqual({ op: "scroll_down" });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run packages/explore/src/adversarial/misuse.test.ts`
Expected: FAIL — the new strategies fall through to `default: return null`, so `boundary-input`/`contradictory-actions` tests fail (`nav-during-pending` already returns `null` which mismatches the expected `{op:"scroll_down"}`).

- [ ] **Step 3: Extend the implementation**

```ts
// packages/explore/src/adversarial/misuse.ts — replace the whole file:
import type { Control, Decision, Op, Snapshot } from "../index.js";
import { chooseInputStrategy, valueFor } from "./input-strategy.js";

export type MisuseStrategy =
  | "ordering-violation" | "repeat-rapid" | "nav-during-pending" | "boundary-input" | "contradictory-actions";

export type MisuseDecision = Decision & { fillText?: string };

const TERMINAL_NAME = /submit|confirm|pay|complete|checkout|send/i;
const OPPOSING_NAME = /cancel|back|reject|decline/i;

function terminalControl(controls: readonly Control[]): Control | undefined {
  return controls.find((c) => c.role === "button" && TERMINAL_NAME.test(c.name ?? "") && c.enabled && c.visible);
}

function firstTextbox(controls: readonly Control[]): Control | undefined {
  return controls.find((c) => c.role === "textbox" && c.enabled && c.visible);
}

export function pickMisuseAction(params: {
  snapshot: Snapshot;
  strategy: MisuseStrategy;
  lastDecision?: Decision;
  rng: () => number;
}): MisuseDecision | null {
  switch (params.strategy) {
    case "ordering-violation": {
      const terminal = terminalControl(params.snapshot.controls);
      return terminal ? { op: "click" as Op, targetIndex: terminal.index } : null;
    }
    case "repeat-rapid":
      return params.lastDecision ?? null;
    case "boundary-input": {
      const textbox = firstTextbox(params.snapshot.controls);
      if (!textbox) return null;
      const strategy = chooseInputStrategy(textbox, []) ?? "invalid";
      return { op: "type" as Op, targetIndex: textbox.index, fillText: valueFor("invalid", textbox), ...{ strategy } as never };
    }
    case "contradictory-actions": {
      if (!params.lastDecision || params.lastDecision.targetIndex === undefined) return null;
      const last = params.snapshot.controls[params.lastDecision.targetIndex];
      if (!last) return null;
      const opposing = TERMINAL_NAME.test(last.name ?? "")
        ? params.snapshot.controls.find((c) => OPPOSING_NAME.test(c.name ?? "") && c.enabled && c.visible)
        : undefined;
      return opposing ? { op: "click" as Op, targetIndex: opposing.index } : null;
    }
    case "nav-during-pending":
      // The mission loop (Task 6) is what actually races this against a
      // pending request; this pure function only chooses "do something
      // else immediately" rather than performing the race itself.
      return { op: "scroll_down" as Op };
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm exec vitest run packages/explore/src/adversarial/misuse.test.ts`
Expected: PASS (10 tests). Note: the `boundary-input` test only asserts `fillText` is truthy, not equal to a specific value — fix the implementation's odd `...{ strategy } as never` spread (dead code, a leftover from an earlier draft) before committing:

```ts
    case "boundary-input": {
      const textbox = firstTextbox(params.snapshot.controls);
      if (!textbox) return null;
      return { op: "type" as Op, targetIndex: textbox.index, fillText: valueFor("invalid", textbox) };
    }
```

- [ ] **Step 5: Re-run to confirm the cleanup didn't break anything**

Run: `pnpm exec vitest run packages/explore/src/adversarial/misuse.test.ts`
Expected: PASS (10 tests).

- [ ] **Step 6: Commit**

```bash
git add packages/explore/src/adversarial/misuse.ts packages/explore/src/adversarial/misuse.test.ts
git commit -m "$(cat <<'EOF'
feat(explore): add boundary-input, contradictory-actions, nav-during-pending

Completes the five bounded misuse strategies from spec §3.1. boundary-input
composes with input-strategy.ts's field-semantics value choice; the other
two are pure action-choice, with nav-during-pending's actual race handled
by the mission loop (Task 6).

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: `runAdversarialMission` — clean run (no defect)

**Files:**
- Create: `packages/explore/src/missions/adversarial.ts`
- Test: `packages/explore/src/missions/adversarial.test.ts`

**Interfaces:**
- Consumes: `PageSignalCollector` (Task 2); `pickMisuseAction`/`MisuseStrategy` (Tasks 3–4); `assertAuthorizedExploreTarget`, `snapshotPage`, `executeAction`, `recordStep`, `defaultBounds` (ticket #1); `FakeJudgmentGateway`, `FakeGenerationGateway` (`@jevitate/ai-core`); `startServer` (`@jevitate/example-site`).
- Produces: `interface AdversarialDefect { signals: DefectSignal[]; url: string; recording: Recording; triage: { summary: string; likelyCause: string } }`; `type AdversarialOutcome = { outcome: "clean"; recording: Recording } | { outcome: "cap"; recording: Recording } | { outcome: "defect"; defect: AdversarialDefect }`; `runAdversarialMission(params): Promise<AdversarialOutcome>` — consumed by Tasks 6–9.

- [ ] **Step 1: Write the failing test**

```ts
// packages/explore/src/missions/adversarial.test.ts
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer } from "@jevitate/example-site";
import { PlaywrightBrowserPort } from "@jevitate/playwright";
import { CastActor, BrowseTheWeb } from "@jevitate/screenplay";
import { FakeJudgmentGateway, FakeGenerationGateway } from "@jevitate/ai-core";
import { runAdversarialMission } from "./adversarial.js";

let site: { url: string; close(): Promise<void> };
let profileDir: string;
let session: { close(): Promise<void>; page: import("playwright").Page };
let actor: CastActor;

beforeAll(async () => {
  site = await startServer();
  profileDir = await mkdtemp(join(tmpdir(), "jevitate-adversarial-"));
  const browserPort = new PlaywrightBrowserPort();
  session = await browserPort.open({ profileDir, headless: true, allowedOrigins: [site.url], baseUrl: site.url });
  actor = CastActor.named("adversary").whoCan(new BrowseTheWeb(session, [site.url]));
});
afterAll(async () => {
  await session.close();
  await site.close();
  await rm(profileDir, { recursive: true, force: true });
});

describe("runAdversarialMission — clean run", () => {
  test("a well-behaved page under bounded misuse strategies reports 'clean'", async () => {
    const judgment = new FakeJudgmentGateway({ looksBroken: { kind: "noul", value: false, probability: 0.1 } });
    const generation = new FakeGenerationGateway();
    const result = await runAdversarialMission({
      page: session.page, actor, judgment, generation,
      seedUrl: `${site.url}/login`, allowlist: [site.url],
      strategies: ["ordering-violation", "repeat-rapid", "boundary-input"],
    });
    expect(result.outcome === "clean" || result.outcome === "cap").toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run packages/explore/src/missions/adversarial.test.ts`
Expected: FAIL — `Cannot find module './adversarial.js'`.

- [ ] **Step 3: Write minimal implementation**

```ts
// packages/explore/src/missions/adversarial.ts
import type { Page } from "playwright";
import type { Actor } from "@jevitate/screenplay";
import { Navigate } from "@jevitate/screenplay";
import type { Recording } from "@jevitate/recording";
import type { JudgmentPort, NoulAnswer, GenerationPort } from "@jevitate/ai-core";
import {
  assertAuthorizedExploreTarget, snapshotPage, executeAction, recordStep, defaultBounds,
  type Bounds, type Decision,
} from "../index.js";
import { PageSignalCollector, type DefectSignal } from "../adversarial/defect-oracle.js";
import { pickMisuseAction, type MisuseStrategy } from "../adversarial/misuse.js";

export interface AdversarialDefect {
  signals: DefectSignal[];
  url: string;
  recording: Recording;
  triage: { summary: string; likelyCause: string };
}

export type AdversarialOutcome =
  | { outcome: "clean"; recording: Recording }
  | { outcome: "cap"; recording: Recording }
  | { outcome: "defect"; defect: AdversarialDefect };

export async function runAdversarialMission(params: {
  page: Page;
  actor: Actor;
  judgment: JudgmentPort;
  generation: GenerationPort;
  seedUrl: string;
  allowlist: readonly string[];
  strategies: readonly MisuseStrategy[];
  bounds?: Bounds;
  userInvariant?: (page: Page) => Promise<{ ok: boolean; reason?: string }>;
}): Promise<AdversarialOutcome> {
  assertAuthorizedExploreTarget(params.seedUrl, params.allowlist);
  const bounds = params.bounds ?? defaultBounds();
  const collector = new PageSignalCollector(params.page); // attached BEFORE navigation

  await params.actor.attemptsTo(Navigate.to(params.seedUrl));
  let recording: Recording = { version: "1", site: new URL(params.seedUrl).origin, pages: [] };
  let snapshot = await snapshotPage(params.page, { maxCandidates: bounds.maxCandidates });
  let lastDecision: Decision | undefined;
  let actions = 0;

  for (const strategy of params.strategies) {
    if (actions >= bounds.maxActions) return { outcome: "cap", recording };

    const decision = pickMisuseAction({ snapshot, strategy, lastDecision, rng: Math.random });
    if (!decision) continue;

    const fillText = (decision as { fillText?: string }).fillText;
    const result = await executeAction({ actor: params.actor, page: params.page, snapshot, decision, fillText });
    actions += 1;
    if (result.ok) {
      recording = recordStep(recording, { decision, snapshot, fillText, timing: { atMs: 0, durationMs: 0, gapBeforeMs: 0 } });
    }
    lastDecision = decision;

    const hardSignals = collector.drain();
    const invariantResult = params.userInvariant ? await params.userInvariant(params.page) : { ok: true };
    if (hardSignals.length > 0 || !invariantResult.ok) {
      const reasons = [...hardSignals.map((s) => s.detail), invariantResult.reason].filter(Boolean).join("; ");
      const triage = await params.generation.generate("triage.narrative", { failureSummary: reasons, url: params.page.url() });
      return {
        outcome: "defect",
        defect: { signals: hardSignals, url: params.page.url(), recording, triage: triage.output },
      };
    }

    // Soft augment only (guardrail #4) — recorded nowhere as a stop reason,
    // used only if a caller wants it surfaced in a wider triage narrative.
    await params.judgment.systemOne({
      state: { goal: "try to break it", url: params.page.url(), controls: snapshot.controls.map((c) => `${c.role ?? ""} ${c.name ?? ""}`.trim()), history: [] },
      questions: { looksBroken: { kind: "noul" } },
    }) as unknown as { looksBroken: NoulAnswer };

    snapshot = await snapshotPage(params.page, { maxCandidates: bounds.maxCandidates });
  }

  return { outcome: "clean", recording };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm exec vitest run packages/explore/src/missions/adversarial.test.ts`
Expected: PASS (1 test).

- [ ] **Step 5: Commit**

```bash
git add packages/explore/src/missions/adversarial.ts packages/explore/src/missions/adversarial.test.ts
git commit -m "$(cat <<'EOF'
feat(explore): add runAdversarialMission — clean-run slice

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: Hard defect → stop, keep Recording as repro, triage narrative

**Files:**
- Modify: `packages/explore/src/missions/adversarial.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// packages/explore/src/missions/adversarial.test.ts — add:
describe("runAdversarialMission — hard defect", () => {
  test("a console error stops the mission, keeps the Recording, and produces a triage narrative", async () => {
    const judgment = new FakeJudgmentGateway({ looksBroken: { kind: "noul", value: false, probability: 0.1 } });
    const generation = new FakeGenerationGateway({ "triage.narrative": { summary: "console error observed", likelyCause: "client-side script error" } });

    // Inject a page that throws a console.error on the FIRST misuse action by
    // wiring a userInvariant hook that itself fires page.evaluate — simpler
    // and more deterministic than depending on a misuse action to trigger it:
    const result = await runAdversarialMission({
      page: session.page, actor, judgment, generation,
      seedUrl: `${site.url}/login`, allowlist: [site.url],
      strategies: ["ordering-violation"],
      userInvariant: async (page) => {
        await page.evaluate(() => console.error("adversarial-synthetic-error"));
        return { ok: true }; // the HARD signal comes from the console listener, not this invariant
      },
    });

    expect(result.outcome).toBe("defect");
    if (result.outcome === "defect") {
      expect(result.defect.signals.some((s) => s.kind === "console-error")).toBe(true);
      expect(result.defect.triage.summary).toContain("console error");
      expect(result.defect.recording).toBeDefined();
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run packages/explore/src/missions/adversarial.test.ts`
Expected: Likely PASSES immediately given Task 5's implementation already checks `collector.drain()` after calling `params.userInvariant`. If it fails because `userInvariant`'s `page.evaluate` fires the console error AFTER `collector.drain()` already ran once earlier in the loop and the console message arrives asynchronously (a real race — Playwright's `console` event can fire on the next microtask after `evaluate` resolves), add a small deterministic wait.

- [ ] **Step 3: Fix the race if RED**

```ts
// packages/explore/src/missions/adversarial.ts — after computing hardSignals, if the
// invariant hook was used to synthesize a signal, give the event loop a tick:
    const invariantResult = params.userInvariant ? await params.userInvariant(params.page) : { ok: true };
    await params.page.waitForTimeout(10); // let a same-tick console event land before draining
    const hardSignals = collector.drain();
```

(Move the `collector.drain()` call to AFTER the invariant hook + a short wait, reordering the two lines from Task 5's draft.)

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm exec vitest run packages/explore/src/missions/adversarial.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/explore/src/missions/adversarial.ts packages/explore/src/missions/adversarial.test.ts
git commit -m "$(cat <<'EOF'
feat(explore): stop-on-hard-defect + triage narrative for adversarial mission

A hard signal (console error / 5xx / failed request / broken user
invariant) stops the mission, keeps the run Recording as the exact repro,
and hands failureSummary+url to the generation gateway for a triage
narrative — per spec §3.1.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

## Task 7: Prove the model never self-certifies (guardrail #4 — critical)

**Files:**
- Modify: `packages/explore/src/missions/adversarial.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// packages/explore/src/missions/adversarial.test.ts — add:
describe("runAdversarialMission — model verdict is advisory only", () => {
  test("Jev screaming 'looks broken' with no hard signal does NOT stop the mission or report a defect", async () => {
    const judgment = new FakeJudgmentGateway({ looksBroken: { kind: "noul", value: true, probability: 0.99 } });
    const generation = new FakeGenerationGateway();
    const result = await runAdversarialMission({
      page: session.page, actor, judgment, generation,
      seedUrl: `${site.url}/login`, allowlist: [site.url],
      strategies: ["ordering-violation", "repeat-rapid"],
    });
    // No console error, no 5xx, no failed request, no broken invariant was
    // ever produced in this run — a maximally-confident "looks broken" from
    // the model alone must never surface as outcome:"defect".
    expect(result.outcome).not.toBe("defect");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run packages/explore/src/missions/adversarial.test.ts`
Expected: PASS immediately given Task 5/6's implementation never reads the `looksBroken` answer to decide the outcome — it is called and then discarded (cast away, per the `as unknown as {...}` line). This is intentional: the test exists to make that discipline **regression-proof**, not to introduce new behavior. If it were ever RED, that would mean someone wired the Noul answer into the stop condition — the single most important guardrail regression this mission can suffer.

- [ ] **Step 3: N/A (already green) — proceed**

- [ ] **Step 4: Run the full adversarial test file once more to confirm no interference between tests sharing the module-level `page`**

Run: `pnpm exec vitest run packages/explore/src/missions/adversarial.test.ts`
Expected: PASS (3 tests). If flaky due to shared `page`/`session` state across tests (e.g. Task 6's injected console error still counted in Task 7's collector because a NEW `PageSignalCollector` wasn't constructed until inside `runAdversarialMission`, which IS the case — Task 5's implementation constructs a fresh `PageSignalCollector` per call, so no cross-test bleed), no fix is needed.

- [ ] **Step 5: Commit**

```bash
git add packages/explore/src/missions/adversarial.test.ts
git commit -m "$(cat <<'EOF'
test(explore): prove adversarial mission never self-certifies (guardrail #4)

The single most important guardrail regression this mission can suffer:
Jev's "looks broken?" must never gate the stop decision, only hard
signals or a user invariant may.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

## Task 8: Guardrail invariant contract

**Files:**
- Create: `packages/explore/src/adversarial-invariants.test.ts`

**Interfaces:**
- Consumes: `runAdversarialMission` (Task 5); `UnauthorizedExploreTargetError` (ticket #1). Mirrors `packages/load/src/slice2-invariants.test.ts`'s style.

- [ ] **Step 1: Write the failing test**

```ts
// packages/explore/src/adversarial-invariants.test.ts
import { describe, expect, test } from "vitest";
import { FakeJudgmentGateway, FakeGenerationGateway } from "@jevitate/ai-core";
import { UnauthorizedExploreTargetError } from "./index.js";
import { runAdversarialMission } from "./missions/adversarial.js";
import { pickMisuseAction } from "./adversarial/misuse.js";
import type { Snapshot } from "./index.js";

describe("adversarial mission — guardrail invariants", () => {
  test("#1 refuses an undeclared origin before touching a Page", async () => {
    const judgment = new FakeJudgmentGateway({ looksBroken: { kind: "noul", value: false, probability: 0 } });
    const generation = new FakeGenerationGateway();
    await expect(
      runAdversarialMission({
        page: {} as never, actor: {} as never, judgment, generation,
        seedUrl: "https://not-authorized.test/checkout",
        allowlist: ["https://authorized.test"],
        strategies: ["ordering-violation"],
      }),
    ).rejects.toThrow(UnauthorizedExploreTargetError);
  });

  test("#2/#6 misuse strategies only ever choose click/type/select/scroll_down — never navigate off-origin or an irreversible op", () => {
    const snapshot: Snapshot = {
      url: "https://x.test/checkout", freshnessSignature: "s",
      controls: [
        { index: 0, descriptor: {}, role: "textbox", name: "Email", visible: true, enabled: true },
        { index: 1, descriptor: {}, role: "button", name: "Pay now", visible: true, enabled: true },
        { index: 2, descriptor: {}, role: "button", name: "Cancel", visible: true, enabled: true },
      ],
    };
    const strategies = ["ordering-violation", "boundary-input", "nav-during-pending", "contradictory-actions"] as const;
    for (const strategy of strategies) {
      const decision = pickMisuseAction({ snapshot, strategy, lastDecision: { op: "click", targetIndex: 1 }, rng: () => 0 });
      if (decision) expect(["click", "type", "select", "scroll_up", "scroll_down", "wait"]).toContain(decision.op);
    }
  });

  test("#3 the triage narrative call receives only failureSummary+url, never raw control/form state", async () => {
    const seen: unknown[] = [];
    const generation = { async generate(kind: string, input: unknown) {
      seen.push(input);
      return { output: { summary: "s", likelyCause: "c" }, provenance: { adapter: "fake" as const, model: "fake", promptVersion: "1", latencyMs: 0, responseHash: "h" } };
    } };
    // GenInput<"triage.narrative"> is statically { failureSummary: string; url: string } —
    // GEN_TASKS.triage.narrative.input.strict() rejects any extra key, so passing
    // a raw Control[]/Snapshot would fail Zod parsing before reaching a real
    // adapter. Verified structurally at packages/ai-core/src/generation.ts:13.
    expect(true).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run packages/explore/src/adversarial-invariants.test.ts`
Expected: FAIL — `Cannot find module './index.js'` exporting `UnauthorizedExploreTargetError`, or (once that resolves) the third test's vacuous `expect(true).toBe(true)` is flagged in self-review as a placeholder-shaped assertion — replaced in Step 3.

- [ ] **Step 3: Replace the vacuous third test with a genuine structural check**

```ts
  test("#3 the generation port's triage.narrative schema is closed — cannot carry raw form state", async () => {
    const { GEN_TASKS } = await import("@jevitate/ai-core");
    const parseResult = GEN_TASKS["triage.narrative"].input.safeParse({
      failureSummary: "x", url: "https://x.test", formValues: { username: "s3cr3t" },
    });
    // .strict() (verified packages/ai-core/src/generation.ts:13) rejects the
    // unknown "formValues" key outright — this is what makes "never sends
    // raw form state to the model" a structural guarantee, not a convention.
    expect(parseResult.success).toBe(false);
  });
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm exec vitest run packages/explore/src/adversarial-invariants.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/explore/src/adversarial-invariants.test.ts
git commit -m "$(cat <<'EOF'
test(explore): add adversarial guardrail-invariant contract (#1, #2/#6, #3)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

## Task 9: Additive CLI — `explore --strategy adversarial`

**Files:**
- Modify: `packages/cli/src/explore-api.ts`
- Modify: `packages/cli/src/program.ts`
- Test: `packages/cli/src/explore-api.test.ts`

**Interfaces:**
- Consumes: `runAdversarialMission` (Task 5); `ok`/`fail`/`JsonEnvelope` (`packages/cli/src/envelope.ts`).
- Produces: `runAdversarialCliMission(opts): Promise<AdversarialOutcome>` wired behind `explore --strategy adversarial`; on `outcome:"defect"`, the CLI action exits non-zero (mirroring how CI would gate on a discovered defect).

- [ ] **Step 1: Write the failing test**

```ts
// packages/cli/src/explore-api.test.ts — add:
import { runAdversarialCliMission } from "./explore-api.js";
import { UnauthorizedExploreTargetError } from "@jevitate/explore";

test("runAdversarialCliMission refuses an undeclared origin (no browser touched)", async () => {
  await expect(
    runAdversarialCliMission({
      seedUrl: "https://not-authorized.test", allowlist: ["https://authorized.test"],
      strategies: ["ordering-violation"],
      judgment: new FakeJudgmentGateway({ looksBroken: { kind: "noul", value: false, probability: 0 } }),
      generation: new FakeGenerationGateway(),
      profileDir: "/tmp/unused",
    }),
  ).rejects.toThrow(UnauthorizedExploreTargetError);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run packages/cli/src/explore-api.test.ts`
Expected: FAIL — `runAdversarialCliMission` is not exported.

- [ ] **Step 3: Write minimal implementation**

```ts
// packages/cli/src/explore-api.ts — add:
import { runAdversarialMission, type AdversarialOutcome } from "@jevitate/explore/missions/adversarial.js";
import type { MisuseStrategy } from "@jevitate/explore/adversarial/misuse.js";

export interface RunAdversarialCliMissionOptions {
  seedUrl: string;
  allowlist: readonly string[];
  strategies: readonly MisuseStrategy[];
  judgment: JudgmentPort;
  generation: GenerationPort;
  profileDir: string;
  headless?: boolean;
}

export async function runAdversarialCliMission(opts: RunAdversarialCliMissionOptions): Promise<AdversarialOutcome> {
  assertAuthorizedExploreTarget(opts.seedUrl, opts.allowlist); // fail closed before opening a browser
  const browserPort = new PlaywrightBrowserPort();
  const session = await browserPort.open({
    profileDir: opts.profileDir, headless: opts.headless ?? true,
    allowedOrigins: [...opts.allowlist], baseUrl: opts.seedUrl,
  });
  try {
    const actor = CastActor.named("adversarial-mission").whoCan(new BrowseTheWeb(session, [...opts.allowlist]));
    return await runAdversarialMission({
      page: session.page, actor, judgment: opts.judgment, generation: opts.generation,
      seedUrl: opts.seedUrl, allowlist: opts.allowlist, strategies: opts.strategies,
    });
  } finally {
    await session.close();
  }
}
```

```ts
// packages/cli/src/program.ts — extend the same `explore` command's --strategy
// branch added in ticket #3's plan (or, if this lands first, add it fresh):
    if (opts.strategy === "adversarial") {
      const result = await runAdversarialCliMission({
        seedUrl: opts.url, allowlist: opts.allow ?? [],
        strategies: ["ordering-violation", "repeat-rapid", "boundary-input", "contradictory-actions", "nav-during-pending"],
        judgment, generation, profileDir: deps.profiles as unknown as string,
      });
      emitJson(program, ok(result));
      if (result.outcome === "defect") process.exitCode = 1;
      return;
    }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm exec vitest run packages/cli/src/explore-api.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/explore-api.ts packages/cli/src/program.ts packages/cli/src/explore-api.test.ts
git commit -m "$(cat <<'EOF'
feat(cli): add `explore --strategy adversarial` (bounded misuse + hard oracle)

Additive: wires runAdversarialMission behind the shared explore command;
exits non-zero on a discovered defect for CI gating. Satisfies
jevitate-site#13's "--strategy adversarial shown as a live flag" requirement.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

## Self-Review

**Spec coverage** (design §3.1 + ticket #4's acceptance bullets):
- "Uses a defect oracle of trusted hard signals ... with Jev Noul as a soft augment only" → `PageSignalCollector` (Task 2) + Task 7's dedicated proof.
- "Applies bounded misuse strategies: ordering violations, repeated/rapid actions, navigation during pending async, boundary inputs, contradictory actions" → all five in `misuse.ts` (Tasks 3–4).
- "Selects input values by field semantics (never blind fuzz)" → `input-strategy.ts` (Task 1).
- "On a defect: stops, keeps the run Recording as the exact repro, and produces a triage narrative" → Task 6.
- "Stays bounded by the safety policy" → `bounds.maxActions` cap in `runAdversarialMission` (Task 5), Task 8's op-restriction invariant.
- Guardrails §6 → Task 8 (invariant contract) + Task 7 (the critical advisory-only proof, called out separately since it's the mission's defining property, not a generic refusal).
- Site pairing #13 (`--strategy adversarial` as a live flag) → Task 9.

**Placeholder scan:** Task 4's Step 3 draft left a dead `...{ strategy } as never` spread, caught and removed in Step 4 rather than left in; Task 8's Step 1 draft had a vacuous `expect(true).toBe(true)` placeholder, caught and replaced in Step 3 with a genuine structural (Zod `.strict()`) assertion.

**Type consistency:** `AdversarialOutcome`, `AdversarialDefect`, `MisuseStrategy`, `MisuseDecision`, `DefectSignal` are defined once (Tasks 1, 2, 4, 5) and reused verbatim through Task 9 with no renames.

**Known risk carried forward:** Task 6's Step 2/3 dance (a plausible console-event timing race between `page.evaluate` and the `console` listener) is left in the plan rather than pre-solved, because Playwright event-ordering details are exactly the kind of thing that should be verified against the real browser during execution, not assumed from a plan. The executing engineer is told precisely what the fix looks like (reorder `drain()` after a short wait) if Step 2 comes back red.
