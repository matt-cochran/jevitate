# M2 Screenplay Runtime + Reads Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up the Screenplay automation runtime driving real Playwright against a local fixture site, and deliver the versioned read actions `session.status`, `inbox.list` (with normalization + dedup + traces), and `thread.get`.

**Architecture:** A `BrowserPort` abstracts Playwright; M2's adapter runs Playwright **in-process** in the runner (runner-only access preserves the control-plane asymmetry; process isolation drops in later over a local socket). A small Screenplay framework (`@doit/screenplay`) gives an Actor capability-limited Abilities, semantic Targets, Interactions, and Questions. A `@doit/site-sdk` defines the versioned `ActionDefinition` contract + registry. The `example-network` site integration implements the three read actions against a Fastify fixture app (`apps/example-site`) that models login + inbox + thread. `inbox.list` normalizes site records into a common schema and upserts them into a new `incoming_message` table, deduped by stable source id.

**Tech Stack:** Node 20+, pnpm workspaces, TypeScript project references, Vitest, zod, Playwright (chromium), Kysely + better-sqlite3, Fastify (fixture only). Builds on M1 (`@doit/domain`, `@doit/application`, `@doit/storage-sqlite`, `@doit/daemon`, `@doit/mcp-facade`, `@doit/cli`).

**Spec:** `docs/superpowers/specs/2026-09-16-browser-automation-mvp-design.md` (§ MVP boundary, milestone M2) and the CONOPS (`Browser_Automation_CONOPS_and_Functional_Specification.md`, §3.3 Playwright runtime, §5 Screenplay model, §5.4 example action) + `approach.md` (Screenplay code shapes). The plan argues from the spec; executors read both.

## Global Constraints

Every task's requirements implicitly include these (verbatim from the spec/CONOPS + M1 conventions carried forward):

- **Node 20+**, ESM packages (`"type": "module"`), **strict** TypeScript with project references; dependency direction points inward toward `domain`/`application`.
- **`domain` and site-integration modules must not import `playwright`, `better-sqlite3`, or `kysely`** (ESLint flat-config rule already scopes the forbidden-import list to `packages/domain/**` and `site-integrations/**`). Site modules use Playwright ONLY through Screenplay abilities/targets, never by importing `playwright` directly.
- **New workspace packages must add**: (a) a `@doit/<pkg>` alias line in root `vitest.config.ts` via the existing `pkg()` helper (tests resolve to TS source, no pre-build), and (b) a `{ "path": "packages/<pkg>" }` (or `apps/<name>` / `site-integrations/<name>`) entry in root `tsconfig.json` references.
- **Commit messages** end with a blank line then EXACTLY `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>` (do not substitute the implementer's model name). **Stage only the task's files with explicit paths — never `git add -A`** (the repo has untracked working files, e.g. the `graft/` cache and `.ignore`, that must stay out).
- **The runner is the only code path to the `BrowserPort`.** Site actions receive an `Actor` whose abilities wrap the browser; they never construct a `BrowserPort` or import `playwright`. MCP/CLI never reach the browser.
- **Timestamps** are RFC 3339 UTC strings; a `Clock` is injected where time is read (no bare `new Date()` in production logic).
- **Playwright determinism:** use role/label/test-id locators and actionability/state assertions, never fixed sleeps. Enable a trace on failed runs.
- Existing M1 behavior must stay green: `pnpm -r build && pnpm test && pnpm lint`.

---

### Task 1: `@doit/playwright` — BrowserPort + in-process adapter

**Files:**
- Create: `packages/playwright/package.json`, `packages/playwright/tsconfig.json`, `packages/playwright/src/browser-port.ts`, `packages/playwright/src/playwright-browser-port.ts`, `packages/playwright/src/index.ts`, `packages/playwright/src/playwright-browser-port.test.ts`
- Modify: root `tsconfig.json`, root `vitest.config.ts`

**Interfaces:**
- Consumes: nothing from sibling packages at runtime.
- Produces:
  - `interface BrowserSession { readonly page: import("playwright").Page; startTracing(): Promise<void>; stopTracingToFile(file: string): Promise<void>; close(): Promise<void> }`
  - `interface OpenOptions { profileDir: string; headless: boolean; allowedOrigins: string[]; baseUrl: string }`
  - `interface BrowserPort { open(opts: OpenOptions): Promise<BrowserSession> }`
  - `class PlaywrightBrowserPort implements BrowserPort` using `chromium.launchPersistentContext`.

- [ ] **Step 1: Add deps and install the browser**

Run: `pnpm add --filter @doit/playwright playwright` then `pnpm --filter @doit/playwright exec playwright install chromium`
Expected: chromium downloads. If the sandbox blocks the download, report BLOCKED with the exact error (the controller may need to pre-install or allow it).

- [ ] **Step 2: Write the failing test**

`packages/playwright/src/playwright-browser-port.test.ts`:
```ts
import { afterAll, expect, test } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PlaywrightBrowserPort } from "./playwright-browser-port.js";

const port = new PlaywrightBrowserPort();

test("opens a persistent context and navigates to a data: URL", async () => {
  const profileDir = await mkdtemp(join(tmpdir(), "doit-pw-"));
  const session = await port.open({ profileDir, headless: true, allowedOrigins: [], baseUrl: "about:blank" });
  try {
    await session.page.setContent("<h1>hello</h1>");
    expect(await session.page.locator("h1").textContent()).toBe("hello");
  } finally {
    await session.close();
    await rm(profileDir, { recursive: true, force: true });
  }
}, 60_000);
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm test packages/playwright/src/playwright-browser-port.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 4: Create the package and implement**

`packages/playwright/package.json`:
```json
{
  "name": "@doit/playwright",
  "version": "0.0.0",
  "type": "module",
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "exports": { ".": "./dist/index.js" },
  "dependencies": { "playwright": "^1.47.0" },
  "scripts": { "build": "tsc --build" }
}
```

`packages/playwright/tsconfig.json`:
```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "rootDir": "src", "outDir": "dist" },
  "include": ["src/**/*"],
  "exclude": ["src/**/*.test.ts"]
}
```

`packages/playwright/src/browser-port.ts`:
```ts
import type { Page } from "playwright";

export interface BrowserSession {
  readonly page: Page;
  startTracing(): Promise<void>;
  stopTracingToFile(file: string): Promise<void>;
  close(): Promise<void>;
}

export interface OpenOptions {
  profileDir: string;
  headless: boolean;
  allowedOrigins: string[];
  baseUrl: string;
}

export interface BrowserPort {
  open(opts: OpenOptions): Promise<BrowserSession>;
}
```

`packages/playwright/src/playwright-browser-port.ts`:
```ts
import { chromium, type BrowserContext } from "playwright";
import type { BrowserPort, BrowserSession, OpenOptions } from "./browser-port.js";

export class PlaywrightBrowserPort implements BrowserPort {
  async open(opts: OpenOptions): Promise<BrowserSession> {
    const context: BrowserContext = await chromium.launchPersistentContext(opts.profileDir, {
      headless: opts.headless,
      baseURL: opts.baseUrl,
    });
    const page = context.pages()[0] ?? (await context.newPage());
    return {
      page,
      async startTracing() {
        await context.tracing.start({ screenshots: true, snapshots: true });
      },
      async stopTracingToFile(file: string) {
        await context.tracing.stop({ path: file });
      },
      async close() {
        await context.close();
      },
    };
  }
}
```

`packages/playwright/src/index.ts`:
```ts
export * from "./browser-port.js";
export * from "./playwright-browser-port.js";
```

Add `{ "path": "packages/playwright" }` to root `tsconfig.json` references, and `"@doit/playwright": pkg("playwright")` to root `vitest.config.ts` aliases.

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm test packages/playwright/src/playwright-browser-port.test.ts`
Expected: PASS. Then `pnpm -r build`.

- [ ] **Step 6: Commit**

```bash
git add packages/playwright tsconfig.json vitest.config.ts pnpm-lock.yaml
git commit -m "feat(playwright): BrowserPort with in-process Playwright adapter" -m "Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2: Domain normalized-message schema

**Files:**
- Create: `packages/domain/src/messages.ts`, `packages/domain/src/messages.test.ts`
- Modify: `packages/domain/src/index.ts`

**Interfaces:**
- Consumes: `IsoTimestamp` from `primitives.ts`.
- Produces (the common local schema, FR-005):
  - `interface NormalizedMessage { sourceMessageId: string; sourceThreadId: string; sender: string; receivedAt: IsoTimestamp; text: string }`
  - `interface NormalizedThread { sourceThreadId: string; subject: string; messages: NormalizedMessage[] }`
  - zod: `NormalizedMessageSchema`, `NormalizedThreadSchema`.

- [ ] **Step 1: Write the failing test**

`packages/domain/src/messages.test.ts`:
```ts
import { expect, test } from "vitest";
import { NormalizedThreadSchema } from "./messages.js";

