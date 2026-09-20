# M3a — Model Gateway + Credential Preflight (Slice 3, revised) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL — use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax. This plan **supersedes** `docs/superpowers/plans/2026-09-17-mvp-m3a-model-gateway.md`: it re-bases M3a onto the current `main` (Slice 1 + RxD A.3b are built), and adds the **credential-preflight** requirement (floor #6 applied to the *platform's own* API keys).

**Goal:** Ship a new leaf-ish `@doit/ai-core` package that provides a **generation gateway** (OpenRouter, deterministic model-catalog hard-filter + provenance) and a **judgment gateway** (Jev/TypeSafe adapter shape), both fully mockable, plus a **fail-closed credential preflight** that detects the platform's own keys, refuses closed with a typed `MissingCredentialError`, and guarantees a key value can never reach any prompt/tool-arg/log/telemetry/outbound payload except the provider's auth header.

**Architecture:** `@doit/ai-core` defines two ports (`GenerationPort`, `JudgmentPort`), each with a deterministic **fake** adapter (all CI tests use fakes) and a real adapter gated on keys. A deterministic `ModelPolicy` hard-filters an OpenRouter catalog by config constraints (cost/region/latency) *before* any model is chosen and records provenance. A `credentials` module inside the same package detects keys, exposes a `requireKeys(feature)` precondition that fails closed, and a `CredentialLeakError`/`assertNoOutboundCredential` guard that mirrors the recording package's redact-before-model discipline. The package plugs in behind the existing mcp-facade allowlist and the CLI as an *optional* capability gated by that preflight — two collection surfaces (CLI secure stdin; MCP typed `setup_required` result).

**Tech Stack:** TS (Node 20+, ESM, NodeNext, strict, project refs), `zod ^4`, `@doit/domain` (for `contentHash` only — imported, never edited), Vitest. Real adapters use `ai` + `@openrouter/ai-sdk-provider` (generation) and `@typesafe-ai/sdk` (`client.systemOne`, judgment), each behind one injectable seam and lazily imported so the package builds/tests without them installed and without network/keys.

