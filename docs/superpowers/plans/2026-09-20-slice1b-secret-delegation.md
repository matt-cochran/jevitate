# Slice 1b — Thin External-Password-Manager Secret Delegation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver `secretMode: "vault-autofill"` — fetch-on-demand secret retrieval from an EXTERNAL password manager, origin-bound, with nothing stored at rest — completing the secret-**value** contracts (§9a invariants #2–#4) that Slice 1's `visible-handback` path deliberately never needed (Slice 1's runner never held a secret value at all).

**Architecture:** A new dependency-free leaf package `@doit/secrets` owns the `Secret` value wrapper (throws on any serialization), the `SecretManagerPort` interface (thin delegation — the platform implements no vault), an origin-binding guard, a test-double adapter (`StubSecretManager`) and a real CLI-shelling adapter (`CliSecretManager`). `@doit/runtime`'s `JourneyRunner` gains one new optional constructor parameter (`secretManager?: SecretManagerPort`) and a `vault-autofill` branch alongside the existing `visible-handback` branch in its `awaiting_human` loop: preflight-checks every declared `SecretRef` resolves before any step runs, then on each handback step fetches the secret, verifies origin + field binding, types it directly into the live page via the Screenplay actor, and never lets the plaintext reach `JourneyRunResult`, a log, or a resumed step's params. `@doit/domain`'s `RunPolicy` needs no structural change — `vault-autofill` is already a valid `SecretMode` literal from Slice 1; this slice only confirms/documents that shape.

**Tech Stack:** TypeScript (strict, ES2022, NodeNext), Vitest, pnpm workspaces, Playwright (via existing `@doit/screenplay`/`@doit/interpreter`), Node's built-in `node:child_process`/`node:util` (no new npm dependencies).

**Spec:** `docs/superpowers/specs/2026-09-19-unified-journey-automation-and-testing-design.md` — Hard Floor #6 (§9, secret invariant), §9a invariants #2–#4, Slice roadmap row **1b** (§10).

## Global Constraints

- Node 20+, ESM (`"type": "module"`), TypeScript strict mode, project references (`tsc --build`), matching every existing package's `tsconfig.json` shape (`extends: "../../tsconfig.base.json"`, `rootDir: "src"`, `outDir: "dist"`, `exclude: ["src/**/*.test.ts"]`).
- Dependency direction is inward: `@doit/secrets` is a pure leaf (zero workspace dependencies, like `@doit/domain`) — it does **not** import `@doit/journey`'s `SecretRef`; it defines its own structurally-identical `SecretRef` interface so TypeScript's structural typing makes the two interchangeable at call sites with zero casting, with zero new inter-package coupling.
- Hard Floor #6 (secret invariant) is **not tunable**: a secret's only permitted path is external manager (fetch-on-demand) → browser input → the target's own auth call. Never in a model prompt, never persisted in a Journey/Recording/log, never in any outbound request except the target's own call. **Origin-bound** — never typed into a different/injected origin. **Nothing stored at rest** (thin delegation only).
- §9a invariants land here: **#2** secret never serialized (no `toString`/JSON on `Secret`; a Journey/Recording holds only a manager reference, never a value); **#3** origin mismatch → `SecretOriginMismatchError`, never fills; **#4** unresolvable secret → fail-fast at **preflight** (before any step runs), never a mid-run silent skip.
- Fail-closed, always: an unenforceable policy branch (e.g. `vault-autofill` requested but no `SecretManagerPort` wired up) throws — reuse `PolicyEnforcementError` from `packages/runtime/src/runner.ts`, exactly as Slice 1 already does for "declared hard limit we cannot enforce."
- **Repo gotcha: packages have NO `"test"` script.** Run tests via `pnpm exec vitest run <path>` — NOT `pnpm --filter <pkg> test`.
- Explicit-path git staging only (e.g. `git add packages/secrets/src/secret.ts packages/secrets/src/secret.test.ts`) — never `git add -A`/`git add .`.
- Commit trailer on every commit in this plan:
  ```
  Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
  ```
- **Orthogonality (parallel slices):** this plan touches only the NEW `packages/secrets/**`, `packages/domain/src/run-policy.ts` (additive), `packages/runtime/src/journey-runner.ts` (the vault-autofill branch) plus new runtime test files, and the additive root wiring files (`tsconfig.json`, `vitest.config.ts`, `pnpm-lock.yaml`, `packages/runtime/package.json`, `packages/runtime/tsconfig.json`). Do **not** touch `@doit/journey`, `@doit/ai-core`, `@doit/sources`, `@doit/load`, `@doit/recording`, or any other package's source. `JourneyRunner`'s public constructor stays backward-compatible: the new `secretManager` parameter is appended, optional, after the existing optional `handback` parameter — every existing 2-arg/3-arg call site keeps compiling and behaving identically.

---

### Task 1: Scaffold `@doit/secrets` + `SecretRef` + `Secret` (invariant #2, part 1)

**Files:**
- Create: `packages/secrets/package.json`
- Create: `packages/secrets/tsconfig.json`
- Create: `packages/secrets/src/secret-ref.ts`
- Create: `packages/secrets/src/secret.ts`
- Create: `packages/secrets/src/secret.test.ts`
- Create: `packages/secrets/src/index.ts`
- Modify: `tsconfig.json` (root) — add `{ "path": "packages/secrets" }` to `references`
- Modify: `vitest.config.ts` (root) — add `"@doit/secrets": pkg("secrets")` alias line

**Interfaces:**
- Produces: `SecretRef { manager: string; key: string; origin: string; field: string }` (`packages/secrets/src/secret-ref.ts`)
- Produces: `class Secret { constructor(value: string); reveal(): string; toString(): never; toJSON(): never; [util.inspect.custom](): never }` (`packages/secrets/src/secret.ts`)

- [ ] **Step 1: Create the package scaffold**

`packages/secrets/package.json`:
```json
{
  "name": "@doit/secrets",
  "version": "0.0.0",
  "type": "module",
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "exports": {
    ".": "./dist/index.js"
  },
  "scripts": {
    "build": "tsc --build"
  }
}
```

`packages/secrets/tsconfig.json`:
```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "rootDir": "src", "outDir": "dist" },
  "include": ["src/**/*"],
  "exclude": ["src/**/*.test.ts"]
}
```

In root `tsconfig.json`, add `{ "path": "packages/secrets" }` to the `references` array (any position — alphabetical-ish grouping is not enforced elsewhere in this file, so append it after `{ "path": "packages/domain" }`).

In root `vitest.config.ts`, add one alias line next to the others:
```ts
      "@doit/secrets": pkg("secrets"),
```

- [ ] **Step 2: Write the failing test for `Secret`**

`packages/secrets/src/secret.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { inspect } from "node:util";
import { Secret } from "./secret.js";

describe("Secret", () => {
  it("reveal() returns the wrapped plaintext", () => {
    expect(new Secret("hunter2").reveal()).toBe("hunter2");
  });

  it("throws on toString() (template-literal interpolation)", () => {
    expect(() => `${new Secret("hunter2")}`).toThrow(/must not be serialized/);
  });

  it("throws on JSON.stringify()", () => {
    expect(() => JSON.stringify({ s: new Secret("hunter2") })).toThrow(/must not be serialized/);
  });

  it("throws on util.inspect() (the console.log path)", () => {
    expect(() => inspect(new Secret("hunter2"))).toThrow(/must not be logged/);
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `pnpm exec vitest run packages/secrets/src/secret.test.ts`
Expected: FAIL — cannot find module `./secret.js` (nothing implemented yet).

- [ ] **Step 4: Implement `SecretRef` and `Secret`**

`packages/secrets/src/secret-ref.ts`:
```ts
/**
 * A reference to a secret held by an EXTERNAL password manager — never a
 * value. The platform owns no vault; this is the whole shape a Journey (or
 * anything else) may hold at rest for a secret (§9a invariant #2: "a
 * Journey/Recording may hold only a manager reference, never a value").
 *
 * Structurally identical to `@doit/journey`'s `SecretRef`
 * (packages/journey/src/journey.ts) — deliberately duplicated, not
 * imported, so `@doit/secrets` stays a dependency-free leaf package.
 * TypeScript's structural typing makes the two interchangeable at call
 * sites with zero casting.
 */
