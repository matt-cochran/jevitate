# M1 Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up the TypeScript monorepo and the deterministic domain + storage + boundary foundation for the browser-automation platform, with no browser automation yet.

**Architecture:** A pnpm workspace of strict-TypeScript packages whose dependencies point inward toward `domain` (pure logic) and `application` (ports). `storage-sqlite` implements the ports on better-sqlite3 + Kysely with WAL, atomic leases, idempotency, and an append-only event log. A `commander` CLI and an MCP domain facade are thin clients; a `daemon` owns leases and crash recovery. The security boundary — the MCP tool allowlist — is asserted by a contract test.

**Tech Stack:** Node 20+, pnpm workspaces, TypeScript (project references), Vitest, zod, better-sqlite3, Kysely, commander, `@modelcontextprotocol/sdk`, pino, nanoid, luxon.

**Spec:** `docs/superpowers/specs/2026-09-16-browser-automation-mvp-design.md` (and the CONOPS + `approach.md` it references). The plan argues from the spec; executors read both.

## Global Constraints

Every task's requirements implicitly include these (verbatim from the spec/CONOPS):

- **Node 20+**, ESM packages (`"type": "module"`), **strict** TypeScript with project references; dependency direction points inward toward `domain`/`application`.
- `domain` imports neither Playwright, SQLite, Kysely, nor the model gateway. Site modules likewise. An ESLint rule enforces this.
- **No TCP listener by default** — daemon/CLI/MCP local transport is a Unix domain socket / Windows named pipe.
- **MCP facade exposes only domain tools**; never `browser_click`, `browser_fill`, `page_evaluate`, `run_selector`, `navigate_url`, raw DOM/cookie/navigation (FR-021/022).
- SQLite: **WAL mode, foreign keys ON, bounded busy timeout**. Run migrations before accepting work.
- **Every externally visible command carries an idempotency key**; `UNIQUE(site, account_id, idempotency_key)`.
- **Append one event per state transition and policy decision** to an append-only log.
- Timestamps stored as **RFC 3339 UTC strings**; use a monotonic clock for in-process timeouts/leases.
- CLI output uses **versioned JSON envelopes and stable exit codes**; never prints secrets or session material.
- Only declared state-machine transitions are legal (CONOPS §4.3).

---

### Task 1: Monorepo scaffolding & toolchain

**Files:**
- Create: `package.json`, `pnpm-workspace.yaml`, `tsconfig.base.json`, `tsconfig.json`, `vitest.config.ts`, `.eslintrc.cjs`, `.gitignore`, `.nvmrc`
- Create: `packages/domain/package.json`, `packages/domain/tsconfig.json`, `packages/domain/src/index.ts`, `packages/domain/src/smoke.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: a workspace where `pnpm install`, `pnpm -r build`, and `pnpm test` run; the `@doit/domain` package name; the pattern every later package copies (`package.json` + `tsconfig.json` referencing `../../tsconfig.base.json`).

- [ ] **Step 1: Write the failing test**

`packages/domain/src/smoke.test.ts`:
```ts
import { expect, test } from "vitest";
import { hello } from "./index.js";

test("workspace builds and tests run", () => {
  expect(hello()).toBe("doit");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test` (after creating the config files below, before `index.ts`).
Expected: FAIL — cannot resolve `./index.js` / `hello` not exported.

- [ ] **Step 3: Write the scaffolding and minimal implementation**

`.nvmrc`:
```
20
```

`pnpm-workspace.yaml`:
```yaml
packages:
  - "packages/*"
  - "site-integrations/*"
  - "apps/*"
```

Root `package.json`:
```json
{
  "name": "doit",
  "private": true,
  "type": "module",
  "engines": { "node": ">=20" },
  "scripts": {
    "build": "tsc --build",
    "test": "vitest run",
    "lint": "eslint ."
  },
  "devDependencies": {
    "typescript": "^5.5.0",
    "vitest": "^2.0.0",
    "eslint": "^9.0.0",
    "@typescript-eslint/eslint-plugin": "^8.0.0",
    "@typescript-eslint/parser": "^8.0.0"
  }
}
```

`tsconfig.base.json`:
```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "declaration": true,
    "composite": true,
    "sourceMap": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true
  }
}
```

Root `tsconfig.json` (solution file; add each package as a reference as it is created):
```json
{
  "files": [],
  "references": [{ "path": "packages/domain" }]
}
```

`packages/domain/package.json`:
```json
{
  "name": "@doit/domain",
  "version": "0.0.0",
  "type": "module",
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "exports": { ".": "./dist/index.js" },
  "scripts": { "build": "tsc --build" }
}
```

`packages/domain/tsconfig.json`:
```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "rootDir": "src", "outDir": "dist" },
  "include": ["src/**/*"],
  "exclude": ["src/**/*.test.ts"]
}
```

`packages/domain/src/index.ts`:
```ts
export function hello(): string {
  return "doit";
}
```

`vitest.config.ts`:
```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: { include: ["packages/**/*.test.ts", "site-integrations/**/*.test.ts"] },
});
```

`.eslintrc.cjs` (flat config alternative acceptable; this rule blocks forbidden imports in `domain`):
```js
module.exports = {
  root: true,
  parser: "@typescript-eslint/parser",
  plugins: ["@typescript-eslint"],
  rules: {
    "no-restricted-imports": ["error", {
      paths: [
        { name: "playwright", message: "domain/site modules must not import playwright" },
        { name: "better-sqlite3", message: "domain/site modules must not import a db driver" },
        { name: "kysely", message: "domain/site modules must not import a db driver" },
      ],
    }],
  },
  overrides: [
    { files: ["packages/domain/**", "site-integrations/**"], rules: {} },
  ],
};
```

`.gitignore`:
```
node_modules/
dist/
*.tsbuildinfo
data/
*.sqlite
*.sqlite-*
.env
```

- [ ] **Step 4: Install and run test to verify it passes**

Run: `pnpm install && pnpm test`
Expected: PASS (1 test).

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "chore: scaffold pnpm/tsc/vitest monorepo with domain package"
```

---

### Task 2: Domain primitives & schemas

**Files:**
- Create: `packages/domain/src/primitives.ts`, `packages/domain/src/primitives.test.ts`
- Modify: `packages/domain/src/index.ts` (re-export)

**Interfaces:**
- Consumes: nothing.
- Produces:
  - Types: `RiskClass = "read" | "external_write"`, `IsoTimestamp = string`.
  - Zod schemas: `RiskClassSchema`, `IdempotencyKeySchema` (non-empty string ≤ 200 chars), `SiteIdSchema`, `AccountIdSchema` (non-empty).
  - `newCommandId(): string` (nanoid-based, prefixed `cmd_`).

- [ ] **Step 1: Write the failing test**

`packages/domain/src/primitives.test.ts`:
```ts
import { expect, test } from "vitest";
import { RiskClassSchema, IdempotencyKeySchema, newCommandId } from "./primitives.js";

test("risk class accepts known values and rejects others", () => {
  expect(RiskClassSchema.parse("read")).toBe("read");
  expect(() => RiskClassSchema.parse("delete")).toThrow();
});

test("idempotency key rejects empty", () => {
  expect(() => IdempotencyKeySchema.parse("")).toThrow();
  expect(IdempotencyKeySchema.parse("k1")).toBe("k1");
});

test("command ids are unique and prefixed", () => {
  const a = newCommandId();
  const b = newCommandId();
  expect(a.startsWith("cmd_")).toBe(true);
  expect(a).not.toBe(b);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test packages/domain/src/primitives.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Add nanoid dependency and implement**

Run: `pnpm add --filter @doit/domain nanoid zod`

`packages/domain/src/primitives.ts`:
```ts
import { z } from "zod";
import { nanoid } from "nanoid";

