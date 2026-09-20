# Distributed Journey Sources (Catalog Federation) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Run tests with `pnpm exec vitest run <path>` — **repo gotcha: packages have NO `"test"` script**, so `pnpm --filter <pkg> test` fails.

**Goal:** Make the built `Journey`/`JourneyRegistry` foundation *collaborative*: host Journeys in external `jevitate-*` git repos (never the engine repo), clone them **pinned to an exact commit** under a managed dir, and federate them into discovery/run — with consuming (pull/discover/run) **and** publishing (author locally → contribute back via PR) both in scope. Every load-bearing supply-chain FMECA mode (spec §12) becomes a fail-fast, "asserts-it-refuses" invariant that fails **closed**.

**Architecture:** A NEW leaf-ish package **`@doit/sources`** owns the whole slice:
- A **`JourneySource`** contract with two impls — **`LocalSource`** (wraps the Slice-1 `FsJourneyStore`/`JourneyRegistry`) and **`RemoteSource`** (read-only loader over a pinned git clone).
- **`jevitate.lock`** reader/writer (`{ sources: [{ name, gitUrl, pinnedCommit }] }`), a **`GitSourceManager`** (clone/pin/pull/update, shells to `git` behind an injectable exec port), a **`jevitate.json`** manifest + `journeys/*.journey.json` convention loader, an **engine-derived risk classifier** (reads steps, author can never downgrade), a content-hash-bound **`TrustStore`/`TrustRecord`**, a **ToU declaration+ack gate**, a **`FederatedJourneyRegistry`** composing N sources, a full **run-gate** (`<source>/<id>` → trust+pin+hash+risk+declared-origin+ToU or refuse), and the **`publish`** contribution flow.

The **ONE additive touch** to an existing package is in `@doit/journey`: export a structural `JourneyStore` interface and *widen* `JourneyRegistry`'s constructor param to it (backward-compatible — `FsJourneyStore` already satisfies it). Optionally one *additive* `findFederatedCapabilities` function is added to `@doit/mcp-facade` (new export, existing `findCapabilities` untouched). Both are called out explicitly in their tasks. **No edits to `@doit/domain`, `@doit/runtime`, `@doit/interpreter`, or any other sibling package** (siblings edit those concurrently).

**Tech Stack:** TypeScript (ESM, strict, tsc project references), pnpm workspaces, Vitest, zod v4, Node 20+ `node:crypto`/`node:fs/promises`/`node:child_process`. Reuses `@doit/journey` (`Journey`/`JourneyMetadata`/`JourneySchema`, `JourneyRegistry`, `FsJourneyStore`) and `@doit/recording` (`Recording`/`Step` closed schema).

**Spec:** `docs/superpowers/specs/2026-09-19-distributed-journey-sources-design.md` (§2 sources/lockfile/addressing, §3 repo convention, §4 federated discovery, §5 tiered trust, §6 engine-derived risk, §8 ToU gate, §9 hard floors 7–9, §10 publish, §12 FMECA, §14 open decisions). The plan argues from that spec; executors read both. It extends `2026-09-19-unified-journey-automation-and-testing-design.md` (§9a invariant-refusal discipline) — those guardrails remain binding.

---

## Global Constraints

- **Node 20+, ESM, strict TS project references.** New package compiles under `tsc --build`; declare it in root `tsconfig.json` references and add its vitest alias.
- **Dependency direction inward.** `@doit/sources` depends on `@doit/journey` + `@doit/recording` (+ zod, node builtins) only. **Nothing in `@doit/journey` may import `@doit/sources`** — the federation reuses `@doit/journey` from the outside. Consumers (`@doit/cli`, `@doit/mcp-facade`, `@doit/runtime`) may later depend on `@doit/sources`; this plan only adds the additive `@doit/mcp-facade` function. No cycles — verify with `pnpm -r build`.
- **The spec's hard floors §9 are non-negotiable and each ships an "asserts-it-refuses" test:**
  - **§9.7 Secret references only** — a shared/published/imported Journey carries secret **references** (`SecretRef { manager,key,origin,field }` — no value field) and never a **materialized** secret value. Any `fill`/`select` value of shape `{ redacted: false, value: ... }` (a real, non-redacted, non-`{var}` value) hard-blocks on **both** publish and import.
  - **§9.8 Reviewed, pinned, in-origin, or refuse** — a Journey runs only its exact hash-pinned, reviewed content within its declared origins. **Unknown source / hash mismatch (TOCTOU) / undeclared origin / untrusted risky Journey / undeclared-ToU target ⇒ fail-closed.**
  - **§9.9 Flat sources** — no transitive/auto-added sources; adding a source is always explicit + acknowledged.