export interface SecretRef {
  manager: string;
  key: string;
  origin: string;
  field: string;
}
```

`packages/secrets/src/secret.ts`:
```ts
import { inspect } from "node:util";

/**
 * Wraps a fetched secret plaintext so it can be threaded from a
 * `SecretManagerPort` to the one place allowed to read it (a browser fill)
 * without ever being accidentally logged, JSON-serialized, or interpolated
 * into a string. §9a invariant #2: "The `Secret` type has no
 * toString/JSON serialization; serializing or logging it throws."
 *
 * `reveal()` is the ONLY way out. Callers must pass its result straight
 * into the browser fill and never assign it to anything that outlives that
 * one statement (no local persisted var, no object literal, no return
 * value, no log line).
 */
export class Secret {
  readonly #value: string;

  constructor(value: string) {
    this.#value = value;
  }

  reveal(): string {
    return this.#value;
  }

  toString(): never {
    throw new Error("Secret must not be serialized to a string (toString)");
  }

  toJSON(): never {
    throw new Error("Secret must not be serialized to JSON (toJSON)");
  }

  [inspect.custom](): never {
    throw new Error("Secret must not be logged/inspected (util.inspect)");
  }
}
```

`packages/secrets/src/index.ts`:
```ts
export type { SecretRef } from "./secret-ref.js";
export { Secret } from "./secret.js";
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `pnpm exec vitest run packages/secrets/src/secret.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 6: Commit**

```bash
git add packages/secrets/package.json packages/secrets/tsconfig.json \
  packages/secrets/src/secret-ref.ts packages/secrets/src/secret.ts \
  packages/secrets/src/secret.test.ts packages/secrets/src/index.ts \
  tsconfig.json vitest.config.ts