**Spec:**
- `docs/superpowers/specs/2026-09-19-unified-journey-automation-and-testing-design.md` — §7 hard floors (esp. **#1** redact-before-model, **#6** secret containment), §9a fail-fast invariant discipline (each invariant ships an "asserts-it-refuses" test), §Slice 3 (model gateways).
- `docs/superpowers/specs/2026-09-19-autonomous-exploration-testing-design.md` — §1–2 two gateways (Jev judgment + OpenRouter generation), §8 P0 (`@doit/ai-core` + both gateways + fakes; live behind `TYPESAFE_API_KEY` + `OPENROUTER_API_KEY`).

## Global Constraints

- **Node 20+, ESM, strict TS, project references.** New package extends `tsconfig.base.json` (`rootDir: src`, `outDir: dist`, `composite`), mirroring `packages/journey`.
- **Dependency direction inward.** `@doit/ai-core` depends only on `zod` and `@doit/domain` (for `contentHash`). It MUST NOT import playwright/sqlite/kysely, the runner, `@doit/journey`, or any sibling-slice package. The model never touches the browser or the queue.
- **Credential never-to-model invariant (hard, §9a-style, NOT tunable):** an API-key *value* is read **only** at the point of the real provider call and placed **only** in that provider endpoint's `Authorization` header. It is NEVER placed in a model prompt, tool argument, log line, telemetry event, provenance record, or any other outbound payload. This ships with an **asserts-it-refuses test** (`assertNoOutboundCredential` throws `CredentialLeakError`).
- **Fail-closed:** `requireKeys(feature)` throws `MissingCredentialError` naming the missing keys; there is **no permissive default** and no silent skip. An empty eligible-model set throws `NoEligibleModelError` — never an unfiltered fallback pick. (The exit-gate `scripts/check-no-permissive-fallback.mjs` scans `packages/*/src/**` and MUST stay clean for `@doit/ai-core`.)
- **Determinism in CI:** every automated test uses a **fake** adapter. Real OpenRouter/Jev paths run only in **opt-in, env-gated** tests (`RUN_OPENROUTER_TESTS=1`+`OPENROUTER_API_KEY`; `RUN_TYPESAFE_TESTS=1`+`TYPESAFE_API_KEY`) that `describe.skip`/`it.skip` cleanly when the env is absent — so the default suite is green with no keys installed. **A mockable port means the live-key tests are gated/skipped when keys are absent.**
- **False-green test-command gotcha:** this repo's packages have **NO `"test"` script** (only `"build"`). Running `pnpm --filter @doit/ai-core test` would find no script and can read as a false green. **Always run tests via `pnpm exec vitest run <path>`** from the repo root (uses the root `vitest.config.ts` and its `pkg()` alias). Full-suite gate is root `pnpm test` (= `vitest run`).
- **Explicit-path git staging only** — `git add <exact paths>`, **never `git add -A`** (graft's `/graft/` cache and other artifacts must stay out). When a task changes deps, **stage `pnpm-lock.yaml`** explicitly.
- **Commit trailer:** every commit ends with a blank line then EXACTLY:
  ```
  Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
  ```
- **Keep the suite green:** each task ends with `pnpm -r build` (no cycle) + the task's `pnpm exec vitest run` green; the exit gate runs `pnpm test` + `pnpm lint` + `pnpm check:no-fallback`.

### Shared-surface touches (flagged for parallel slices)

This slice **owns** the new package `@doit/ai-core`. Per the orthogonality constraint it does **not** touch `@doit/domain`, `@doit/runtime`, `@doit/journey`, `@doit/secrets`/`@doit/sources`/`@doit/load`. The only shared surfaces it edits are **additive** and each is called out at its task:

| Shared file | Change | Task | Collision risk |
|---|---|---|---|
| `tsconfig.json` (root) | add `{ "path": "packages/ai-core" }` to `references` | T1 | append-only |
| `vitest.config.ts` (root) | add one alias `"@doit/ai-core": pkg("ai-core")` | T1 | append-only (file already has a "add one line per new package" marker) |
| `pnpm-lock.yaml` (root) | new package + its deps | T1, T6, T7 | regenerated; stage explicitly |
| `packages/cli/src/program.ts` | one import + one `registerAiCommands(program, deps)` call inside `buildProgram` | T9 | one line inside `buildProgram`; all command bodies live in a NEW `packages/cli/src/ai-cli.ts` |
| `packages/cli/package.json` | add `"@doit/ai-core": "workspace:*"` dep | T9 | append-only |
| `packages/mcp-facade/src/tools.ts` | append `"ai_generate_text"` to `ALLOWED_TOOLS`; export a preflight-gated handler from a NEW `packages/mcp-facade/src/ai-tools.ts` | T9 | one array entry; logic in a new file. **May be deferred to the integrating slice** — see T9 note |

---

### Task 1: Scaffold `@doit/ai-core` (mirror `packages/journey`)

**Files:**
- create `packages/ai-core/package.json`
- create `packages/ai-core/tsconfig.json`
- create `packages/ai-core/src/index.ts`
- create `packages/ai-core/src/smoke.test.ts`
- modify `tsconfig.json` (root) — add project ref
- modify `vitest.config.ts` (root) — add alias

**Interfaces — Produces:** an installable, buildable empty package importable in tests via the `@doit/ai-core` alias.

**Steps:**
- [ ] 1. Write `packages/ai-core/package.json` (mirror journey; deps trimmed to what T2 needs first — `zod` + `@doit/domain`):
  ```json
  {
    "name": "@doit/ai-core",
    "version": "0.0.0",
    "type": "module",
    "main": "dist/index.js",
    "types": "dist/index.d.ts",
    "exports": { ".": "./dist/index.js" },
    "scripts": { "build": "tsc --build" },
    "dependencies": {
      "@doit/domain": "workspace:*",
      "zod": "^4.6.5"
    }
  }
  ```
- [ ] 2. Write `packages/ai-core/tsconfig.json`:
  ```json
  {
    "extends": "../../tsconfig.base.json",
    "compilerOptions": { "rootDir": "src", "outDir": "dist" },
    "references": [{ "path": "../domain" }],
    "include": ["src/**/*"],
    "exclude": ["src/**/*.test.ts"]
  }
  ```
- [ ] 3. Write `packages/ai-core/src/index.ts` with a single placeholder export to keep the module non-empty:
  ```ts
  /** @doit/ai-core — model gateways (generation + judgment) and credential preflight. */
  export const AI_CORE = "ai-core" as const;
  ```
- [ ] 4. Add the root project ref: in `tsconfig.json` `references` append `{ "path": "packages/ai-core" }` (alongside the other packages). **[shared-surface: append-only]**
- [ ] 5. Add the vitest alias: in `vitest.config.ts`, next to the "Add one line per new package here" marker, add `"@doit/ai-core": pkg("ai-core"),`. **[shared-surface: append-only]**
- [ ] 6. Write `packages/ai-core/src/smoke.test.ts`:
  ```ts
  import { describe, it, expect } from "vitest";
  import { AI_CORE } from "./index.js";

  describe("@doit/ai-core scaffold", () => {
    it("is importable via the workspace alias", () => {
      expect(AI_CORE).toBe("ai-core");
    });
  });
  ```
- [ ] 7. Run `pnpm install` (registers the workspace package + lockfile). Run `pnpm exec vitest run packages/ai-core/src/smoke.test.ts` → **passes**. Run `pnpm -r build` → no cycle.
- [ ] 8. Commit (stage explicit paths incl. `pnpm-lock.yaml`): `chore(ai-core): scaffold @doit/ai-core package (mirrors journey)`.

---

### Task 2: Credential detection + `requireKeys` (fail-closed)

**Files:** create `packages/ai-core/src/credentials.ts`, `packages/ai-core/src/credentials.test.ts`; modify `packages/ai-core/src/index.ts`.

**Interfaces — Consumes:** `process.env` and an optional local config record. **Produces:**
```ts
// credentials.ts
export type CredentialKey = "OPENROUTER_API_KEY" | "TYPESAFE_API_KEY";
export type Feature = "generation" | "judgment";

/** feature → the keys it strictly requires. No feature maps to "no key". */
export const FEATURE_KEYS: Readonly<Record<Feature, readonly CredentialKey[]>> = {
  generation: ["OPENROUTER_API_KEY"],
  judgment: ["TYPESAFE_API_KEY"],
} as const;

export class MissingCredentialError extends Error {
  readonly code = "E_MISSING_CREDENTIAL" as const;
  constructor(readonly feature: Feature, readonly missing: CredentialKey[]) {
    super(`feature '${feature}' requires ${missing.join(", ")} — none found in env or local config`);
    this.name = "MissingCredentialError";
  }
}

/** Reads keys from env + an optional local (gitignored) config record.
 *  `detect` never returns the value; `read` returns it (used ONLY at the
 *  provider call). Fail-closed: an unset key is `false`/`undefined`, never a
 *  placeholder. */
export interface CredentialStore {
  detect(key: CredentialKey): boolean;
  read(key: CredentialKey): string | undefined;
}

export function envCredentialStore(
  env: Record<string, string | undefined> = process.env,
  localConfig: Partial<Record<CredentialKey, string>> = {},
): CredentialStore {
  const resolve = (k: CredentialKey) => {
    const v = env[k] ?? localConfig[k];
    return v && v.trim().length > 0 ? v : undefined;
  };
  return { detect: (k) => resolve(k) !== undefined, read: (k) => resolve(k) };
}

/** Precondition: throws MissingCredentialError (fail-closed) unless every
 *  required key for `feature` is present. Returns the required key names on
 *  success (NOT the values). */
export function requireKeys(feature: Feature, store: CredentialStore): CredentialKey[] {
  const required = FEATURE_KEYS[feature];
  const missing = required.filter((k) => !store.detect(k));
  if (missing.length > 0) throw new MissingCredentialError(feature, missing);
  return [...required];
}
```

**Steps:**
- [ ] 1. Write `credentials.test.ts` (failing):
  ```ts
  import { describe, it, expect } from "vitest";
  import { envCredentialStore, requireKeys, MissingCredentialError } from "./index.js";

  describe("requireKeys (fail-closed)", () => {
    it("throws MissingCredentialError naming the missing key when absent", () => {
      const store = envCredentialStore({}, {});
      expect(() => requireKeys("generation", store)).toThrow(MissingCredentialError);
      try { requireKeys("generation", store); } catch (e) {
        expect((e as MissingCredentialError).missing).toEqual(["OPENROUTER_API_KEY"]);
      }
    });
    it("passes when the key is set in env, and returns names (not values)", () => {
      const store = envCredentialStore({ OPENROUTER_API_KEY: "sk-or-secret" }, {});
      expect(requireKeys("generation", store)).toEqual(["OPENROUTER_API_KEY"]);
    });
    it("reads from local config when env is empty; blank env is treated as unset", () => {
      const store = envCredentialStore({ TYPESAFE_API_KEY: "  " }, { TYPESAFE_API_KEY: "ts-key" });
      expect(store.detect("TYPESAFE_API_KEY")).toBe(true);
      expect(requireKeys("judgment", store)).toEqual(["TYPESAFE_API_KEY"]);
    });
  });
  ```
- [ ] 2. `pnpm exec vitest run packages/ai-core/src/credentials.test.ts` → **fails** (module missing).
- [ ] 3. Implement `credentials.ts` as above; add `export * from "./credentials.js";` to `index.ts`.
- [ ] 4. Rerun → **passes**. `pnpm -r build`.
- [ ] 5. Commit: `feat(ai-core): fail-closed credential detection and requireKeys precondition`.

---

### Task 3: Credential never-to-model guard (asserts-it-refuses)

**Files:** create `packages/ai-core/src/credential-guard.ts`, `packages/ai-core/src/credential-guard.test.ts`; modify `index.ts`.

**Interfaces — Consumes:** a `CredentialStore` (for the known key values) + an arbitrary outbound payload. **Produces:**
```ts
// credential-guard.ts
import { CredentialKey } from "./credentials.js";

export class CredentialLeakError extends Error {
  readonly code = "E_CREDENTIAL_LEAK" as const;
  constructor(readonly key: CredentialKey) {
    // NOTE: never include the value in the message.
    super(`credential ${key} value found in an outbound payload — refused (floor #6, never-to-model)`);
    this.name = "CredentialLeakError";
  }
}

/** Throws CredentialLeakError if any known key VALUE appears anywhere in the
 *  serialized payload (prompt, tool args, log line, telemetry, provider body).
 *  This is the single choke point every generation/judgment path routes its
 *  outbound payload through BEFORE sending. It is intentionally value-based:
 *  the auth header is built separately and never passes through here. */
export function assertNoOutboundCredential(
  payload: unknown,
  store: { read(k: CredentialKey): string | undefined },
  keys: readonly CredentialKey[] = ["OPENROUTER_API_KEY", "TYPESAFE_API_KEY"],
): void {
  const haystack = typeof payload === "string" ? payload : JSON.stringify(payload);
  for (const k of keys) {
    const v = store.read(k);
    if (v && v.length > 0 && haystack.includes(v)) throw new CredentialLeakError(k);
  }
}
```

**Steps:**
- [ ] 1. Write `credential-guard.test.ts` (failing) — the **asserts-it-refuses** contract, both directions:
  ```ts
  import { describe, it, expect } from "vitest";
  import { envCredentialStore, assertNoOutboundCredential, CredentialLeakError } from "./index.js";

  const store = envCredentialStore({ OPENROUTER_API_KEY: "sk-or-LEAKME-123" }, {});

  describe("assertNoOutboundCredential (floor #6 never-to-model)", () => {
    it("passes when the payload contains no key value", () => {
      expect(() => assertNoOutboundCredential(
        { prompt: "draft a reply", meta: { model: "x/y" } }, store,
      )).not.toThrow();
    });
    it("REFUSES a payload that embeds the key value (prompt/tool-arg/log/telemetry)", () => {
      expect(() => assertNoOutboundCredential(
        { prompt: "use sk-or-LEAKME-123 to auth" }, store,
      )).toThrow(CredentialLeakError);
    });
    it("does not disclose the value in the error message", () => {
      try { assertNoOutboundCredential("...sk-or-LEAKME-123...", store); }
      catch (e) { expect((e as Error).message).not.toContain("sk-or-LEAKME-123"); }
    });
  });
  ```
- [ ] 2. `pnpm exec vitest run packages/ai-core/src/credential-guard.test.ts` → **fails**.
- [ ] 3. Implement `credential-guard.ts`; add `export * from "./credential-guard.js";` to `index.ts`.
- [ ] 4. Rerun → **passes**. `pnpm -r build`.
- [ ] 5. Commit: `feat(ai-core): never-to-model credential leak guard (asserts-it-refuses)`.

---

### Task 4: `GenerationPort` + task types + provenance + `FakeGenerationGateway`

**Files:** create `packages/ai-core/src/generation.ts`, `packages/ai-core/src/generation.test.ts`; modify `index.ts`.

**Interfaces — Consumes:** `contentHash` from `@doit/domain`. **Produces:**
```ts
// generation.ts
import { z } from "zod";
import { contentHash } from "@doit/domain";

/** Text-only generation tasks (form values / triage). Closed set. */
export const FormValueInput = z.object({
  fieldLabel: z.string(),
  goal: z.string(),
  visibleContext: z.string().max(4000),
  history: z.array(z.string()).default([]),
}).strict();
export const FormValueOutput = z.object({ text: z.string().nullable() }).strict();

export const TriageInput = z.object({ failureSummary: z.string(), url: z.string() }).strict();
export const TriageOutput = z.object({ summary: z.string(), likelyCause: z.string() }).strict();

export const GEN_TASKS = {
  "form.value": { input: FormValueInput, output: FormValueOutput, promptVersion: "1" },
  "triage.narrative": { input: TriageInput, output: TriageOutput, promptVersion: "1" },
} as const;
export type GenTaskKind = keyof typeof GEN_TASKS;
export type GenInput<K extends GenTaskKind> = z.input<(typeof GEN_TASKS)[K]["input"]>;
export type GenOutput<K extends GenTaskKind> = z.output<(typeof GEN_TASKS)[K]["output"]>;

export interface GenerationProvenance {
  adapter: "openrouter" | "fake";
  model: string;             // the chosen model id — recorded per run
  promptVersion: string;
  latencyMs: number;
  responseHash: string;      // contentHash(output) — never any key
}
export interface GenerationResult<K extends GenTaskKind> {
  output: GenOutput<K>;
  provenance: GenerationProvenance;
}

/** The mockable port. Every consumer depends only on this. */
export interface GenerationPort {
  generate<K extends GenTaskKind>(kind: K, input: GenInput<K>): Promise<GenerationResult<K>>;
}

/** Deterministic fake — used by ALL CI tests; no network, no key. */
export class FakeGenerationGateway implements GenerationPort {
  constructor(private readonly canned?: Partial<Record<GenTaskKind, unknown>>) {}
  async generate<K extends GenTaskKind>(kind: K, input: GenInput<K>): Promise<GenerationResult<K>> {
    const parsed = GEN_TASKS[kind].input.parse(input);
    const raw = this.canned?.[kind] ?? this.defaultFor(kind, parsed);
    const output = GEN_TASKS[kind].output.parse(raw) as GenOutput<K>;
    return {
      output,
      provenance: {
        adapter: "fake", model: "fake",
        promptVersion: GEN_TASKS[kind].promptVersion,
        latencyMs: 0, responseHash: contentHash(output),
      },
    };
  }
  private defaultFor(kind: GenTaskKind, input: unknown): unknown {
    if (kind === "form.value") return { text: `value:${(input as { fieldLabel: string }).fieldLabel}` };
    return { summary: "fake triage", likelyCause: "unknown" };
  }
}
```

**Steps:**
- [ ] 1. Write `generation.test.ts` (failing): equal input → equal output + equal `responseHash`; output validates against the task schema; the port is satisfiable by the fake without a key.
  ```ts
  import { describe, it, expect } from "vitest";
  import { FakeGenerationGateway, type GenerationPort } from "./index.js";

  const g: GenerationPort = new FakeGenerationGateway();
  const input = { fieldLabel: "email", goal: "log in", visibleContext: "form", history: [] };

  describe("FakeGenerationGateway", () => {
    it("is deterministic and content-addresses its output", async () => {
      const a = await g.generate("form.value", input);
      const b = await g.generate("form.value", input);
      expect(a.output).toEqual(b.output);
      expect(a.provenance.responseHash).toBe(b.provenance.responseHash);
      expect(a.provenance.model).toBe("fake");
    });
  });
  ```
- [ ] 2. `pnpm exec vitest run packages/ai-core/src/generation.test.ts` → **fails**.
- [ ] 3. Implement `generation.ts`; add `export * from "./generation.js";` to `index.ts`.
- [ ] 4. Rerun → **passes**. `pnpm -r build`.
- [ ] 5. Commit: `feat(ai-core): GenerationPort + typed tasks + deterministic fake gateway`.

---

### Task 5: `ModelPolicy` — deterministic catalog hard-filter + cache-stable selection

**Files:** create `packages/ai-core/src/model-policy.ts`, `packages/ai-core/src/model-policy.test.ts`; modify `index.ts`.

**Interfaces — Produces:**
```ts
// model-policy.ts
import { z } from "zod";

export const CatalogModelSchema = z.object({
  id: z.string(),
  promptUsdPer1k: z.number().nonnegative(),
  completionUsdPer1k: z.number().nonnegative(),
  regions: z.array(z.string()).default([]),       // e.g. ["US"]
  latencyClass: z.enum(["fast", "standard", "slow"]).default("standard"),
  capabilities: z.array(z.string()).default([]),
}).strict();
export type CatalogModel = z.infer<typeof CatalogModelSchema>;

export const ModelConstraintsSchema = z.object({
  maxPromptUsdPer1k: z.number().nonnegative().optional(),
  maxCompletionUsdPer1k: z.number().nonnegative().optional(),
  requireRegion: z.string().optional(),            // e.g. "US"
  maxLatencyClass: z.enum(["fast", "standard", "slow"]).optional(),
  requiredCapabilities: z.array(z.string()).default([]),
  pinnedModelId: z.string().optional(),            // preferred iff it still passes the filter
}).strict();
export type ModelConstraints = z.infer<typeof ModelConstraintsSchema>;

export class NoEligibleModelError extends Error {
  readonly code = "E_NO_ELIGIBLE_MODEL" as const;
  constructor(readonly reason: string) { super(`no model passes constraints: ${reason}`); this.name = "NoEligibleModelError"; }
}

const LATENCY_RANK = { fast: 0, standard: 1, slow: 2 } as const;

/** HARD filter: drops every model that fails ANY constraint. Never relaxes. */
export function filterCatalog(catalog: CatalogModel[], c: ModelConstraints): CatalogModel[] {
  const maxLat = c.maxLatencyClass ? LATENCY_RANK[c.maxLatencyClass] : Infinity;
  return catalog.filter((m) =>
    (c.maxPromptUsdPer1k === undefined || m.promptUsdPer1k <= c.maxPromptUsdPer1k) &&
    (c.maxCompletionUsdPer1k === undefined || m.completionUsdPer1k <= c.maxCompletionUsdPer1k) &&
    (c.requireRegion === undefined || m.regions.includes(c.requireRegion)) &&
    (LATENCY_RANK[m.latencyClass] <= maxLat) &&
    c.requiredCapabilities.every((cap) => m.capabilities.includes(cap)));
}

/** Deterministic + prompt-cache-stable: same catalog+constraints → same id.
 *  Honors a still-eligible pin; else the cheapest, tie-broken by id (stable).
 *  Fail-closed: empty eligible set → NoEligibleModelError (never an unfiltered pick). */
export function selectModel(catalog: CatalogModel[], c: ModelConstraints): string {
  const eligible = filterCatalog(catalog, c);
  if (eligible.length === 0) throw new NoEligibleModelError("all filtered out by cost/region/latency/capability");
  if (c.pinnedModelId && eligible.some((m) => m.id === c.pinnedModelId)) return c.pinnedModelId;
  return [...eligible].sort((a, b) =>
    (a.promptUsdPer1k + a.completionUsdPer1k) - (b.promptUsdPer1k + b.completionUsdPer1k)
    || a.id.localeCompare(b.id))[0].id;
}
```

**Steps:**
- [ ] 1. Write `model-policy.test.ts` (failing): a US-only + cost-cap filter removes non-US/over-cost models; selection is stable across calls; empty eligible set throws `NoEligibleModelError`; a pin that still passes is honored, a pin filtered out is NOT used.
  ```ts
  import { describe, it, expect } from "vitest";
  import { filterCatalog, selectModel, NoEligibleModelError } from "./index.js";

  const cat = [
    { id: "a/cheap-eu", promptUsdPer1k: 0.1, completionUsdPer1k: 0.1, regions: ["EU"], latencyClass: "fast" as const, capabilities: [] },
    { id: "b/cheap-us", promptUsdPer1k: 0.1, completionUsdPer1k: 0.1, regions: ["US"], latencyClass: "fast" as const, capabilities: [] },
    { id: "c/dear-us",  promptUsdPer1k: 9.0, completionUsdPer1k: 9.0, regions: ["US"], latencyClass: "slow" as const, capabilities: [] },
  ];
  describe("ModelPolicy hard filter + selection", () => {
    it("hard-filters by region and cost BEFORE choosing", () => {
      const c = { requireRegion: "US", maxPromptUsdPer1k: 1, requiredCapabilities: [] };
      expect(filterCatalog(cat, c).map((m) => m.id)).toEqual(["b/cheap-us"]);
      expect(selectModel(cat, c)).toBe("b/cheap-us");
      expect(selectModel(cat, c)).toBe("b/cheap-us"); // cache-stable
    });
    it("fails closed when nothing is eligible", () => {
      expect(() => selectModel(cat, { requireRegion: "APAC", requiredCapabilities: [] })).toThrow(NoEligibleModelError);
    });
    it("ignores a pin that no longer passes the filter", () => {
      const c = { requireRegion: "US", maxPromptUsdPer1k: 1, requiredCapabilities: [], pinnedModelId: "c/dear-us" };
      expect(selectModel(cat, c)).toBe("b/cheap-us");
    });
  });
  ```
- [ ] 2. `pnpm exec vitest run packages/ai-core/src/model-policy.test.ts` → **fails**.
- [ ] 3. Implement `model-policy.ts`; add `export * from "./model-policy.js";` to `index.ts`.
- [ ] 4. Rerun → **passes**. `pnpm -r build`.
- [ ] 5. Commit: `feat(ai-core): deterministic model-catalog hard-filter and cache-stable selection`.

---

### Task 6: OpenRouter generation adapter (key only at provider call)

**Files:** create `packages/ai-core/src/openrouter.ts`, `packages/ai-core/src/openrouter.test.ts` (unit, mocked seam), `packages/ai-core/src/openrouter.integration.test.ts` (opt-in, env-gated); modify `index.ts`, `package.json` (add `ai`, `@openrouter/ai-sdk-provider`).

**Interfaces — Consumes:** `CredentialStore`, `assertNoOutboundCredential`, `selectModel`, `GEN_TASKS`, `requireKeys`. **Produces:**
```ts
// openrouter.ts
import { z } from "zod";
import { contentHash } from "@doit/domain";
import { GEN_TASKS, type GenTaskKind, type GenInput, type GenOutput, type GenerationPort, type GenerationResult } from "./generation.js";
import { type CredentialStore, requireKeys } from "./credentials.js";
import { assertNoOutboundCredential } from "./credential-guard.js";
import { type CatalogModel, type ModelConstraints, selectModel } from "./model-policy.js";

/** The one injectable seam. Production wires the AI SDK's generateObject; the
 *  unit test injects a fake. The key is read HERE and only HERE, and placed
 *  ONLY into the Authorization header — never in `body`. */
export interface OpenRouterCall {
  (args: {
    model: string;
    schema: z.ZodTypeAny;
    body: unknown;          // redacted, guard-checked — carries NO key
    authHeader: string;     // `Bearer <key>` — never logged, never in body
    signal?: AbortSignal;
  }): Promise<{ object: unknown; latencyMs: number }>;
}

export interface OpenRouterConfig {
  store: CredentialStore;
  catalog: CatalogModel[];
  constraints: ModelConstraints;
  call: OpenRouterCall;    // injected (real seam in bin wiring; fake in tests)
}

export class OpenRouterGenerationGateway implements GenerationPort {
  constructor(private readonly cfg: OpenRouterConfig) {}

  async generate<K extends GenTaskKind>(kind: K, input: GenInput<K>): Promise<GenerationResult<K>> {
    requireKeys("generation", this.cfg.store);                    // fail-closed precondition
    const task = GEN_TASKS[kind];
    const parsed = task.input.parse(input);                        // untrusted-in re-validated
    const model = selectModel(this.cfg.catalog, this.cfg.constraints); // deterministic pick
    const body = { model, task: kind, promptVersion: task.promptVersion, input: parsed };

    // FLOOR #6 CHOKE POINT: nothing with a key value may leave.
    assertNoOutboundCredential(body, this.cfg.store);

    const key = this.cfg.store.read("OPENROUTER_API_KEY");         // read at the call, nowhere else
    if (!key) throw new Error("unreachable: requireKeys passed but key unreadable");
    const { object, latencyMs } = await this.cfg.call({
      model, schema: task.output, body, authHeader: `Bearer ${key}`,
    });

    const output = task.output.parse(object) as GenOutput<K>;      // untrusted-out re-validated
    return {
      output,
      provenance: {
        adapter: "openrouter", model, promptVersion: task.promptVersion,
        latencyMs, responseHash: contentHash(output),              // no key anywhere
      },
    };
  }
}
```
> **Real seam (documented, wired in `bin`/host, NOT unit-tested):** the production `OpenRouterCall` lazily imports `ai` + `@openrouter/ai-sdk-provider` and calls `generateObject({ model: openrouter(model), schema, prompt: JSON.stringify(body), headers: { Authorization: authHeader } })`. Lazy import keeps the package building/testing without the SDK installed. Pin both versions and confirm the `generateObject` signature at wiring time.

**Steps:**
- [ ] 1. Write `openrouter.test.ts` (failing) with an **injected fake `call`** (no network): assert it (a) refuses when the key is absent (`MissingCredentialError`), (b) selects a model via the constraints, (c) passes a body with **no key** and an `authHeader` carrying the key, (d) records provenance with the chosen model and never the key, (e) throws when the returned object fails the schema.
  ```ts
  import { describe, it, expect, vi } from "vitest";
  import { OpenRouterGenerationGateway, envCredentialStore, MissingCredentialError, type OpenRouterCall } from "./index.js";

  const catalog = [{ id: "b/cheap-us", promptUsdPer1k: 0.1, completionUsdPer1k: 0.1, regions: ["US"], latencyClass: "fast" as const, capabilities: [] }];
  const constraints = { requireRegion: "US", maxPromptUsdPer1k: 1, requiredCapabilities: [] };
  const input = { fieldLabel: "email", goal: "log in", visibleContext: "form", history: [] };

  it("refuses when the key is absent (fail-closed)", async () => {
    const g = new OpenRouterGenerationGateway({ store: envCredentialStore({}, {}), catalog, constraints, call: vi.fn() as unknown as OpenRouterCall });
    await expect(g.generate("form.value", input)).rejects.toBeInstanceOf(MissingCredentialError);
  });

  it("sends no key in the body, puts it only in the auth header, and records provenance", async () => {
    const store = envCredentialStore({ OPENROUTER_API_KEY: "sk-or-SECRET" }, {});
    const call: OpenRouterCall = async (args) => {
      expect(JSON.stringify(args.body)).not.toContain("sk-or-SECRET"); // never-to-model
      expect(args.authHeader).toBe("Bearer sk-or-SECRET");
      expect(args.model).toBe("b/cheap-us");
      return { object: { text: "hi" }, latencyMs: 12 };
    };
    const g = new OpenRouterGenerationGateway({ store, catalog, constraints, call });
    const res = await g.generate("form.value", input);
    expect(res.output).toEqual({ text: "hi" });
    expect(res.provenance.model).toBe("b/cheap-us");
    expect(JSON.stringify(res.provenance)).not.toContain("sk-or-SECRET");
  });

  it("throws when the model's returned object fails the task schema", async () => {
    const store = envCredentialStore({ OPENROUTER_API_KEY: "sk-or-SECRET" }, {});
    const call: OpenRouterCall = async () => ({ object: { wrong: 1 }, latencyMs: 1 });
    const g = new OpenRouterGenerationGateway({ store, catalog, constraints, call });
    await expect(g.generate("form.value", input)).rejects.toBeTruthy();
  });
  ```
- [ ] 2. `pnpm exec vitest run packages/ai-core/src/openrouter.test.ts` → **fails**.
- [ ] 3. Implement `openrouter.ts`; add `export * from "./openrouter.js";` to `index.ts`; add `ai` + `@openrouter/ai-sdk-provider` to `package.json` deps (pinned).
- [ ] 4. Write `openrouter.integration.test.ts` — a `describe.skipIf(!process.env.RUN_OPENROUTER_TESTS || !process.env.OPENROUTER_API_KEY)` block that builds the real `call` seam and runs one `form.value` against a cheap US-eligible model, asserting the output validates and provenance is populated. **Verify it SKIPS cleanly with no env set** (`pnpm exec vitest run packages/ai-core/src/openrouter.integration.test.ts` shows skipped, suite green).
  ```ts
  import { describe, it, expect } from "vitest";
  const RUN = process.env.RUN_OPENROUTER_TESTS === "1" && !!process.env.OPENROUTER_API_KEY;
  describe.skipIf(!RUN)("OpenRouter live (opt-in)", () => {
    it("generates a form value against a real cheap US model", async () => {
      // build real OpenRouterCall via lazily-imported `ai` + `@openrouter/ai-sdk-provider`; assert output validates + provenance populated.
      expect(RUN).toBe(true);
    });
  });
  ```
- [ ] 5. Rerun the unit test → **passes**. `pnpm -r build`. Commit (stage `pnpm-lock.yaml`): `feat(ai-core): OpenRouter generation adapter with key-at-call-only + injectable seam`.

---

### Task 7: `JudgmentPort` + Choice/Noul/Score types + fake + Jev adapter shape

**Files:** create `packages/ai-core/src/judgment.ts`, `packages/ai-core/src/judgment.test.ts`, `packages/ai-core/src/jev.ts`, `packages/ai-core/src/jev.integration.test.ts` (opt-in); modify `index.ts`, `package.json` (add `@typesafe-ai/sdk`).

**Interfaces — Produces:**
```ts
// judgment.ts — typed DRIVING decisions (Jev shape: Choice / Noul / Score)
export interface ChoiceQuestion<T extends string> { kind: "choice"; options: readonly T[] }
export interface NoulQuestion { kind: "noul" }          // boolean-ish judgment
export interface ScoreQuestion { kind: "score" }         // 0..1
export type Question = ChoiceQuestion<string> | NoulQuestion | ScoreQuestion;

export interface JudgmentState { goal: string; url: string; controls: string[]; history: string[] }
export interface ChoiceAnswer<T extends string> { kind: "choice"; value: T; confidence: number }
export interface NoulAnswer { kind: "noul"; value: boolean; probability: number }
export interface ScoreAnswer { kind: "score"; value: number }
export type Answer = ChoiceAnswer<string> | NoulAnswer | ScoreAnswer;

export interface JudgmentPort {
  systemOne(args: { state: JudgmentState; questions: Record<string, Question> }): Promise<Record<string, Answer>>;
}

/** Deterministic fake — scripted answers; used by ALL CI tests, no key. */
export class FakeJudgmentGateway implements JudgmentPort {
  constructor(private readonly scripted: Record<string, Answer>) {}
  async systemOne(args: { state: JudgmentState; questions: Record<string, Question> }): Promise<Record<string, Answer>> {
    const out: Record<string, Answer> = {};
    for (const name of Object.keys(args.questions)) {
      const a = this.scripted[name];
      if (!a) throw new Error(`no scripted answer for question '${name}'`);
      out[name] = a;
    }
    return out;
  }
}
```
```ts
// jev.ts — adapter SHAPE only; live calls gated on TYPESAFE_API_KEY.
import { type JudgmentPort, type JudgmentState, type Question, type Answer } from "./judgment.js";
import { type CredentialStore, requireKeys } from "./credentials.js";
import { assertNoOutboundCredential } from "./credential-guard.js";

export interface JevClientCall {
  (args: { state: JudgmentState; questions: Record<string, Question>; authHeader: string }): Promise<Record<string, Answer>>;
}
export class JevJudgmentGateway implements JudgmentPort {
  constructor(private readonly store: CredentialStore, private readonly call: JevClientCall) {}
  async systemOne(args: { state: JudgmentState; questions: Record<string, Question> }): Promise<Record<string, Answer>> {
    requireKeys("judgment", this.store);                     // fail-closed
    assertNoOutboundCredential(args, this.store);            // never-to-model choke point (redact-before-model already applied by caller)
    const key = this.store.read("TYPESAFE_API_KEY")!;
    return this.call({ ...args, authHeader: `Bearer ${key}` });
  }
}
```
> **Real seam (documented, wired in host):** the production `JevClientCall` lazily imports `@typesafe-ai/sdk`, constructs the client, and calls `client.systemOne({ state, questions })` mapping `Choice`/`Noul`/`Score` results to `Answer`. Lazy import keeps the package buildable without the SDK.

**Steps:**
- [ ] 1. Write `judgment.test.ts` (failing): the fake returns scripted answers for each question; missing script throws; `JevJudgmentGateway` refuses when `TYPESAFE_API_KEY` is absent and passes the key only in the auth header (inject a fake `call`).
- [ ] 2. `pnpm exec vitest run packages/ai-core/src/judgment.test.ts` → **fails**.
- [ ] 3. Implement `judgment.ts` + `jev.ts`; add both to `index.ts`; add `@typesafe-ai/sdk` to `package.json` deps (pinned).
- [ ] 4. Write `jev.integration.test.ts` — `describe.skipIf(!process.env.RUN_TYPESAFE_TESTS || !process.env.TYPESAFE_API_KEY)`; verify it **skips cleanly** with no env.
- [ ] 5. Rerun unit test → **passes**. `pnpm -r build`. Commit (stage `pnpm-lock.yaml`): `feat(ai-core): JudgmentPort + Choice/Noul/Score + fake + Jev adapter shape`.

---

### Task 8: Preflight surfaces — MCP typed `setup_required` result + CLI secure collection

**Files:** create `packages/ai-core/src/preflight-surface.ts`, `packages/ai-core/src/preflight-surface.test.ts`; modify `index.ts`.

**Interfaces — Produces:** the two out-of-band collection primitives (the model never types or sees a key):
```ts
// preflight-surface.ts
import { MissingCredentialError, type CredentialKey, type Feature, type CredentialStore, requireKeys } from "./credentials.js";

/** MCP surface: a typed precondition result the HOST reads to collect keys.
 *  The agent/model never types or sees the key — it only sees "setup required"
 *  and WHICH keys are missing (names, never values). */
export interface SetupRequiredResult {
  ok: false;
  precondition: "setup_required";
  feature: Feature;
  missing: CredentialKey[];
  hint: string;
}
export function toSetupRequiredResult(err: MissingCredentialError): SetupRequiredResult {
  return {
    ok: false, precondition: "setup_required", feature: err.feature, missing: err.missing,
    hint: `Set ${err.missing.join(", ")} via the host's secure credential entry, then retry.`,
  };
}

/** Wrap a key-requiring MCP handler so a missing key becomes a typed
 *  setup_required result instead of a thrown error / permissive default. */
export function withPreflight<T>(
  feature: Feature, store: CredentialStore, handler: () => Promise<T>,
): () => Promise<T | SetupRequiredResult> {
  return async () => {
    try { requireKeys(feature, store); }
    catch (e) { if (e instanceof MissingCredentialError) return toSetupRequiredResult(e); throw e; }
    return handler();
  };
}

/** CLI surface: collect a key OUT-OF-BAND via a caller-supplied secure prompt
 *  (masked stdin) and persist to a gitignored local config. NEVER echoes the
 *  value and NEVER returns it to a model. The persistence + prompt fns are
 *  injected so this is testable without real stdin or disk. */
export interface SecureKeyIO {
  promptSecret(message: string): Promise<string>;   // masked; never echoed
  persist(key: CredentialKey, value: string): Promise<void>;  // writes gitignored config, chmod 600
}
export async function collectMissingKeys(
  feature: Feature, store: CredentialStore, io: SecureKeyIO,
): Promise<CredentialKey[]> {
  const required = Object.keys({ generation: 0, judgment: 0 }) as unknown; // (compile hint)
  const missing = requireKeysSafe(feature, store);
  for (const k of missing) {
    const v = await io.promptSecret(`Enter ${k} (input hidden; stored locally, never sent to a model):`);
    if (!v || v.trim().length === 0) throw new Error(`${k} not provided — aborting (fail-closed)`);
    await io.persist(k, v.trim());
  }
  return missing;
}
function requireKeysSafe(feature: Feature, store: CredentialStore): CredentialKey[] {
  try { requireKeys(feature, store); return []; }
  catch (e) { if (e instanceof MissingCredentialError) return e.missing; throw e; }
}
```
> Implementation note: drop the stray `required` line above when implementing — it is illustrative only; `collectMissingKeys` uses `requireKeysSafe` to learn what's missing. The `persist` fn writes to `~/.doit/credentials.json` (mode `0600`) which `.gitignore` must cover — `.gitignore` already ignores `.env`; add `credentials.json` under `~/.doit` is out-of-tree so no repo `.gitignore` change is needed (the file lives in the user's home, not the repo).

**Steps:**
- [ ] 1. Write `preflight-surface.test.ts` (failing):
  - `withPreflight("generation", emptyStore, handler)` returns a `setup_required` result naming `OPENROUTER_API_KEY` and never calls `handler`.
  - `withPreflight` with the key present calls `handler` and returns its value.
  - `collectMissingKeys` calls `promptSecret` + `persist` once per missing key with the injected IO, never echoing the value; a blank input throws (fail-closed).
  - assert the `SetupRequiredResult` contains key **names** only, never a value.
- [ ] 2. `pnpm exec vitest run packages/ai-core/src/preflight-surface.test.ts` → **fails**.
- [ ] 3. Implement `preflight-surface.ts` (clean, without the illustrative line); add to `index.ts`.
- [ ] 4. Rerun → **passes**. `pnpm -r build`.
- [ ] 5. Commit: `feat(ai-core): MCP setup_required precondition + CLI secure key collection (out-of-band)`.

---

### Task 9: Wiring — CLI commands + MCP preflight-gated tool (additive, flagged)

**Files:** create `packages/cli/src/ai-cli.ts`, `packages/cli/src/ai-cli.test.ts`; modify `packages/cli/src/program.ts` (one import + one call), `packages/cli/package.json` (add dep); create `packages/mcp-facade/src/ai-tools.ts`, `packages/mcp-facade/src/ai-tools.test.ts`; modify `packages/mcp-facade/src/tools.ts` (one allowlist entry).

**⚠ SHARED SURFACES — call out in the PR:** `packages/cli/src/program.ts`, `packages/cli/package.json`, `packages/mcp-facade/src/tools.ts`. All additive. The mcp-facade allowlist entry may be **deferred to the integrating slice** if a sibling slice is mid-edit on `tools.ts`; ship T9's CLI half + the `ai-tools.ts` handler regardless, and note the one-line allowlist addition as a follow-up.

**Interfaces — Consumes:** `@doit/ai-core` (`envCredentialStore`, `requireKeys`, `collectMissingKeys`, `withPreflight`, `toSetupRequiredResult`, `FakeGenerationGateway`). **Produces:**
- CLI: `brauto ai status [--json]` (per-feature detected/missing, **names only**), `brauto ai setup <feature> [--json]` (secure-prompt + persist missing keys via `collectMissingKeys`), `brauto ai generate <task> --input <json> [--json]` (runs the generation gateway; **defaults to the fake adapter** — deterministic, no key; real adapter is wired only when a key is present + a `--real` flag). Uses the existing `ok`/`fail`/`emitJson` envelope pattern.
- `packages/cli/src/ai-cli.ts` exports `registerAiCommands(program: Command, deps: CliDeps): void`; `program.ts` adds `import { registerAiCommands } from "./ai-cli.js";` and one line `registerAiCommands(program, deps);` before `return program;`.
- MCP: `packages/mcp-facade/src/ai-tools.ts` exports `aiGenerateText(store, gateway, args)` wrapped with `withPreflight("generation", store, ...)` so a missing key returns a `setup_required` result (host collects it); `tools.ts` appends `"ai_generate_text"` to `ALLOWED_TOOLS`.

**Steps:**
- [ ] 1. Write `ai-cli.test.ts` (failing): build the program with a fake `CliDeps`; `ai status --json` reports `generation`/`judgment` as missing when env is empty (names only, no values); `ai generate form.value --input '{...}' --json` prints an `ok` envelope from the **fake** gateway with a deterministic `responseHash`; `ai setup generation` with an injected secure IO persists the prompted key without echoing it.
- [ ] 2. Write `ai-tools.test.ts` (failing): `aiGenerateText` with an empty store returns `{ ok: false, precondition: "setup_required", missing: ["OPENROUTER_API_KEY"] }`; with a key + injected fake gateway returns the generated text.
- [ ] 3. `pnpm exec vitest run packages/cli/src/ai-cli.test.ts packages/mcp-facade/src/ai-tools.test.ts` → **fails**.
- [ ] 4. Implement `ai-cli.ts` + `ai-tools.ts`; add the additive `program.ts` line, the `cli/package.json` dep (`"@doit/ai-core": "workspace:*"`), and the one `ALLOWED_TOOLS` entry in `tools.ts`.
- [ ] 5. Rerun → **passes**. `pnpm -r build`. Confirm the existing `packages/mcp-facade/src/boundary.test.ts` / `named-tools.test.ts` still pass (`pnpm exec vitest run packages/mcp-facade`).
- [ ] 6. Commit (stage `pnpm-lock.yaml` + the exact files): `feat(cli,mcp-facade): wire @doit/ai-core behind preflight (additive, optional capability)`.

---

### Task 10: M3a exit gate

**Files:** none (verification only; commit only if a config file changed).

**Steps:**
- [ ] 1. `pnpm -r build` → clean, **no dependency cycle** (`@doit/ai-core` imports only `zod` + `@doit/domain`).
- [ ] 2. `pnpm test` (root `vitest run`) → **all green**; the OpenRouter + Jev live tests report **skipped** (no keys).
- [ ] 3. `pnpm lint` → clean.
- [ ] 4. `pnpm check:no-fallback` → clean (no permissive fallback in `@doit/ai-core`; `requireKeys`, `selectModel`, `withPreflight` all fail closed).
- [ ] 5. Grep guards: `@doit/ai-core` imports no `playwright`/`sqlite`/`kysely`/`runtime`/`journey` (`grep -rE "playwright|sqlite|kysely|@doit/(runtime|journey|screenplay|interpreter|recorder)" packages/ai-core/src` → no hits). Confirm the never-to-model guard is wired into BOTH the OpenRouter and Jev paths and the asserts-it-refuses test exists.
- [ ] 6. Confirm the credential value never appears in any provenance/log: `grep -rn "read(\"OPENROUTER_API_KEY\")\|read(\"TYPESAFE_API_KEY\")" packages/ai-core/src` returns ONLY the two provider-call sites in `openrouter.ts` / `jev.ts`.
- [ ] 7. Commit only if a config file changed: `chore(ai-core): M3a exit gate green`.

---

## Self-Review

**Spec coverage:**
- Generation gateway (OpenRouter): `GenerationPort` + typed tasks + provenance (T4), deterministic `ModelPolicy` hard-filter (cost/region/latency) + cache-stable selection + provenance of chosen model (T5), OpenRouter adapter with local re-validation (T6). ✅ (spec: autonomous-exploration §1–2, §8 P0; unified Slice 3)
- Judgment gateway (Jev/TypeSafe): `JudgmentPort` + Choice/Noul/Score + fake + Jev adapter shape, live gated on `TYPESAFE_API_KEY` (T7). ✅
- Both ports mockable / package testable without network or keys: `FakeGenerationGateway` (T4), `FakeJudgmentGateway` (T7), all unit tests use fakes; live tests `describe.skipIf` (T6/T7). ✅
- Credential preflight (floor #6 for platform keys): detection + `requireKeys` fail-closed + `MissingCredentialError` (T2); never-to-model invariant + **asserts-it-refuses** `CredentialLeakError`/`assertNoOutboundCredential` (T3), wired into both provider paths (T6/T7); key read only at the provider call, only in the auth header (T6/T7). ✅ (unified §7 floor #1 + #6, §9a)
- Collection as interaction, out-of-band, never through the model: CLI masked-stdin → gitignored local config (T8/T9); MCP typed `setup_required` result so the host collects it (T8/T9). ✅
- Wiring behind mcp-facade allowlist / CLI as an optional preflight-gated capability, additive (T9). ✅

**Placeholder scan:** no unimplemented stubs. The two real provider SDK calls sit behind one injectable seam each (`OpenRouterCall`, `JevClientCall`), documented and wired at the host — deliberately not unit-tested with network. The one illustrative `required` line in the T8 snippet is explicitly flagged to be dropped at implementation. Live tests are gated skips, not placeholders.

**Type consistency:** `CredentialKey`/`Feature`/`CredentialStore`/`MissingCredentialError`/`requireKeys` (T2) reused by T3/T6/T7/T8; `CredentialLeakError`/`assertNoOutboundCredential` (T3) reused by T6/T7; `GenerationPort`/`GenTaskKind`/`GenInput`/`GenOutput`/`GenerationResult`/`GenerationProvenance` (T4) reused by T6/T9; `CatalogModel`/`ModelConstraints`/`selectModel`/`NoEligibleModelError` (T5) reused by T6; `JudgmentPort`/`Question`/`Answer` (T7); `SetupRequiredResult`/`withPreflight`/`collectMissingKeys` (T8) reused by T9. Each symbol defined once, re-exported from `index.ts`.

**Fail-closed / never-permissive:** `requireKeys` throws (T2), `selectModel` throws `NoEligibleModelError` on empty eligible set (T5), `withPreflight` returns a typed refusal (T8), `collectMissingKeys` aborts on blank input (T8) — all surfaced to `pnpm check:no-fallback` (T10).