- **Engine-derived risk is NEVER author-declared.** `classifyRisk` reads `recording.steps` (recursively into `forEach`) + `declaredOrigins`; the manifest/file cannot set or downgrade `riskClass` (FMECA #6).
- **Fail-closed on unknown / mismatch / undeclared.** No permissive default anywhere: a resolve/verify that cannot prove safety **throws a typed error**, never returns a degraded "ok". (Enforced by the exit gate, Task 14.)
- **Repo gotcha:** packages have NO `"test"` script. Run a single file with **`pnpm exec vitest run <path>`** (e.g. `pnpm exec vitest run packages/sources/src/hash.test.ts`), never `pnpm --filter @doit/sources test`. Whole suite: `pnpm test` (root) or `pnpm exec vitest run`.
- **Explicit-path git staging only** — `git add packages/sources/... pnpm-lock.yaml tsconfig.json vitest.config.ts docs/...`; **never `git add -A`** (untracked `.gitignore`/`.ignore` graft artifacts must stay out).
- **Commit trailer:** a blank line then EXACTLY `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.
- Keep the suite green after every task: `pnpm -r build && pnpm test && pnpm lint`.

## §14 Open decisions — RESOLVED here

1. **Lockfile + sources-dir location.** `jevitate.lock` lives at the **project root** (resolved from `cwd`; the same directory tests/CLI run in). Rationale: the lock is small, shareable metadata a team **commits to their repo** so everyone reproduces the identical catalog (§7). The managed clones live at **`~/.doit/sources/<name>/`**, mirroring the existing `~/.doit/journeys` + `~/.doit/db.sqlite` conventions (`packages/cli/src/program.ts` `DEFAULT_JOURNEYS_DIR`) and overridable via a `CliDeps.sourcesDir` / `--sources-dir` seam. Rationale: clones are large git working trees that must **never** be committed and are per-machine cache. **`TrustStore` and ToU-ack records are LOCAL/per-user** at `~/.doit/trust/` and are **not** written into the shared lock — trust is a human judgment made on this machine, not something a teammate's lock can grant (FMECA #2/#5; §9.9 flat sources).
2. **Content-hash canonicalization.** `canonicalJourneyHash(file)` = `"sha256:" + sha256hex(canonicalJson(SharedJourneyFileSchema.parse(file)))`, where `canonicalJson` is a **purpose-written deterministic serializer** (NOT bare `JSON.stringify`): object keys sorted ascending by JS string comparison, **arrays preserved in order** (step order is semantic), `undefined`/absent optionals omitted (never emitted as `null`), no insignificant whitespace, numbers via `Number.prototype.toString`. The hash covers the **entire closed-schema file** — `metadata` + `recording` + `declaredOrigins` — every behavior-affecting byte, so "what you reviewed is what runs" (§7) binds all of it. Validating through `SharedJourneyFileSchema` first strips unknown keys so hashing is defined only over schema-known content. Pinned in Task 2.
3. **PR mechanism (§10):** `gh` CLI when present (`gh pr create`), else the publish flow completes the branch+commit+push and **returns explicit branch+push+PR instructions** rather than failing — graceful degrade. Task 13.
4. **Manifest schema versioning:** `jevitate.json` carries a required `version: 1` (`z.literal(1)` now) so forward-compat is a schema decision, not a guess. Task 4.
5. **Trust revocation / audit:** deferred per spec §14 (later slice). `TrustStore` exposes `list()` now so a future `journey untrust` is additive; no revocation UI in this slice.

## File Structure (all NEW, under `packages/sources/`)

- `package.json`, `tsconfig.json` — package manifest + project-refs config.
- `src/index.ts` — barrel.
- `src/errors.ts` — typed fail-closed errors (`UnknownSourceError`, `HashMismatchError`, `UndeclaredOriginError`, `UntrustedRiskyJourneyError`, `UndeclaredTouError`, `EmbeddedSecretError`, `SourceValidationError`).
- `src/hash.ts` — `canonicalJson`, `canonicalJourneyHash`. (§14.2)
- `src/lockfile.ts` — `JevitateLock`, `JevitateLockSchema`, `readLock`, `writeLock`, `DEFAULT_LOCK_PATH`. (§14.1)
- `src/manifest.ts` — `JevitateManifest`, `SiteDeclaration`, `SharedJourneyFile`, schemas, `loadManifest`, `loadJourneyFiles`.
- `src/risk.ts` — `RiskClass`, `classifyRisk`. (§6)
- `src/git.ts` — `GitExec` port, `execGit` (real, shells `git`), `GitSourceManager` (add/pull/update/remove/resolveDir).
- `src/source.ts` — `JourneySource`, `SourcedJourney`, `SourcedJourneyMetadata`.
- `src/local-source.ts` — `LocalSource`.
- `src/remote-source.ts` — `RemoteSource`.
- `src/trust.ts` — `TrustRecord`, `TrustStore` (`FsTrustStore`).
- `src/tou.ts` — `TouGate`, `TouAck`, `AckStore`.
- `src/federated-registry.ts` — `FederatedJourneyRegistry` (the composing type).
- `src/run-gate.ts` — `resolveForRun` (the full §9.8 gate).
- `src/publish.ts` — `publishJourney`, `PublishResult`. (§10)
- `src/*.test.ts` — colocated unit tests; `src/invariants.test.ts` — consolidated §9/FMECA refusal contract (Task 14).

**Edits to existing files (called out, minimal):**
- `packages/journey/src/store.ts` (or `registry.ts`) — export a structural `JourneyStore` interface; `packages/journey/src/registry.ts` — widen constructor param type. (Task 7)
- `packages/mcp-facade/src/journey-tools.ts` — add `findFederatedCapabilities` (new export; existing functions untouched). (Task 11)
- Root additive: `tsconfig.json` (add `{ "path": "packages/sources" }`), `vitest.config.ts` (add `@doit/sources` alias), `pnpm-lock.yaml`.

---

### Task 1: Scaffold `@doit/sources` (mirror `packages/journey`)

**Files:**
- Create: `packages/sources/package.json`, `packages/sources/tsconfig.json`, `packages/sources/src/index.ts`, `packages/sources/src/scaffold.test.ts`
- Modify: root `tsconfig.json` (add reference), root `vitest.config.ts` (add alias)

**Interfaces:** none yet — this task only proves the package builds, resolves under vitest, and is wired into project refs.

- [ ] **Step 1: Write the failing test**
```ts
// packages/sources/src/scaffold.test.ts
import { describe, it, expect } from "vitest";
import * as sources from "./index.js";

describe("@doit/sources scaffold", () => {
  it("exposes a package marker so the barrel resolves", () => {
    expect(sources.PACKAGE_NAME).toBe("@doit/sources");
  });
});
```
Run: `pnpm exec vitest run packages/sources/src/scaffold.test.ts` → fails (no module).

- [ ] **Step 2: Minimal impl**
```json
// packages/sources/package.json
{
  "name": "@doit/sources",
  "version": "0.0.0",
  "type": "module",
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "exports": { ".": "./dist/index.js" },
  "scripts": { "build": "tsc --build" },
  "dependencies": {
    "@doit/journey": "workspace:*",
    "@doit/recording": "workspace:*",
    "zod": "^4.6.5"
  }
}
```
```json
// packages/sources/tsconfig.json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "rootDir": "src", "outDir": "dist" },
  "references": [{ "path": "../journey" }, { "path": "../recording" }],
  "include": ["src/**/*"],
  "exclude": ["src/**/*.test.ts"]
}
```
```ts
// packages/sources/src/index.ts
export const PACKAGE_NAME = "@doit/sources";
```
Root `tsconfig.json`: add `{ "path": "packages/sources" }` to `references`. Root `vitest.config.ts`: add `"@doit/sources": pkg("sources"),` to the alias map.

- [ ] **Step 3:** `pnpm install` (records `pnpm-lock.yaml`), then `pnpm exec vitest run packages/sources/src/scaffold.test.ts` → pass. `pnpm -r build` green.
- [ ] **Step 4: Commit** — `git add packages/sources/package.json packages/sources/tsconfig.json packages/sources/src/index.ts packages/sources/src/scaffold.test.ts tsconfig.json vitest.config.ts pnpm-lock.yaml docs/superpowers/plans/2026-09-20-distributed-journey-sources.md` then commit (`feat(sources): scaffold @doit/sources package` + trailer).

---

### Task 2: Content-hash canonicalization (`hash.ts`) — resolves §14.2

**Files:** Create `packages/sources/src/hash.ts`, `packages/sources/src/hash.test.ts`; export from barrel.

**Interfaces:**
- `function canonicalJson(value: unknown): string` — deterministic serialization (sorted object keys, ordered arrays, omitted `undefined`).
- `function canonicalJourneyHash(file: unknown): string` — `"sha256:"`-prefixed hex over the schema-parsed file. (Parses via `SharedJourneyFileSchema` from Task 4; until then hash the raw canonical form and tighten in Task 4.)

- [ ] **Step 1: Failing test** — the load-bearing property: **key order and whitespace must not change the hash; array order must.**
```ts
// packages/sources/src/hash.test.ts
import { describe, it, expect } from "vitest";
import { canonicalJson, canonicalJourneyHash } from "./hash.js";