git commit -m "$(cat <<'EOF'
feat(secrets): scaffold @doit/secrets — SecretRef + Secret (never-serialize invariant)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: Origin-binding guard (invariant #3)

**Files:**
- Create: `packages/secrets/src/errors.ts`
- Create: `packages/secrets/src/origin-binding.ts`
- Create: `packages/secrets/src/origin-binding.test.ts`
- Modify: `packages/secrets/src/index.ts`

**Interfaces:**
- Consumes: `SecretRef` (Task 1, `./secret-ref.js`)
- Produces: `class SecretOriginMismatchError extends Error`, `class SecretUnresolvableError extends Error` (`packages/secrets/src/errors.ts`)
- Produces: `function assertOriginBound(ref: SecretRef, currentUrl: string): void` (`packages/secrets/src/origin-binding.ts`) — throws `SecretOriginMismatchError` on any mismatch.

- [ ] **Step 1: Write the failing test**

`packages/secrets/src/origin-binding.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { assertOriginBound } from "./origin-binding.js";
import { SecretOriginMismatchError } from "./errors.js";

const ref = { manager: "stub", key: "gmail-password", origin: "https://mail.example.com", field: "password" };

describe("assertOriginBound", () => {
  it("passes silently when the current URL's origin matches ref.origin", () => {
    expect(() => assertOriginBound(ref, "https://mail.example.com/login")).not.toThrow();
  });

  it("throws SecretOriginMismatchError on a different host", () => {
    expect(() => assertOriginBound(ref, "https://evil.example.com/login")).toThrow(SecretOriginMismatchError);
  });

  it("throws SecretOriginMismatchError on a different scheme (https vs http)", () => {
    expect(() => assertOriginBound(ref, "http://mail.example.com/login")).toThrow(SecretOriginMismatchError);
  });

  it("throws SecretOriginMismatchError on a different port", () => {
    expect(() =>
      assertOriginBound({ ...ref, origin: "https://mail.example.com:8443" }, "https://mail.example.com/login"),
    ).toThrow(SecretOriginMismatchError);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run packages/secrets/src/origin-binding.test.ts`
Expected: FAIL — cannot find module `./origin-binding.js` / `./errors.js`.

- [ ] **Step 3: Implement `errors.ts` and `origin-binding.ts`**

`packages/secrets/src/errors.ts`:
```ts
/** §9a invariant #3: origin (or expected-field) mismatch before a secret
 * fill — never fills, always throws. */
export class SecretOriginMismatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SecretOriginMismatchError";
  }
}

/** §9a invariant #4: the declared manager+entry could not be resolved.
 * Raised at PREFLIGHT (before any step runs), never as a mid-run silent
 * skip. */
export class SecretUnresolvableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SecretUnresolvableError";
  }
}
```

`packages/secrets/src/origin-binding.ts`:
```ts
import type { SecretRef } from "./secret-ref.js";
import { SecretOriginMismatchError } from "./errors.js";

/** Normalizes a URL string down to its origin (scheme+host+port), so
 * "https://example.com/login" and "https://example.com" compare equal. */
function originOf(url: string): string {
  return new URL(url).origin;
}

/**
 * §9a invariant #3: before any secret fill, assert the CURRENT page's
 * origin equals `ref.origin` exactly. Throws `SecretOriginMismatchError`
 * (never fills) on any mismatch — including a same-site-but-different-port
 * or -scheme redirect/injection.
 */
export function assertOriginBound(ref: SecretRef, currentUrl: string): void {
  const current = originOf(currentUrl);
  const bound = originOf(ref.origin);
  if (current !== bound) {
    throw new SecretOriginMismatchError(
      `secret "${ref.key}" is bound to origin ${bound}, but the current page is ${current} — refusing to fill`,
    );
  }
}
```

Update `packages/secrets/src/index.ts`:
```ts
export type { SecretRef } from "./secret-ref.js";
export { Secret } from "./secret.js";
export { SecretOriginMismatchError, SecretUnresolvableError } from "./errors.js";
export { assertOriginBound } from "./origin-binding.js";
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm exec vitest run packages/secrets/src/origin-binding.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 5: Commit**

```bash
git add packages/secrets/src/errors.ts packages/secrets/src/origin-binding.ts \
  packages/secrets/src/origin-binding.test.ts packages/secrets/src/index.ts
git commit -m "$(cat <<'EOF'
feat(secrets): origin-binding guard — SecretOriginMismatchError (invariant #3)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: `SecretManagerPort` + `StubSecretManager` (invariant #4, preflight contract)

**Files:**
- Create: `packages/secrets/src/secret-manager-port.ts`
- Create: `packages/secrets/src/stub-secret-manager.ts`
- Create: `packages/secrets/src/stub-secret-manager.test.ts`
- Modify: `packages/secrets/src/index.ts`

**Interfaces:**
- Consumes: `SecretRef` (Task 1), `Secret` (Task 1), `SecretUnresolvableError` (Task 2)
- Produces: `interface SecretManagerPort { assertResolvable(ref: SecretRef): Promise<void>; fetch(ref: SecretRef): Promise<Secret> }` (`packages/secrets/src/secret-manager-port.ts`)
- Produces: `class StubSecretManager implements SecretManagerPort { constructor(values: Record<string, string>) }` (`packages/secrets/src/stub-secret-manager.ts`) — keyed by `ref.key`.

- [ ] **Step 1: Write the failing test**

`packages/secrets/src/stub-secret-manager.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { StubSecretManager } from "./stub-secret-manager.js";
import { SecretUnresolvableError } from "./errors.js";
import { Secret } from "./secret.js";

const ref = { manager: "stub", key: "gmail-password", origin: "https://mail.example.com", field: "password" };

describe("StubSecretManager", () => {
  it("assertResolvable resolves cleanly when the key is present", async () => {
    const mgr = new StubSecretManager({ "gmail-password": "hunter2" });
    await expect(mgr.assertResolvable(ref)).resolves.toBeUndefined();
  });

  it("assertResolvable throws SecretUnresolvableError when the key is absent", async () => {
    const mgr = new StubSecretManager({});
    await expect(mgr.assertResolvable(ref)).rejects.toBeInstanceOf(SecretUnresolvableError);
  });

  it("fetch returns a Secret wrapping the value", async () => {
    const mgr = new StubSecretManager({ "gmail-password": "hunter2" });
    const secret = await mgr.fetch(ref);
    expect(secret).toBeInstanceOf(Secret);
    expect(secret.reveal()).toBe("hunter2");
  });

  it("fetch throws SecretUnresolvableError when the key is absent", async () => {
    const mgr = new StubSecretManager({});
    await expect(mgr.fetch(ref)).rejects.toBeInstanceOf(SecretUnresolvableError);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run packages/secrets/src/stub-secret-manager.test.ts`
Expected: FAIL — cannot find module `./stub-secret-manager.js`.

- [ ] **Step 3: Implement `SecretManagerPort` and `StubSecretManager`**

`packages/secrets/src/secret-manager-port.ts`:
```ts
import type { SecretRef } from "./secret-ref.js";
import type { Secret } from "./secret.js";

/**
 * Thin delegation to an EXTERNAL password/secret manager. The platform
 * implements NO vault of its own — every method here fetches on demand
 * from whatever manager `ref.manager` names; nothing is cached or
 * persisted by an implementation of this port (Hard Floor #6: "we store no
 * secrets at rest").
 */
export interface SecretManagerPort {
  /**
   * Fail-fast preflight check (§9a invariant #4): resolves cleanly, or
   * throws `SecretUnresolvableError` with an actionable message. Must be
   * called BEFORE any step runs — never mid-run.
   */
  assertResolvable(ref: SecretRef): Promise<void>;

  /** Fetches the secret's current value on demand. Never caches it. */
  fetch(ref: SecretRef): Promise<Secret>;
}
```

`packages/secrets/src/stub-secret-manager.ts`:
```ts
import type { SecretRef } from "./secret-ref.js";
import type { SecretManagerPort } from "./secret-manager-port.js";
import { Secret } from "./secret.js";
import { SecretUnresolvableError } from "./errors.js";

/**
 * Test-only `SecretManagerPort`: an in-memory map keyed by `ref.key`. Real
 * adapters (e.g. `CliSecretManager`) shell out to an actual external
 * manager; this one exists so runtime/journey tests never need a real
 * vault. It still enforces the same "thin delegation, nothing persisted"
 * contract — the map is caller-supplied fixture data, not something this
 * class writes to.
 */
export class StubSecretManager implements SecretManagerPort {
  constructor(private readonly values: Record<string, string>) {}

  async assertResolvable(ref: SecretRef): Promise<void> {
    if (!(ref.key in this.values)) {
      throw new SecretUnresolvableError(
        `stub secret manager has no entry for key "${ref.key}" (manager "${ref.manager}")`,
      );
    }
  }

  async fetch(ref: SecretRef): Promise<Secret> {
    const value = this.values[ref.key];
    if (value === undefined) {
      throw new SecretUnresolvableError(
        `stub secret manager has no entry for key "${ref.key}" (manager "${ref.manager}")`,
      );
    }
    return new Secret(value);
  }
}
```

Update `packages/secrets/src/index.ts`:
```ts
export type { SecretRef } from "./secret-ref.js";
export { Secret } from "./secret.js";
export { SecretOriginMismatchError, SecretUnresolvableError } from "./errors.js";
export { assertOriginBound } from "./origin-binding.js";
export type { SecretManagerPort } from "./secret-manager-port.js";
export { StubSecretManager } from "./stub-secret-manager.js";
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm exec vitest run packages/secrets/src/stub-secret-manager.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 5: Commit**

```bash
git add packages/secrets/src/secret-manager-port.ts packages/secrets/src/stub-secret-manager.ts \
  packages/secrets/src/stub-secret-manager.test.ts packages/secrets/src/index.ts
git commit -m "$(cat <<'EOF'
feat(secrets): SecretManagerPort + StubSecretManager test double

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: `CliSecretManager` — real thin-delegation adapter

**Files:**
- Create: `packages/secrets/src/cli-secret-manager.ts`
- Create: `packages/secrets/src/cli-secret-manager.test.ts`
- Modify: `packages/secrets/src/index.ts`

**Interfaces:**
- Consumes: `SecretRef`, `SecretManagerPort`, `Secret`, `SecretUnresolvableError`
- Produces: `interface CliCommand { cmd: string; args: string[] }`, `type ExecFn = (cmd: string, args: string[]) => Promise<string>`, `class CliSecretManager implements SecretManagerPort { constructor(buildCommand: (ref: SecretRef) => CliCommand, exec?: ExecFn) }`

- [ ] **Step 1: Write the failing test**

`packages/secrets/src/cli-secret-manager.test.ts`:
```ts
import { describe, it, expect, vi } from "vitest";
import { CliSecretManager } from "./cli-secret-manager.js";
import { Secret } from "./secret.js";
import { SecretUnresolvableError } from "./errors.js";

const ref = { manager: "op", key: "gmail-password", origin: "https://mail.example.com", field: "password" };

describe("CliSecretManager", () => {
  it("fetch runs the built command and wraps trimmed stdout in a Secret", async () => {
    const exec = vi.fn(async () => "hunter2\n");
    const mgr = new CliSecretManager((r) => ({ cmd: "op", args: ["read", r.key] }), exec);
    const secret = await mgr.fetch(ref);
    expect(exec).toHaveBeenCalledWith("op", ["read", "gmail-password"]);
    expect(secret).toBeInstanceOf(Secret);
    expect(secret.reveal()).toBe("hunter2");
  });

  it("fetch throws SecretUnresolvableError (not the raw exec error) when the CLI fails", async () => {
    const exec = vi.fn(async () => {
      throw new Error("exit code 1");
    });
    const mgr = new CliSecretManager((r) => ({ cmd: "op", args: ["read", r.key] }), exec);
    await expect(mgr.fetch(ref)).rejects.toBeInstanceOf(SecretUnresolvableError);
  });

  it("assertResolvable succeeds when the CLI succeeds (and discards the value)", async () => {
    const exec = vi.fn(async () => "hunter2\n");
    const mgr = new CliSecretManager((r) => ({ cmd: "op", args: ["read", r.key] }), exec);
    await expect(mgr.assertResolvable(ref)).resolves.toBeUndefined();
  });

  it("assertResolvable rejects with SecretUnresolvableError when the CLI fails", async () => {
    const exec = vi.fn(async () => {
      throw new Error("not found");
    });
    const mgr = new CliSecretManager((r) => ({ cmd: "op", args: ["read", r.key] }), exec);
    await expect(mgr.assertResolvable(ref)).rejects.toBeInstanceOf(SecretUnresolvableError);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run packages/secrets/src/cli-secret-manager.test.ts`
Expected: FAIL — cannot find module `./cli-secret-manager.js`.

- [ ] **Step 3: Implement `CliSecretManager`**

`packages/secrets/src/cli-secret-manager.ts`:
```ts
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { SecretRef } from "./secret-ref.js";
import type { SecretManagerPort } from "./secret-manager-port.js";
import { Secret } from "./secret.js";
import { SecretUnresolvableError } from "./errors.js";

const execFileAsync = promisify(execFile);

export interface CliCommand {
  cmd: string;
  args: string[];
}

export type ExecFn = (cmd: string, args: string[]) => Promise<string>;

const defaultExec: ExecFn = async (cmd, args) => {
  const { stdout } = await execFileAsync(cmd, args);
  return stdout;
};

/**
 * Thin delegation to an EXTERNAL password manager's own CLI (e.g. `op`,
 * `bw`, `pass`) — the platform never implements a vault itself.
 * `buildCommand` maps a `SecretRef` to the manager-specific CLI invocation
 * (syntax varies per manager, so this is caller-supplied, never hardcoded
 * to one vendor). Nothing fetched is cached: every `fetch`/`assertResolvable`
 * call re-invokes the CLI.
 */
export class CliSecretManager implements SecretManagerPort {
  constructor(
    private readonly buildCommand: (ref: SecretRef) => CliCommand,
    private readonly exec: ExecFn = defaultExec,
  ) {}

  async assertResolvable(ref: SecretRef): Promise<void> {
    await this.fetch(ref); // discarded immediately — never stored, never logged
  }

  async fetch(ref: SecretRef): Promise<Secret> {
    const { cmd, args } = this.buildCommand(ref);
    let stdout: string;
    try {
      stdout = await this.exec(cmd, args);
    } catch (err) {
      throw new SecretUnresolvableError(
        `manager "${ref.manager}" could not resolve key "${ref.key}": ${(err as Error).message}`,
      );
    }
    return new Secret(stdout.trim());
  }
}
```

Update `packages/secrets/src/index.ts`:
```ts
export type { SecretRef } from "./secret-ref.js";
export { Secret } from "./secret.js";
export { SecretOriginMismatchError, SecretUnresolvableError } from "./errors.js";
export { assertOriginBound } from "./origin-binding.js";
export type { SecretManagerPort } from "./secret-manager-port.js";
export { StubSecretManager } from "./stub-secret-manager.js";
export { CliSecretManager, type CliCommand, type ExecFn } from "./cli-secret-manager.js";
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm exec vitest run packages/secrets/src/cli-secret-manager.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 5: Commit**

```bash
git add packages/secrets/src/cli-secret-manager.ts packages/secrets/src/cli-secret-manager.test.ts \
  packages/secrets/src/index.ts
git commit -m "$(cat <<'EOF'
feat(secrets): CliSecretManager — real thin-delegation adapter over an external manager CLI

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: "Nothing stored at rest" exit test (Hard Floor #6)

**Files:**
- Create: `packages/secrets/src/no-persistence.test.ts`

**Interfaces:**
- Consumes: nothing (reads its own directory's source files as text)

- [ ] **Step 1: Write the failing test**

`packages/secrets/src/no-persistence.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const srcDir = fileURLToPath(new URL(".", import.meta.url));

const FORBIDDEN: RegExp[] = [
  /\bnode:fs\b/,
  /from ["']fs["']/,
  /\bwriteFile(Sync)?\(/,
  /\bcreateWriteStream\(/,
  /better-sqlite3/,
  /\bnode:sqlite\b/,
  /\blocalStorage\b/,
];

describe("Hard Floor #6 — nothing stored at rest", () => {
  it("no @doit/secrets source file touches the filesystem or a database (thin delegation only, per-call fetch)", () => {
    const files = readdirSync(srcDir).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"));
    expect(files.length).toBeGreaterThan(0); // guard against an empty/misconfigured glob silently "passing"
    for (const file of files) {
      const text = readFileSync(join(srcDir, file), "utf8");
      for (const pattern of FORBIDDEN) {
        expect(text, `${file} matched forbidden persistence pattern ${pattern}`).not.toMatch(pattern);
      }
    }
  });
});
```

- [ ] **Step 2: Run test to verify it passes immediately**

Run: `pnpm exec vitest run packages/secrets/src/no-persistence.test.ts`
Expected: PASS (1 test) — nothing written so far touches the filesystem, so this test is a **regression guard** going forward (TDD note: this is the rare invariant test that should already pass; its value is in `git blame`-flagging any future file in this package that starts writing to disk). Confirm it fails if you temporarily add `readFileSync` fake bait — e.g. run `grep -n writeFileSync packages/secrets/src/*.ts` and confirm zero hits, then trust the assertion.

- [ ] **Step 3: Commit**

```bash
git add packages/secrets/src/no-persistence.test.ts
git commit -m "$(cat <<'EOF'
test(secrets): guard test — no source file in @doit/secrets touches disk/db (Hard Floor #6)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

### Task 6: `@doit/domain` — confirm the `vault-autofill` `SecretMode` shape (additive)

**Files:**
- Modify: `packages/domain/src/run-policy.ts` (doc comment only — no structural change)
- Modify: `packages/domain/src/run-policy.test.ts`

**Interfaces:**
- Consumes: existing `SecretMode`, `RunPolicy`, `safeRunPolicy()` (unchanged signatures)
- Produces: nothing new — this task is a confirming test, not a new type. `SecretMode = "vault-autofill" | "visible-handback" | "fail-closed"` already includes `"vault-autofill"` since Slice 1; `vault-autofill`'s own parameters (which manager, which key, which origin) live on the Journey's `metadata.secretRefs: SecretRef[]` (already defined in `@doit/journey`), **not** on `RunPolicy` — a `RunPolicy` only ever says *which mode*, never secret-specific data. No `RunPolicy` field is added.

- [ ] **Step 1: Write the failing (well — currently-missing) test**

Add to `packages/domain/src/run-policy.test.ts` (append inside the existing `describe`, or a new `describe` block):
```ts
describe("SecretMode — vault-autofill (Slice 1b)", () => {
  it("accepts secretMode: 'vault-autofill' as a valid RunPolicy without any extra required fields", () => {
    const p: RunPolicy = {
      selfHeal: { mode: "fail-closed" },
      direction: { direction: "deterministic" },
      secret: { secretMode: "vault-autofill" },
    };
    expect(p.secret.secretMode).toBe("vault-autofill");
  });

  it("safeRunPolicy() is unchanged — still defaults to fail-closed secret, never vault-autofill", () => {
    expect(safeRunPolicy().secret.secretMode).toBe("fail-closed");
  });
});
```

- [ ] **Step 2: Run test to verify current behavior**

Run: `pnpm exec vitest run packages/domain/src/run-policy.test.ts`
Expected: PASS already (no production code changes are needed — `"vault-autofill"` is already a member of the `SecretMode` union from Slice 1). This step is deliberately a **confirmation**, not a red-green cycle: it locks in, with an explicit test, that Slice 1b requires zero breaking changes to `RunPolicy`/`safeRunPolicy()`.

- [ ] **Step 3: Add a documentation-only comment recording this ruling**

In `packages/domain/src/run-policy.ts`, above the `SecretMode` type declaration, add:
```ts
// Slice 1b (thin external-manager secret delegation) implements the
// "vault-autofill" branch of secretMode's behavior in @doit/runtime's
// JourneyRunner. It is already a member of this union as of Slice 1 and
// requires NO new field here — a vault-autofill run's manager/key/origin
// come from the Journey's own `metadata.secretRefs` (see
// packages/journey/src/journey.ts's `SecretRef`), never from RunPolicy.
export type SecretMode = "vault-autofill" | "visible-handback" | "fail-closed";
```
(Replace the existing bare `export type SecretMode = ...` line with this commented version — the type text itself is unchanged.)

- [ ] **Step 4: Run the full domain test suite to confirm no regression**

Run: `pnpm exec vitest run packages/domain/src/run-policy.test.ts`
Expected: PASS (all tests, old and new)

- [ ] **Step 5: Commit**

```bash
git add packages/domain/src/run-policy.ts packages/domain/src/run-policy.test.ts
git commit -m "$(cat <<'EOF'
test(domain): confirm vault-autofill SecretMode requires no RunPolicy shape change (Slice 1b)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

### Task 7: `@doit/runtime` — wire `@doit/secrets` + `JourneyRunner` preflight (invariant #4)

**Files:**
- Modify: `packages/runtime/package.json` — add `"@doit/secrets": "workspace:*"` to `dependencies`
- Modify: `packages/runtime/tsconfig.json` — add `{ "path": "../secrets" }` to `references`
- Modify: `packages/runtime/src/journey-runner.ts`
- Create: `packages/runtime/src/vault-autofill.test.ts`

**Interfaces:**
- Consumes: `SecretManagerPort`, `SecretOriginMismatchError`, `assertOriginBound`, `StubSecretManager` (from `@doit/secrets`); `SecretRef` (type, from `@doit/journey`, already a runtime dependency); `InterpretResult`, `descriptorToTarget` (from `@doit/interpreter`, already a dependency); `Enter`, `BrowseTheWebToken` (from `@doit/screenplay`, already a dependency)
- Produces (extends, backward-compatibly): `JourneyRunner`'s constructor becomes `constructor(actor: Actor, interpreter: RecordingInterpreter, handback?: HandbackHandler, secretManager?: SecretManagerPort)` — the new 4th parameter is optional and appended after the existing optional 3rd, so every existing call site (`new JourneyRunner(actor, interp)` and `new JourneyRunner(actor, interp, handback)`) keeps compiling and behaving identically. `run()`'s signature (`(req: JourneyRunRequest): Promise<JourneyRunResult>`) is completely unchanged.

This task adds the constructor parameter and the **preflight** half of vault-autofill (invariant #4 + the missing-manager fail-closed case) — no field-filling logic yet (Task 8).

- [ ] **Step 1: Write the failing tests**

`packages/runtime/src/vault-autofill.test.ts`:
```ts
import { describe, it, expect, vi } from "vitest";
import { CastActor, BrowseTheWeb } from "@doit/screenplay";
import { safeRunPolicy } from "@doit/domain";
import { StubSecretManager, SecretUnresolvableError } from "@doit/secrets";
import { JourneyRunner, PolicyEnforcementError } from "./index.js";

function fakeLocator() {
  return {
    click: vi.fn(async () => {}),
    fill: vi.fn(async () => {}),
    pressSequentially: vi.fn(async () => {}),
    isVisible: vi.fn(async () => true),
  };
}

function fakePage(locator: ReturnType<typeof fakeLocator>, url: string) {
  return {
    goto: vi.fn(async () => {}),
    url: vi.fn(() => url),
    getByTestId: vi.fn(() => locator),
    getByRole: vi.fn(() => locator),
    getByLabel: vi.fn(() => locator),
    getByText: vi.fn(() => locator),
    locator: vi.fn(() => locator),
  };
}

function actorWithPage(page: any) {
  return CastActor.named("test").whoCan(
    new BrowseTheWeb({ page, startTracing: vi.fn(), stopTracingToFile: vi.fn(), close: vi.fn() } as any, []),
  );
}

function fakeInterpreter(handbackResult: any) {
  return {
    run: vi.fn().mockResolvedValue(handbackResult),
    resumeFrom: vi.fn().mockResolvedValue({ outcome: "completed", vars: {} }),
  } as any;
}

const journeyWithSecret = (secretRefs: any[]) =>
  ({
    metadata: { id: "j", name: "j", promoted: true, params: [], secretRefs, createdAtIso: "x" },
    recording: { version: "1", site: "s", pages: [] },
  }) as any;

const ref = { manager: "stub", key: "login-password", origin: "https://mail.example.test", field: "password" };
const vaultPolicy = { ...safeRunPolicy(), secret: { secretMode: "vault-autofill" as const } };
const handback = {
  outcome: "awaiting_human",
  at: 0,
  prompt: "please enter your password",
  resume: { kind: "visible", target: { label: "Password" } },
};

describe("JourneyRunner — vault-autofill preflight", () => {
  it("§9a invariant #4: an unresolvable declared secretRef fails at PREFLIGHT, before any step runs", async () => {
    const actor = actorWithPage(fakePage(fakeLocator(), "https://mail.example.test/login"));
    const interp = fakeInterpreter(handback);
    const manager = new StubSecretManager({}); // "login-password" not present
    const runner = new JourneyRunner(actor, interp, undefined, manager);

    await expect(
      runner.run({ journey: journeyWithSecret([ref]), params: {}, policy: vaultPolicy }),
    ).rejects.toBeInstanceOf(SecretUnresolvableError);
    expect(interp.run).not.toHaveBeenCalled(); // fail-fast BEFORE execution
  });

  it("missing SecretManagerPort under vault-autofill fails closed (PolicyEnforcementError), never a permissive skip", async () => {
    const actor = actorWithPage(fakePage(fakeLocator(), "https://mail.example.test/login"));
    const interp = fakeInterpreter(handback);
    const runner = new JourneyRunner(actor, interp); // no secretManager passed at all — backward-compatible 2-arg call

    await expect(
      runner.run({ journey: journeyWithSecret([ref]), params: {}, policy: vaultPolicy }),
    ).rejects.toBeInstanceOf(PolicyEnforcementError);
    expect(interp.run).not.toHaveBeenCalled();
  });

  it("a journey with no declared secretRefs under vault-autofill has nothing to preflight and proceeds", async () => {
    const actor = actorWithPage(fakePage(fakeLocator(), "https://mail.example.test/login"));
    const interp = fakeInterpreter({ outcome: "completed", vars: {} });
    const manager = new StubSecretManager({});
    const runner = new JourneyRunner(actor, interp, undefined, manager);

    const result = await runner.run({ journey: journeyWithSecret([]), params: {}, policy: vaultPolicy });
    expect(result).toEqual({ outcome: "ok", output: {} });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm exec vitest run packages/runtime/src/vault-autofill.test.ts`
Expected: FAIL — `@doit/secrets` is not yet a resolvable import from `packages/runtime` (no dependency wired), and `JourneyRunner`'s constructor does not yet accept a 4th argument / preflight logic does not exist.

- [ ] **Step 3: Wire the dependency**

In `packages/runtime/package.json`, add to `"dependencies"` (alphabetical, matching the existing list's order):
```json
    "@doit/secrets": "workspace:*",
```
placing it after `"@doit/screenplay": "workspace:*"` and before `"@doit/site-sdk": "workspace:*"`.

In `packages/runtime/tsconfig.json`, add `{ "path": "../secrets" }` to `"references"` (any position — append after `{ "path": "../domain" }`).

Run `pnpm install` at the repo root so `pnpm-lock.yaml` picks up the new workspace edge (this is the "additive root pnpm-lock touch" the orthogonality note expects).

- [ ] **Step 4: Extend the `JourneyRunner` constructor + add preflight**

In `packages/runtime/src/journey-runner.ts`, update the imports at the top:
```ts
import type { Actor } from "@doit/screenplay";
import type { RunPolicy } from "@doit/domain";
import { deriveParamSchema, validateParams, type Journey, type SecretRef } from "@doit/journey";
import { RecordingInterpreter, checkAssertion, type InterpretResult } from "@doit/interpreter";
import type { SecretManagerPort } from "@doit/secrets";
import { PolicyEnforcementError } from "./runner.js";
```

Update the class:
```ts
export class JourneyRunner {
  constructor(
    private readonly actor: Actor,
    private readonly interpreter: RecordingInterpreter,
    private readonly handback?: HandbackHandler,
    private readonly secretManager?: SecretManagerPort,
  ) {}
```

Add the preflight call at the top of `run()`, right after `validateParams(...)` and before the first `this.interpreter.run(...)` call:
```ts
  async run(req: JourneyRunRequest): Promise<JourneyRunResult> {
    assertCompletePolicy(req?.policy); // #1 — fires before ANY interpreter call
    validateParams(deriveParamSchema(req.journey.recording), req.params); // #5 — before any step

    if (req.policy.secret.secretMode === "vault-autofill") {
      await this.preflightSecretRefs(req.journey.metadata.secretRefs ?? []);
    }

    let result = await this.interpreter.run(this.actor, req.journey.recording, req.params);
    // ... (rest of the method is unchanged for this task — Task 8 extends the loop)
```

Add the new private method (anywhere inside the class, e.g. right after `run()`):
```ts
  /** §9a invariant #4: preflight — every declared secretRef must resolve
   * BEFORE any step runs. A missing SecretManagerPort under vault-autofill
   * is itself an unenforceable policy (mirrors PolicyEnforcementError's
   * existing "declared hard limit we cannot enforce" pattern in
   * runner.ts) and fails closed the same way — never a permissive skip. */
  private async preflightSecretRefs(refs: SecretRef[]): Promise<void> {
    if (!this.secretManager) {
      throw new PolicyEnforcementError(
        "RunPolicy declares secretMode: vault-autofill but this JourneyRunner has no SecretManagerPort wired up — refusing to run (fail-closed)",
      );
    }
    for (const ref of refs) {
      await this.secretManager.assertResolvable(ref); // throws SecretUnresolvableError, never a silent skip
    }
  }
```

(The `InterpretResult` import added above is not used until Task 8 — it is imported now so Task 8's diff to this file is smaller; if your TypeScript setup errors on an unused import, it is safe to defer that one import line to Task 8's Step instead. Prefer adding it now for a cleaner history, since `noUnusedLocals`/`noUnusedParameters` are not enabled in `tsconfig.base.json` — verify with `grep noUnused tsconfig.base.json` returning nothing before relying on this.)

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm exec vitest run packages/runtime/src/vault-autofill.test.ts`
Expected: PASS (3 tests)

- [ ] **Step 6: Run the full existing runtime suite to confirm no regression (backward compatibility)**

Run: `pnpm exec vitest run packages/runtime/src`
Expected: PASS — in particular `journey-runner.test.ts`'s existing 2-arg/3-arg `new JourneyRunner(...)` call sites must still pass unmodified, proving the constructor extension is backward-compatible.

- [ ] **Step 7: Commit**

```bash
git add packages/runtime/package.json packages/runtime/tsconfig.json \
  packages/runtime/src/journey-runner.ts packages/runtime/src/vault-autofill.test.ts \
  pnpm-lock.yaml
git commit -m "$(cat <<'EOF'
feat(runtime): wire @doit/secrets + JourneyRunner vault-autofill preflight (invariant #4)

Adds an optional 4th constructor parameter (SecretManagerPort) — every
existing call site keeps compiling unchanged.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

### Task 8: `JourneyRunner` vault-autofill fill branch (invariants #2/#3)

**Files:**
- Modify: `packages/runtime/src/journey-runner.ts`
- Modify: `packages/runtime/src/vault-autofill.test.ts`

**Interfaces:**
- Consumes: everything from Task 7, plus `SecretOriginMismatchError`, `assertOriginBound` (from `@doit/secrets`); `Enter`, `BrowseTheWebToken` (from `@doit/screenplay`); `descriptorToTarget` (from `@doit/interpreter`)
- Produces: no new public surface — this fills in the body of the `awaiting_human` loop for `secretMode === "vault-autofill"`.

- [ ] **Step 1: Write the failing tests**

Append to `packages/runtime/src/vault-autofill.test.ts` (new `describe` block):
```ts
import { SecretOriginMismatchError } from "@doit/secrets"; // add to the existing import line at the top instead of a second import statement
```
(Edit the existing `import { StubSecretManager, SecretUnresolvableError } from "@doit/secrets";` line to read `import { StubSecretManager, SecretUnresolvableError, SecretOriginMismatchError } from "@doit/secrets";` instead of adding a second import line.)

```ts
describe("JourneyRunner — vault-autofill fill", () => {
  it("fetches the secret via the SecretManagerPort and types it into the recorded field, then resumes", async () => {
    const locator = fakeLocator();
    const page = fakePage(locator, "https://mail.example.test/login");
    const actor = actorWithPage(page);
    const interp = fakeInterpreter(handback);
    const manager = new StubSecretManager({ "login-password": "hunter2" });
    const runner = new JourneyRunner(actor, interp, undefined, manager);

    const result = await runner.run({ journey: journeyWithSecret([ref]), params: {}, policy: vaultPolicy });

    expect(result).toEqual({ outcome: "ok", output: {} });
    expect(locator.fill).toHaveBeenCalledWith("hunter2");
    expect(interp.resumeFrom).toHaveBeenCalledWith(actor, expect.anything(), 1, {});
  });

  it("never puts the secret plaintext into the JourneyRunResult (JSON round-trips clean)", async () => {
    const locator = fakeLocator();
    const page = fakePage(locator, "https://mail.example.test/login");
    const actor = actorWithPage(page);
    const interp = fakeInterpreter(handback);
    const manager = new StubSecretManager({ "login-password": "hunter2" });
    const runner = new JourneyRunner(actor, interp, undefined, manager);

    const result = await runner.run({ journey: journeyWithSecret([ref]), params: {}, policy: vaultPolicy });

    const serialized = JSON.stringify(result); // must not throw — would, if a raw Secret object had leaked in
    expect(serialized).not.toContain("hunter2");
  });

  it("§9a invariant #3: no declared secretRef matches the current page's origin — throws SecretOriginMismatchError and never fills", async () => {
    const locator = fakeLocator();
    const page = fakePage(locator, "https://evil.example.test/login");
    const actor = actorWithPage(page);
    const interp = fakeInterpreter(handback);
    const manager = new StubSecretManager({ "login-password": "hunter2" });
    const runner = new JourneyRunner(actor, interp, undefined, manager);

    await expect(
      runner.run({ journey: journeyWithSecret([ref]), params: {}, policy: vaultPolicy }),
    ).rejects.toBeInstanceOf(SecretOriginMismatchError);
    expect(locator.fill).not.toHaveBeenCalled();
  });

  it("a handback resume that isn't a 'visible' target assertion cannot be auto-filled — quarantines rather than guessing", async () => {
    const actor = actorWithPage(fakePage(fakeLocator(), "https://mail.example.test/login"));
    const interp = fakeInterpreter({ ...handback, resume: { kind: "urlIncludes", text: "/home" } });
    const manager = new StubSecretManager({ "login-password": "hunter2" });
    const runner = new JourneyRunner(actor, interp, undefined, manager);

    const result = await runner.run({ journey: journeyWithSecret([ref]), params: {}, policy: vaultPolicy });
    expect(result).toMatchObject({ outcome: "quarantined", at: 0 });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm exec vitest run packages/runtime/src/vault-autofill.test.ts`
Expected: FAIL — the `awaiting_human` loop currently only knows the `visible-handback` branch, so under `vault-autofill` it falls through to the existing `if (secretMode !== "visible-handback" || !this.handback)` guard and returns `{outcome:"quarantined", reason:"secret step reached under fail-closed/unattended secretMode"}` instead of filling — the first two new tests will fail their `toEqual`/`toHaveBeenCalledWith` assertions.

- [ ] **Step 3: Implement the fill branch**

In `packages/runtime/src/journey-runner.ts`, update the imports (merging into the existing lines from Task 7):
```ts
import type { Actor } from "@doit/screenplay";
import { BrowseTheWebToken, Enter } from "@doit/screenplay";
import type { RunPolicy } from "@doit/domain";
import { deriveParamSchema, validateParams, type Journey, type SecretRef } from "@doit/journey";
import { RecordingInterpreter, checkAssertion, descriptorToTarget, type InterpretResult } from "@doit/interpreter";
import { SecretOriginMismatchError, assertOriginBound, type SecretManagerPort } from "@doit/secrets";
import { PolicyEnforcementError } from "./runner.js";
```

Replace the `while (result.outcome === "awaiting_human")` loop body in `run()` with:
```ts
    while (result.outcome === "awaiting_human") {
      if (req.policy.secret.secretMode === "vault-autofill") {
        const refusal = await this.fillViaVaultAutofill(req, result);
        if (refusal) return refusal; // quarantined — bail out, never assume success
        result = await this.interpreter.resumeFrom(this.actor, req.journey.recording, result.at + 1, req.params);
        continue;
      }

      // #7: a handback (secret) step. Only proceed if policy explicitly
      // opts into a visible handback AND a handler is wired up; otherwise
      // fail closed — never assume a human will show up.
      if (req.policy.secret.secretMode !== "visible-handback" || !this.handback) {
        return {
          outcome: "quarantined",
          reason: "secret step reached under fail-closed/unattended secretMode",
          at: result.at,
        };
      }
      await this.handback.present(result.prompt); // human enters the secret in the headed browser; we never hold it
      const ok = await checkAssertion(this.actor, result.resume); // verify BEFORE resuming — never assume-success
      if (!ok) {
        return {
          outcome: "quarantined",
          reason: `handback resume postcondition not satisfied at step ${result.at}`,
          at: result.at,
        };
      }
      result = await this.interpreter.resumeFrom(this.actor, req.journey.recording, result.at + 1, req.params);
      // loop: a resumed run may hit another handback.
    }
```

Add the new private method, right after `preflightSecretRefs`:
```ts
  /**
   * §9a invariants #2/#3: fetches the secret ONLY at the moment of fill,
   * types it directly into the recorded field via the actor, and holds the
   * plaintext in nothing but this method's own local bindings — never in
   * `JourneyRunResult`, never logged, never passed to `resumeFrom`'s
   * `params`. Returns a `{outcome:"quarantined",...}` result when it
   * refuses to fill for a reason that is not itself a hard invariant
   * breach (only `SecretOriginMismatchError` — thrown, not returned — is
   * that); returns `undefined` on a successful fill so the caller's loop
   * proceeds to `resumeFrom`.
   *
   * RULING (Slice 1b scope): vault-autofill can only locate the field to
   * type into when the handback step's `resume` assertion is
   * `{kind:"visible", target}` — exactly what the recorder emits for a
   * real secret field (see `packages/recorder/src/assemble.ts`'s
   * `buildStep`: `resume: visible(resolution.descriptor)`). Any other
   * `resume` shape reaching here has no field to fill programmatically, so
   * it fails closed rather than guessing.
   *
   * RULING (Slice 1b scope): exactly one declared `SecretRef` must match
   * the current page's origin. Zero matches (origin mismatch) or more than
   * one match (ambiguous — e.g. separate username/password refs on the
   * same origin) both fail closed via `SecretOriginMismatchError`;
   * disambiguating multiple same-origin secrets by field is out of scope
   * for this thin slice.
   */
  private async fillViaVaultAutofill(
    req: JourneyRunRequest,
    result: Extract<InterpretResult, { outcome: "awaiting_human" }>,
  ): Promise<JourneyRunResult | undefined> {
    if (result.resume.kind !== "visible") {
      return {
        outcome: "quarantined",
        reason: `vault-autofill: handback resume is not a "visible" target assertion at step ${result.at} — cannot locate a field to fill`,
        at: result.at,
      };
    }

    const page = this.actor.ability(BrowseTheWebToken).session.page;
    const currentUrl = page.url();
    const refs = req.journey.metadata.secretRefs ?? [];
    const matching = refs.filter((ref) => {
      try {
        assertOriginBound(ref, currentUrl);
        return true;
      } catch {
        return false;
      }
    });
    if (matching.length !== 1) {
      throw new SecretOriginMismatchError(
        `vault-autofill: expected exactly one declared secretRef bound to the current origin (${currentUrl}), found ${matching.length}`,
      );
    }
    const ref = matching[0];

    const fieldVisible = await checkAssertion(this.actor, result.resume);
    if (!fieldVisible) {
      return {
        outcome: "quarantined",
        reason: `vault-autofill: expected credential field not visible before fill at step ${result.at}`,
        at: result.at,
      };
    }

    const secret = await this.secretManager!.fetch(ref); // preflight already proved this resolves
    const target = descriptorToTarget(result.resume.target);
    await Enter.theText(secret.reveal()).into(target).performAs(this.actor);
    return undefined;
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm exec vitest run packages/runtime/src/vault-autofill.test.ts`
Expected: PASS (7 tests total — 3 from Task 7 + 4 new)

- [ ] **Step 5: Run the full existing runtime suite to confirm no regression**

Run: `pnpm exec vitest run packages/runtime/src`
Expected: PASS — `journey-runner.test.ts`, `journey-login-e2e.test.ts` (real-browser, may be slow), and `slice1-invariants.test.ts` all still pass unmodified.

- [ ] **Step 6: Commit**

```bash
git add packages/runtime/src/journey-runner.ts packages/runtime/src/vault-autofill.test.ts
git commit -m "$(cat <<'EOF'
feat(runtime): JourneyRunner vault-autofill fill branch (invariants #2/#3)

Fetches on demand, verifies origin+field binding before every fill, types
directly into the live page, and never lets the plaintext reach
JourneyRunResult, a log, or a resumed step's params.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

### Task 9: Slice 1b §9a invariant refusal contract

**Files:**
- Create: `packages/runtime/src/slice1b-invariants.test.ts`

**Interfaces:**
- Consumes: `JourneyRunner`, `PolicyEnforcementError` (from `./index.js`); `safeRunPolicy` (from `@doit/domain`); `StubSecretManager`, `SecretOriginMismatchError`, `SecretUnresolvableError`, `Secret` (from `@doit/secrets`)
- Produces: no new production code — mirrors `slice1-invariants.test.ts`'s role as "one readable place a reviewer can read to see every invariant refuse," re-using the same fixtures/fakes already proven in Tasks 7–8 (per that file's own convention, fixtures are re-declared locally rather than imported from another test file).

- [ ] **Step 1: Write the test file**

`packages/runtime/src/slice1b-invariants.test.ts`:
```ts
import { describe, it, expect, vi } from "vitest";
import { CastActor, BrowseTheWeb } from "@doit/screenplay";
import { safeRunPolicy } from "@doit/domain";
import { StubSecretManager, SecretOriginMismatchError, SecretUnresolvableError, Secret } from "@doit/secrets";
import { JourneyRunner, PolicyEnforcementError } from "./index.js";

/**
 * Slice 1b §9a — invariant refusal contract for the secret-VALUE
 * invariants (#2–#4), which Slice 1's visible-handback path never
 * exercised (the runner never held a value there). Adds NO new production
 * logic — re-uses the same fakes/fixtures as `vault-autofill.test.ts`. That
 * file remains the source of truth for exhaustive cases; this file exists
 * so a reviewer can read one place and see invariants #2, #3, and #4 all
 * refuse, plus Hard Floor #6 ("nothing stored at rest", covered by
 * `packages/secrets/src/no-persistence.test.ts`).
 */

function fakeLocator() {
  return { fill: vi.fn(async () => {}), isVisible: vi.fn(async () => true) };
}
function fakePage(locator: ReturnType<typeof fakeLocator>, url: string) {
  return {
    url: vi.fn(() => url),
    getByTestId: vi.fn(() => locator),
    getByRole: vi.fn(() => locator),
    getByLabel: vi.fn(() => locator),
    getByText: vi.fn(() => locator),
    locator: vi.fn(() => locator),
  };
}
function actorWithPage(page: any) {
  return CastActor.named("test").whoCan(
    new BrowseTheWeb({ page, startTracing: vi.fn(), stopTracingToFile: vi.fn(), close: vi.fn() } as any, []),
  );
}
function fakeInterpreter(handbackResult: any) {
  return {
    run: vi.fn().mockResolvedValue(handbackResult),
    resumeFrom: vi.fn().mockResolvedValue({ outcome: "completed", vars: {} }),
  } as any;
}
const journeyWithSecret = (secretRefs: any[]) =>
  ({
    metadata: { id: "j", name: "j", promoted: true, params: [], secretRefs, createdAtIso: "x" },
    recording: { version: "1", site: "s", pages: [] },
  }) as any;

const ref = { manager: "stub", key: "login-password", origin: "https://mail.example.test", field: "password" };
const vaultPolicy = { ...safeRunPolicy(), secret: { secretMode: "vault-autofill" as const } };
const handback = {
  outcome: "awaiting_human",
  at: 0,
  prompt: "please enter your password",
  resume: { kind: "visible", target: { label: "Password" } },
};

describe("Slice 1b §9a — invariant refusal contract", () => {
  it("#2 Secret never serialized: toString()/JSON.stringify()/util.inspect() all throw", async () => {
    const { inspect } = await import("node:util");
    const secret = new Secret("hunter2");
    expect(() => `${secret}`).toThrow();
    expect(() => JSON.stringify(secret)).toThrow();
    expect(() => inspect(secret)).toThrow();
  });

  it("#3 origin mismatch: JourneyRunner.run rejects with SecretOriginMismatchError and never fills", async () => {
    const locator = fakeLocator();
    const actor = actorWithPage(fakePage(locator, "https://evil.example.test/login"));
    const interp = fakeInterpreter(handback);
    const manager = new StubSecretManager({ "login-password": "hunter2" });
    const runner = new JourneyRunner(actor, interp, undefined, manager);

    await expect(
      runner.run({ journey: journeyWithSecret([ref]), params: {}, policy: vaultPolicy }),
    ).rejects.toBeInstanceOf(SecretOriginMismatchError);
    expect(locator.fill).not.toHaveBeenCalled();
  });

  it("#4 unresolvable secret: JourneyRunner.run rejects with SecretUnresolvableError BEFORE any step runs", async () => {
    const actor = actorWithPage(fakePage(fakeLocator(), "https://mail.example.test/login"));
    const interp = fakeInterpreter(handback);
    const manager = new StubSecretManager({});
    const runner = new JourneyRunner(actor, interp, undefined, manager);

    await expect(
      runner.run({ journey: journeyWithSecret([ref]), params: {}, policy: vaultPolicy }),
    ).rejects.toBeInstanceOf(SecretUnresolvableError);
    expect(interp.run).not.toHaveBeenCalled();
  });

  it("missing SecretManagerPort under vault-autofill fails closed (PolicyEnforcementError) — never a permissive skip", async () => {
    const actor = actorWithPage(fakePage(fakeLocator(), "https://mail.example.test/login"));
    const interp = fakeInterpreter(handback);
    const runner = new JourneyRunner(actor, interp); // no secretManager

    await expect(
      runner.run({ journey: journeyWithSecret([ref]), params: {}, policy: vaultPolicy }),
    ).rejects.toBeInstanceOf(PolicyEnforcementError);
    expect(interp.run).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run the test to verify it passes**

Run: `pnpm exec vitest run packages/runtime/src/slice1b-invariants.test.ts`
Expected: PASS (4 tests) — this is a **consolidation** file (all four assertions already hold from Tasks 1–8), so there is no red phase; running it is the verification step.

- [ ] **Step 3: Commit**

```bash
git add packages/runtime/src/slice1b-invariants.test.ts
git commit -m "$(cat <<'EOF'
test: Slice 1b §9a invariant refusal contract (secret-value invariants #2-#4)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

### Task 10: Exit gate

**Files:** none created/modified — verification only.

- [ ] **Step 1: Run the permissive-fallback exit gate over the whole repo (including the new `@doit/secrets` package)**

Run: `node scripts/check-no-permissive-fallback.mjs`
Expected: `check-no-permissive-fallback: OK (<N> file(s) scanned, 0 hits)` — confirms none of the new `packages/secrets/src/**` or `packages/runtime/src/journey-runner.ts` code introduced a `catch { return {outcome:"ok"} }`, a `secretMode ?? {...}`-style permissive default, or an inline-steps `run_journey`/`runJourney` shape. Pay particular attention to `this.secretManager!.fetch(ref)` in `fillViaVaultAutofill` — the non-null assertion operator (`!`) is not a permissive fallback pattern the script matches, but visually re-confirm by reading the surrounding preflight logic that it can only execute once `preflightSecretRefs` has already proven `this.secretManager` is defined.

- [ ] **Step 2: Run the full workspace test suite**

Run: `pnpm exec vitest run`
Expected: every existing suite plus all new Slice 1b tests pass (0 failures). This includes the (slow, real-browser) `packages/runtime/src/journey-login-e2e.test.ts`.

- [ ] **Step 3: Typecheck the whole workspace via project references**

Run: `pnpm -w exec tsc --build`
Expected: clean build, no errors — confirms `@doit/secrets`'s new `tsconfig.json` reference and `@doit/runtime`'s updated reference/dependency are wired correctly end-to-end, and that `JourneyRunner`'s extended constructor type-checks against every existing call site in the workspace (in particular `packages/runtime/src/journey-login-e2e.test.ts`'s `new JourneyRunner(actor, new RecordingInterpreter(), handbackHandler)` 3-arg call).

- [ ] **Step 4: Manually re-confirm backward compatibility for the concurrent load-harness slice**

Run: `grep -rn "new JourneyRunner(" packages apps site-integrations --include=*.ts`
Expected: every call site found has 2 or 3 positional arguments (`actor, interpreter[, handback]`) and none needs modification — proving the 4th, optional `secretManager` parameter added in Task 7 is purely additive for any consumer (including a sibling load-harness slice) that only reads `JourneyRunner`'s existing public API.

- [ ] **Step 5: Record completion (no commit — this task makes no file changes)**

If Steps 1–4 all pass, Slice 1b is complete: `secretMode: "vault-autofill"` is implemented, origin-bound, fetch-on-demand, nothing stored at rest, with a passing "asserts-it-refuses" test for each of §9a invariants #2, #3, and #4, and `JourneyRunner`'s public signature remains backward-compatible.

---

## Self-Review

**1. Spec coverage:**
- Hard Floor #6 (secret invariant, §9): external-manager-only path → `SecretManagerPort`/`CliSecretManager`/`StubSecretManager` (Tasks 3–4); never in a model prompt/log → `Secret`'s throw-on-serialize (Task 1) + the no-plaintext-leak test (Task 8); origin-bound → `assertOriginBound`/`SecretOriginMismatchError` (Task 2, wired in Task 8); nothing stored at rest → `no-persistence.test.ts` (Task 5) plus every adapter's per-call (never cached) `fetch`.
- §9a invariant #2 (never serialized) → Task 1 (`Secret` class) + Task 9's consolidated test.
- §9a invariant #3 (origin mismatch → refuse) → Task 2 (guard) + Task 8 (wired into the fill branch) + Task 9's consolidated test.
- §9a invariant #4 (unresolvable → fail-fast at preflight) → Task 3 (`assertResolvable` contract) + Task 7 (`preflightSecretRefs`, called before any step) + Task 9's consolidated test.
- Roadmap row 1b's "fetch-on-demand, origin-bound, nothing stored" → covered end-to-end by Tasks 1–8; the full-flow success test in Task 8 (fetch → type → resume) demonstrates the complete path.
- `RunPolicy`/`safeRunPolicy()` non-breaking → Task 6 (confirming test + doc comment, no structural change).
- `JourneyRunner` public signature backward compatibility (orthogonality requirement, not the spec itself, but load-bearing for the sibling slice) → Task 7 (additive optional 4th param) + Task 10 Step 4 (grep-verified across the whole workspace).
- Not in scope for 1b per the roadmap (correctly excluded): invariant #8 (Slice 6), #9–#10 (Slice 2), any model/Jev-directed behavior (Slice 3+).

**2. Placeholder scan:** No `TBD`/`TODO`/"add appropriate error handling" strings anywhere in the tasks above; every step that touches code includes the exact, complete source, not a description of it. The one place that could look like a placeholder — Task 7 Step 4's parenthetical about the `InterpretResult` import — is a real, load-bearing instruction (what to do if your TS config disagrees), not a stand-in for missing content.

**3. Type consistency:**
- `SecretRef` is used identically everywhere: `{manager, key, origin, field}`, defined once in `packages/secrets/src/secret-ref.ts` (Task 1) and consumed structurally (never imported) by `journey-runner.ts`'s `SecretRef` (imported from `@doit/journey`, itself already identical) — verified in Tasks 7–8's exact import lines.
- `SecretManagerPort.assertResolvable`/`.fetch` signatures are defined once (Task 3) and implemented identically by `StubSecretManager` (Task 3) and `CliSecretManager` (Task 4); `JourneyRunner`'s `preflightSecretRefs`/`fillViaVaultAutofill` (Tasks 7–8) call exactly those two method names with exactly those argument shapes — no drift (e.g. no `resolve()` vs `fetch()` naming mismatch across tasks).
- `JourneyRunner`'s constructor parameter list is stated identically in Task 7's "Produces" line and Task 7 Step 4's code — `(actor, interpreter, handback?, secretManager?)` — and never changes again in Task 8 (Task 8 only edits the loop body and adds a private method).
- `JourneyRunResult`'s two variants (`{outcome:"ok",...}` / `{outcome:"quarantined",...}`) are never given a third shape by `fillViaVaultAutofill` — it returns exactly `JourneyRunResult | undefined`, matching the existing type exported from this file.