export type RiskClass = "read" | "external_write";
export type IsoTimestamp = string;

export const RiskClassSchema = z.enum(["read", "external_write"]);
export const IdempotencyKeySchema = z.string().min(1).max(200);
export const SiteIdSchema = z.string().min(1);
export const AccountIdSchema = z.string().min(1);

export function newCommandId(): string {
  return `cmd_${nanoid()}`;
}
```

Add to `packages/domain/src/index.ts`:
```ts
export * from "./primitives.js";
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test packages/domain/src/primitives.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat(domain): add primitives and zod schemas"
```

---

### Task 3: Command state machine

**Files:**
- Create: `packages/domain/src/command-state.ts`, `packages/domain/src/command-state.test.ts`
- Modify: `packages/domain/src/index.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `type CommandState = "queued" | "validating" | "awaiting_approval" | "ready" | "leased" | "running" | "succeeded" | "failed" | "denied" | "expired" | "retry" | "quarantined" | "reconciling"`.
  - `const TRANSITIONS: Record<CommandState, CommandState[]>`.
  - `canTransition(from: CommandState, to: CommandState): boolean`.
  - `transition(from: CommandState, to: CommandState): CommandState` — returns `to` or throws `IllegalTransitionError`.
  - `class IllegalTransitionError extends Error`.

- [ ] **Step 1: Write the failing test**

`packages/domain/src/command-state.test.ts`:
```ts
import { expect, test } from "vitest";
import { transition, canTransition, IllegalTransitionError } from "./command-state.js";

test("legal transition returns the target state", () => {
  expect(transition("ready", "leased")).toBe("leased");
});

test("illegal transition throws", () => {
  expect(canTransition("succeeded", "running")).toBe(false);
  expect(() => transition("succeeded", "running")).toThrow(IllegalTransitionError);
});

test("lease expiry can return a command to ready or retry", () => {
  expect(canTransition("leased", "ready")).toBe(true);
  expect(canTransition("leased", "retry")).toBe(true);
});

test("unknown external outcome routes to reconciling not retry", () => {
  expect(canTransition("running", "reconciling")).toBe(true);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test packages/domain/src/command-state.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

`packages/domain/src/command-state.ts`:
```ts
export type CommandState =
  | "queued" | "validating" | "awaiting_approval" | "ready"
  | "leased" | "running" | "succeeded" | "failed"
  | "denied" | "expired" | "retry" | "quarantined" | "reconciling";

export const TRANSITIONS: Record<CommandState, CommandState[]> = {
  queued: ["validating", "denied"],
  validating: ["awaiting_approval", "ready", "denied"],
  awaiting_approval: ["ready", "denied", "expired"],
  ready: ["leased"],
  leased: ["running", "ready", "retry", "expired"],
  running: ["succeeded", "failed", "retry", "quarantined", "reconciling"],
  retry: ["ready", "failed"],
  reconciling: ["succeeded", "failed", "quarantined"],
  succeeded: [],
  failed: [],
  denied: [],
  expired: [],
  quarantined: [],
};

export class IllegalTransitionError extends Error {
  constructor(from: CommandState, to: CommandState) {
    super(`Illegal command transition: ${from} -> ${to}`);
    this.name = "IllegalTransitionError";
  }
}

export function canTransition(from: CommandState, to: CommandState): boolean {
  return TRANSITIONS[from].includes(to);
}

export function transition(from: CommandState, to: CommandState): CommandState {
  if (!canTransition(from, to)) throw new IllegalTransitionError(from, to);
  return to;
}
```

Add to `index.ts`:
```ts
export * from "./command-state.js";
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test packages/domain/src/command-state.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat(domain): command state machine with legal transitions"
```

---

### Task 4: Policy engine

**Files:**
- Create: `packages/domain/src/policy.ts`, `packages/domain/src/policy.test.ts`
- Modify: `packages/domain/src/index.ts`

**Interfaces:**
- Consumes: `RiskClass` from `primitives.ts`.
- Produces:
  - `type ApprovalMode = "none" | "writes" | "all"`.
  - `interface PolicyContext { risk: RiskClass; isNewContact: boolean; approvalMode: ApprovalMode; newContactsEnabled: boolean }`.
  - `type Decision = { kind: "allow" } | { kind: "require_approval" } | { kind: "deny"; reason: string }`.
  - `decide(ctx: PolicyContext): Decision` — pure.

- [ ] **Step 1: Write the failing test**

`packages/domain/src/policy.test.ts`:
```ts
import { expect, test } from "vitest";
import { decide } from "./policy.js";

const base = { isNewContact: false, approvalMode: "writes" as const, newContactsEnabled: false };

test("reads are allowed", () => {
  expect(decide({ ...base, risk: "read" })).toEqual({ kind: "allow" });
});

test("external writes require approval under approvalMode=writes", () => {
  expect(decide({ ...base, risk: "external_write" })).toEqual({ kind: "require_approval" });
});

test("new contact while disabled is denied", () => {
  const d = decide({ ...base, risk: "external_write", isNewContact: true });
  expect(d.kind).toBe("deny");
});