describe("canonicalJson", () => {
  it("is invariant to object key order and whitespace", () => {
    expect(canonicalJson({ b: 1, a: 2 })).toBe(canonicalJson({ a: 2, b: 1 }));
  });
  it("preserves array order (step order is semantic)", () => {
    expect(canonicalJson([1, 2])).not.toBe(canonicalJson([2, 1]));
  });
  it("omits undefined optionals rather than emitting null", () => {
    expect(canonicalJson({ a: 1, b: undefined })).toBe(canonicalJson({ a: 1 }));
  });
});

describe("canonicalJourneyHash", () => {
  const j = {
    metadata: { id: "x", name: "x", promoted: false, params: [], createdAtIso: "t" },
    recording: { version: "1", site: "s", pages: [] },
    declaredOrigins: ["https://mail.example.com"],
  };
  it("is stable and sha256-prefixed", () => {
    expect(canonicalJourneyHash(j)).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(canonicalJourneyHash(j)).toBe(canonicalJourneyHash({ ...j }));
  });
  it("changes when a step's bytes change (TOCTOU basis)", () => {
    const j2 = { ...j, declaredOrigins: ["https://evil.example.com"] };
    expect(canonicalJourneyHash(j2)).not.toBe(canonicalJourneyHash(j));
  });
});
```
- [ ] **Step 2: Impl**
```ts
// packages/sources/src/hash.ts
import { createHash } from "node:crypto";

export function canonicalJson(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("non-finite number is not canonicalizable");
    return value.toString();
  }
  // string | boolean — JSON.stringify is deterministic for these scalars
  return JSON.stringify(value);
}