test("valid thread parses; missing sourceThreadId rejected", () => {
  const t = { sourceThreadId: "t1", subject: "Hi", messages: [
    { sourceMessageId: "m1", sourceThreadId: "t1", sender: "jane", receivedAt: "2026-09-17T00:00:00Z", text: "hello" },
  ]};
  expect(NormalizedThreadSchema.parse(t).messages).toHaveLength(1);
  expect(() => NormalizedThreadSchema.parse({ subject: "x", messages: [] })).toThrow();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test packages/domain/src/messages.test.ts` → FAIL (module not found).

- [ ] **Step 3: Implement**

`packages/domain/src/messages.ts`:
```ts
import { z } from "zod";
import type { IsoTimestamp } from "./primitives.js";

export interface NormalizedMessage {
  sourceMessageId: string;
  sourceThreadId: string;
  sender: string;
  receivedAt: IsoTimestamp;
  text: string;
}

export interface NormalizedThread {
  sourceThreadId: string;
  subject: string;
  messages: NormalizedMessage[];
}

export const NormalizedMessageSchema = z.object({
  sourceMessageId: z.string().min(1),
  sourceThreadId: z.string().min(1),
  sender: z.string().min(1),
  receivedAt: z.string().min(1),
  text: z.string(),
});

export const NormalizedThreadSchema = z.object({
  sourceThreadId: z.string().min(1),
  subject: z.string(),
  messages: z.array(NormalizedMessageSchema),
});
```

Append to `packages/domain/src/index.ts`:
```ts
export * from "./messages.js";
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test packages/domain/src/messages.test.ts` → PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/domain/src/messages.ts packages/domain/src/messages.test.ts packages/domain/src/index.ts
git commit -m "feat(domain): normalized message and thread schema" -m "Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 3: `@doit/screenplay` — core contracts + actor

**Files:**
- Create: `packages/screenplay/package.json`, `packages/screenplay/tsconfig.json`, `packages/screenplay/src/core.ts`, `packages/screenplay/src/cast-actor.ts`, `packages/screenplay/src/cast-actor.test.ts`, `packages/screenplay/src/index.ts`
- Modify: root `tsconfig.json`, root `vitest.config.ts`

**Interfaces:**
- Consumes: nothing.
- Produces (shapes from `approach.md`):
  - `interface Ability { readonly kind: string }`
  - `interface AbilityToken<T extends Ability> { readonly kind: string }`
  - `interface Activity { readonly description: string; performAs(actor: Actor): Promise<void> }`
  - `interface Question<T> { readonly description: string; answeredBy(actor: Actor): Promise<T> }`
  - `interface Actor { readonly name: string; ability<T extends Ability>(t: AbilityToken<T>): T; attemptsTo(...a: Activity[]): Promise<void>; asks<T>(q: Question<T>): Promise<T> }`
  - `class CastActor implements Actor` — built from `CastActor.named(name).whoCan(...abilities)`.
  - `class MissingAbilityError extends Error`.

- [ ] **Step 1: Write the failing test**

`packages/screenplay/src/cast-actor.test.ts`:
```ts
import { expect, test } from "vitest";
import { CastActor, MissingAbilityError, type Ability, type AbilityToken, type Activity } from "./index.js";

class Counter implements Ability { readonly kind = "counter"; n = 0; }
const CounterToken: AbilityToken<Counter> = { kind: "counter" };
const Increment: Activity = { description: "increment", async performAs(actor) { actor.ability(CounterToken).n += 1; } };

test("actor runs activities and exposes abilities", async () => {
  const c = new Counter();
  const actor = CastActor.named("Tester").whoCan(c);
  await actor.attemptsTo(Increment, Increment);
  expect(c.n).toBe(2);
});

test("missing ability throws", () => {
  const actor = CastActor.named("Tester").whoCan();
  expect(() => actor.ability(CounterToken)).toThrow(MissingAbilityError);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test packages/screenplay/src/cast-actor.test.ts` → FAIL (package/module not found).

- [ ] **Step 3: Create the package and implement**

`packages/screenplay/package.json`:
```json
{
  "name": "@doit/screenplay",
  "version": "0.0.0",
  "type": "module",
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "exports": { ".": "./dist/index.js" },
  "dependencies": { "@doit/playwright": "workspace:*" },
  "scripts": { "build": "tsc --build" }
}
```

`packages/screenplay/tsconfig.json`:
```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "rootDir": "src", "outDir": "dist" },
  "references": [{ "path": "../playwright" }],
  "include": ["src/**/*"],
  "exclude": ["src/**/*.test.ts"]
}
```

`packages/screenplay/src/core.ts`:
```ts
export interface Ability {
  readonly kind: string;
}

export interface AbilityToken<T extends Ability> {
  readonly kind: string;
}

export interface Activity {
  readonly description: string;
  performAs(actor: Actor): Promise<void>;
}

export interface Question<T> {
  readonly description: string;
  answeredBy(actor: Actor): Promise<T>;
}

export interface Actor {
  readonly name: string;
  ability<T extends Ability>(token: AbilityToken<T>): T;
  attemptsTo(...activities: Activity[]): Promise<void>;
  asks<T>(question: Question<T>): Promise<T>;
}
```

`packages/screenplay/src/cast-actor.ts`:
```ts
import type { Ability, AbilityToken, Activity, Actor, Question } from "./core.js";

export class MissingAbilityError extends Error {
  constructor(kind: string) {
    super(`Actor lacks ability: ${kind}`);
    this.name = "MissingAbilityError";
  }
}

export class CastActor implements Actor {
  private readonly abilities = new Map<string, Ability>();

  private constructor(readonly name: string) {}

  static named(name: string): CastActor {
    return new CastActor(name);
  }

  whoCan(...abilities: Ability[]): this {
    for (const a of abilities) this.abilities.set(a.kind, a);
    return this;
  }

  ability<T extends Ability>(token: AbilityToken<T>): T {
    const found = this.abilities.get(token.kind);
    if (!found) throw new MissingAbilityError(token.kind);
    return found as T;
  }

  async attemptsTo(...activities: Activity[]): Promise<void> {
    for (const activity of activities) await activity.performAs(this);
  }

  asks<T>(question: Question<T>): Promise<T> {
    return question.answeredBy(this);
  }
}
```

`packages/screenplay/src/index.ts`:
```ts
export * from "./core.js";
export * from "./cast-actor.js";
```

Add `{ "path": "packages/screenplay" }` to root `tsconfig.json`, and `"@doit/screenplay": pkg("screenplay")` to `vitest.config.ts`.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm install && pnpm test packages/screenplay/src/cast-actor.test.ts` → PASS. Then `pnpm -r build`.

- [ ] **Step 5: Commit**

```bash
git add packages/screenplay tsconfig.json vitest.config.ts pnpm-lock.yaml
git commit -m "feat(screenplay): actor, ability, activity, question contracts" -m "Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 4: Screenplay — BrowseTheWeb ability + Target

**Files:**
- Create: `packages/screenplay/src/browse-the-web.ts`, `packages/screenplay/src/target.ts`, `packages/screenplay/src/target.test.ts`
- Modify: `packages/screenplay/src/index.ts`

**Interfaces:**
- Consumes: `Ability`, `AbilityToken` from `core.ts`; `BrowserSession` from `@doit/playwright`; Playwright `Page`/`Locator` types.
- Produces:
  - `class BrowseTheWeb implements Ability { readonly kind = "browse-the-web"; constructor(readonly session: BrowserSession, readonly allowedOrigins: string[]) {} }` and `const BrowseTheWebToken: AbilityToken<BrowseTheWeb> = { kind: "browse-the-web" }`.
  - `class Target { readonly description: string; static named(d: string): TargetBuilder; resolve(page: Page): Locator }` where `TargetBuilder.locatedBy(fn: (page: Page) => Locator): Target`.

- [ ] **Step 1: Write the failing test**

`packages/screenplay/src/target.test.ts`:
```ts
import { expect, test } from "vitest";
import { Target } from "./target.js";

test("target carries a description and resolves a locator via its finder", () => {
  const SendButton = Target.named("send button").locatedBy((page: any) => page.getByRole("button", { name: "Send" }));
  expect(SendButton.description).toBe("send button");
  const fakeLocator = {};
  const fakePage: any = { getByRole: () => fakeLocator };
  expect(SendButton.resolve(fakePage)).toBe(fakeLocator);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test packages/screenplay/src/target.test.ts` → FAIL (module not found).

- [ ] **Step 3: Implement**

`packages/screenplay/src/target.ts`:
```ts
import type { Locator, Page } from "playwright";

export class Target {
  private constructor(
    readonly description: string,
    private readonly finder: (page: Page) => Locator,
  ) {}

  static named(description: string): { locatedBy(finder: (page: Page) => Locator): Target } {
    return { locatedBy: (finder) => new Target(description, finder) };
  }

  resolve(page: Page): Locator {
    return this.finder(page);
  }
}
```

`packages/screenplay/src/browse-the-web.ts`:
```ts
import type { BrowserSession } from "@doit/playwright";
import type { Ability, AbilityToken } from "./core.js";

export class BrowseTheWeb implements Ability {
  readonly kind = "browse-the-web";
  constructor(
    readonly session: BrowserSession,
    readonly allowedOrigins: string[],
  ) {}
}

export const BrowseTheWebToken: AbilityToken<BrowseTheWeb> = { kind: "browse-the-web" };
```

Append to `packages/screenplay/src/index.ts`:
```ts
export * from "./browse-the-web.js";
export * from "./target.js";
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test packages/screenplay/src/target.test.ts` → PASS. Then `pnpm -r build`.

- [ ] **Step 5: Commit**

```bash
git add packages/screenplay/src/browse-the-web.ts packages/screenplay/src/target.ts packages/screenplay/src/target.test.ts packages/screenplay/src/index.ts
git commit -m "feat(screenplay): BrowseTheWeb ability and semantic Target" -m "Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 5: Screenplay — interactions + questions

**Files:**
- Create: `packages/screenplay/src/interactions.ts`, `packages/screenplay/src/questions.ts`, `packages/screenplay/src/interactions.test.ts`
- Modify: `packages/screenplay/src/index.ts`

**Interfaces:**
- Consumes: `Activity`, `Question`, `Actor` from `core.ts`; `BrowseTheWebToken` from `browse-the-web.ts`; `Target`.
- Produces:
  - `const Navigate = { to(path: string): Activity }` (uses `page.goto(path)`).
  - `const Click = { on(target: Target): Activity }`.
  - `const Enter = { theText(value: string): { into(target: Target): Activity } }`.
  - `const TextOf = { target(t: Target): Question<string> }` (returns `locator.innerText()`).
  - `const IsVisible = { target(t: Target): Question<boolean> }`.
  - `const CountOf = { target(t: Target): Question<number> }` (returns `locator.count()`).

- [ ] **Step 1: Write the failing test** (uses a fake BrowseTheWeb ability + fake page)

`packages/screenplay/src/interactions.test.ts`:
```ts
import { expect, test } from "vitest";
import { CastActor } from "./cast-actor.js";
import { BrowseTheWeb } from "./browse-the-web.js";
import { Target } from "./target.js";
import { Click, Enter, Navigate } from "./interactions.js";
import { TextOf } from "./questions.js";

function fakeSessionWithPage(page: any) {
  return { page, startTracing: async () => {}, stopTracingToFile: async () => {}, close: async () => {} };
}

test("Navigate/Enter/Click drive the page; TextOf reads locator text", async () => {
  const calls: string[] = [];
  const locator = {
    click: async () => { calls.push("click"); },
    fill: async (v: string) => { calls.push(`fill:${v}`); },
    innerText: async () => "hello",
  };
  const page: any = { goto: async (p: string) => { calls.push(`goto:${p}`); }, getByRole: () => locator, getByLabel: () => locator };
  const actor = CastActor.named("T").whoCan(new BrowseTheWeb(fakeSessionWithPage(page), []));
  const Box = Target.named("box").locatedBy((p: any) => p.getByRole("textbox"));
  const Btn = Target.named("btn").locatedBy((p: any) => p.getByRole("button"));
  await actor.attemptsTo(Navigate.to("/inbox"), Enter.theText("hi").into(Box), Click.on(Btn));
  expect(calls).toEqual(["goto:/inbox", "fill:hi", "click"]);
  expect(await actor.asks(TextOf.target(Box))).toBe("hello");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test packages/screenplay/src/interactions.test.ts` → FAIL (module not found).

- [ ] **Step 3: Implement**

`packages/screenplay/src/interactions.ts`:
```ts
import type { Activity } from "./core.js";
import { BrowseTheWebToken } from "./browse-the-web.js";
import type { Target } from "./target.js";

export const Navigate = {
  to(path: string): Activity {
    return {
      description: `Navigate to ${path}`,
      async performAs(actor) {
        const page = actor.ability(BrowseTheWebToken).session.page;
        await page.goto(path);
      },
    };
  },
};

export const Click = {
  on(target: Target): Activity {
    return {
      description: `Click ${target.description}`,
      async performAs(actor) {
        const page = actor.ability(BrowseTheWebToken).session.page;
        await target.resolve(page).click();
      },
    };
  },
};

export const Enter = {
  theText(value: string) {
    return {
      into(target: Target): Activity {
        return {
          description: `Enter "${value}" into ${target.description}`,
          async performAs(actor) {
            const page = actor.ability(BrowseTheWebToken).session.page;
            await target.resolve(page).fill(value);
          },
        };
      },
    };
  },
};
```

`packages/screenplay/src/questions.ts`:
```ts
import type { Question } from "./core.js";
import { BrowseTheWebToken } from "./browse-the-web.js";
import type { Target } from "./target.js";

export const TextOf = {
  target(target: Target): Question<string> {
    return {
      description: `text of ${target.description}`,
      async answeredBy(actor) {
        const page = actor.ability(BrowseTheWebToken).session.page;
        return target.resolve(page).innerText();
      },
    };
  },
};

export const IsVisible = {
  target(target: Target): Question<boolean> {
    return {
      description: `visibility of ${target.description}`,
      async answeredBy(actor) {
        const page = actor.ability(BrowseTheWebToken).session.page;
        return target.resolve(page).isVisible();
      },
    };
  },
};

export const CountOf = {
  target(target: Target): Question<number> {
    return {
      description: `count of ${target.description}`,
      async answeredBy(actor) {
        const page = actor.ability(BrowseTheWebToken).session.page;
        return target.resolve(page).count();
      },
    };
  },
};
```

Append to `packages/screenplay/src/index.ts`:
```ts
export * from "./interactions.js";
export * from "./questions.js";
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test packages/screenplay/src/interactions.test.ts` → PASS. Then `pnpm -r build`.

- [ ] **Step 5: Commit**

```bash
git add packages/screenplay/src/interactions.ts packages/screenplay/src/questions.ts packages/screenplay/src/interactions.test.ts packages/screenplay/src/index.ts
git commit -m "feat(screenplay): interactions and questions over Targets" -m "Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 6: `@doit/site-sdk` — ActionDefinition + registry

**Files:**
- Create: `packages/site-sdk/package.json`, `packages/site-sdk/tsconfig.json`, `packages/site-sdk/src/action.ts`, `packages/site-sdk/src/registry.ts`, `packages/site-sdk/src/registry.test.ts`, `packages/site-sdk/src/index.ts`
- Modify: root `tsconfig.json`, root `vitest.config.ts`

**Interfaces:**
- Consumes: `Actor` from `@doit/screenplay`; `RiskClass` from `@doit/domain`; zod.
- Produces:
  - `interface ActionDefinition<I extends z.ZodType, O extends z.ZodType> { id: string; version: string; input: I; output: O; risk: RiskClass; throttleClass: string; execute(actor: Actor, input: z.output<I>): Promise<z.output<O>> }`
  - `function defineAction<I,O>(def: ActionDefinition<I,O>): ActionDefinition<I,O>` (identity, for typing).
  - `class ActionRegistry { register(site: string, def: ActionDefinition<any,any>): void; resolve(site: string, id: string, version: string): ActionDefinition<any,any> }` throwing `UnknownActionError` when absent.

- [ ] **Step 1: Write the failing test**

`packages/site-sdk/src/registry.test.ts`:
```ts
import { expect, test } from "vitest";
import { z } from "zod";
import { defineAction, ActionRegistry, UnknownActionError } from "./index.js";

const Ping = defineAction({
  id: "diag.ping", version: "1.0.0",
  input: z.object({}), output: z.object({ ok: z.boolean() }),
  risk: "read", throttleClass: "read",
  async execute() { return { ok: true }; },
});

test("registry resolves a registered action and rejects unknown", () => {
  const reg = new ActionRegistry();
  reg.register("example-network", Ping);
  expect(reg.resolve("example-network", "diag.ping", "1.0.0").id).toBe("diag.ping");
  expect(() => reg.resolve("example-network", "diag.ping", "9.9.9")).toThrow(UnknownActionError);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test packages/site-sdk/src/registry.test.ts` → FAIL (package/module not found).

- [ ] **Step 3: Create the package and implement**

`packages/site-sdk/package.json`:
```json
{
  "name": "@doit/site-sdk",
  "version": "0.0.0",
  "type": "module",
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "exports": { ".": "./dist/index.js" },
  "dependencies": { "@doit/domain": "workspace:*", "@doit/screenplay": "workspace:*", "zod": "^4.6.5" },
  "scripts": { "build": "tsc --build" }
}
```

`packages/site-sdk/tsconfig.json`:
```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "rootDir": "src", "outDir": "dist" },
  "references": [{ "path": "../domain" }, { "path": "../screenplay" }],
  "include": ["src/**/*"],
  "exclude": ["src/**/*.test.ts"]
}
```

`packages/site-sdk/src/action.ts`:
```ts
import type { z } from "zod";
import type { Actor } from "@doit/screenplay";
import type { RiskClass } from "@doit/domain";

export interface ActionDefinition<I extends z.ZodType, O extends z.ZodType> {
  readonly id: string;
  readonly version: string;
  readonly input: I;
  readonly output: O;
  readonly risk: RiskClass;
  readonly throttleClass: string;
  execute(actor: Actor, input: z.output<I>): Promise<z.output<O>>;
}

export function defineAction<I extends z.ZodType, O extends z.ZodType>(
  def: ActionDefinition<I, O>,
): ActionDefinition<I, O> {
  return def;
}
```

`packages/site-sdk/src/registry.ts`:
```ts
import type { ActionDefinition } from "./action.js";

export class UnknownActionError extends Error {
  constructor(site: string, id: string, version: string) {
    super(`Unknown action: ${site}/${id}@${version}`);
    this.name = "UnknownActionError";
  }
}

type AnyAction = ActionDefinition<any, any>;

export class ActionRegistry {
  private readonly actions = new Map<string, AnyAction>();

  private key(site: string, id: string, version: string): string {
    return `${site}::${id}::${version}`;
  }

  register(site: string, def: AnyAction): void {
    this.actions.set(this.key(site, def.id, def.version), def);
  }

  resolve(site: string, id: string, version: string): AnyAction {
    const found = this.actions.get(this.key(site, id, version));
    if (!found) throw new UnknownActionError(site, id, version);
    return found;
  }
}
```

`packages/site-sdk/src/index.ts`:
```ts
export * from "./action.js";
export * from "./registry.js";
```

Add `{ "path": "packages/site-sdk" }` to root `tsconfig.json` and `"@doit/site-sdk": pkg("site-sdk")` to `vitest.config.ts`.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm install && pnpm test packages/site-sdk/src/registry.test.ts` → PASS. Then `pnpm -r build`.

- [ ] **Step 5: Commit**

```bash
git add packages/site-sdk tsconfig.json vitest.config.ts pnpm-lock.yaml
git commit -m "feat(site-sdk): ActionDefinition contract and action registry" -m "Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 7: `apps/example-site` — Fastify fixture (login + inbox + thread)

**Files:**
- Create: `apps/example-site/package.json`, `apps/example-site/tsconfig.json`, `apps/example-site/src/server.ts`, `apps/example-site/src/data.ts`, `apps/example-site/src/index.ts`, `apps/example-site/src/server.test.ts`
- Modify: root `tsconfig.json`, root `vitest.config.ts`

**Interfaces:**
- Consumes: nothing from siblings.
- Produces:
  - `function buildServer(): FastifyInstance` — routes below, using an in-memory session cookie `sid`.
  - `function startServer(port?: number): Promise<{ url: string; close(): Promise<void> }>` — listens on an ephemeral port (`port ?? 0`) and returns the resolved base URL.
  - Seed data in `data.ts`: two threads, each with messages.
- Routes & markup contract (Screenplay targets depend on these accessible names):
  - `GET /login` → form with a textbox labeled `Username` and a button named `Sign in`. POST `/login` sets cookie `sid=ok` and redirects to `/inbox`.
  - `GET /inbox` → if no valid `sid` cookie, redirect (302) to `/login`. Else render a heading `Inbox`, and for each thread a link with role `link` whose accessible name is the thread subject and `href="/thread/<id>"`; each list item exposes `data-thread-id`, `data-sender`, `data-received-at`, `data-message-id`, and the message text.
  - `GET /thread/:id` → if unauthenticated redirect to `/login`; else render heading with the subject and the messages (each with `data-message-id`, `data-sender`, `data-received-at`, text).
  - `GET /whoami` → JSON `{ authenticated: boolean, account: string | null }` based on the cookie (used by `session.status`).

- [ ] **Step 1: Write the failing test**

`apps/example-site/src/server.test.ts`:
```ts
import { afterAll, beforeAll, expect, test } from "vitest";
import { startServer } from "./index.js";

let srv: { url: string; close(): Promise<void> };
beforeAll(async () => { srv = await startServer(); });
afterAll(async () => { await srv.close(); });

test("unauthenticated inbox redirects to login", async () => {
  const res = await fetch(`${srv.url}/inbox`, { redirect: "manual" });
  expect(res.status).toBe(302);
  expect(res.headers.get("location")).toBe("/login");
});

test("login sets a cookie and whoami reports authenticated", async () => {
  const login = await fetch(`${srv.url}/login`, {
    method: "POST", redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: "username=jane",
  });
  const cookie = login.headers.get("set-cookie")!.split(";")[0];
  const who = await fetch(`${srv.url}/whoami`, { headers: { cookie } });
  expect(await who.json()).toMatchObject({ authenticated: true });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test apps/example-site/src/server.test.ts` → FAIL (package/module not found).

- [ ] **Step 3: Create the package and implement**

`apps/example-site/package.json`:
```json
{
  "name": "@doit/example-site",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "exports": { ".": "./dist/index.js" },
  "dependencies": { "@fastify/cookie": "^10.0.0", "@fastify/formbody": "^8.0.0", "fastify": "^5.0.0" },
  "scripts": { "build": "tsc --build" }
}
```

`apps/example-site/tsconfig.json`:
```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "rootDir": "src", "outDir": "dist" },
  "include": ["src/**/*"],
  "exclude": ["src/**/*.test.ts"]
}
```

`apps/example-site/src/data.ts`:
```ts
export interface SeedMessage { id: string; sender: string; receivedAt: string; text: string; }
export interface SeedThread { id: string; subject: string; messages: SeedMessage[]; }

export const SEED_THREADS: SeedThread[] = [
  { id: "t-1", subject: "Welcome", messages: [
    { id: "m-1", sender: "jane", receivedAt: "2026-09-17T09:00:00.000Z", text: "Hello there" },
  ]},
  { id: "t-2", subject: "Follow up", messages: [
    { id: "m-2", sender: "raj", receivedAt: "2026-09-17T10:00:00.000Z", text: "Circling back" },
    { id: "m-3", sender: "raj", receivedAt: "2026-09-17T10:05:00.000Z", text: "Any update?" },
  ]},
];
```

`apps/example-site/src/server.ts`:
```ts
import Fastify, { type FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";
import formbody from "@fastify/formbody";
import { SEED_THREADS } from "./data.js";

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));
const authed = (req: { cookies: Record<string, string | undefined> }) => req.cookies.sid === "ok";

export function buildServer(): FastifyInstance {
  const app = Fastify();
  app.register(cookie);
  app.register(formbody);

  app.get("/login", async (_req, reply) => {
    reply.type("text/html").send(`<!doctype html><html><body><h1>Sign in</h1>
<form method="post" action="/login">
<label>Username <input name="username" aria-label="Username" /></label>
<button type="submit">Sign in</button></form></body></html>`);
  });

  app.post<{ Body: { username?: string } }>("/login", async (req, reply) => {
    if (!req.body?.username) { reply.code(400).send("username required"); return; }
    reply.setCookie("sid", "ok", { path: "/" }).redirect("/inbox");
  });

  app.get("/whoami", async (req, reply) => {
    reply.send({ authenticated: authed(req), account: authed(req) ? "jane" : null });
  });

  app.get("/inbox", async (req, reply) => {
    if (!authed(req)) { reply.redirect("/login"); return; }
    const items = SEED_THREADS.map((t) => {
      const first = t.messages[0];
      return `<li data-thread-id="${esc(t.id)}" data-message-id="${esc(first.id)}" data-sender="${esc(first.sender)}" data-received-at="${esc(first.receivedAt)}">
<a href="/thread/${esc(t.id)}">${esc(t.subject)}</a>
<p>${esc(first.text)}</p></li>`;
    }).join("");
    reply.type("text/html").send(`<!doctype html><html><body><h1>Inbox</h1><ul>${items}</ul></body></html>`);
  });

  app.get<{ Params: { id: string } }>("/thread/:id", async (req, reply) => {
    if (!authed(req)) { reply.redirect("/login"); return; }
    const t = SEED_THREADS.find((x) => x.id === req.params.id);
    if (!t) { reply.code(404).send("not found"); return; }
    const msgs = t.messages.map((m) =>
      `<li data-message-id="${esc(m.id)}" data-sender="${esc(m.sender)}" data-received-at="${esc(m.receivedAt)}">${esc(m.text)}</li>`,
    ).join("");
    reply.type("text/html").send(`<!doctype html><html><body><h1>${esc(t.subject)}</h1><ul>${msgs}</ul></body></html>`);
  });

  return app;
}
```

`apps/example-site/src/index.ts`:
```ts
import { buildServer } from "./server.js";

export { buildServer } from "./server.js";
export { SEED_THREADS } from "./data.js";

export async function startServer(port = 0): Promise<{ url: string; close(): Promise<void> }> {
  const app = buildServer();
  await app.listen({ port, host: "127.0.0.1" });
  const addr = app.server.address();
  if (addr === null || typeof addr === "string") throw new Error("failed to bind");
  const url = `http://127.0.0.1:${addr.port}`;
  return { url, close: () => app.close() };
}
```

Add `{ "path": "apps/example-site" }` to root `tsconfig.json` and `"@doit/example-site": pkg("example-site")` to `vitest.config.ts` — but note the alias helper points at `packages/<name>`; for apps add an explicit alias entry `"@doit/example-site": fileURLToPath(new URL("./apps/example-site/src/index.ts", import.meta.url))` (do not force it through `pkg()`).

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm install && pnpm test apps/example-site/src/server.test.ts` → PASS. Then `pnpm -r build`.

- [ ] **Step 5: Commit**

```bash
git add apps/example-site tsconfig.json vitest.config.ts pnpm-lock.yaml
git commit -m "feat(example-site): Fastify fixture with login, inbox, thread" -m "Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 8: Storage — incoming_message table

**Files:**
- Create: `packages/storage-sqlite/src/migrations/2026-09-17-incoming-message.ts`
- Modify: `packages/storage-sqlite/src/schema.ts` (add `IncomingMessageTable` + `Database.incoming_message`), `packages/storage-sqlite/src/migrator.ts` (append the new migration to the ordered array)
- Test: `packages/storage-sqlite/src/migrator.test.ts` (add a case)

**Interfaces:**
- Produces: an `incoming_message` table with `UNIQUE (site, account_id, source_message_id)` (dedup key, CONOPS §4.2), columns: `id`, `site`, `account_id`, `source_thread_id`, `source_message_id`, `sender`, `received_at`, `text`, `first_seen_at`, `processing_status`. Schema type `IncomingMessageTable`.

- [ ] **Step 1: Write the failing test** (append to `migrator.test.ts`)

```ts
test("incoming_message dedups on (site, account_id, source_message_id)", async () => {
  const db = openDatabase(":memory:");
  await migrateToLatest(db);
  const now = new Date().toISOString();
  const row = { id: "im_1", site: "s", account_id: "a", source_thread_id: "t1", source_message_id: "m1",
    sender: "jane", received_at: now, text: "hi", first_seen_at: now, processing_status: "new" };
  await db.insertInto("incoming_message").values(row).execute();
  await expect(
    db.insertInto("incoming_message").values({ ...row, id: "im_2" }).execute(),
  ).rejects.toThrow();
  await db.destroy();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test packages/storage-sqlite/src/migrator.test.ts` → the new case FAILS (no such table / no unique constraint).

- [ ] **Step 3: Implement**

`packages/storage-sqlite/src/migrations/2026-09-17-incoming-message.ts`:
```ts
import { Kysely, sql } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE TABLE IF NOT EXISTS incoming_message (
      id TEXT PRIMARY KEY,
      site TEXT NOT NULL,
      account_id TEXT NOT NULL,
      source_thread_id TEXT NOT NULL,
      source_message_id TEXT NOT NULL,
      sender TEXT NOT NULL,
      received_at TEXT NOT NULL,
      text TEXT NOT NULL,
      first_seen_at TEXT NOT NULL,
      processing_status TEXT NOT NULL,
      UNIQUE (site, account_id, source_message_id)
    )`.execute(db);
  await sql`CREATE INDEX IF NOT EXISTS idx_incoming_thread
    ON incoming_message (site, account_id, source_thread_id)`.execute(db);
}
```

Add to `packages/storage-sqlite/src/schema.ts`:
```ts
export interface IncomingMessageTable {
  id: string;
  site: string;
  account_id: string;
  source_thread_id: string;
  source_message_id: string;
  sender: string;
  received_at: string;
  text: string;
  first_seen_at: string;
  processing_status: string;
}
```
and add `incoming_message: IncomingMessageTable;` to the `Database` interface.

In `migrator.ts`, import the new migration and append it AFTER the initial one:
```ts
import { up as incomingMessage } from "./migrations/2026-09-17-incoming-message.js";
const MIGRATIONS = [initial, incomingMessage];
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test packages/storage-sqlite/src/migrator.test.ts` → PASS. Then `pnpm -r build`.

- [ ] **Step 5: Commit**

```bash
git add packages/storage-sqlite/src/migrations/2026-09-17-incoming-message.ts packages/storage-sqlite/src/schema.ts packages/storage-sqlite/src/migrator.ts packages/storage-sqlite/src/migrator.test.ts
git commit -m "feat(storage): incoming_message table with source-id dedup" -m "Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 9: Storage — IncomingMessageRepository + port

**Files:**
- Create: `packages/storage-sqlite/src/incoming-message-repository.ts`, `packages/storage-sqlite/src/incoming-message-repository.test.ts`
- Modify: `packages/application/src/ports.ts` (add `IncomingMessageRepository` port + `IncomingMessageRecord`), `packages/application/src/index.ts` (already re-exports ports), `packages/storage-sqlite/src/index.ts`

**Interfaces:**
- Consumes: `NormalizedMessage` from `@doit/domain`; `Clock`, the new `IncomingMessageRepository` port from `@doit/application`; `Database`, `newCommandId`-style id (use `nanoid` with an `im_` prefix — add a `newIncomingMessageId()` to domain primitives OR generate inline; prefer inline `im_${nanoid()}`).
- Produces:
  - Port (in `@doit/application`): `interface IncomingMessageRecord extends NormalizedMessage { id: string; site: string; account: string; firstSeenAt: string; processingStatus: string }` and `interface IncomingMessageRepository { upsert(site: string, account: string, msg: NormalizedMessage): Promise<{ inserted: boolean; id: string }>; listBySite(site: string, account: string): Promise<IncomingMessageRecord[]> }`.
  - `class SqliteIncomingMessageRepository implements IncomingMessageRepository` — `upsert` is dedup-idempotent: on `UNIQUE(site, account_id, source_message_id)` conflict it returns `{ inserted: false, id: <existing> }` and does NOT overwrite `first_seen_at`.

- [ ] **Step 1: Write the failing test**

`packages/storage-sqlite/src/incoming-message-repository.test.ts`:
```ts
import { expect, test } from "vitest";
import { openDatabase } from "./db.js";
import { migrateToLatest } from "./migrator.js";
import { SqliteIncomingMessageRepository } from "./incoming-message-repository.js";

const clock = { nowIso: () => "2026-09-17T12:00:00.000Z", monotonicMs: () => 0 };
const msg = { sourceMessageId: "m1", sourceThreadId: "t1", sender: "jane", receivedAt: "2026-09-17T09:00:00.000Z", text: "hi" };

test("upsert inserts once, dedups on repeat, preserves first_seen", async () => {
  const db = openDatabase(":memory:");
  await migrateToLatest(db);
  const repo = new SqliteIncomingMessageRepository(db, clock);
  const first = await repo.upsert("example-network", "primary", msg);
  const second = await repo.upsert("example-network", "primary", msg);
  expect(first.inserted).toBe(true);
  expect(second.inserted).toBe(false);
  expect(second.id).toBe(first.id);
  const all = await repo.listBySite("example-network", "primary");
  expect(all).toHaveLength(1);
  expect(all[0].firstSeenAt).toBe("2026-09-17T12:00:00.000Z");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test packages/storage-sqlite/src/incoming-message-repository.test.ts` → FAIL (module not found).

- [ ] **Step 3: Implement**

Add to `packages/application/src/ports.ts`:
```ts
import type { NormalizedMessage } from "@doit/domain";

export interface IncomingMessageRecord extends NormalizedMessage {
  id: string;
  site: string;
  account: string;
  firstSeenAt: string;
  processingStatus: string;
}

export interface IncomingMessageRepository {
  upsert(site: string, account: string, msg: NormalizedMessage): Promise<{ inserted: boolean; id: string }>;
  listBySite(site: string, account: string): Promise<IncomingMessageRecord[]>;
}
```

`packages/storage-sqlite/src/incoming-message-repository.ts`:
```ts
import { nanoid } from "nanoid";
import type { Kysely } from "kysely";
import type { Clock, IncomingMessageRecord, IncomingMessageRepository } from "@doit/application";
import type { NormalizedMessage } from "@doit/domain";
import type { Database, IncomingMessageTable } from "./schema.js";

function toRecord(row: IncomingMessageTable): IncomingMessageRecord {
  return {
    id: row.id, site: row.site, account: row.account_id,
    sourceThreadId: row.source_thread_id, sourceMessageId: row.source_message_id,
    sender: row.sender, receivedAt: row.received_at, text: row.text,
    firstSeenAt: row.first_seen_at, processingStatus: row.processing_status,
  };
}

export class SqliteIncomingMessageRepository implements IncomingMessageRepository {
  constructor(private readonly db: Kysely<Database>, private readonly clock: Clock) {}

  async upsert(site: string, account: string, msg: NormalizedMessage): Promise<{ inserted: boolean; id: string }> {
    const now = this.clock.nowIso();
    const id = `im_${nanoid()}`;
    try {
      await this.db.insertInto("incoming_message").values({
        id, site, account_id: account, source_thread_id: msg.sourceThreadId,
        source_message_id: msg.sourceMessageId, sender: msg.sender, received_at: msg.receivedAt,
        text: msg.text, first_seen_at: now, processing_status: "new",
      }).execute();
      return { inserted: true, id };
    } catch (err) {
      const existing = await this.db.selectFrom("incoming_message").select("id")
        .where("site", "=", site).where("account_id", "=", account)
        .where("source_message_id", "=", msg.sourceMessageId).executeTakeFirst();
      if (existing) return { inserted: false, id: existing.id };
      throw err;
    }
  }

  async listBySite(site: string, account: string): Promise<IncomingMessageRecord[]> {
    const rows = await this.db.selectFrom("incoming_message").selectAll()
      .where("site", "=", site).where("account_id", "=", account)
      .orderBy("received_at", "asc").execute();
    return rows.map(toRecord);
  }
}
```

Append to `packages/storage-sqlite/src/index.ts`:
```ts
export * from "./incoming-message-repository.js";
```

Ensure `@doit/storage-sqlite` has `nanoid` as a dependency (`pnpm add --filter @doit/storage-sqlite nanoid`).

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm install && pnpm test packages/storage-sqlite/src/incoming-message-repository.test.ts` → PASS. Then `pnpm -r build`.

- [ ] **Step 5: Commit**

```bash
git add packages/application/src/ports.ts packages/storage-sqlite/src/incoming-message-repository.ts packages/storage-sqlite/src/incoming-message-repository.test.ts packages/storage-sqlite/src/index.ts packages/storage-sqlite/package.json pnpm-lock.yaml
git commit -m "feat(storage): incoming message repository with dedup upsert" -m "Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 10: `example-network` — targets + questions

**Files:**
- Create: `site-integrations/example-network/package.json`, `site-integrations/example-network/tsconfig.json`, `site-integrations/example-network/src/targets.ts`, `site-integrations/example-network/src/questions.ts`, `site-integrations/example-network/src/questions.test.ts`, `site-integrations/example-network/src/index.ts`
- Modify: root `tsconfig.json`, root `vitest.config.ts`

**Interfaces:**
- Consumes: `Target` from `@doit/screenplay`; `BrowseTheWebToken`; `NormalizedThread`/`NormalizedMessage` from `@doit/domain`; `Question`/`Actor` from screenplay.
- Produces:
  - Targets: `UsernameField`, `SignInButton`, `InboxHeading`, `ThreadItems` (the `<li data-thread-id>` list), `ThreadMessages` (`<li data-message-id>`), `ThreadHeading`.
  - Questions: `AuthenticatedUser: Question<{ authenticated: boolean; account: string | null }>` (reads `/whoami` via `page.request`); `InboxThreads: Question<NormalizedThread[]>` (reads the DOM data attributes on `/inbox`); `ThreadDetail(id): Question<NormalizedThread>` (reads `/thread/:id`).

- [ ] **Step 1: Write the failing test** (DOM-parsing questions against a fake page/locator; `AuthenticatedUser` against a fake `page.request`)

`site-integrations/example-network/src/questions.test.ts`:
```ts
import { expect, test } from "vitest";
import { CastActor } from "@doit/screenplay";
import { BrowseTheWeb } from "@doit/screenplay";
import { AuthenticatedUser } from "./questions.js";

function actorWithPage(page: any) {
  const session = { page, startTracing: async () => {}, stopTracingToFile: async () => {}, close: async () => {} };
  return CastActor.named("T").whoCan(new BrowseTheWeb(session, []));
}

test("AuthenticatedUser reads /whoami JSON via page.request", async () => {
  const page: any = { request: { get: async (u: string) => ({ json: async () => ({ authenticated: true, account: "jane" }) }) } };
  const actor = actorWithPage(page);
  expect(await actor.asks(AuthenticatedUser)).toEqual({ authenticated: true, account: "jane" });
});
```

> Note: `InboxThreads`/`ThreadDetail` DOM-parsing are covered end-to-end in Task 16's integration test against the real fixture (they need a real DOM). This unit test locks the `AuthenticatedUser` contract, which is pure request/JSON.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test site-integrations/example-network/src/questions.test.ts` → FAIL (package/module not found).

- [ ] **Step 3: Create the package and implement**

`site-integrations/example-network/package.json`:
```json
{
  "name": "@doit/site-example-network",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "exports": { ".": "./dist/index.js" },
  "dependencies": { "@doit/domain": "workspace:*", "@doit/screenplay": "workspace:*", "@doit/site-sdk": "workspace:*", "zod": "^4.6.5" },
  "scripts": { "build": "tsc --build" }
}
```

`site-integrations/example-network/tsconfig.json`:
```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "rootDir": "src", "outDir": "dist" },
  "references": [{ "path": "../../packages/domain" }, { "path": "../../packages/screenplay" }, { "path": "../../packages/site-sdk" }],
  "include": ["src/**/*"],
  "exclude": ["src/**/*.test.ts"]
}
```

`site-integrations/example-network/src/targets.ts`:
```ts
import { Target } from "@doit/screenplay";

export const UsernameField = Target.named("username field").locatedBy((p) => p.getByLabel("Username"));
export const SignInButton = Target.named("sign in button").locatedBy((p) => p.getByRole("button", { name: "Sign in" }));
export const InboxHeading = Target.named("inbox heading").locatedBy((p) => p.getByRole("heading", { name: "Inbox" }));
export const ThreadItems = Target.named("thread items").locatedBy((p) => p.locator("li[data-thread-id]"));
export const ThreadMessages = Target.named("thread messages").locatedBy((p) => p.locator("li[data-message-id]"));
```

`site-integrations/example-network/src/questions.ts`:
```ts
import type { Question } from "@doit/screenplay";
import { BrowseTheWebToken } from "@doit/screenplay";
import type { NormalizedThread } from "@doit/domain";

export const AuthenticatedUser: Question<{ authenticated: boolean; account: string | null }> = {
  description: "authenticated user",
  async answeredBy(actor) {
    const page = actor.ability(BrowseTheWebToken).session.page;
    const res = await page.request.get("/whoami");
    return res.json() as Promise<{ authenticated: boolean; account: string | null }>;
  },
};

export const InboxThreads: Question<NormalizedThread[]> = {
  description: "inbox threads",
  async answeredBy(actor) {
    const page = actor.ability(BrowseTheWebToken).session.page;
    const items = page.locator("li[data-thread-id]");
    const count = await items.count();
    const threads: NormalizedThread[] = [];
    for (let i = 0; i < count; i++) {
      const li = items.nth(i);
      const [sourceThreadId, sourceMessageId, sender, receivedAt] = await Promise.all([
        li.getAttribute("data-thread-id"), li.getAttribute("data-message-id"),
        li.getAttribute("data-sender"), li.getAttribute("data-received-at"),
      ]);
      const subject = (await li.getByRole("link").innerText()).trim();
      const text = (await li.locator("p").innerText()).trim();
      threads.push({
        sourceThreadId: sourceThreadId!, subject,
        messages: [{ sourceThreadId: sourceThreadId!, sourceMessageId: sourceMessageId!, sender: sender!, receivedAt: receivedAt!, text }],
      });
    }
    return threads;
  },
};

export function ThreadDetail(threadId: string): Question<NormalizedThread> {
  return {
    description: `thread ${threadId}`,
    async answeredBy(actor) {
      const page = actor.ability(BrowseTheWebToken).session.page;
      const subject = (await page.getByRole("heading").first().innerText()).trim();
      const items = page.locator("li[data-message-id]");
      const count = await items.count();
      const messages = [];
      for (let i = 0; i < count; i++) {
        const li = items.nth(i);
        const [sourceMessageId, sender, receivedAt] = await Promise.all([
          li.getAttribute("data-message-id"), li.getAttribute("data-sender"), li.getAttribute("data-received-at"),
        ]);
        messages.push({ sourceThreadId: threadId, sourceMessageId: sourceMessageId!, sender: sender!, receivedAt: receivedAt!, text: (await li.innerText()).trim() });
      }
      return { sourceThreadId: threadId, subject, messages };
    },
  };
}
```

`site-integrations/example-network/src/index.ts`:
```ts
export * from "./targets.js";
export * from "./questions.js";
```

Add `{ "path": "site-integrations/example-network" }` to root `tsconfig.json` and an alias `"@doit/site-example-network": fileURLToPath(new URL("./site-integrations/example-network/src/index.ts", import.meta.url))` in `vitest.config.ts`.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm install && pnpm test site-integrations/example-network/src/questions.test.ts` → PASS. Then `pnpm -r build`.

- [ ] **Step 5: Commit**

```bash
git add site-integrations/example-network tsconfig.json vitest.config.ts pnpm-lock.yaml
git commit -m "feat(example-network): targets and read questions" -m "Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 11: `example-network` — read actions (session.status, inbox.list, thread.get)

**Files:**
- Create: `site-integrations/example-network/src/actions.ts`, `site-integrations/example-network/src/actions.test.ts`
- Modify: `site-integrations/example-network/src/index.ts`

**Interfaces:**
- Consumes: `defineAction` from `@doit/site-sdk`; `Navigate` from `@doit/screenplay`; the targets/questions from Task 10; zod; `NormalizedThreadSchema` from `@doit/domain`.
- Produces (each an `ActionDefinition`):
  - `SessionStatus` — id `session.status`, v `1.0.0`, risk `read`; input `z.object({})`; output `z.object({ authenticated: z.boolean(), account: z.string().nullable() })`; execute navigates to `/inbox` is NOT required — it just asks `AuthenticatedUser`.
  - `InboxList` — id `inbox.list`, v `1.0.0`, risk `read`; input `z.object({ limit: z.number().int().min(1).max(50).default(20) })`; output `z.object({ items: z.array(NormalizedThreadSchema) })`; execute `Navigate.to("/inbox")` then asks `InboxThreads`, slices to `limit`.
  - `ThreadGet` — id `thread.get`, v `1.0.0`, risk `read`; input `z.object({ threadId: z.string().min(1) })`; output `NormalizedThreadSchema`; execute `Navigate.to("/thread/" + input.threadId)` then asks `ThreadDetail(input.threadId)`.
  - `EXAMPLE_NETWORK_ACTIONS: ActionDefinition<any,any>[]` exporting all three.

- [ ] **Step 1: Write the failing test** (unit-level: verify the action definitions' metadata + input parsing; execution is covered end-to-end in Task 16)

`site-integrations/example-network/src/actions.test.ts`:
```ts
import { expect, test } from "vitest";
import { SessionStatus, InboxList, ThreadGet } from "./actions.js";

test("action metadata and input schemas are correct", () => {
  expect(SessionStatus.id).toBe("session.status");
  expect(InboxList.id).toBe("inbox.list");
  expect(InboxList.input.parse({}).limit).toBe(20);
  expect(() => InboxList.input.parse({ limit: 0 })).toThrow();
  expect(ThreadGet.id).toBe("thread.get");
  expect(() => ThreadGet.input.parse({})).toThrow();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test site-integrations/example-network/src/actions.test.ts` → FAIL (module not found).

- [ ] **Step 3: Implement**

`site-integrations/example-network/src/actions.ts`:
```ts
import { z } from "zod";
import { defineAction } from "@doit/site-sdk";
import { Navigate } from "@doit/screenplay";
import { NormalizedThreadSchema } from "@doit/domain";
import { AuthenticatedUser, InboxThreads, ThreadDetail } from "./questions.js";

export const SessionStatus = defineAction({
  id: "session.status", version: "1.0.0",
  input: z.object({}),
  output: z.object({ authenticated: z.boolean(), account: z.string().nullable() }),
  risk: "read", throttleClass: "read",
  async execute(actor) {
    return actor.asks(AuthenticatedUser);
  },
});

export const InboxList = defineAction({
  id: "inbox.list", version: "1.0.0",
  input: z.object({ limit: z.number().int().min(1).max(50).default(20) }),
  output: z.object({ items: z.array(NormalizedThreadSchema) }),
  risk: "read", throttleClass: "read",
  async execute(actor, input) {
    await actor.attemptsTo(Navigate.to("/inbox"));
    const items = await actor.asks(InboxThreads);
    return { items: items.slice(0, input.limit) };
  },
});

export const ThreadGet = defineAction({
  id: "thread.get", version: "1.0.0",
  input: z.object({ threadId: z.string().min(1) }),
  output: NormalizedThreadSchema,
  risk: "read", throttleClass: "read",
  async execute(actor, input) {
    await actor.attemptsTo(Navigate.to(`/thread/${input.threadId}`));
    return actor.asks(ThreadDetail(input.threadId));
  },
});

export const EXAMPLE_NETWORK_ACTIONS = [SessionStatus, InboxList, ThreadGet];
```

Append to `site-integrations/example-network/src/index.ts`:
```ts
export * from "./actions.js";
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test site-integrations/example-network/src/actions.test.ts` → PASS. Then `pnpm -r build`.

- [ ] **Step 5: Commit**

```bash
git add site-integrations/example-network/src/actions.ts site-integrations/example-network/src/actions.test.ts site-integrations/example-network/src/index.ts
git commit -m "feat(example-network): session.status, inbox.list, thread.get actions" -m "Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 12: Runner — actor assembly + registered-action execution

**Files:**
- Create: `packages/screenplay/src/runner.ts`, `packages/screenplay/src/runner.test.ts`
- Modify: `packages/screenplay/src/index.ts`, `packages/screenplay/package.json` (add `@doit/site-sdk` dep)

**Interfaces:**
- Consumes: `BrowserPort` from `@doit/playwright`; `ActionRegistry` from `@doit/site-sdk`; `BrowseTheWeb` ability; `CastActor`.
- Produces:
  - `interface RunRequest { site: string; account: string; actionId: string; version: string; input: unknown; profileDir: string; baseUrl: string; headless: boolean; allowedOrigins: string[] }`
  - `interface RunResult { output: unknown }`
  - `class ActionRunner { constructor(browser: BrowserPort, registry: ActionRegistry) ; run(req: RunRequest): Promise<RunResult> }` — resolves the action, opens a session, builds a `CastActor` with a `BrowseTheWeb` ability, validates input via `action.input.parse`, executes, validates output via `action.output.parse`, always closes the session. This is the ONLY place a `BrowserPort` is opened.

- [ ] **Step 1: Write the failing test** (fake BrowserPort + a trivial registered action, so the runner is tested without a real browser)

`packages/screenplay/src/runner.test.ts`:
```ts
import { expect, test } from "vitest";
import { z } from "zod";
import { defineAction, ActionRegistry } from "@doit/site-sdk";
import { BrowseTheWebToken } from "./browse-the-web.js";
import { ActionRunner } from "./runner.js";

const fakeBrowser = {
  open: async () => ({
    page: { url: () => "about:blank" } as any,
    startTracing: async () => {},
    stopTracingToFile: async () => {},
    close: async () => {},
  }),
};

const Echo = defineAction({
  id: "diag.echo", version: "1.0.0",
  input: z.object({ msg: z.string() }), output: z.object({ echoed: z.string(), hasBrowser: z.boolean() }),
  risk: "read", throttleClass: "read",
  async execute(actor, input) {
    return { echoed: input.msg, hasBrowser: !!actor.ability(BrowseTheWebToken) };
  },
});

test("runner resolves, validates, executes, and returns typed output", async () => {
  const reg = new ActionRegistry();
  reg.register("example-network", Echo);
  const runner = new ActionRunner(fakeBrowser as any, reg);
  const res = await runner.run({
    site: "example-network", account: "primary", actionId: "diag.echo", version: "1.0.0",
    input: { msg: "hi" }, profileDir: "/tmp/x", baseUrl: "about:blank", headless: true, allowedOrigins: [],
  });
  expect(res.output).toEqual({ echoed: "hi", hasBrowser: true });
});

test("runner rejects invalid input", async () => {
  const reg = new ActionRegistry();
  reg.register("example-network", Echo);
  const runner = new ActionRunner(fakeBrowser as any, reg);
  await expect(runner.run({
    site: "example-network", account: "primary", actionId: "diag.echo", version: "1.0.0",
    input: { msg: 123 }, profileDir: "/tmp/x", baseUrl: "about:blank", headless: true, allowedOrigins: [],
  })).rejects.toThrow();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test packages/screenplay/src/runner.test.ts` → FAIL (module not found).

- [ ] **Step 3: Implement**

`packages/screenplay/src/runner.ts`:
```ts
import type { BrowserPort } from "@doit/playwright";
import type { ActionRegistry } from "@doit/site-sdk";
import { CastActor } from "./cast-actor.js";
import { BrowseTheWeb } from "./browse-the-web.js";

export interface RunRequest {
  site: string;
  account: string;
  actionId: string;
  version: string;
  input: unknown;
  profileDir: string;
  baseUrl: string;
  headless: boolean;
  allowedOrigins: string[];
}

export interface RunResult {
  output: unknown;
}

export class ActionRunner {
  constructor(
    private readonly browser: BrowserPort,
    private readonly registry: ActionRegistry,
  ) {}

  async run(req: RunRequest): Promise<RunResult> {
    const action = this.registry.resolve(req.site, req.actionId, req.version);
    const input = action.input.parse(req.input);
    const session = await this.browser.open({
      profileDir: req.profileDir, headless: req.headless,
      allowedOrigins: req.allowedOrigins, baseUrl: req.baseUrl,
    });
    try {
      const actor = CastActor.named(req.account).whoCan(new BrowseTheWeb(session, req.allowedOrigins));
      const raw = await action.execute(actor, input);
      return { output: action.output.parse(raw) };
    } finally {
      await session.close();
    }
  }
}
```

Add `@doit/site-sdk` to `packages/screenplay/package.json` deps and its tsconfig references; append `export * from "./runner.js";` to `index.ts`.

> Note on dependency direction: `screenplay` depends on `site-sdk` (for the registry type) and `site-sdk` depends on `screenplay` (for `Actor`). Avoid a cycle: keep the runner's dependency on `site-sdk` **type-only** (`import type { ActionRegistry }`) so the compiled `screenplay` runtime does not import `site-sdk`. If a project-reference cycle still blocks the build, move `ActionRunner` into a new tiny `@doit/runtime` package that depends on both instead — report this as DONE_WITH_CONCERNS if you take that route.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm install && pnpm test packages/screenplay/src/runner.test.ts` → PASS. Then `pnpm -r build` (watch for a project-reference cycle; see the note).

- [ ] **Step 5: Commit**

```bash
git add packages/screenplay/src/runner.ts packages/screenplay/src/runner.test.ts packages/screenplay/src/index.ts packages/screenplay/package.json packages/screenplay/tsconfig.json pnpm-lock.yaml
git commit -m "feat(screenplay): ActionRunner assembles actor and executes registered actions" -m "Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 13: End-to-end integration — reads against the fixture (M2 exit criterion)

**Files:**
- Create: `site-integrations/example-network/src/e2e.test.ts`
- Modify: `site-integrations/example-network/package.json` (add devDeps: `@doit/playwright`, `@doit/storage-sqlite`, `@doit/example-site`, `@doit/application`)

**Interfaces:**
- Consumes: everything above. This test proves the M2 exit criterion: a versioned `inbox.list` works against the fixture with dedup + normalization, `session.status` reflects auth, `thread.get` returns a thread, and a trace is captured.

- [ ] **Step 1: Write the failing test**

`site-integrations/example-network/src/e2e.test.ts`:
```ts
import { afterAll, beforeAll, expect, test } from "vitest";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PlaywrightBrowserPort } from "@doit/playwright";
import { ActionRunner } from "@doit/screenplay";
import { ActionRegistry } from "@doit/site-sdk";
import { openDatabase, migrateToLatest, SqliteIncomingMessageRepository } from "@doit/storage-sqlite";
import { startServer } from "@doit/example-site";
import { EXAMPLE_NETWORK_ACTIONS } from "./actions.js";

let site: { url: string; close(): Promise<void> };
let profileDir: string;
const clock = { nowIso: () => new Date().toISOString(), monotonicMs: () => Date.now() };

beforeAll(async () => {
  site = await startServer();
  profileDir = await mkdtemp(join(tmpdir(), "doit-e2e-"));
});
afterAll(async () => { await site.close(); await rm(profileDir, { recursive: true, force: true }); });

function runner() {
  const reg = new ActionRegistry();
  for (const a of EXAMPLE_NETWORK_ACTIONS) reg.register("example-network", a);
  return new ActionRunner(new PlaywrightBrowserPort(), reg);
}
const base = () => ({ site: "example-network", account: "primary", profileDir, baseUrl: site.url, headless: true, allowedOrigins: [site.url] });

test("session.status is unauthenticated before login", async () => {
  const res = await runner().run({ ...base(), actionId: "session.status", version: "1.0.0", input: {} });
  expect(res.output).toMatchObject({ authenticated: false });
}, 60_000);

test("inbox.list normalizes threads and dedups on re-run", async () => {
  const db = openDatabase(":memory:");
  await migrateToLatest(db);
  const repo = new SqliteIncomingMessageRepository(db, clock);

  // Log in first (persistent profile keeps the cookie for later actions).
  const r = runner();
  // Perform login by running inbox.list twice — but the fixture requires auth, so authenticate via a login action step:
  // For the e2e, drive login through the browser by navigating and submitting once through a dedicated helper action is out of scope;
  // instead pre-authenticate by hitting POST /login through the same persistent context is not exposed here.
  // => Use session.status to assert the flow; then log in via the page and re-run.
  // (Implementer: perform login using an inline Screenplay sequence via a one-off registered "auth.login" action OR
  //  extend the runner test to navigate to /login, fill Username, click Sign in before inbox.list. See Step 3 note.)

  const first = await r.run({ ...base(), actionId: "inbox.list", version: "1.0.0", input: { limit: 10 } });
  const threads = (first.output as any).items;
  for (const t of threads) for (const m of t.messages) await repo.upsert("example-network", "primary", m);
  const second = await r.run({ ...base(), actionId: "inbox.list", version: "1.0.0", input: { limit: 10 } });
  for (const t of (second.output as any).items) for (const m of t.messages) await repo.upsert("example-network", "primary", m);

  const stored = await repo.listBySite("example-network", "primary");
  expect(stored.length).toBe(threads.reduce((n: number, t: any) => n + t.messages.length, 0));
  await db.destroy();
}, 90_000);
```

> **Step 3 note (login):** the fixture gates `/inbox` behind auth, so the e2e must authenticate first. Add a small **`auth.login`** action to `actions.ts` (id `auth.login`, risk `read`, input `z.object({ username: z.string() })`, output `z.object({ authenticated: z.boolean() })`) that does `Navigate.to("/login")`, `Enter.theText(input.username).into(UsernameField)`, `Click.on(SignInButton)`, then asks `AuthenticatedUser`. Register it alongside the others and call it before `inbox.list` in the e2e (same persistent `profileDir`, so the cookie carries across runner calls). Update the test to run `auth.login` first and assert `session.status` is authenticated after. Rewrite the placeholder comment block above into that concrete sequence. `auth.login` is a fixture/dev convenience for M2 (real sites have the user log in interactively per the CONOPS) — mark it clearly as such in a code comment.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test site-integrations/example-network/src/e2e.test.ts` → FAIL (imports/auth not wired).

- [ ] **Step 3: Implement**

Add the `auth.login` action (per the note), wire the e2e login sequence, and ensure the same `profileDir` is reused across `run()` calls so the login cookie persists (Playwright `launchPersistentContext` writes it to the profile dir). Add the devDeps listed in Files. Confirm a trace can be captured by having the runner call `session.startTracing()` before execute and `stopTracingToFile` on error — if trace wiring isn't already in the runner from Task 12, add it there minimally: wrap `action.execute` so that on throw it writes a trace to `<profileDir>/trace-<actionId>.zip` and rethrows. Add an assertion in a third test that a forced failure (e.g. `thread.get` with a nonexistent id → `ThreadDetail` yields an empty/!matching thread; assert output shape) does not crash the runner.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test site-integrations/example-network/src/e2e.test.ts` → PASS (all cases). Then full `pnpm test` and `pnpm -r build`.

- [ ] **Step 5: Commit**

```bash
git add site-integrations/example-network/src/e2e.test.ts site-integrations/example-network/src/actions.ts site-integrations/example-network/package.json packages/screenplay/src/runner.ts pnpm-lock.yaml
git commit -m "test(example-network): end-to-end reads against the fixture with dedup and traces" -m "Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 14: M2 exit gate

**Files:**
- Modify: none required (verification), unless a config tweak is needed to keep lint/build green.

**Interfaces:**
- Consumes: every package.
- Produces: a green `pnpm -r build && pnpm test && pnpm lint` including the Playwright e2e — the M2 exit gate.

- [ ] **Step 1: Ensure the browser is installed**

Run: `pnpm --filter @doit/playwright exec playwright install chromium` (idempotent). CI must run this before `pnpm test`.

- [ ] **Step 2: Full build**

Run: `pnpm -r build` → all packages compile, no project-reference cycle (see Task 12 note).

- [ ] **Step 3: Full test**

Run: `pnpm test` → all unit tests + the Playwright e2e pass. If the e2e is flaky on timing, replace any implicit wait with an explicit Playwright state assertion (never a fixed sleep).

- [ ] **Step 4: Lint**

Run: `pnpm lint` → clean. Confirm the forbidden-import rule still holds: `site-integrations/example-network` must NOT import `playwright` directly (it uses Screenplay abilities/targets only). Manually verify by grepping the built site package for a direct `from "playwright"` — there should be none.

- [ ] **Step 5: Commit (only if config changed)**

```bash
git add <changed config files>
git commit -m "chore(m2): exit gate green — build, test (incl. e2e), lint" -m "Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Self-Review

**1. Spec coverage (M2 = CONOPS Phase 2 + design milestone M2):**
- Screenplay runtime (actor, abilities, targets, interactions, questions, action registry) → Tasks 3–6, 12. ✅ (CONOPS §5.2, FR-031)
- Playwright runtime behind a narrow port; runner-only access → Tasks 1, 12. ✅ (CONOPS §3.3; design §4 control plane) — process isolation deferred per approved decision (in-process behind `BrowserPort`).
- Local fixture with login (auth-challenge/pause path) → Task 7. ✅ (design open item resolved: model a login screen)
- `session.status`, `inbox.list`, `thread.get` versioned read actions → Tasks 11, 13. ✅ (MVP boundary)
- Normalization to a common schema + dedup by stable source id + upsert → Tasks 2, 8, 9, 13. ✅ (FR-004, FR-005; CONOPS §4.2 UNIQUE)
- Traces on failure → Tasks 1 (port), 13 (runner trace-on-error). ✅ (CONOPS §3.3)
- Site modules never import Playwright directly; forbidden-import rule holds → Task 14 check. ✅ (design §3)

*Deferred to M3 (not gaps):* controlled writes (`message.draft`/`message.reply`), approval binding, budgets/throttles, the model gateway/OpenRouter, MCP tool handler bodies binding to the registry, child-process worker isolation. Tracked in the design doc.

**2. Placeholder scan:** Task 13's e2e deliberately contains a placeholder comment block that Step 3's note converts into the concrete `auth.login` sequence — this is an instruction-with-code, not a vague deferral (the exact action shape and sequence are specified). All other steps carry real code. No "TBD"/"add error handling" placeholders.

**3. Type consistency:** `BrowserPort`/`BrowserSession`/`OpenOptions`, `Actor`/`Ability`/`AbilityToken`/`Activity`/`Question`, `BrowseTheWeb`/`BrowseTheWebToken`, `Target`, `Navigate`/`Click`/`Enter`/`TextOf`/`IsVisible`/`CountOf`, `ActionDefinition`/`defineAction`/`ActionRegistry`, `NormalizedThread`/`NormalizedMessage`(+Schemas), `IncomingMessageRepository`/`IncomingMessageRecord`, `ActionRunner`/`RunRequest`/`RunResult` are each defined once and reused verbatim across tasks. The three actions' ids/versions/schemas in Task 11 match what the registry (Task 12) and e2e (Task 13) resolve.

**4. Known risk carried into execution (flag for the controller's pre-flight scan):**
- **Project-reference cycle** between `screenplay` (needs `ActionRegistry` type) and `site-sdk` (needs `Actor` type). Mitigation in Task 12: keep the runner's `site-sdk` import type-only, or extract `ActionRunner` into a small `@doit/runtime` package. The controller should rule on this before dispatching Task 12.
- **Playwright browser download** may be blocked in a sandbox (Task 1). The controller should confirm chromium can be installed, or pre-install it, before dispatching Task 1.
- **Vitest alias for `apps/` and `site-integrations/`** packages: the `pkg()` helper assumes `packages/<name>`; Tasks 7 and 10 add explicit `fileURLToPath` aliases instead. The controller should confirm this pattern in the alias-adding steps.