test("approvalMode=all requires approval even for reads", () => {
  expect(decide({ ...base, risk: "read", approvalMode: "all" })).toEqual({ kind: "require_approval" });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test packages/domain/src/policy.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

`packages/domain/src/policy.ts`:
```ts
import type { RiskClass } from "./primitives.js";

export type ApprovalMode = "none" | "writes" | "all";

export interface PolicyContext {
  risk: RiskClass;
  isNewContact: boolean;
  approvalMode: ApprovalMode;
  newContactsEnabled: boolean;
}

export type Decision =
  | { kind: "allow" }
  | { kind: "require_approval" }
  | { kind: "deny"; reason: string };

export function decide(ctx: PolicyContext): Decision {
  if (ctx.isNewContact && !ctx.newContactsEnabled) {
    return { kind: "deny", reason: "new outbound contacts are disabled" };
  }
  if (ctx.approvalMode === "all") return { kind: "require_approval" };
  if (ctx.risk === "external_write" && ctx.approvalMode === "writes") {
    return { kind: "require_approval" };
  }
  return { kind: "allow" };
}
```

Add to `index.ts`:
```ts
export * from "./policy.js";
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test packages/domain/src/policy.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat(domain): pure policy engine"
```

---

### Task 5: Approval binding & content hash

**Files:**
- Create: `packages/domain/src/approval.ts`, `packages/domain/src/approval.test.ts`
- Modify: `packages/domain/src/index.ts`

**Interfaces:**
- Consumes: `IsoTimestamp`.
- Produces:
  - `contentHash(value: unknown): string` — sha256 hex over canonical JSON (sorted keys).
  - `interface ApprovalBinding { commandId: string; recipientHash: string; contentHash: string; actionId: string; actionVersion: string; artifactHash: string; settingsRevision: string; expiresAt: IsoTimestamp }`.
  - `bindingMatches(a: ApprovalBinding, b: ApprovalBinding): boolean`.
  - `isExpired(a: ApprovalBinding, now: IsoTimestamp): boolean`.

- [ ] **Step 1: Write the failing test**

`packages/domain/src/approval.test.ts`:
```ts
import { expect, test } from "vitest";
import { contentHash, bindingMatches, isExpired, type ApprovalBinding } from "./approval.js";

test("content hash is stable across key order", () => {
  expect(contentHash({ a: 1, b: 2 })).toBe(contentHash({ b: 2, a: 1 }));
});

test("content hash changes when content changes", () => {
  expect(contentHash({ body: "hi" })).not.toBe(contentHash({ body: "hello" }));
});

const b: ApprovalBinding = {
  commandId: "cmd_1", recipientHash: "r", contentHash: "c", actionId: "message.reply",
  actionVersion: "1.0.0", artifactHash: "h", settingsRevision: "s", expiresAt: "2026-09-16T12:00:00Z",
};

test("binding mismatch is detected", () => {
  expect(bindingMatches(b, { ...b, contentHash: "different" })).toBe(false);
  expect(bindingMatches(b, { ...b })).toBe(true);
});

test("expiry is detected", () => {
  expect(isExpired(b, "2026-09-16T12:00:01Z")).toBe(true);
  expect(isExpired(b, "2026-09-16T11:59:59Z")).toBe(false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test packages/domain/src/approval.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

`packages/domain/src/approval.ts`:
```ts
import { createHash } from "node:crypto";
import type { IsoTimestamp } from "./primitives.js";

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
}

export function contentHash(value: unknown): string {
  return createHash("sha256").update(canonical(value)).digest("hex");
}

export interface ApprovalBinding {
  commandId: string;
  recipientHash: string;
  contentHash: string;
  actionId: string;
  actionVersion: string;
  artifactHash: string;
  settingsRevision: string;
  expiresAt: IsoTimestamp;
}

export function bindingMatches(a: ApprovalBinding, b: ApprovalBinding): boolean {
  return contentHash(a) === contentHash(b);
}

export function isExpired(a: ApprovalBinding, now: IsoTimestamp): boolean {
  return new Date(now).getTime() > new Date(a.expiresAt).getTime();
}
```

Add to `index.ts`:
```ts
export * from "./approval.js";
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test packages/domain/src/approval.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat(domain): approval binding and content hashing"
```

---

### Task 6: Domain event types

**Files:**
- Create: `packages/domain/src/events.ts`, `packages/domain/src/events.test.ts`
- Modify: `packages/domain/src/index.ts`

**Interfaces:**
- Consumes: `IsoTimestamp`.
- Produces:
  - `interface DomainEvent { sequence: number; aggregate: string; type: string; payload: unknown; occurredAt: IsoTimestamp; correlationId: string }`.
  - `DomainEventInputSchema` (zod) for everything except `sequence` (assigned by the store).
  - `type DomainEventInput = Omit<DomainEvent, "sequence">`.

- [ ] **Step 1: Write the failing test**

`packages/domain/src/events.test.ts`:
```ts
import { expect, test } from "vitest";
import { DomainEventInputSchema } from "./events.js";

test("valid event input parses", () => {
  const e = { aggregate: "cmd_1", type: "state.changed", payload: { to: "ready" }, occurredAt: "2026-09-16T12:00:00Z", correlationId: "corr_1" };
  expect(DomainEventInputSchema.parse(e).type).toBe("state.changed");
});

test("missing type is rejected", () => {
  expect(() => DomainEventInputSchema.parse({ aggregate: "x", occurredAt: "t", correlationId: "c" })).toThrow();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test packages/domain/src/events.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

`packages/domain/src/events.ts`:
```ts
import { z } from "zod";
import type { IsoTimestamp } from "./primitives.js";

export interface DomainEvent {
  sequence: number;
  aggregate: string;
  type: string;
  payload: unknown;
  occurredAt: IsoTimestamp;
  correlationId: string;
}

export type DomainEventInput = Omit<DomainEvent, "sequence">;

export const DomainEventInputSchema = z.object({
  aggregate: z.string().min(1),
  type: z.string().min(1),
  payload: z.unknown(),
  occurredAt: z.string().min(1),
  correlationId: z.string().min(1),
});
```

Add to `index.ts`:
```ts
export * from "./events.js";
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test packages/domain/src/events.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat(domain): domain event types"
```

---

### Task 7: Application ports

**Files:**
- Create: `packages/application/package.json`, `packages/application/tsconfig.json`, `packages/application/src/index.ts`, `packages/application/src/ports.ts`, `packages/application/src/ports.test.ts`
- Modify: root `tsconfig.json` (add reference)

**Interfaces:**
- Consumes: `CommandState`, `RiskClass`, `IdempotencyKey`, `DomainEventInput` from `@doit/domain`.
- Produces (the contracts `storage-sqlite` and `daemon` implement):
  - `interface Clock { nowIso(): string; monotonicMs(): number }`.
  - `interface NewCommand { site: string; account: string; actionId: string; actionVersion: string; payload: unknown; idempotencyKey: string; risk: RiskClass; notBefore?: string }`.
  - `interface CommandRecord extends NewCommand { id: string; state: CommandState; attempt: number; leaseExpiresAt: string | null }`.
  - `interface CommandRepository { enqueue(cmd: NewCommand): Promise<CommandRecord>; get(id: string): Promise<CommandRecord | null>; leaseNextReady(leaseMs: number): Promise<CommandRecord | null>; setState(id: string, to: CommandState): Promise<void>; recoverExpiredLeases(): Promise<number> }`.
  - `interface EventLog { append(e: DomainEventInput): Promise<number>; since(seq: number): Promise<import("@doit/domain").DomainEvent[]> }`.

- [ ] **Step 1: Write the failing test**

`packages/application/src/ports.test.ts`:
```ts
import { expect, test } from "vitest";
import type { Clock } from "./ports.js";

test("a Clock implementation satisfies the port", () => {
  const clock: Clock = { nowIso: () => "2026-09-16T00:00:00Z", monotonicMs: () => 1 };
  expect(clock.nowIso()).toMatch(/^2026/);
  expect(clock.monotonicMs()).toBe(1);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test packages/application/src/ports.test.ts`
Expected: FAIL — package/module not found.

- [ ] **Step 3: Create the package and ports**

`packages/application/package.json`:
```json
{
  "name": "@doit/application",
  "version": "0.0.0",
  "type": "module",
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "exports": { ".": "./dist/index.js" },
  "dependencies": { "@doit/domain": "workspace:*" },
  "scripts": { "build": "tsc --build" }
}
```

`packages/application/tsconfig.json`:
```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "rootDir": "src", "outDir": "dist" },
  "references": [{ "path": "../domain" }],
  "include": ["src/**/*"],
  "exclude": ["src/**/*.test.ts"]
}
```

`packages/application/src/ports.ts`:
```ts
import type { CommandState, RiskClass, DomainEvent, DomainEventInput } from "@doit/domain";

export interface Clock {
  nowIso(): string;
  monotonicMs(): number;
}

export interface NewCommand {
  site: string;
  account: string;
  actionId: string;
  actionVersion: string;
  payload: unknown;
  idempotencyKey: string;
  risk: RiskClass;
  notBefore?: string;
}

export interface CommandRecord extends NewCommand {
  id: string;
  state: CommandState;
  attempt: number;
  leaseExpiresAt: string | null;
}

export interface CommandRepository {
  enqueue(cmd: NewCommand): Promise<CommandRecord>;
  get(id: string): Promise<CommandRecord | null>;
  leaseNextReady(leaseMs: number): Promise<CommandRecord | null>;
  setState(id: string, to: CommandState): Promise<void>;
  recoverExpiredLeases(): Promise<number>;
}

export interface EventLog {
  append(e: DomainEventInput): Promise<number>;
  since(seq: number): Promise<DomainEvent[]>;
}
```

`packages/application/src/index.ts`:
```ts
export * from "./ports.js";
```

Add `{ "path": "packages/application" }` to root `tsconfig.json` references.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm install && pnpm test packages/application/src/ports.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat(application): repository and clock ports"
```

---

### Task 8: SQLite connection with WAL

**Files:**
- Create: `packages/storage-sqlite/package.json`, `packages/storage-sqlite/tsconfig.json`, `packages/storage-sqlite/src/db.ts`, `packages/storage-sqlite/src/schema.ts`, `packages/storage-sqlite/src/db.test.ts`, `packages/storage-sqlite/src/index.ts`
- Modify: root `tsconfig.json`

**Interfaces:**
- Consumes: nothing at runtime from other packages (adapter).
- Produces:
  - `interface Database` (Kysely schema type) in `schema.ts`.
  - `openDatabase(file: string): Kysely<Database>` — opens better-sqlite3, sets `journal_mode=WAL`, `foreign_keys=ON`, `busy_timeout=5000`, wraps in Kysely.

- [ ] **Step 1: Write the failing test**

`packages/storage-sqlite/src/db.test.ts`:
```ts
import { expect, test } from "vitest";
import { sql } from "kysely";
import { openDatabase } from "./db.js";

test("opens in WAL with foreign keys on", async () => {
  const db = openDatabase(":memory:");
  const jm = await sql<{ journal_mode: string }>`PRAGMA journal_mode`.execute(db);
  const fk = await sql<{ foreign_keys: number }>`PRAGMA foreign_keys`.execute(db);
  // :memory: reports "memory"; a file path reports "wal". foreign_keys must be 1 either way.
  expect(["wal", "memory"]).toContain(jm.rows[0].journal_mode);
  expect(fk.rows[0].foreign_keys).toBe(1);
  await db.destroy();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test packages/storage-sqlite/src/db.test.ts`
Expected: FAIL — package/module not found.

- [ ] **Step 3: Create package and implement**

`packages/storage-sqlite/package.json`:
```json
{
  "name": "@doit/storage-sqlite",
  "version": "0.0.0",
  "type": "module",
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "exports": { ".": "./dist/index.js" },
  "dependencies": {
    "@doit/application": "workspace:*",
    "@doit/domain": "workspace:*",
    "better-sqlite3": "^11.0.0",
    "kysely": "^0.27.0"
  },
  "devDependencies": { "@types/better-sqlite3": "^7.6.0" },
  "scripts": { "build": "tsc --build" }
}
```

`packages/storage-sqlite/tsconfig.json`:
```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "rootDir": "src", "outDir": "dist" },
  "references": [{ "path": "../application" }, { "path": "../domain" }],
  "include": ["src/**/*"],
  "exclude": ["src/**/*.test.ts"]
}
```

`packages/storage-sqlite/src/schema.ts`:
```ts
export interface CommandTable {
  id: string;
  site: string;
  account_id: string;
  action_id: string;
  action_version: string;
  payload: string;          // JSON
  idempotency_key: string;
  risk: string;
  not_before: string | null;
  state: string;
  attempt: number;
  lease_expires_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface EventTable {
  sequence: number;         // autoincrement
  aggregate: string;
  type: string;
  payload: string;          // JSON
  occurred_at: string;
  correlation_id: string;
}

export interface Database {
  command: CommandTable;
  event: EventTable;
}
```

`packages/storage-sqlite/src/db.ts`:
```ts
import SQLite from "better-sqlite3";
import { Kysely, SqliteDialect } from "kysely";
import type { Database } from "./schema.js";

export function openDatabase(file: string): Kysely<Database> {
  const sqlite = new SQLite(file);
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");
  sqlite.pragma("busy_timeout = 5000");
  return new Kysely<Database>({ dialect: new SqliteDialect({ database: sqlite }) });
}
```

`packages/storage-sqlite/src/index.ts`:
```ts
export * from "./db.js";
export * from "./schema.js";
```

Add `{ "path": "packages/storage-sqlite" }` to root `tsconfig.json`.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm install && pnpm test packages/storage-sqlite/src/db.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat(storage): sqlite connection with WAL + foreign keys"
```

---

### Task 9: Migrations & migrator

**Files:**
- Create: `packages/storage-sqlite/src/migrations/2026-09-16-initial.ts`, `packages/storage-sqlite/src/migrator.ts`, `packages/storage-sqlite/src/migrator.test.ts`
- Modify: `packages/storage-sqlite/src/index.ts`

**Interfaces:**
- Consumes: `Database`, `openDatabase`.
- Produces: `migrateToLatest(db: Kysely<Database>): Promise<void>` creating `command` and `event` tables with the constraints from Global Constraints.

- [ ] **Step 1: Write the failing test**

`packages/storage-sqlite/src/migrator.test.ts`:
```ts
import { expect, test } from "vitest";
import { sql } from "kysely";
import { openDatabase } from "./db.js";
import { migrateToLatest } from "./migrator.js";

test("migration creates command table with idempotency uniqueness", async () => {
  const db = openDatabase(":memory:");
  await migrateToLatest(db);
  const now = new Date().toISOString();
  const row = { site: "s", account_id: "a", action_id: "inbox.list", action_version: "1.0.0",
    payload: "{}", idempotency_key: "k", risk: "read", not_before: null, state: "queued",
    attempt: 0, lease_expires_at: null, created_at: now, updated_at: now };
  await db.insertInto("command").values({ id: "cmd_1", ...row }).execute();
  await expect(
    db.insertInto("command").values({ id: "cmd_2", ...row }).execute(),
  ).rejects.toThrow(); // UNIQUE(site, account_id, idempotency_key)
  await db.destroy();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test packages/storage-sqlite/src/migrator.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

`packages/storage-sqlite/src/migrations/2026-09-16-initial.ts`:
```ts
import { Kysely, sql } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE TABLE command (
      id TEXT PRIMARY KEY,
      site TEXT NOT NULL,
      account_id TEXT NOT NULL,
      action_id TEXT NOT NULL,
      action_version TEXT NOT NULL,
      payload TEXT NOT NULL,
      idempotency_key TEXT NOT NULL,
      risk TEXT NOT NULL,
      not_before TEXT,
      state TEXT NOT NULL,
      attempt INTEGER NOT NULL DEFAULT 0,
      lease_expires_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE (site, account_id, idempotency_key)
    )`.execute(db);
  await sql`
    CREATE TABLE event (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      aggregate TEXT NOT NULL,
      type TEXT NOT NULL,
      payload TEXT NOT NULL,
      occurred_at TEXT NOT NULL,
      correlation_id TEXT NOT NULL
    )`.execute(db);
  await sql`CREATE INDEX idx_command_state ON command (state, not_before)`.execute(db);
}
```

`packages/storage-sqlite/src/migrator.ts`:
```ts
import type { Kysely } from "kysely";
import type { Database } from "./schema.js";
import { up as initial } from "./migrations/2026-09-16-initial.js";

const MIGRATIONS = [initial];

export async function migrateToLatest(db: Kysely<Database>): Promise<void> {
  for (const migrate of MIGRATIONS) {
    await migrate(db as unknown as Kysely<unknown>);
  }
}
```

> Note: this uses an explicit ordered migration array for M1's two tables. When the schema grows in M2/M3, switch to Kysely's `Migrator` with a `FileMigrationProvider` and a `schema_migrations` ledger table; the ordered-array form is a deliberate MVP simplification for a single migration.

Add exports to `index.ts`:
```ts
export * from "./migrator.js";
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test packages/storage-sqlite/src/migrator.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat(storage): initial migrations for command and event tables"
```

---

### Task 10: Command repository (idempotency + atomic lease)

**Files:**
- Create: `packages/storage-sqlite/src/command-repository.ts`, `packages/storage-sqlite/src/command-repository.test.ts`
- Modify: `packages/storage-sqlite/src/index.ts`

**Interfaces:**
- Consumes: `CommandRepository`, `NewCommand`, `CommandRecord`, `Clock` from `@doit/application`; `newCommandId`, `canTransition`, `IllegalTransitionError` from `@doit/domain`; `Database`.
- Produces: `class SqliteCommandRepository implements CommandRepository`. Constructor `(db: Kysely<Database>, clock: Clock)`. `leaseNextReady` runs an atomic transaction that selects the oldest `ready` row whose `not_before` has passed and flips it to `leased` with a lease expiry; `enqueue` maps a UNIQUE violation to returning the existing row (idempotent); `setState` enforces `canTransition`.

- [ ] **Step 1: Write the failing test**

`packages/storage-sqlite/src/command-repository.test.ts`:
```ts
import { beforeEach, expect, test } from "vitest";
import { openDatabase } from "./db.js";
import { migrateToLatest } from "./migrator.js";
import { SqliteCommandRepository } from "./command-repository.js";
import type { NewCommand } from "@doit/application";

const clock = { nowIso: () => new Date().toISOString(), monotonicMs: () => Date.now() };
const cmd: NewCommand = { site: "s", account: "a", actionId: "inbox.list", actionVersion: "1.0.0",
  payload: {}, idempotencyKey: "k1", risk: "read" };

async function repo() {
  const db = openDatabase(":memory:");
  await migrateToLatest(db);
  return new SqliteCommandRepository(db, clock);
}

test("enqueue is idempotent by (site, account, idempotency key)", async () => {
  const r = await repo();
  const a = await r.enqueue(cmd);
  const b = await r.enqueue(cmd);
  expect(b.id).toBe(a.id);
});

test("leaseNextReady moves a ready command to leased exactly once", async () => {
  const r = await repo();
  const c = await r.enqueue(cmd);
  await r.setState(c.id, "validating");
  await r.setState(c.id, "ready");
  const leased = await r.leaseNextReady(1000);
  expect(leased?.id).toBe(c.id);
  expect(leased?.state).toBe("leased");
  expect(await r.leaseNextReady(1000)).toBeNull();
});

test("setState rejects an illegal transition", async () => {
  const r = await repo();
  const c = await r.enqueue(cmd);
  await expect(r.setState(c.id, "succeeded")).rejects.toThrow();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test packages/storage-sqlite/src/command-repository.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

`packages/storage-sqlite/src/command-repository.ts`:
```ts
import type { Kysely } from "kysely";
import type { Clock, CommandRepository, CommandRecord, NewCommand } from "@doit/application";
import type { CommandState } from "@doit/domain";
import { newCommandId, canTransition, IllegalTransitionError } from "@doit/domain";
import type { CommandTable, Database } from "./schema.js";

function toRecord(row: CommandTable): CommandRecord {
  return {
    id: row.id, site: row.site, account: row.account_id, actionId: row.action_id,
    actionVersion: row.action_version, payload: JSON.parse(row.payload),
    idempotencyKey: row.idempotency_key, risk: row.risk as CommandRecord["risk"],
    notBefore: row.not_before ?? undefined, state: row.state as CommandState,
    attempt: row.attempt, leaseExpiresAt: row.lease_expires_at,
  };
}

export class SqliteCommandRepository implements CommandRepository {
  constructor(private readonly db: Kysely<Database>, private readonly clock: Clock) {}

  async enqueue(cmd: NewCommand): Promise<CommandRecord> {
    const now = this.clock.nowIso();
    const id = newCommandId();
    try {
      await this.db.insertInto("command").values({
        id, site: cmd.site, account_id: cmd.account, action_id: cmd.actionId,
        action_version: cmd.actionVersion, payload: JSON.stringify(cmd.payload ?? {}),
        idempotency_key: cmd.idempotencyKey, risk: cmd.risk, not_before: cmd.notBefore ?? null,
        state: "queued", attempt: 0, lease_expires_at: null, created_at: now, updated_at: now,
      }).execute();
      return (await this.get(id))!;
    } catch (err) {
      const existing = await this.db.selectFrom("command").selectAll()
        .where("site", "=", cmd.site).where("account_id", "=", cmd.account)
        .where("idempotency_key", "=", cmd.idempotencyKey).executeTakeFirst();
      if (existing) return toRecord(existing);
      throw err;
    }
  }

  async get(id: string): Promise<CommandRecord | null> {
    const row = await this.db.selectFrom("command").selectAll().where("id", "=", id).executeTakeFirst();
    return row ? toRecord(row) : null;
  }

  async leaseNextReady(leaseMs: number): Promise<CommandRecord | null> {
    const now = this.clock.nowIso();
    const leaseUntil = new Date(this.clock.monotonicMs() + leaseMs).toISOString();
    return this.db.transaction().execute(async (tx) => {
      const candidate = await tx.selectFrom("command").selectAll()
        .where("state", "=", "ready")
        .where((eb) => eb.or([eb("not_before", "is", null), eb("not_before", "<=", now)]))
        .orderBy("created_at", "asc").limit(1).executeTakeFirst();
      if (!candidate) return null;
      await tx.updateTable("command")
        .set({ state: "leased", lease_expires_at: leaseUntil, updated_at: now })
        .where("id", "=", candidate.id).where("state", "=", "ready").execute();
      return toRecord({ ...candidate, state: "leased", lease_expires_at: leaseUntil });
    });
  }

  async setState(id: string, to: CommandState): Promise<void> {
    const current = await this.get(id);
    if (!current) throw new Error(`command not found: ${id}`);
    if (!canTransition(current.state, to)) throw new IllegalTransitionError(current.state, to);
    await this.db.updateTable("command").set({ state: to, updated_at: this.clock.nowIso() })
      .where("id", "=", id).execute();
  }

  async recoverExpiredLeases(): Promise<number> {
    const now = this.clock.nowIso();
    const result = await this.db.updateTable("command")
      .set({ state: "ready", lease_expires_at: null, updated_at: now })
      .where("state", "=", "leased").where("lease_expires_at", "<=", now).executeTakeFirst();
    return Number(result.numUpdatedRows);
  }
}
```

Add to `index.ts`:
```ts
export * from "./command-repository.js";
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test packages/storage-sqlite/src/command-repository.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat(storage): command repository with idempotency and atomic lease"
```

---

### Task 11: Append-only event log

**Files:**
- Create: `packages/storage-sqlite/src/event-log.ts`, `packages/storage-sqlite/src/event-log.test.ts`
- Modify: `packages/storage-sqlite/src/index.ts`

**Interfaces:**
- Consumes: `EventLog` from `@doit/application`; `DomainEvent`, `DomainEventInput` from `@doit/domain`; `Database`.
- Produces: `class SqliteEventLog implements EventLog`. `append` inserts and returns the assigned `sequence`; `since(seq)` returns events with `sequence > seq` in order. No update/delete methods exist (append-only).

- [ ] **Step 1: Write the failing test**

`packages/storage-sqlite/src/event-log.test.ts`:
```ts
import { expect, test } from "vitest";
import { openDatabase } from "./db.js";
import { migrateToLatest } from "./migrator.js";
import { SqliteEventLog } from "./event-log.js";

test("append assigns increasing sequences and since() filters", async () => {
  const db = openDatabase(":memory:");
  await migrateToLatest(db);
  const log = new SqliteEventLog(db);
  const s1 = await log.append({ aggregate: "cmd_1", type: "created", payload: {}, occurredAt: "t1", correlationId: "c" });
  const s2 = await log.append({ aggregate: "cmd_1", type: "state.changed", payload: { to: "ready" }, occurredAt: "t2", correlationId: "c" });
  expect(s2).toBeGreaterThan(s1);
  const rest = await log.since(s1);
  expect(rest.map((e) => e.type)).toEqual(["state.changed"]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test packages/storage-sqlite/src/event-log.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

`packages/storage-sqlite/src/event-log.ts`:
```ts
import type { Kysely } from "kysely";
import type { EventLog } from "@doit/application";
import type { DomainEvent, DomainEventInput } from "@doit/domain";
import type { Database } from "./schema.js";

export class SqliteEventLog implements EventLog {
  constructor(private readonly db: Kysely<Database>) {}

  async append(e: DomainEventInput): Promise<number> {
    const result = await this.db.insertInto("event").values({
      aggregate: e.aggregate, type: e.type, payload: JSON.stringify(e.payload ?? null),
      occurred_at: e.occurredAt, correlation_id: e.correlationId,
    }).returning("sequence").executeTakeFirstOrThrow();
    return Number(result.sequence);
  }

  async since(seq: number): Promise<DomainEvent[]> {
    const rows = await this.db.selectFrom("event").selectAll()
      .where("sequence", ">", seq).orderBy("sequence", "asc").execute();
    return rows.map((r) => ({
      sequence: Number(r.sequence), aggregate: r.aggregate, type: r.type,
      payload: JSON.parse(r.payload), occurredAt: r.occurred_at, correlationId: r.correlation_id,
    }));
  }
}
```

Add to `index.ts`:
```ts
export * from "./event-log.js";
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test packages/storage-sqlite/src/event-log.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat(storage): append-only event log"
```

---

### Task 12: Profile manager

**Files:**
- Create: `packages/daemon/package.json`, `packages/daemon/tsconfig.json`, `packages/daemon/src/profile-manager.ts`, `packages/daemon/src/profile-manager.test.ts`, `packages/daemon/src/index.ts`
- Modify: root `tsconfig.json`

**Interfaces:**
- Consumes: nothing from other packages (filesystem concern).
- Produces:
  - `interface ProfileStatus { name: string; dir: string; exists: boolean }`.
  - `class ProfileManager` with `constructor(rootDir: string)`, `create(name: string): Promise<ProfileStatus>` (creates `rootDir/<name>` with mode `0o700`), `status(name: string): Promise<ProfileStatus>`. Never reads or exports session secrets — it only manages the directory.

- [ ] **Step 1: Write the failing test**

`packages/daemon/src/profile-manager.test.ts`:
```ts
import { expect, test } from "vitest";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProfileManager } from "./profile-manager.js";

test("create then status reports the profile exists", async () => {
  const root = await mkdtemp(join(tmpdir(), "doit-prof-"));
  const pm = new ProfileManager(root);
  expect((await pm.status("main")).exists).toBe(false);
  const created = await pm.create("main");
  expect(created.exists).toBe(true);
  expect(created.dir).toBe(join(root, "main"));
  expect((await pm.status("main")).exists).toBe(true);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test packages/daemon/src/profile-manager.test.ts`
Expected: FAIL — package/module not found.

- [ ] **Step 3: Create package and implement**

`packages/daemon/package.json`:
```json
{
  "name": "@doit/daemon",
  "version": "0.0.0",
  "type": "module",
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "exports": { ".": "./dist/index.js" },
  "dependencies": {
    "@doit/application": "workspace:*",
    "@doit/domain": "workspace:*"
  },
  "scripts": { "build": "tsc --build" }
}
```

`packages/daemon/tsconfig.json`:
```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "rootDir": "src", "outDir": "dist" },
  "references": [{ "path": "../application" }, { "path": "../domain" }],
  "include": ["src/**/*"],
  "exclude": ["src/**/*.test.ts"]
}
```

`packages/daemon/src/profile-manager.ts`:
```ts
import { mkdir, stat } from "node:fs/promises";
import { join } from "node:path";

export interface ProfileStatus {
  name: string;
  dir: string;
  exists: boolean;
}

export class ProfileManager {
  constructor(private readonly rootDir: string) {}

  private dirFor(name: string): string {
    return join(this.rootDir, name);
  }

  async create(name: string): Promise<ProfileStatus> {
    const dir = this.dirFor(name);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    return { name, dir, exists: true };
  }

  async status(name: string): Promise<ProfileStatus> {
    const dir = this.dirFor(name);
    try {
      await stat(dir);
      return { name, dir, exists: true };
    } catch {
      return { name, dir, exists: false };
    }
  }
}
```

`packages/daemon/src/index.ts`:
```ts
export * from "./profile-manager.js";
```

Add `{ "path": "packages/daemon" }` to root `tsconfig.json`.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm install && pnpm test packages/daemon/src/profile-manager.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat(daemon): profile manager for dedicated browser profiles"
```

---

### Task 13: Daemon lease recovery

**Files:**
- Create: `packages/daemon/src/recovery.ts`, `packages/daemon/src/recovery.test.ts`
- Modify: `packages/daemon/src/index.ts`

**Interfaces:**
- Consumes: `CommandRepository`, `EventLog` from `@doit/application`.
- Produces: `recoverOnStartup(repo: CommandRepository, log: EventLog, correlationId: string): Promise<number>` — calls `repo.recoverExpiredLeases()` and appends one `lease.recovered` event with the count; returns the count. This is the crash-recovery entry point (CONOPS FR/§10: recover queue processing after restart).

- [ ] **Step 1: Write the failing test**

`packages/daemon/src/recovery.test.ts`:
```ts
import { expect, test } from "vitest";
import { openDatabase, migrateToLatest, SqliteCommandRepository, SqliteEventLog } from "@doit/storage-sqlite";
import { recoverOnStartup } from "./recovery.js";

const past = { nowIso: () => "2000-01-01T00:00:00Z", monotonicMs: () => 0 };

test("a lease expired before restart is returned to ready and logged", async () => {
  const db = openDatabase(":memory:");
  await migrateToLatest(db);
  const repo = new SqliteCommandRepository(db, { nowIso: () => new Date().toISOString(), monotonicMs: () => Date.now() });
  const log = new SqliteEventLog(db);

  const c = await repo.enqueue({ site: "s", account: "a", actionId: "inbox.list", actionVersion: "1.0.0", payload: {}, idempotencyKey: "k", risk: "read" });
  await repo.setState(c.id, "validating");
  await repo.setState(c.id, "ready");
  // Lease it into the past so the lease is already expired.
  const expiredRepo = new SqliteCommandRepository(db, past);
  await expiredRepo.leaseNextReady(1000);

  const recovered = await recoverOnStartup(repo, log, "corr_boot");
  expect(recovered).toBe(1);
  expect((await repo.get(c.id))?.state).toBe("ready");
  expect((await log.since(0)).some((e) => e.type === "lease.recovered")).toBe(true);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test packages/daemon/src/recovery.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Add `@doit/storage-sqlite` to `packages/daemon/package.json` devDependencies (test-only usage):
```json
"devDependencies": { "@doit/storage-sqlite": "workspace:*" }
```

`packages/daemon/src/recovery.ts`:
```ts
import type { CommandRepository, EventLog } from "@doit/application";

export async function recoverOnStartup(
  repo: CommandRepository,
  log: EventLog,
  correlationId: string,
): Promise<number> {
  const count = await repo.recoverExpiredLeases();
  await log.append({
    aggregate: "daemon",
    type: "lease.recovered",
    payload: { count },
    occurredAt: new Date().toISOString(),
    correlationId,
  });
  return count;
}
```

Add to `packages/daemon/src/index.ts`:
```ts
export * from "./recovery.js";
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm install && pnpm test packages/daemon/src/recovery.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat(daemon): crash recovery returns expired leases to ready"
```

---

### Task 14: MCP domain facade + boundary contract test

**Files:**
- Create: `packages/mcp-facade/package.json`, `packages/mcp-facade/tsconfig.json`, `packages/mcp-facade/src/tools.ts`, `packages/mcp-facade/src/boundary.test.ts`, `packages/mcp-facade/src/index.ts`
- Modify: root `tsconfig.json`

**Interfaces:**
- Consumes: nothing at runtime yet (tool handlers wired to the repo come in M2/M3).
- Produces:
  - `const ALLOWED_TOOLS: readonly string[]` = `["queue_retrieval","queue_action","get_command","list_incoming","get_thread","approve_action","cancel_command","get_site_health"]`.
  - `const FORBIDDEN_TOOLS: readonly string[]` = `["browser_click","browser_fill","page_evaluate","run_selector","navigate_url","get_dom","get_cookies"]`.
  - `listToolNames(): string[]` — the names the facade would register (M1: exactly `ALLOWED_TOOLS`).

- [ ] **Step 1: Write the failing test**

`packages/mcp-facade/src/boundary.test.ts`:
```ts
import { expect, test } from "vitest";
import { listToolNames, ALLOWED_TOOLS, FORBIDDEN_TOOLS } from "./tools.js";

test("facade exposes exactly the allowed domain tools", () => {
  expect([...listToolNames()].sort()).toEqual([...ALLOWED_TOOLS].sort());
});

test("facade exposes none of the forbidden browser surfaces", () => {
  const names = new Set(listToolNames());
  for (const forbidden of FORBIDDEN_TOOLS) {
    expect(names.has(forbidden)).toBe(false);
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test packages/mcp-facade/src/boundary.test.ts`
Expected: FAIL — package/module not found.

- [ ] **Step 3: Create package and implement**

`packages/mcp-facade/package.json`:
```json
{
  "name": "@doit/mcp-facade",
  "version": "0.0.0",
  "type": "module",
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "exports": { ".": "./dist/index.js" },
  "dependencies": {
    "@doit/application": "workspace:*",
    "@modelcontextprotocol/sdk": "^1.0.0"
  },
  "scripts": { "build": "tsc --build" }
}
```

`packages/mcp-facade/tsconfig.json`:
```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "rootDir": "src", "outDir": "dist" },
  "references": [{ "path": "../application" }],
  "include": ["src/**/*"],
  "exclude": ["src/**/*.test.ts"]
}
```

`packages/mcp-facade/src/tools.ts`:
```ts
export const ALLOWED_TOOLS = [
  "queue_retrieval", "queue_action", "get_command", "list_incoming",
  "get_thread", "approve_action", "cancel_command", "get_site_health",
] as const;

export const FORBIDDEN_TOOLS = [
  "browser_click", "browser_fill", "page_evaluate", "run_selector",
  "navigate_url", "get_dom", "get_cookies",
] as const;

export function listToolNames(): string[] {
  return [...ALLOWED_TOOLS];
}
```

`packages/mcp-facade/src/index.ts`:
```ts
export * from "./tools.js";
```

Add `{ "path": "packages/mcp-facade" }` to root `tsconfig.json`.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm install && pnpm test packages/mcp-facade/src/boundary.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat(mcp): domain tool allowlist with boundary contract test"
```

---

### Task 15: CLI skeleton with versioned JSON envelope

**Files:**
- Create: `packages/cli/package.json`, `packages/cli/tsconfig.json`, `packages/cli/src/envelope.ts`, `packages/cli/src/envelope.test.ts`, `packages/cli/src/program.ts`, `packages/cli/src/program.test.ts`, `packages/cli/src/bin.ts`, `packages/cli/src/index.ts`
- Modify: root `tsconfig.json`

**Interfaces:**
- Consumes: `ProfileManager` from `@doit/daemon`.
- Produces:
  - `interface JsonEnvelope<T> { v: 1; ok: boolean; data?: T; error?: { code: string; message: string } }`.
  - `ok<T>(data: T): JsonEnvelope<T>` and `fail(code: string, message: string): JsonEnvelope<never>`.
  - `buildProgram(deps: { profiles: ProfileManager }): Command` — a commander program with `brauto init` and `brauto profile create|status`, each printing a JSON envelope when `--json` is passed. Exit code 0 on `ok`, 1 on `fail`.

- [ ] **Step 1: Write the failing test**

`packages/cli/src/envelope.test.ts`:
```ts
import { expect, test } from "vitest";
import { ok, fail } from "./envelope.js";

test("ok envelope is versioned and successful", () => {
  expect(ok({ x: 1 })).toEqual({ v: 1, ok: true, data: { x: 1 } });
});

test("fail envelope carries a code and message", () => {
  expect(fail("E_BAD", "nope")).toEqual({ v: 1, ok: false, error: { code: "E_BAD", message: "nope" } });
});
```

`packages/cli/src/program.test.ts`:
```ts
import { expect, test } from "vitest";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProfileManager } from "@doit/daemon";
import { buildProgram } from "./program.js";

test("profile create prints a success envelope", async () => {
  const root = await mkdtemp(join(tmpdir(), "doit-cli-"));
  const profiles = new ProfileManager(root);
  const lines: string[] = [];
  const program = buildProgram({ profiles });
  program.configureOutput({ writeOut: (s) => lines.push(s) });
  program.exitOverride();
  await program.parseAsync(["profile", "create", "main", "--json"], { from: "user" });
  const parsed = JSON.parse(lines.join(""));
  expect(parsed).toMatchObject({ v: 1, ok: true, data: { name: "main", exists: true } });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test packages/cli/src/`
Expected: FAIL — package/module not found.

- [ ] **Step 3: Create package and implement**

`packages/cli/package.json`:
```json
{
  "name": "@doit/cli",
  "version": "0.0.0",
  "type": "module",
  "bin": { "brauto": "dist/bin.js" },
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "exports": { ".": "./dist/index.js" },
  "dependencies": {
    "@doit/daemon": "workspace:*",
    "commander": "^12.0.0"
  },
  "scripts": { "build": "tsc --build" }
}
```

`packages/cli/tsconfig.json`:
```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "rootDir": "src", "outDir": "dist" },
  "references": [{ "path": "../daemon" }],
  "include": ["src/**/*"],
  "exclude": ["src/**/*.test.ts"]
}
```

`packages/cli/src/envelope.ts`:
```ts
export interface JsonEnvelope<T> {
  v: 1;
  ok: boolean;
  data?: T;
  error?: { code: string; message: string };
}

export function ok<T>(data: T): JsonEnvelope<T> {
  return { v: 1, ok: true, data };
}

export function fail(code: string, message: string): JsonEnvelope<never> {
  return { v: 1, ok: false, error: { code, message } };
}
```

`packages/cli/src/program.ts`:
```ts
import { Command } from "commander";
import type { ProfileManager } from "@doit/daemon";
import { ok } from "./envelope.js";

export interface CliDeps {
  profiles: ProfileManager;
}

export function buildProgram(deps: CliDeps): Command {
  const program = new Command();
  program.name("brauto").description("Local browser automation platform").version("0.0.0");

  program.command("init")
    .option("--json", "emit a JSON envelope")
    .action(function (this: Command) {
      this.parent?.configureOutput;
      program.outputHelp;
      const out = ok({ initialized: true });
      program.configureOutput().writeOut?.(JSON.stringify(out));
    });

  const profile = program.command("profile");

  profile.command("create <name>")
    .option("--json", "emit a JSON envelope")
    .action(async (name: string) => {
      const status = await deps.profiles.create(name);
      program.configureOutput().writeOut?.(JSON.stringify(ok(status)));
    });

  profile.command("status <name>")
    .option("--json", "emit a JSON envelope")
    .action(async (name: string) => {
      const status = await deps.profiles.status(name);
      program.configureOutput().writeOut?.(JSON.stringify(ok(status)));
    });

  return program;
}
```

> Implementer note: the `program.configureOutput().writeOut?.(...)` calls above are a simplification. In practice, capture the writer once via `program.configureOutput({ writeOut })` (as the test does) and call that writer in the actions. Wire each action to the shared writer so `--json` output is testable; keep exit codes 0 for `ok` and 1 for `fail`.

`packages/cli/src/bin.ts`:
```ts
#!/usr/bin/env node
import { join } from "node:path";
import { homedir } from "node:os";
import { ProfileManager } from "@doit/daemon";
import { buildProgram } from "./program.js";

const profiles = new ProfileManager(join(homedir(), ".doit", "profiles"));
const program = buildProgram({ profiles });
program.parseAsync(process.argv).catch((err) => {
  process.stderr.write(`${String(err)}\n`);
  process.exit(1);
});
```

`packages/cli/src/index.ts`:
```ts
export * from "./envelope.js";
export * from "./program.js";
```

Add `{ "path": "packages/cli" }` to root `tsconfig.json`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm install && pnpm test packages/cli/src/`
Expected: PASS. Fix the `writeOut` wiring per the implementer note if the program test does not capture output.

- [ ] **Step 5: Verify the built binary runs**

Run: `pnpm -r build && node packages/cli/dist/bin.js profile status main --json`
Expected: prints a JSON envelope like `{"v":1,"ok":true,"data":{"name":"main",...}}`.

- [ ] **Step 6: Commit**

```bash
git add -A && git commit -m "feat(cli): commander skeleton with versioned JSON envelopes"
```

---

### Task 16: Full-build & lint gate

**Files:**
- Modify: root `package.json` (ensure `build`, `test`, `lint` scripts), `.eslintrc.cjs`

**Interfaces:**
- Consumes: every package.
- Produces: a green `pnpm -r build && pnpm test && pnpm lint` — the M1 exit gate.

- [ ] **Step 1: Run the full build**

Run: `pnpm -r build`
Expected: all packages compile with no type errors (project references resolve in order).

- [ ] **Step 2: Run all tests**

Run: `pnpm test`
Expected: every task's tests pass.

- [ ] **Step 3: Run lint (verify the forbidden-import rule holds)**

Run: `pnpm lint`
Expected: no errors. Manually confirm the rule works by temporarily adding `import "better-sqlite3"` to `packages/domain/src/index.ts`, running `pnpm lint`, seeing it fail, then reverting.

- [ ] **Step 4: Commit**

```bash
git add -A && git commit -m "chore: M1 full build, test, and lint gate green"
```

---

## Self-Review

**1. Spec coverage (M1 = CONOPS Phase 1 deliverables + design §3, §4):**
- Monorepo + toolchain → Task 1. ✅ (design §1, §3)
- Domain model (state machine, policy, approval binding, events) → Tasks 2–6. ✅ (CONOPS §4.3, §5.3, §9; FR-006)
- SQLite migrations, WAL, leases, idempotency, append-only event log → Tasks 8–11. ✅ (CONOPS §4.1, §4.2, §4.4; FR-003)
- Profile manager → Task 12. ✅ (CONOPS §2.5, §3.6; FR-001 setup portion — login flow itself is M2)
- CLI surface (subset) with versioned JSON envelopes → Task 15. ✅ (CONOPS §8; FR-018). Full command surface is fleshed out across M2/M3 as handlers exist.
- MCP facade skeleton + boundary contract test → Task 14. ✅ (CONOPS §3.5; FR-021/022)
- Crash recovery → Task 13. ✅ (CONOPS §10 reliability; recover within 30s)
- Build/lint gate incl. forbidden-import boundary → Tasks 1, 16. ✅ (design §3)

*Deferred to M2/M3 by design (not gaps):* Screenplay runtime, Playwright worker, the fixture site, reads/writes actions, model gateway, approval workflow wiring, throttle reservation, the remaining CLI handlers and MCP tool bodies. Tracked in the design doc's milestone list.

**2. Placeholder scan:** No "TBD"/"implement later" steps. Two "implementer note" callouts (Task 9 migrator evolution, Task 15 `writeOut` wiring) give concrete guidance and real code, not deferrals.

**3. Type consistency:** `CommandState`, `RiskClass`, `NewCommand`, `CommandRecord`, `CommandRepository`, `EventLog`, `Clock`, `ApprovalBinding`, `Decision`, `JsonEnvelope`, `ProfileStatus`, `ProfileManager`, `ALLOWED_TOOLS` names are defined once and reused verbatim across tasks. Repository method names (`enqueue`, `get`, `leaseNextReady`, `setState`, `recoverExpiredLeases`) match between the port (Task 7), implementation (Task 10), and consumers (Task 13).