export function canonicalJourneyHash(file: unknown): string {
  // Task 4 tightens this to SharedJourneyFileSchema.parse(file) first.
  const hex = createHash("sha256").update(canonicalJson(file), "utf8").digest("hex");
  return `sha256:${hex}`;
}
```
- [ ] **Step 3:** run → pass. **Step 4: Commit** (`feat(sources): deterministic content-hash canonicalization` + trailer).

---

### Task 3: `jevitate.lock` reader/writer (`lockfile.ts`) — resolves §14.1

**Files:** Create `packages/sources/src/lockfile.ts`, `packages/sources/src/lockfile.test.ts`; barrel export.

**Interfaces:**
- `interface SourceEntry { name: string; gitUrl: string; pinnedCommit: string }`
- `interface JevitateLock { version: 1; sources: SourceEntry[] }`
- `const JevitateLockSchema: z.ZodType<JevitateLock>` (strict; `pinnedCommit` `/^[0-9a-f]{7,40}$/`; `name` no `/`, `\`, `..`)
- `function DEFAULT_LOCK_PATH(cwd?: string): string` → `join(cwd ?? process.cwd(), "jevitate.lock")`
- `async function readLock(path: string): Promise<JevitateLock>` (missing file ⇒ `{ version: 1, sources: [] }`; malformed ⇒ **throw**, never silently empty)
- `async function writeLock(path: string, lock: JevitateLock): Promise<void>` (validate before write; deterministic key/entry order — sort sources by name)

- [ ] **Step 1: Failing tests** — round-trip; missing ⇒ empty; **malformed lock throws (fail-closed, not silent empty)**; duplicate/typosquat-adjacent names allowed textually but each addressable distinctly; `pinnedCommit` must be a hex sha.
```ts
// packages/sources/src/lockfile.test.ts (essentials)
it("round-trips and is deterministic in order", async () => {
  const p = join(mkdtempSync(join(tmpdir(), "lock-")), "jevitate.lock");
  await writeLock(p, { version: 1, sources: [
    { name: "gmail", gitUrl: "https://github.com/x/jevitate-gmail", pinnedCommit: "a".repeat(40) },
  ]});
  expect((await readLock(p)).sources[0].name).toBe("gmail");
});
it("returns empty for a missing lock but THROWS on a malformed one", async () => {
  const dir = mkdtempSync(join(tmpdir(), "lock-"));
  expect((await readLock(join(dir, "nope.lock"))).sources).toEqual([]);
  writeFileSync(join(dir, "bad.lock"), "{ not json");
  await expect(readLock(join(dir, "bad.lock"))).rejects.toThrow();
});
it("rejects a pin that is not a hex commit", async () => {
  expect(() => JevitateLockSchema.parse({ version: 1, sources: [
    { name: "x", gitUrl: "https://h/x", pinnedCommit: "latest" }] })).toThrow();
});
```
- [ ] **Step 2:** Impl with `readFile`/`writeFile`; catch only `ENOENT` → empty (mirror `FsJourneyStore.list`), rethrow everything else; `JSON.parse` then `JevitateLockSchema.parse`. **Step 3:** pass. **Step 4: Commit** (`feat(sources): jevitate.lock reader/writer, project-root + hex-pinned`).

---

### Task 4: `jevitate.json` manifest + `journeys/*.journey.json` loader (`manifest.ts`)

**Files:** Create `packages/sources/src/manifest.ts`, `packages/sources/src/manifest.test.ts`; barrel export. Tighten `canonicalJourneyHash` (Task 2) to parse `SharedJourneyFileSchema` first.

**Interfaces:**
- `interface SiteDeclaration { origin: string; automationPolicy: "allowed"; touBasis: string }`
- `interface JevitateManifest { version: 1; source: string; sites: SiteDeclaration[] }`
- `interface SharedJourneyFile extends Journey { declaredOrigins: string[] }`
- `const JevitateManifestSchema`, `const SharedJourneyFileSchema` (reuses `JourneySchema` from `@doit/journey`, adds `declaredOrigins`)
- `async function loadManifest(cloneDir: string): Promise<JevitateManifest>` (missing/invalid ⇒ **throw** `SourceValidationError`)
- `async function loadJourneyFiles(cloneDir: string): Promise<SharedJourneyFile[]>` (scans `journeys/*.journey.json`; each validated; one bad file ⇒ **throw**, not skip — a source is a trust boundary, unlike the tolerant local `FsJourneyStore.list`)

```ts
// packages/sources/src/manifest.ts (schema shape)
import { z } from "zod";
import { JourneySchema, type Journey } from "@doit/journey";

const SiteDeclarationSchema = z.object({
  origin: z.string().url(),
  automationPolicy: z.literal("allowed"),
  touBasis: z.string().min(1),
}).strict();

export const JevitateManifestSchema = z.object({
  version: z.literal(1),
  source: z.string().min(1),
  sites: z.array(SiteDeclarationSchema),
}).strict();

export const SharedJourneyFileSchema = z.intersection(
  JourneySchema,
  z.object({ declaredOrigins: z.array(z.string().url()).min(1) }),
);
```
- [ ] **Step 1: Failing tests** — valid manifest+files load; a `.journey.json` missing `declaredOrigins` throws; an unknown top-level key in the manifest throws (`.strict()`); one corrupt journey file **fails the whole load** (fail-closed); a `version: 2` manifest throws (forward-compat gate). Write fixtures into a temp clone dir.
- [ ] **Step 2:** Impl `loadManifest` (`readFile(join(cloneDir,"jevitate.json"))` → parse → `JevitateManifestSchema.parse`), `loadJourneyFiles` (`readdir(join(cloneDir,"journeys"))`, filter `.journey.json`, `SharedJourneyFileSchema.parse` each). Update `hash.ts` `canonicalJourneyHash` to `canonicalJson(SharedJourneyFileSchema.parse(file))`.
- [ ] **Step 3:** pass. **Step 4: Commit** (`feat(sources): jevitate.json manifest + journeys/*.journey.json loader (versioned, fail-closed)`).

---

### Task 5: Engine-derived risk classifier (`risk.ts`) — spec §6, FMECA #1 & #6

**Files:** Create `packages/sources/src/risk.ts`, `packages/sources/src/risk.test.ts`; barrel export.

**Interfaces:**
- `type RiskClass = "read-only" | "risky"`
- `function classifyRisk(file: SharedJourneyFile): RiskClass` — **reads steps only; ignores any author claim.**

Rules (conservative poka-yoke): `read-only` **iff** every step (recursively into `forEach.steps`) has `kind` in `{ navigate, waitFor, extract, assert }` **and** every `navigate.url` that is absolute (`http(s)://…`) has an origin present in `declaredOrigins` (relative `/…` urls are same-origin, fine). **Anything else ⇒ `risky`** — any `click`/`fill`/`select`/`press`/`handback`, or any navigate that could leave `declaredOrigins`.

- [ ] **Step 1: Failing tests** (the FMECA-#6 anti-downgrade property is the headline):
```ts
// packages/sources/src/risk.test.ts (essentials)
const base = (steps: any[]) => ({
  metadata: { id: "j", name: "j", promoted: false, params: [], createdAtIso: "t" },
  recording: { version: "1", site: "s", pages: [{ url: "/", steps: steps.map((s) => ({ step: s })) }] },
  declaredOrigins: ["https://mail.example.com"],
});
it("pure reads within declared origins are read-only", () => {
  expect(classifyRisk(base([
    { kind: "navigate", url: "https://mail.example.com/inbox", expect: { kind: "urlIncludes", text: "/inbox" } },
    { kind: "assert", check: { kind: "urlIncludes", text: "/inbox" } },
  ]) as any)).toBe("read-only");
});
it("ANY write step is risky — an author cannot downgrade it (FMECA #6)", () => {
  expect(classifyRisk(base([
    { kind: "click", target: { testId: "del" }, expect: { kind: "urlIncludes", text: "/x" } },
  ]) as any)).toBe("risky");
});
it("a navigate leaving declaredOrigins is risky (FMECA #1)", () => {
  expect(classifyRisk(base([
    { kind: "navigate", url: "https://evil.example.com/x", expect: { kind: "urlIncludes", text: "x" } },
  ]) as any)).toBe("risky");
});
it("recurses into forEach — a write nested inside is still risky", () => {
  expect(classifyRisk(base([
    { kind: "forEach", items: { testId: "row" }, as: "r", steps: [
      { kind: "fill", target: { testId: "f" }, value: { var: "r" }, expect: { kind: "urlIncludes", text: "x" } },
    ]},
  ]) as any)).toBe("risky");
});
```
- [ ] **Step 2:** Impl — flatten steps recursively (walk `forEach.steps`), `originOf(url)` via `new URL` for absolute urls, compare against a `Set(declaredOrigins.map(o => new URL(o).origin))`. **Step 3:** pass. **Step 4: Commit** (`feat(sources): engine-derived risk classifier (author cannot downgrade)`).

---

### Task 6: Git source manager (`git.ts`) — clone/pin/pull/update, shells to `git`

**Files:** Create `packages/sources/src/git.ts`, `packages/sources/src/git.test.ts`; barrel export.

**Interfaces:**
- `type GitExec = (args: string[], opts: { cwd: string }) => Promise<{ stdout: string }>` — injectable port (real impl `execGit` uses `node:child_process` `execFile("git", args)`; **never** shell-interpolates — args array only).
- `class GitSourceManager { constructor(sourcesDir: string, exec?: GitExec) }`
  - `resolveDir(name: string): string` → `join(sourcesDir, name)` (reuse `assertSafeName` — no `/`,`\`,`..`)
  - `async add(name, gitUrl): Promise<string>` — clone, return current HEAD commit (the pin)
  - `async pull(name): Promise<void>` — `git fetch` only; **does not move the pin**
  - `async checkout(name, commit): Promise<void>` — `git checkout <commit>` (fail-closed if commit absent)
  - `async update(name): Promise<string>` — fetch + fast-forward, return the **new** HEAD (the only way a pin advances; explicit)
  - `async remove(name): Promise<void>`

- [ ] **Step 1: Failing tests** — with a **fake `GitExec`**: `add` returns the HEAD the fake reports and creates no shell injection (assert args are an array, url passed as one arg); `resolveDir` rejects a `../escape` name; `checkout` of a missing commit **rejects** (fake throws → propagate, no swallow). Add ONE real-git integration test guarded by a helper that inits a local temp bare repo (no network) to prove `execGit` clones + pins.
```ts
// packages/sources/src/git.test.ts (fake-exec essentials)
const calls: string[][] = [];
const fake: GitExec = async (args) => {
  calls.push(args);
  if (args[0] === "rev-parse") return { stdout: "b".repeat(40) + "\n" };
  return { stdout: "" };
};
it("add clones then pins to HEAD (rev-parse), args are an array (no shell injection)", async () => {
  const m = new GitSourceManager(mkdtempSync(join(tmpdir(), "src-")), fake);
  const pin = await m.add("gmail", "https://github.com/x/jevitate-gmail");
  expect(pin).toBe("b".repeat(40));
  expect(calls.some((a) => a[0] === "clone")).toBe(true);
});
it("rejects a path-traversal source name", () => {
  const m = new GitSourceManager("/tmp/x", fake);
  expect(() => m.resolveDir("../evil")).toThrow();
});
```
- [ ] **Step 2:** Impl. `execGit` wraps `promisify(execFile)("git", args, { cwd })`. **Step 3:** pass. **Step 4: Commit** (`feat(sources): pinned git source manager (clone/pin/pull/explicit-update)`).

---

### Task 7: `JourneySource` contract + `LocalSource` + **additive `@doit/journey` hook**

**Files:** Create `packages/sources/src/source.ts`, `packages/sources/src/local-source.ts`, tests; barrel export. **Modify (the ONE allowed existing-package edit):** `packages/journey/src/store.ts` + `packages/journey/src/registry.ts`.

**Interfaces (new, in `@doit/sources`):**
```ts
// packages/sources/src/source.ts
import type { JourneyMetadata } from "@doit/journey";
import type { SharedJourneyFile } from "./manifest.js";
import type { RiskClass } from "./risk.js";

export interface SourcedJourneyMetadata extends JourneyMetadata {
  source: string;          // source name
  pin?: string;            // pinned commit (remote sources)
  riskClass: RiskClass;    // engine-derived
  contentHash: string;     // canonicalJourneyHash
  trusted: boolean;        // per-Journey review present & hash matches
}
export interface SourcedJourney { meta: SourcedJourneyMetadata; file: SharedJourneyFile }

export interface JourneySource {
  readonly name: string;
  readonly pin?: string;                          // undefined for LocalSource
  list(): Promise<SourcedJourneyMetadata[]>;      // promoted-only, source-tagged
  get(id: string): Promise<SourcedJourney | null>;
}
```

**Additive `@doit/journey` edit — CALLED OUT, backward-compatible:** widen `JourneyRegistry`'s constructor to a structural interface so the federation can reuse the registry without `@doit/journey` importing `@doit/sources`.
```ts
// packages/journey/src/store.ts — ADD (export the shape FsJourneyStore already implements)
export interface JourneyStore {
  get(id: string): Promise<Journey | null>;
  put(j: Journey): Promise<void>;
  list(): Promise<JourneyMetadata[]>;
}
// packages/journey/src/registry.ts — CHANGE ONLY the param type (widening; FsJourneyStore still satisfies it)
import type { JourneyStore } from "./store.js";
export class JourneyRegistry {
  constructor(private readonly store: JourneyStore) {}   // was: FsJourneyStore
  // ...rest unchanged
}
```
This is the sole edit to existing `@doit/journey` source. It is purely additive (a new exported type) + a widening (no existing caller breaks; `registry.test.ts`/`slice1-invariants.test.ts` still pass).

`LocalSource` wraps a `JourneyRegistry` (so it reuses the promoted-only `find`/`get`), computes `riskClass`/`contentHash`, and marks local Journeys `trusted: true` within their own origins (source trust = the local author).

- [ ] **Step 1: Failing tests** — `LocalSource.list()` returns only promoted journeys tagged with `source`, engine-derived `riskClass`, and a `contentHash`; `get` returns the file; a `@doit/journey` regression check (`pnpm exec vitest run packages/journey/src/registry.test.ts` still green).
- [ ] **Step 2:** Impl `LocalSource` over `JourneyRegistry`; apply the two-line `@doit/journey` widening. **Step 3:** pass **both** the new tests and the existing journey tests. **Step 4: Commit** (`feat(sources): JourneySource contract + LocalSource; additive JourneyRegistry store-interface widening`).

---

### Task 8: `RemoteSource` (read-only loader over a pinned clone)

**Files:** Create `packages/sources/src/remote-source.ts`, test; barrel export.

**Interfaces:**
- `class RemoteSource implements JourneySource { constructor(name: string, cloneDir: string, pin: string) }`
  - `list()` — `loadManifest` + `loadJourneyFiles`, classify each, tag `source`/`pin`/`contentHash`; **`trusted` is left `false` here** (trust is applied by the run-gate/federated registry against the `TrustStore`); enforce **manifest⇄file origin coverage** (every `declaredOrigin` must have a `SiteDeclaration` — else that file is excluded from `list` AND the run-gate refuses it; see §9.8 undeclared-origin / §8 ToU).
  - `get(id)` — one file, same tagging.

- [ ] **Step 1: Failing tests** — a fixture clone (`jevitate.json` + `journeys/`) lists source-tagged, risk-classified journeys with the pin; a journey whose `declaredOrigins` includes an origin **absent** from the manifest's `sites` is **not listed** (fail-closed, FMECA #4 basis); `contentHash` equals `canonicalJourneyHash` of the file bytes.
- [ ] **Step 2:** Impl. **Step 3:** pass. **Step 4: Commit** (`feat(sources): RemoteSource over pinned clone, manifest-origin coverage enforced`).

---

### Task 9: `TrustStore` / `TrustRecord` (content-hash-bound) — spec §5, FMECA #2

**Files:** Create `packages/sources/src/trust.ts`, test; barrel export.

**Interfaces:**
- `interface TrustRecord { sourceId: string; journeyId: string; contentHash: string; approvedBy: string; approvedAtIso: string }`
- `interface TrustStore { get(sourceId, journeyId): Promise<TrustRecord | null>; put(r: TrustRecord): Promise<void>; list(): Promise<TrustRecord[]> }`
- `class FsTrustStore implements TrustStore` — local per-user at `~/.doit/trust/` (§14.1); keyed by `<sourceId>__<journeyId>.json`; `assertSafeId` on both parts; `0o600`/`0o700` perms (mirror `FsJourneyStore`).
- `function isTrusted(store, sourceId, journeyId, contentHash): Promise<boolean>` — true **only if** a record exists **and** `record.contentHash === contentHash` (TOCTOU close).

- [ ] **Step 1: Failing tests** — put+get round-trips; **`isTrusted` returns false when the stored hash differs from the current content hash** (the TOCTOU/mode-2 property — a source update that changed bytes invalidates trust); path-traversal ids rejected.
- [ ] **Step 2:** Impl. **Step 3:** pass. **Step 4: Commit** (`feat(sources): content-hash-bound TrustStore (TOCTOU-closing)`).

---

### Task 10: ToU declaration + ack gate (`tou.ts`) — spec §8, FMECA #4

**Files:** Create `packages/sources/src/tou.ts`, test; barrel export.

**Interfaces:**
- `interface TouAck { sourceName: string; gitUrl: string; origins: string[]; ackedBy: string; ackedAtIso: string }`
- `interface AckStore { get(sourceName): Promise<TouAck | null>; put(a: TouAck): Promise<void> }` (`FsAckStore` local, `~/.doit/trust/acks/`)
- `function requireDeclaredTou(manifest: JevitateManifest, origin: string): SiteDeclaration` — returns the declaration or **throws `UndeclaredTouError`** (fail-closed on undeclared target).
- `function surfaceForAck(manifest, gitUrl): { gitUrl: string; sites: SiteDeclaration[] }` — the data `source add` shows before recording the ack (§8 + FMECA #5: full URL shown).

- [ ] **Step 1: Failing tests** — `requireDeclaredTou` returns the declaration for a declared origin and **throws for an undeclared origin** (FMECA #4); `surfaceForAck` includes the full `gitUrl` + every `touBasis` (so the human sees what they ack); ack round-trips.
- [ ] **Step 2:** Impl. **Step 3:** pass. **Step 4: Commit** (`feat(sources): ToU declaration+ack gate (fail-closed on undeclared origin)`).

---

### Task 11: `FederatedJourneyRegistry` + **additive mcp-facade source-tagging**

**Files:** Create `packages/sources/src/federated-registry.ts`, test; barrel export. **Modify (additive, called out):** `packages/mcp-facade/src/journey-tools.ts` (new `findFederatedCapabilities`; existing exports untouched).

**Interfaces:**
- `class FederatedJourneyRegistry { constructor(sources: JourneySource[], trust: TrustStore) }`
  - `async find(query: string): Promise<SourcedJourneyMetadata[]>` — merges `list()` across all sources (promoted-only, already), applies the same substring filter as `JourneyRegistry.find`, **stamps `trusted`** by `isTrusted(...)`, addresses each as `<source>/<id>`, **deterministic ranking** (sort by source then id). No cross-source id collision — the address is `source/id`.
  - `async get(address: string): Promise<SourcedJourney | null>` — split `<source>/<id>`; **unknown source ⇒ throw `UnknownSourceError`** (FMECA #5 / §9.8).

**Additive mcp-facade function (§4, §11 — the optional "IF needed" touch, kept minimal):**
```ts
// packages/mcp-facade/src/journey-tools.ts — ADD (existing findCapabilities unchanged)
import type { FederatedJourneyRegistry } from "@doit/sources";
export interface SourcedCapability extends Capability {
  source: string; pin?: string; riskClass: "read-only" | "risky"; trusted: boolean;
}
export async function findFederatedCapabilities(
  fed: FederatedJourneyRegistry, query: string,
): Promise<SourcedCapability[]> {
  const metas = await fed.find(query);
  return metas.map((m) => ({
    id: `${m.source}/${m.id}`, name: m.name, description: m.description, params: m.params,
    source: m.source, pin: m.pin, riskClass: m.riskClass, trusted: m.trusted,
  }));
}
```
(Requires adding `"@doit/sources": "workspace:*"` to `packages/mcp-facade/package.json` — an additive dep, called out.)

- [ ] **Step 1: Failing tests** — compose a `LocalSource` + a fixture `RemoteSource`; `find("")` merges both, each result addressed `<source>/<id>`, tagged with source/pin/riskClass/trusted; a promoted local + a promoted remote with the same bare id do **not** collide; `get("nosuchsource/x")` **throws `UnknownSourceError`**; `findFederatedCapabilities` projects the tags.
- [ ] **Step 2:** Impl both. **Step 3:** pass (incl. `pnpm exec vitest run packages/mcp-facade/...`). **Step 4: Commit** (`feat(sources): FederatedJourneyRegistry + additive mcp-facade findFederatedCapabilities`).

---

### Task 12: The run-gate (`run-gate.ts`) — the full §9.8 "reviewed, pinned, in-origin, or refuse"

**Files:** Create `packages/sources/src/run-gate.ts`, test; barrel export. **No runtime edit** — this returns a *validated, ready-to-run* `SharedJourneyFile`; a sibling wires it into `@doit/runtime`'s `JourneyRunner` later. Keeps the slice orthogonal.

**Interfaces:**
- `interface RunGateDeps { fed: FederatedJourneyRegistry; trust: TrustStore; manifestFor(source: string): Promise<JevitateManifest>; ackFor(source: string): Promise<TouAck | null> }`
- `async function resolveForRun(deps: RunGateDeps, address: string): Promise<SharedJourneyFile>` — runs **every** gate, in order, each throwing its typed error on failure (fail-closed, no permissive default):
  1. **Unknown source / unknown id** ⇒ `UnknownSourceError` (FMECA #5).
  2. **Hash mismatch** — recompute `canonicalJourneyHash(file)`; if a `TrustRecord` exists and its hash differs ⇒ `HashMismatchError` (FMECA #2, TOCTOU).
  3. **Risk gate** — `classifyRisk(file)`; if `risky` and **not** `isTrusted(...)` ⇒ `UntrustedRiskyJourneyError` (FMECA #6 + §5 per-Journey review).
  4. **Declared-origin gate** — every `declaredOrigin` must be declared in the manifest's `sites`; else `UndeclaredOriginError` (§9.8).
  5. **ToU gate** — each declared origin must resolve via `requireDeclaredTou`, and a recorded `TouAck` must cover the source; else `UndeclaredTouError` (§8, FMECA #4).
  6. **Secret-references-only (import side of §9.7)** — scan steps; any `{ redacted: false, value }` materialized value ⇒ `EmbeddedSecretError`.

- [ ] **Step 1: Failing tests — one "asserts-it-refuses" case per gate** (the heart of this slice):
```ts
// packages/sources/src/run-gate.test.ts (shape)
it("refuses an unknown source", async () => {
  await expect(resolveForRun(deps, "ghost/x")).rejects.toBeInstanceOf(UnknownSourceError);
});
it("refuses on content-hash mismatch (TOCTOU)", async () => { /* trust record hash != current */ });
it("refuses a risky Journey with no TrustRecord", async () => { /* click step, untrusted */ });
it("refuses a Journey with an undeclared origin", async () => {});
it("refuses when ToU is undeclared/unacked", async () => {});
it("refuses an embedded/materialized secret value", async () => {});
it("resolves a read-only in-origin Journey under source trust (happy path)", async () => {});
```
- [ ] **Step 2:** Impl the ordered gate; each failure `throw`s — **no branch returns a degraded object**. **Step 3:** pass. **Step 4: Commit** (`feat(sources): run-gate enforcing trust+pin+hash+risk+origin+ToU or refuse`).

---

### Task 13: Publish contribution flow (`publish.ts`) — spec §10, FMECA #3 & #7

**Files:** Create `packages/sources/src/publish.ts`, test; barrel export.

**Interfaces:**
- `interface PublishRequest { journey: Journey; declaredOrigins: string[]; toSource: string; asId?: string }`
- `interface PublishResult { branch: string; pushed: boolean; prUrl?: string; instructions?: string }`
- `function validateForPublish(req): SharedJourneyFile` — throws unless: closed schema parses (`SharedJourneyFileSchema`); **secrets references-only** — any `{ redacted: false, value }` ⇒ `EmbeddedSecretError` (FMECA #3, publish side of §9.7); `declaredOrigins` present **and covering** every origin the steps touch (reuse the risk classifier's origin walk).
- `async function publishJourney(mgr: GitSourceManager, gh: GhPort, req): Promise<PublishResult>` — validate → write `journeys/<id>.journey.json` into the clone on a **new branch** `publish/<id>` → commit → push → open a PR via `gh` if present, else return branch+push+PR `instructions`. **Never pushes to the default branch; explicit per-id; never auto-publishes** (FMECA #7). Returns a preview/diff-ready result.
- `type GhPort = { available(): Promise<boolean>; createPr(cwd, branch, title): Promise<string> }` (injectable; real impl shells `gh pr create`).

- [ ] **Step 1: Failing tests** — `validateForPublish` **throws `EmbeddedSecretError`** for a `fill` with `{ redacted: false, value: "hunter2" }` (FMECA #3); throws when a step touches an origin missing from `declaredOrigins`; a valid journey with `{var}`/`{redacted:true}` values passes. With a **fake `GhPort` + fake `GitExec`**: `publishJourney` writes to `publish/<id>` (never `main`), and when `gh` is unavailable returns `instructions` (graceful degrade, §14.3). Assert the target branch arg is never the default branch.
- [ ] **Step 2:** Impl. **Step 3:** pass. **Step 4: Commit** (`feat(sources): publish flow — references-only, branch+PR, never auto-publish`).

---

### Task 14: Invariant refusal contract + exit gate (LAST TASK)

**Files:** Create `packages/sources/src/invariants.test.ts` (consolidated §9-style contract, mirroring `packages/runtime/src/slice1-invariants.test.ts`). Extend the repo exit gate `scripts/check-no-permissive-fallback.mjs` coverage to include `packages/sources` (it already scans `<repoRoot>/packages/**/src/**/*.ts` — verify `@doit/sources` is in scope) and add a sources-specific assertion.

**Purpose:** one readable file where a reviewer sees **every load-bearing FMECA mode refuse**, plus the permissive-fallback grep gate passing.

- [ ] **Step 1: Consolidated contract test** — re-uses the fixtures/fakes from Tasks 8–13; asserts each refusal in one place:
```ts
// packages/sources/src/invariants.test.ts
describe("Distributed-sources §9/FMECA — refusal contract", () => {
  it("FMECA #5 / §9.8 unknown source → UnknownSourceError", async () => { /* resolveForRun ghost/x */ });
  it("FMECA #2 hash mismatch (TOCTOU) → HashMismatchError", async () => {});
  it("FMECA #1 / §9.8 undeclared origin → UndeclaredOriginError", async () => {});
  it("FMECA #6 author-downgraded risk: classifier still 'risky' → UntrustedRiskyJourneyError", async () => {});
  it("FMECA #4 / §8 undeclared-ToU target → UndeclaredTouError", async () => {});
  it("FMECA #3 / §9.7 embedded secret value → EmbeddedSecretError (publish AND import)", async () => {});
  it("§9.9 flat sources: adding a source is explicit; nothing auto-adds a transitive source", async () => {
    // structural: RemoteSource.list() yields only journeys, never SourceEntry;
    // no code path calls GitSourceManager.add from within list()/find().
  });
});
```
- [ ] **Step 2: Exit gate** — run `node scripts/check-no-permissive-fallback.mjs` and confirm it scans `packages/sources` with **0 hits** (no `catch → return { outcome: "ok" }`, no `?? "ok"`, no inline-steps in a run path). Run the full green gate: `pnpm -r build && pnpm test && pnpm lint`.
- [ ] **Step 3: Commit** (`test(sources): §9/FMECA refusal contract + exit-gate coverage` + trailer).

---

## Self-Review

**Spec coverage → task map:**
- §2 sources/lockfile/addressing → Tasks 3 (lock), 6 (git manager), 11 (`<source>/<id>` addressing). ✅
- §3 repo convention (`jevitate.json`, `journeys/*.journey.json`, engine-derived risk) → Tasks 4, 5. ✅
- §4 federated discovery (merge + tag source/pin/riskClass/trust) → Task 11. ✅
- §5 tiered trust (`TrustRecord`, content-hash, re-review on mismatch) → Tasks 9, 12. ✅
- §6 engine-derived risk → Task 5. ✅
- §7 reproducibility (pin + hash, explicit update) → Tasks 2, 3, 6, 12. ✅
- §8 ToU declaration+ack+fail-closed → Tasks 10, 12. ✅
- §9.7 secrets references-only (publish AND import) → Tasks 12 (import), 13 (publish), 14. ✅
- §9.8 reviewed/pinned/in-origin/or-refuse → Task 12. ✅
- §9.9 flat sources → Task 14 (structural). ✅
- §10 publish (validate/branch/PR/never-auto) → Task 13. ✅
- §14 open decisions → resolved in the header block (lockfile+dir §14.1, canonicalization §14.2, PR mechanism §14.3, manifest versioning, revocation deferred). ✅

**FMECA mode → asserts-it-refuses test:**
- #1 off-origin/undeclared-origin → Tasks 5, 8, 12, 14. ✅
- #2 TOCTOU hash mismatch → Tasks 9, 12, 14. ✅
- #3 embedded secret value → Tasks 12, 13, 14. ✅
- #4 ToU violation/undeclared target → Tasks 8, 10, 12, 14. ✅
- #5 typosquat/unknown source → Tasks 3 (URL-namespaced), 11, 12, 14. ✅
- #6 author self-downgrades risk → Task 5 (engine-derived), 12, 14. ✅
- #7 publish over-share → Task 13 (explicit per-id, branch-only, preview). ✅
- #8 non-reproducible run → Tasks 3, 6, 12 (pin-only resolution). ✅
- #9 transitive sources → Task 14 (flat, structural). ✅

**Orthogonality / shared-file touches (all called out):**
- ONE `@doit/journey` edit (Task 7): export `JourneyStore` interface + widen `JourneyRegistry` constructor — additive + backward-compatible; existing journey tests must stay green.
- ONE additive `@doit/mcp-facade` edit (Task 11): new `findFederatedCapabilities` export + a `@doit/sources` dep; existing `findCapabilities`/`runJourney`/`listNamedJourneyTools` untouched.
- Additive root touches (expected): `tsconfig.json` reference, `vitest.config.ts` alias, `pnpm-lock.yaml`, and the exit-gate scan already covering `packages/sources`.
- **No edits** to `@doit/domain`, `@doit/runtime`, `@doit/interpreter`, `@doit/recording`, `@doit/cli`, or any other sibling. The run-gate returns a validated `SharedJourneyFile` for a sibling to wire into `JourneyRunner` — no runtime edit here.

**Placeholder scan:** every task carries real code snippets (schemas, classifier, canonicalizer, gate order) — no `TODO`/`throw new Error("not implemented")` placeholders in impl steps. Fixtures are described concretely (temp clone dirs, fake `GitExec`/`GhPort`).

**Type consistency:** `SharedJourneyFile = Journey & { declaredOrigins }` threads through classifier, hash, sources, trust, gate, publish; `SourcedJourneyMetadata extends JourneyMetadata`; the `@doit/journey` widening keeps `FsJourneyStore` a valid `JourneyStore`. Errors are one typed class per refusal, all thrown (never returned) — consistent with the fail-closed constraint and the exit gate.
