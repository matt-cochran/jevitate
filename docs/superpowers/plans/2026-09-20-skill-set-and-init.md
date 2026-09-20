# Jevitate Skill Set + `jevitate init` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Status:** Proposed (plan — for review before execution)
**Date:** 2026-09-20
**Ticket:** `gh issue view 9 --repo matt-cochran/jevitate` — "An agent skill scopes change-driven testing over shipped Journeys from a diff or story" (the `jevitate-mission-scope` skill below is this ticket's deliverable). This plan additionally builds the **skill set infrastructure** (`@jevitate/skills`) that `jevitate-mission-scope` ships inside, plus the remaining five capability skills and the `jevitate init` installer, per the parent task's design direction.
**Paired site ticket:** #17 (LLM-directed mission scoping) covers the site-facing description of #9/scoping — not addressed here (this plan is code + skill content only).
**Specs:** `docs/superpowers/specs/2026-09-19-unified-journey-automation-and-testing-design.md` (Journey/CLI/MCP surfaces this skill set drives), `docs/superpowers/specs/2026-09-19-autonomous-exploration-testing-design.md` §9 ("LLM-directed mission scoping" — the change-driven-targeting framing `jevitate-mission-scope` and `jevitate-explore` implement).
**Sibling plan:** `docs/superpowers/plans/2026-09-20-ticket-8-mcp-queue-exploration.md` (the `queue_exploration` MCP tool the `jevitate-explore` skill drives).

**Goal:** (1) Ship a `@jevitate/skills` package containing six Claude-Code-format `SKILL.md` files — one per jevitate capability — each pure LLM instructions for driving the `jevitate` CLI/MCP surface (no TS logic encodes the *judgment*; the judgment stays in the skill's prose, per the parent task's binding design direction). (2) Ship a `jevitate init` CLI command that (a) reuses the existing `@jevitate/ai-core` credential preflight to collect missing `OPENROUTER_API_KEY`/`TYPESAFE_API_KEY` values, and (b) detects which agent runtimes are present on the machine/project and installs the skill set into each, idempotently, never overwriting a user's own edits without confirmation.

## Why this shape (state of the code, verified)

- **No skill-set precedent exists in this repo.** `find . -iname SKILL.md` under `packages/`/`docs/` returns nothing — this repo has never authored a `SKILL.md` before (the *user's* `~/.claude/skills` directory is unrelated, external tooling). Everything here is new, modeled on the Claude Code skill format (YAML frontmatter `name`/`description` + a Markdown instruction body) already visible in this session's own available-skills listing.
- **The real CLI surface, verified against `packages/cli/src/program.ts`**, is: `jevitate init`, `jevitate profile create|status`, `jevitate site policy get|set`, `jevitate site simulate`, `jevitate recording promote|diff|fit|postdoc`, `jevitate journey list|find|run`, `jevitate load run`, `jevitate ai status|setup|generate`. There is **no** `jevitate explore` yet (P1 of the exploration-engine plan, not built), **no** `jevitate journey publish/create/promote` (Journeys are currently registered only via the `JourneyRegistry.put`/`.promote` TS API, exercised in tests — no CLI wraps it), and **no** `jevitate source ...` surface over `@jevitate/sources` (a fully-built, richly-tested programmatic package — git-backed remote sources, trust/ack, lockfile pinning, publish, run-gate — with zero CLI wiring). Every `SKILL.md` below is written to be **honest about this** — it drives what exists today, and explicitly tells the reader (a future LLM invocation) what is a known gap rather than inventing a command. Fabricating a working-sounding command in an LLM-instruction file is worse than useless: it produces a confident, wrong tool call.
- **The credential preflight to reuse** is `@jevitate/ai-core`'s `collectMissingKeys(feature, store, io)` / `FEATURE_KEYS` / `envCredentialStore` (`packages/ai-core/src/credentials.ts`, `preflight-surface.ts`), already consumed by `packages/cli/src/ai-cli.ts`'s `ai setup <feature>` command. Its `SecureKeyIO.promptSecret` masks stdin (verified: `createMutableEcho` + a documented Node-readline mute workaround) and `persist` writes `~/.jevitate/credentials.json` at `mode: 0o600` — the key is **never** echoed and **never** returned to a model (matches the parent task's binding constraint). `ai-cli.ts`'s `realSecureIO()` factory is currently **module-private** (not exported) — this plan exports it (additive) so `init` can reuse the exact same masked-prompt implementation rather than re-implementing it.
- **The `~/.jevitate` data-dir convention** (`packages/cli/src/data-dir.ts`'s `resolveDataDir`, injectable `homedir`) is the pattern to reuse for `init`'s own idempotency-state file.
- **The `journey`/`sources` packages' conventions** (`SAFE_ID_RE`, `.strict()` zod schemas validated before I/O, structural `*Store` interfaces + `Fs*Store`, injectable dependencies for testability) are reused throughout the install mechanics below, exactly as in the sibling ticket-8 plan.
- **`scripts/check-no-permissive-fallback.mjs`** already gates the repo against silent-success-on-error patterns; `init`'s "never overwrite without confirmation" behavior is designed so that a conflict is a **visible, reported skip**, never a silent no-op that looks like success.

## Design direction this plan must not violate (binding, from the parent task)

LLM-driven capabilities (mission scoping, change-driven testing, "what to test") are **skills** — Markdown instructions an LLM reads and follows by calling the CLI/MCP — **not** TypeScript logic. Nothing in this plan implements mission-scoping *judgment* in code. The only TypeScript this plan adds is: (a) a tiny, generic skill-manifest **loader** (reads `SKILL.md` frontmatter off disk — metadata, not judgment) and (b) the `init` command's detect/plan/install **mechanics** (filesystem operations — where to put a file, whether it already exists, whether it changed) — both are ordinary, unit-testable infrastructure, explicitly called out as such in the parent task ("the install/detect MECHANICS are TS + tested" vs. "the SKILL.md CONTENT is LLM instructions, not unit-tested logic").

## Architecture

```
@jevitate/skills                             (NEW leaf package — skill content + loader)
  package.json                               # "files": ["dist", "skills"]
  tsconfig.json
  skills/                                     # the "repo skills/ dir" the parent task specifies —
    jevitate-explore/SKILL.md                 # living HERE (inside the publishable package) is the
    jevitate-record/SKILL.md                  # single source of truth; there is no second copy at
    jevitate-run-journey/SKILL.md             # repo-root to drift out of sync with (see Decision 1).
    jevitate-mission-scope/SKILL.md           # ← ticket #9's deliverable
    jevitate-load-test/SKILL.md
    jevitate-sources/SKILL.md
  src/
    index.ts                                  # barrel
    frontmatter.ts                             # tiny `name:`/`description:` extractor (no yaml dep)
    frontmatter.test.ts
    manifest.ts                                # loadManifest(): scans skills/*/SKILL.md at load time
    manifest.test.ts                           # — a DERIVED manifest, not hand-duplicated data (Decision 2)

@jevitate/cli                                 (existing — additive only)
  package.json                                # + "@jevitate/skills": "workspace:*"
  src/
    ai-cli.ts                                  # `realSecureIO` becomes exported (was module-private)
    init-skills.ts                             # NEW — detectRuntimes, resolveInstallTargetPaths,
    init-skills.test.ts                        #        planSkillInstall, installSkills
    init-keys.ts                                # NEW — thin wrapper: run credential preflight for
    init-keys.test.ts                           #        both features, collecting a combined report
    program.ts                                  # `init` command extended (was a stub)
    program.test.ts                             # extended
```

Dependency direction: `@jevitate/skills` depends on Node builtins only (no new external dependency — frontmatter parsing is 6 lines of string splitting, not a YAML library, since only two flat string fields are ever needed). `@jevitate/cli` gains one new dependency, `@jevitate/skills`. Nothing depends on `@jevitate/cli` (unchanged, it's the outermost package). `@jevitate/skills` has no dependency on `@jevitate/mcp-facade`, `@jevitate/missions`, or `@jevitate/explore` — a skill's *content* references those tools/commands by name in prose, it never imports their types.

## Decisions (resolved here — the parent task's direction underspecifies these)

1. **One copy of `skills/`, inside the package.** The parent task says "a repo `skills/` dir of SKILL.md skills" *and* "publish them as a `@jevitate/skills` package (packages/skills, ships the SKILL.md set...)". Read literally as two things (a root-level `skills/` PLUS a package that ships a copy) that would be two copies of the same content with no mechanism keeping them in sync — a guaranteed drift bug. Resolution: `packages/skills/skills/` **is** "the repo skills/ dir" (it is, after all, a directory in the repo named `skills`) and simultaneously the exact content `@jevitate/skills` ships (`package.json`'s `"files"` includes it verbatim, no copy step, no build step for the Markdown). `jevitate init`'s Claude-Code/generic install targets read directly from this one location via `@jevitate/skills`'s `loadManifest()`.
2. **The manifest is derived, not hand-maintained.** A hand-written `manifest.json` listing `{id, name, description}` for each skill would drift from the actual `SKILL.md` frontmatter the moment someone edits one file and forgets the other (exactly the class of bug `packages/skills/src/manifest.test.ts` exists to prevent). `loadManifest()` instead reads every subdirectory of `skills/`, parses that subdirectory's `SKILL.md` frontmatter, and returns `{ id: <dirname>, name, description, filePath, body }[]` — the manifest **is** a live projection of the files, so there is structurally nothing to keep in sync. This still satisfies "a small manifest": the loader is small, and its *output* is the manifest.
3. **Four install targets, exactly as specified, with concrete mechanics:**
   - **Claude Code** — global, `~/.claude/skills/<id>/SKILL.md`. Detected by `existsSync(join(homedir(), ".claude"))`. One file per skill, byte-identical copy of `packages/skills/skills/<id>/SKILL.md`.
   - **Codex** — Codex has no native per-skill directory; its context-loading convention is a global `AGENTS.md` (`~/.codex/AGENTS.md`). Detected by `existsSync(join(homedir(), ".codex"))`. Install target: a **marked, idempotent block** inside that file (`<!-- BEGIN JEVITATE SKILLS v1 -->` … `<!-- END JEVITATE SKILLS v1 -->`), containing, per skill, its name/description and a pointer to the installed Claude-Code path (`~/.claude/skills/<id>/SKILL.md`) **or**, if Claude Code isn't also detected, the full body inlined — Codex reads `AGENTS.md` as plain instructions, so either form works; inlining when there's no other copy on disk avoids a dangling reference.
   - **Cursor** — project-scoped `.cursor/rules/jevitate-<id>.mdc` (Cursor's own convention: frontmatter `description`/`globs`/`alwaysApply` + Markdown body). Detected by `existsSync(join(cwd, ".cursor"))` — **project-local** detection (unlike Claude Code/Codex, which are user-global), because Cursor rules are inherently a project concept. Not auto-created for a project with no `.cursor/` dir (would clutter non-Cursor projects); available via `--targets cursor` opt-in regardless of detection.
   - **Generic project-local** — always installed, no detection gate (this is the tool-agnostic fallback the parent task calls for explicitly): `AGENTS.md` at the project root (marked block, same mechanism as Codex's, so a project already using the emerging `AGENTS.md` convention for another tool is never clobbered outside the marked block) **and** `.agent/skills/<id>/SKILL.md` (one file per skill, mirroring the Claude Code layout, for any tool that scans a local skills directory by convention).
4. **Idempotency + never-overwrite-without-confirmation, one mechanism for both target kinds.** `init` keeps a small state file, `~/.jevitate/skills-install-state.json` (via `resolveDataDir(["skills-install-state.json"])`), mapping `"<target>:<skillId>" → sha256(<content last written by init>)`. On each run, for every (target, skill) pair:
   - Target file/block doesn't exist → **create**.
   - Target file/block exists, and its current hash matches the recorded last-installed hash → **update** if the source `SKILL.md` changed (new content), else **unchanged** (no write).
   - Target file/block exists, and its current hash does **not** match the recorded last-installed hash (someone edited it after `init` wrote it, or it pre-dates `init` entirely and was never recorded) → **skip-user-modified**, reported to the user, never written — unless `--force` is passed, or the user confirms interactively (a `y/N` prompt per conflicting file when running without `--json`/`--yes`).
   This single `planInstall(...)` decision function is shared by both the whole-file targets (Claude Code, generic `.agent/skills/`) and the marked-block targets (Codex, generic `AGENTS.md`) — a block target hashes only the text between its markers, not the whole file, so user content elsewhere in `AGENTS.md` never participates in the diff at all (it's not read, hashed, or touched).
5. **`jevitate init`'s existing stub is extended, not replaced.** Today `init` (`packages/cli/src/program.ts` line ~133) takes no options besides `--json` and always returns `{ initialized: true }`. This plan keeps that shape as the **base** of the envelope's `data` and adds `keys` (the credential-collection report) and `skills` (the install report) alongside it — an existing caller parsing `{ initialized: true }` out of the envelope still finds it.

## Guardrails (binding — each ships a test)

1. **A key is never echoed, logged, or handed to a model.** `init`'s credential step is a thin call into the existing, already-guardrailed `collectMissingKeys`/`SecureKeyIO` — this plan adds no new code path that reads a key value; `init-keys.ts` only orchestrates *which* features to preflight and shapes the report.
2. **Install never overwrites a user's own edit without `--force` or interactive confirmation.** `planSkillInstall` returning `"skip-user-modified"` **must** result in no write — asserted directly (a `writeFile` spy never called for that pair) in `init-skills.test.ts`.
3. **A marked block never touches content outside its own markers.** `AGENTS.md`/Codex-block tests assert that arbitrary surrounding text (simulating a user's own `AGENTS.md` content) is byte-identical before and after an `init` run, both on first-install (block appended) and on re-run (block replaced in place).
4. **Detection is fail-closed toward "don't install where not detected."** A runtime not detected and not named in `--targets` is never written to, even if its directory happens to be creatable — `installSkills` only acts on `detectRuntimes()` ∪ `--targets` override, never "all four, always" (this would spam an unrelated project's root with `AGENTS.md`/`.agent/` on every `jevitate init`, surprising a user who never asked for the generic target — **except** the generic target, which is intentionally always-on per Decision 3, and that exception is itself asserted by a test, not left implicit).
5. **Manifest/file drift is impossible by construction, and tested anyway.** `manifest.test.ts` asserts every entry in `loadManifest()`'s output corresponds to a real `skills/<id>/SKILL.md` with frontmatter `name` matching a documented naming convention (`name` starts with `jevitate-`) and a non-empty `description`.

## Tech Stack

TypeScript (strict, ES2022, NodeNext), Vitest, pnpm workspaces, Node builtins only (`node:fs`, `node:fs/promises`, `node:path`, `node:os`, `node:crypto` for `sha256`). No new external dependency in either package.

## Global Constraints

- Node 20+, ESM, `strict: true`, TS project references (`tsc --build`).
- Run tests with `pnpm exec vitest run <path>` — never `pnpm --filter <pkg> test`.
- Git staging is explicit-path only (`git add <exact files>`), never `-A`/`.`.
- Commit trailer on every commit: `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.
- Dependency direction stays inward: `@jevitate/skills` is a leaf; `@jevitate/cli` depends on it; nothing depends on `@jevitate/cli`.
- Gitflow: feature branch off `dev`, PR back to `dev`, never directly to `main`.
- Secrets: `init` never sends a collected key anywhere except `SecureKeyIO.persist`'s local, gitignored, `0o600` file — this is unchanged from the existing `ai setup` behavior, just invoked from a second entrypoint.

## File Structure

```
packages/skills/
  package.json
  tsconfig.json
  skills/
    jevitate-explore/SKILL.md
    jevitate-record/SKILL.md
    jevitate-run-journey/SKILL.md
    jevitate-mission-scope/SKILL.md
    jevitate-load-test/SKILL.md
    jevitate-sources/SKILL.md
  src/
    index.ts
    frontmatter.ts
    frontmatter.test.ts
    manifest.ts
    manifest.test.ts

packages/cli/src/
  ai-cli.ts                 # export realSecureIO (was unexported)
  init-skills.ts
  init-skills.test.ts
  init-keys.ts
  init-keys.test.ts
  program.ts                 # init command extended
  program.test.ts            # extended

tsconfig.json                # + { "path": "packages/skills" }
vitest.config.ts             # + "@jevitate/skills": pkg("skills")
```

---

## Part A — `@jevitate/skills` package + the six `SKILL.md` files

### Task 1: Scaffold `@jevitate/skills`
- [ ] `packages/skills/package.json`: `{ "name": "@jevitate/skills", "version": "0.0.0", "type": "module", "main": "dist/index.js", "types": "dist/index.d.ts", "exports": { ".": "./dist/index.js" }, "files": ["dist", "skills"], "scripts": { "build": "tsc --build" } }` — no `dependencies` (Node builtins only).
- [ ] `packages/skills/tsconfig.json`: extends `../../tsconfig.base.json`, `rootDir: "src"`, `outDir: "dist"`, no references (leaf).
- [ ] `packages/skills/src/index.ts`: empty barrel to start.
- [ ] Add `{ "path": "packages/skills" }` to root `tsconfig.json`'s `references`.
- [ ] Add `"@jevitate/skills": pkg("skills")` to `vitest.config.ts`'s `resolve.alias`.

### Task 2: Frontmatter parser (pure, tiny, no yaml dependency)
- [ ] `packages/skills/src/frontmatter.test.ts`: 
  - Parses `---\nname: jevitate-explore\ndescription: Drives...\n---\nBody text.` into `{ name: "jevitate-explore", description: "Drives...", body: "Body text." }` (body has the frontmatter block stripped, leading blank line trimmed).
  - Throws a clear error on a missing closing `---` (malformed frontmatter — fail-closed, not "silently treat the whole file as body").
  - Throws on a missing `name:` or `description:` field.
  - A `description:` value containing a literal colon (e.g. `description: Drives jevitate explore: goal-based testing`) parses correctly (split on the **first** `:` only, not every `:`).
- [ ] `packages/skills/src/frontmatter.ts`: `export function parseFrontmatter(md: string): { name: string; description: string; body: string }` — split on the first two `---` lines, then per remaining frontmatter line split on the first `:`; no YAML nesting/lists supported (deliberately — only two flat string fields are ever needed here; a real YAML parser would be over-engineering for this).
- [ ] `pnpm exec vitest run packages/skills/src/frontmatter.test.ts`.

### Task 3: The six `SKILL.md` files

Each file: YAML frontmatter (`name`, `description`) + a body written as direct second-person instructions to the LLM that will read it (matching this session's own skill-listing style), grounded **only** in CLI/MCP surface verified to exist (or, where noted, explicitly flagged as depending on a sibling plan landing first). Each ends with a "Known gaps" section where the real surface is incomplete, so the skill never invents a working-sounding command that doesn't exist.

- [ ] `packages/skills/skills/jevitate-run-journey/SKILL.md`:
  ```markdown
  ---
  name: jevitate-run-journey
  description: Find and run a promoted Jevitate Journey by id, with typed params, via the jevitate CLI or the find_capabilities/run_journey MCP tools. Use when a user wants to execute a known, already-recorded browser automation (a login, a checkout, a form submission) rather than explore or record a new one.
  ---

  You drive already-published, promoted Jevitate Journeys. You never write or invent
  automation steps yourself — a Journey is a deterministic, pre-recorded, reviewed
  artifact; your job is to find the right one and run it with the right params.

  ## Discover

  - CLI: `jevitate journey find "<query>" --json` — searches promoted Journeys by
    name/description. Returns `{ id, name, description, params }[]`.
  - MCP: `find_capabilities(query)` returns the same shape. Prefer this when you are
    already inside an MCP-connected session — it is scoped to the same
    promoted-only allowlist.
  - `jevitate journey list --json` shows ALL Journeys including unpromoted ones —
    use this only for authoring/debugging with a human present, never to find
    something to run autonomously (an unpromoted Journey is unpromoted for a
    reason and `journey run`/`run_journey` will refuse it anyway).

  ## Run

  - CLI: `jevitate journey run <id> --param key=value --param key2=value2 --json`.
    Every param the `find`/`find_capabilities` result listed under `params` is
    required; passing an unknown param key is a refusal (`E_INVALID_PARAMS`), not
    a silent ignore.
  - MCP: `run_journey(id, params)` — same param-schema validation, same refusal on
    an unknown id or params.
  - Read the JSON envelope's `outcome` field. `"ok"` means it completed. Anything
    else (including a secret-handback pause) means it did not — report that
    honestly, do not summarize a non-`"ok"` outcome as success.

  ## What you must never do

  - Never pass inline steps, a raw URL, or a selector anywhere in this flow — you
    only ever pass an `id` that came from `find`/`find_capabilities`.
  - Never guess a param value that looks like a secret (a password, an API key) —
    if a Journey's params include something secret-shaped, tell the user it needs
    to be supplied by them or via the configured secret manager, never invent one.
  - Never try to run an id you have not first seen in a `find`/`find_capabilities`
    result in this same session — a promoted id can be revoked; don't rely on a
    memorized id from an earlier conversation.

  ## Known gaps (as of 2026-09-20)

  - There is currently no CLI/MCP command to *publish* or *promote* a new Journey
    — that happens via the `JourneyRegistry` TypeScript API today. If a user asks
    you to "save this as a Journey" or "promote this recording," tell them this
    isn't yet exposed as a command and point them at a human with repo access,
    rather than guessing at a command name.
  ```

- [ ] `packages/skills/skills/jevitate-record/SKILL.md`:
  ```markdown
  ---
  name: jevitate-record
  description: Post-process a captured Jevitate Recording — diff multiple takes, review/classify fill steps (postdoc), fit a timing policy, and promote a value to a variable — via the jevitate CLI. Use after a human has recorded one or more takes of a browser flow and wants to turn them into a parameterized, replayable artifact.
  ---

  You drive the **post-processing** half of Jevitate's human-driven authoring mode
  (RxD). A human has already recorded one or more "takes" (raw `Recording` JSON
  files, each produced by stepping through a browser flow) — your job is to turn
  those takes into a clean, parameterized `Recording` a Journey can be built from.
  You do not capture the recording yourself; there is no CLI step for that in this
  skill (see Known gaps).

  ## Diff multiple takes

  - `jevitate recording diff <takeA.json> <takeB.json> [more.json...] --json` —
    compares fill/select steps across takes and classifies each varying value
    (constant vs. likely-variable) with a confidence score. Read the confidences;
    do not treat a low-confidence classification as settled — surface it to the
    human via `postdoc` instead of deciding for them.

  ## Review and classify (postdoc)

  - `jevitate recording postdoc <take1.json> [more.json...] --decisions <decisions.json> --out <result.json> --json`
    applies a `PostdocDecision[]` (one decision per varying fill/select step:
    `classify: "constant" | "variable" | "handback"`, with a `name` for
    `"variable"` or a `prompt` for `"handback"`) non-interactively. Build the
    decisions file yourself from the `diff` output and the user's stated intent
    (e.g. "the quantity should be a variable, everything else is fixed") — do not
    ask the human to run the interactive prompt flow when you already know the
    answer from context.
  - Without `--decisions`, `postdoc` is interactive (prompts a human at the
    terminal) — only omit `--decisions` when you are explicitly handing control
    to a human, not when driving autonomously.

  ## Fit a timing policy

  - `jevitate recording fit <recording.json> --json` derives a `SitePolicy`
    (interaction timing) from a recording's captured pacing. Hand the result to
    `jevitate site policy set <site> --file <policy.json>` if the user wants it
    applied.

  ## Promote a value to a variable directly (single-take shortcut)

  - `jevitate recording promote <file.json> --page <n> --step <n> --var <name>` —
    for the simple case of a single take with one known value to parameterize,
    skipping the full diff/postdoc review flow.

  ## Known gaps (as of 2026-09-20)

  - There is no CLI command to **capture** a take from a live browser session in
    this skill's scope — recording capture is driven by `@jevitate/recorder`'s
    browser-injection primitives, not yet wrapped in a `jevitate` CLI verb. If a
    user asks you to "record a new take," tell them capture isn't yet a CLI
    command and ask how the existing take file was produced (or point them at a
    human with repo access), rather than inventing a `jevitate record start`-style
    command that does not exist.
  - There is no CLI command to publish the `postdoc` result as a runnable Journey
    (see `jevitate-run-journey`'s Known gaps) — the output of `postdoc`/`promote`
    is a `Recording` JSON file, one step short of a promoted `Journey`.
  ```

- [ ] `packages/skills/skills/jevitate-mission-scope/SKILL.md` (ticket #9's deliverable):
  ```markdown
  ---
  name: jevitate-mission-scope
  description: Reads a diff, pull request, changelog, or user story and scopes change-driven testing — identifies at-risk routes/features, maps them to existing promoted Journeys, runs the most relevant ones, and recommends which newly-discovered repros to promote. Use when a user wants to know "what should I test" after a code change, rather than testing everything or picking targets blindly.
  ---

  You scope testing to what actually changed. You never drive a browser yourself —
  Jev (the judgment gateway) makes browser-driving decisions inside the
  exploration engine, and the deterministic Journey runner executes promoted
  Journeys; your job is entirely the "what and why," spending tokens once to
  target instead of on every click.

  ## 1. Read the change

  Given a diff, PR description, changelog entry, or user story, identify:
  - Which routes/pages/features it plausibly touches (file paths → routes is a
    judgment call — a change to `src/checkout/*` plausibly affects the checkout
    flow even if no route string literally appears in the diff).
  - Whether it's additive (a new feature, lower regression risk to *existing*
    Journeys but a candidate for a *new* exploration goal) or modifying existing
    behavior (higher regression risk — prioritize existing promoted Journeys that
    exercise the touched area).
  - Anything explicitly called out as risky (auth, payment, data deletion) —
    weight these higher regardless of diff size.

  State your reasoning in one or two sentences before acting — "what changed" and
  "why this is (or isn't) at risk" — so the human reviewing your output can
  sanity-check the judgment, not just the commands you ran.

  ## 2. Map to existing promoted Journeys first

  - `jevitate journey find "<term>" --json` (or MCP `find_capabilities`) once per
    at-risk area you identified in step 1. Try more than one query term per area
    if the first returns nothing plausible — a Journey's `name`/`description`
    might not use the same words as the diff.
  - For each match, run it: `jevitate journey run <id> --param k=v ... --json` (or
    MCP `run_journey`). Read the `outcome` field; do not summarize a non-`"ok"`
    outcome as a pass.
  - If a promoted Journey exists for an at-risk area and it passes, that area has
    regression coverage — say so plainly; you do not need to additionally explore
    it from scratch.

  ## 3. Where no promoted Journey covers an at-risk area

  This is exactly the gap the exploration engine and `queue_exploration` exist
  for. Once both are available in your environment:
  - Prefer `jevitate-explore` (see that skill) or the `queue_exploration` MCP tool
    to scope a **bounded** goal-based mission at the specific at-risk area — a
    `goal` (or `feature`/`route`) plus a `successAssertion` you write from the
    diff/story's stated intent (e.g. "after submitting, the URL includes
    `/confirmation`"), never a vague "test everything" goal.
  - If neither `jevitate explore` nor `queue_exploration` is available yet in
    your environment, say so explicitly and stop there — do not attempt to drive
    a browser yourself with generic browser-automation tools; that would bypass
    every guardrail (bounded budget, independent assertion, redaction,
    deterministic Recording output) this platform exists to provide. Report the
    gap as a finding, not a failure to hide.

  ## 4. Recommend promotion of new repros

  After a `jevitate-explore`/`queue_exploration`-driven mission produces a new
  `Recording` (a "discovered repro"), you do not promote it yourself — promotion
  is a human-approval gate. Recommend, with reasoning: which discovered repros
  are worth promoting into the durable regression suite (does it cover a
  genuinely new, at-risk path? did it reveal a defect worth a permanent
  prove-broken/prove-fixed test?), and which are one-off exploratory noise not
  worth keeping. Narrow the regression set to what matters — quality over
  quantity.

  ## What you must never do

  - Never test everything indiscriminately when a diff/story is available to
    scope from — that defeats the entire purpose of this skill.
  - Never invent a Journey id, route, or param value — every id you run must have
    come from a `find`/`find_capabilities` result you saw in this session.
  - Never promote anything yourself — recommend, and let a human decide.

  ## Known gaps (as of 2026-09-20)

  - `jevitate explore` (the goal-based exploration CLI command) and the
    `queue_exploration` MCP tool may not yet be present in every environment —
    see `docs/superpowers/plans/2026-09-20-testing-missions-exploration-engine.md`
    and `docs/superpowers/plans/2026-09-20-ticket-8-mcp-queue-exploration.md`.
    Step 3 above degrades gracefully (report the gap) when they're absent.
  ```

- [ ] `packages/skills/skills/jevitate-explore/SKILL.md`:
  ```markdown
  ---
  name: jevitate-explore
  description: Scopes and runs a bounded, goal-based exploration mission via `jevitate explore` or the MCP `queue_exploration` tool — drives Jev (not you) to accomplish a stated goal on an authorized target and emits a replayable Recording. Use when there is no existing Journey for what needs testing and a human wants autonomous, bounded exploration toward a specific goal.
  ---

  You scope an exploration mission; you never drive the browser yourself. Jev
  (the judgment gateway) makes every click/type/select decision inside the
  exploration engine; a generative model writes only form text; an independent,
  user-supplied assertion — not the model's own "done" signal — decides whether
  the mission actually succeeded. Your entire job is composing a good `goal` and
  a good `successAssertion`, and reading the result honestly.

  ## Before you start

  - The target must already be authorized. This tool refuses an unknown or
    unauthorized target by design (guardrail: authoring/test plane only, never
    production writes). If you don't know whether a target is authorized, ask —
    do not guess a URL and hope it's accepted.
  - Write a `goal` in plain language describing the end state, not a sequence of
    clicks ("place an order for one widget and reach the confirmation page," not
    "click .add-to-cart then click #checkout").
  - Write a `successAssertion` independent of what you expect Jev to report — it
    should be checkable from the page state alone (e.g. "the URL includes
    `/confirmation`" or "an element with the order-number role is visible").
    Jev's own "goal met?" judgment is advisory only; the assertion is what
    actually decides success. If you cannot state a concrete, checkable
    assertion, that's a sign the goal itself is too vague — narrow it first.

  ## Running it

  - Local/CLI: `jevitate explore --url <authorized-url> --goal "<goal>" --success
    <assertion-spec> --allow <authorized-origin> --json` (flags per the
    exploration-engine plan; confirm the exact flag names against `jevitate
    explore --help` in your environment before relying on them verbatim, since
    this command is newer than the rest of the CLI surface).
  - Authoring-plane / from an MCP-connected session, or when you want to scope a
    mission without waiting for it to run synchronously: the `queue_exploration`
    MCP tool — `queue_exploration({ target, goal|feature|route, successAssertion,
    strategy: "goal-based", budget })`. This **enqueues** a bounded mission; it
    does not run it inline and returns immediately with a `missionId`. `target`
    must be a pre-registered, promoted mission target id — you cannot pass a raw
    URL here (ask a human to register the target first if it doesn't exist yet).

  ## Reading the result

  - The output is always a deterministic `Recording`, whether the mission
    succeeded, was `blocked`, or ran out of budget (`exhausted`). Report the
    actual `outcome`, not an optimistic gloss — a `blocked` or `exhausted`
    outcome with a partial Recording is still useful (it's a precise repro of how
    far Jev got) but it is not success.
  - A successful goal-based Recording is a candidate to hand to `jevitate-record`
    for postdoc review and eventual promotion into a runnable Journey — say so
    when it succeeds.

  ## What you must never do

  - Never widen `--allow`/the target beyond what the human explicitly authorized.
  - Never treat Jev's in-loop "done" signal as the final word — only the
    `successAssertion` result is.
  - Never ask the exploration engine to do anything on a production target — this
    is authoring/test-plane only, always.

  ## Known gaps (as of 2026-09-20)

  - As of this writing, `@jevitate/explore` and `jevitate explore` may not yet be
    built in your environment (see
    `docs/superpowers/plans/2026-09-20-testing-missions-exploration-engine.md`,
    P1) and `queue_exploration` may not yet be wired (see
    `docs/superpowers/plans/2026-09-20-ticket-8-mcp-queue-exploration.md`). If
    neither is available, say so plainly rather than falling back to a generic
    browser-automation tool — that would bypass every guardrail this skill
    exists to enforce.
  ```

- [ ] `packages/skills/skills/jevitate-load-test/SKILL.md`:
  ```markdown
  ---
  name: jevitate-load-test
  description: Runs a seeded, human-paced concurrent load test of a promoted Journey via `jevitate load run`, against an explicitly authorized target only. Use when a user wants a capacity/throughput measurement, not a single functional run.
  ---

  You scope and run a throughput/capacity measurement, never a single functional
  check (use `jevitate-run-journey` for that instead).

  ## Before you start — authorization is mandatory, not optional

  - `jevitate load run` refuses to start with zero `--authorized-origin` values
    (`E_LOAD_RUN`, "at least one --authorized-origin is required"). This is not a
    formality — running N concurrent actors against a target the operator hasn't
    explicitly authorized for load is exactly the kind of irreversible,
    high-blast-radius action this platform's guardrails exist to prevent. Never
    add an `--authorized-origin` value the human did not explicitly state.

  ## Running it

  - `jevitate load run <journeyId> --authorized-origin <origin> [--authorized-origin
    <origin2> ...] --param k=v --concurrency <n> --iterations <n> --seed <n>
    --json`.
  - `<journeyId>` must be a promoted Journey id (same discovery flow as
    `jevitate-run-journey`: `jevitate journey find`/`find_capabilities` first).
  - `--seed` makes the run reproducible — if the human wants to compare two
    configurations, keep the seed fixed and vary only `--concurrency`/
    `--iterations`.

  ## Reading the result

  - The report's metrics are always labeled `measured` or `modeled` — never
    report a `modeled` number as if it were `measured`, and if the report says a
    requested live run could not run, that is a failure to surface honestly, not
    a number to approximate around.

  ## What you must never do

  - Never run a load test against a target without an explicit, human-stated
    `--authorized-origin`.
  - Never scale `--concurrency`/`--iterations` up beyond what the human asked for
    "just to get a cleaner number" — a bigger run is a bigger real-world load on
    someone's infrastructure.
  ```

- [ ] `packages/skills/skills/jevitate-sources/SKILL.md`:
  ```markdown
  ---
  name: jevitate-sources
  description: Explains Jevitate's distributed Journey sources model (local vs. remote git-backed sources, trust/acknowledgement, lockfile pinning, risk classification) and how a federated Journey would be discovered/run once a CLI or MCP surface exists for it. Use when a user asks about sharing Journeys across repos, trusting a third-party Journey source, or the risk/trust model behind an external Journey — not for running an already-local promoted Journey (use jevitate-run-journey for that).
  ---

  You explain and reason about Jevitate's federated-Journey-source model. As of
  this writing there is **no CLI or MCP command surface** over this capability —
  `@jevitate/sources` is a fully built, tested TypeScript package
  (git-backed remote sources, a local source, trust/acknowledgement tracking, a
  lockfile for pinning a source at a specific commit, a publish flow, and a
  run-gate that classifies a federated Journey's risk before allowing it to run)
  with nothing yet wired to a command a user or an LLM can invoke directly.

  ## What you can do today

  - Explain the model accurately: a `JourneySource` (local or remote/git) exposes
    a promoted-only `list()`/`find()` just like a local `JourneyRegistry`; a
    `FederatedJourneyRegistry` aggregates multiple sources; each result is tagged
    with `source`, an optional `pin` (a locked commit/version), a `riskClass`
    (`"read-only" | "risky"`), and `trusted` (whether the consuming project has
    acknowledged that source) — see `packages/mcp-facade/src/journey-tools.ts`'s
    `findFederatedCapabilities` for the exact shape a caller would eventually see.
  - Help a user reason about trust/risk **conceptually** — e.g. "a `risky`,
    untrusted Journey from an unacknowledged source should not run without an
    explicit acknowledgement step" — without claiming there is a command that
    performs that acknowledgement today.
  - If asked to actually add, trust, or run a federated source, tell the user
    plainly that this isn't yet exposed as a CLI/MCP command and point them at
    `@jevitate/sources`'s programmatic API (for someone with repo access) rather
    than guessing at a `jevitate source ...` invocation that does not exist.

  ## What you must never do

  - Never invent a `jevitate source add/trust/run`-style command — it does not
    exist. Confidently guessing here produces a broken tool call, which is worse
    than saying "not yet available."
  - Never treat an untrusted or `risky`-classified federated Journey as safe to
    run just because a user asked — the trust/risk model exists precisely to gate
    that decision behind an explicit human step, even once a command surface
    ships.
  ```

- [ ] `pnpm exec vitest run` is not applicable to this task (no code yet) — instead, manually sanity-check every file parses: run Task 4's `manifest.test.ts` after writing it (next task) as the actual verification.

### Task 4: The manifest loader
- [ ] `packages/skills/src/manifest.test.ts`:
  - `loadManifest()` (default root = the package's own `skills/` dir, resolved relative to the module's location so it works both from `src` under `ts-node`/vitest and from `dist` after build) returns exactly 6 entries.
  - Every entry's `id` equals its directory name and starts with `jevitate-`.
  - Every entry's `name` (from frontmatter) equals its `id`.
  - Every entry's `description` is non-empty and under some sane length ceiling (e.g. 500 chars) — long enough to be useful, short enough that a tool-listing UI doesn't truncate it unreadably (matches this session's own available-skill descriptions' rough length).
  - `loadManifest(customDir)` against a `mkdtempSync` fixture with one deliberately malformed `SKILL.md` (missing `description:`) throws, naming the offending path — fail-closed, not a skipped/silently-dropped entry (a broken skill file should be loud, not quietly absent from the installed set).
  - The `jevitate-mission-scope` entry's `body` contains the literal substrings `journey find` and `journey run` (a regression guard: ticket #9 requires this skill to map to existing Journeys via those two specific commands — if a future edit removes that guidance, this test catches it).
- [ ] `packages/skills/src/manifest.ts`:
  ```ts
  import { readdirSync, readFileSync } from "node:fs";
  import { join, dirname } from "node:path";
  import { fileURLToPath } from "node:url";
  import { parseFrontmatter } from "./frontmatter.js";

  export interface ResolvedSkill {
    id: string;
    name: string;
    description: string;
    filePath: string;
    body: string;
  }

  const DEFAULT_SKILLS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "skills");

  export function loadManifest(skillsDir: string = DEFAULT_SKILLS_DIR): ResolvedSkill[] {
    const ids = readdirSync(skillsDir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort();
    return ids.map((id) => {
      const filePath = join(skillsDir, id, "SKILL.md");
      let parsed: ReturnType<typeof parseFrontmatter>;
      try {
        parsed = parseFrontmatter(readFileSync(filePath, "utf8"));
      } catch (err) {
        throw new Error(`invalid SKILL.md at ${filePath}: ${err instanceof Error ? err.message : err}`);
      }
      return { id, name: parsed.name, description: parsed.description, filePath, body: parsed.body };
    });
  }
  ```
  (`DEFAULT_SKILLS_DIR` resolves relative to the compiled `dist/manifest.js`'s own location, i.e. `dist/../skills` = the package root's `skills/` — matches the `package.json` `"files"` list shipping both `dist` and `skills` as siblings.)
- [ ] `packages/skills/src/index.ts`: `export * from "./frontmatter.js"; export * from "./manifest.js";`.
- [ ] `pnpm exec vitest run packages/skills/src/manifest.test.ts`.
- [ ] `git add packages/skills/package.json packages/skills/tsconfig.json packages/skills/skills packages/skills/src tsconfig.json vitest.config.ts` (explicit paths); commit: `feat(skills): add @jevitate/skills — the six-skill jevitate skill set (closes #9's skill deliverable)`.

---

## Part B — `jevitate init`: credential collection + skill installation

### Task 5: Export `realSecureIO` from `ai-cli.ts`
- [ ] No new test needed (behavior-preserving visibility change) — but extend `packages/cli/src/ai-cli.test.ts` with one line confirming `realSecureIO` is now an exported member of the module (a type-level/import check is sufficient; it's already behaviorally tested via `ai setup`'s existing tests).
- [ ] `packages/cli/src/ai-cli.ts`: change `function realSecureIO()` → `export function realSecureIO()`. No other change.
- [ ] `pnpm exec vitest run packages/cli/src/ai-cli.test.ts`.

### Task 6: Credential-collection step for `init`
- [ ] `packages/cli/src/init-keys.test.ts`:
  - With a fake `CredentialStore` missing both keys and a fake `SecureKeyIO`, `collectAllMissingKeys(store, io)` collects both `generation` and `judgment` features' keys and returns `{ generation: { required: [...], collected: [...] }, judgment: { required: [...], collected: [...] } }`.
  - With both keys already present, returns both features with empty `collected` arrays and `io.promptSecret` is never called (assert via spy — never prompt for a key that's already configured).
  - If `io.promptSecret` throws/rejects for one feature (user aborts), the function surfaces that as a rejected promise (fail-closed — `init` must not report a bogus "collected" for a feature that actually failed); the plan's `init` command action must catch this per-feature so one aborted feature doesn't prevent reporting the other feature's already-complete status (see Task 8).
- [ ] `packages/cli/src/init-keys.ts`:
  ```ts
  import { collectMissingKeys, FEATURE_KEYS, type CredentialStore, type SecureKeyIO, type Feature, type CredentialKey } from "@jevitate/ai-core";

  export interface FeatureKeyReport { required: CredentialKey[]; collected: CredentialKey[] }
  export type KeyCollectionReport = Record<Feature, FeatureKeyReport>;

  const FEATURES: Feature[] = ["generation", "judgment"];

  /** Thin orchestration over the existing, already-guardrailed
   *  `collectMissingKeys` — collects every feature's missing keys in turn
   *  (never in parallel: `SecureKeyIO.promptSecret` is a single shared stdin,
   *  concurrent prompts would interleave). Adds no new key-handling logic. */
  export async function collectAllMissingKeys(
    store: CredentialStore,
    io: SecureKeyIO,
  ): Promise<KeyCollectionReport> {
    const report = {} as KeyCollectionReport;
    for (const feature of FEATURES) {
      const collected = await collectMissingKeys(feature, store, io);
      report[feature] = { required: [...FEATURE_KEYS[feature]], collected };
    }
    return report;
  }
  ```
- [ ] `pnpm exec vitest run packages/cli/src/init-keys.test.ts`.

### Task 7: Runtime detection + install-target paths
- [ ] `packages/cli/src/init-skills.test.ts` (part 1 — detection, using injected `existsSync`/`homedir`/`cwd`, no real filesystem touched):
  - `detectRuntimes({ existsSync: (p) => p === "/home/u/.claude", homedir: () => "/home/u", cwd: () => "/proj" })` returns `["claude-code", "generic"]` (Codex/Cursor absent, generic always present).
  - With `/home/u/.codex` and `/proj/.cursor` also existing, returns all four: `["claude-code", "codex", "cursor", "generic"]`.
  - With nothing existing, returns `["generic"]` only — never an empty array (Decision 3/Guardrail 4).
- [ ] `packages/cli/src/init-skills.ts` (part 1):
  ```ts
  import { existsSync as realExistsSync } from "node:fs";
  import { homedir as realHomedir } from "node:os";
  import { join } from "node:path";

  export type RuntimeId = "claude-code" | "codex" | "cursor" | "generic";

  export interface DetectionDeps {
    existsSync?: (path: string) => boolean;
    homedir?: () => string;
    cwd?: () => string;
  }

  export function detectRuntimes(deps: DetectionDeps = {}): RuntimeId[] {
    const existsSync = deps.existsSync ?? realExistsSync;
    const homedir = deps.homedir ?? realHomedir;
    const cwd = deps.cwd ?? process.cwd;
    const detected: RuntimeId[] = [];
    if (existsSync(join(homedir(), ".claude"))) detected.push("claude-code");
    if (existsSync(join(homedir(), ".codex"))) detected.push("codex");
    if (existsSync(join(cwd(), ".cursor"))) detected.push("cursor");
    detected.push("generic"); // always-on fallback target — see Decision 3 / Guardrail 4
    return detected;
  }

  export interface InstallTargetPaths {
    claudeSkillsDir: string;
    codexAgentsFile: string;
    cursorRulesDir: string;
    genericAgentsFile: string;
    genericSkillsDir: string;
  }

  export function resolveInstallTargetPaths(deps: DetectionDeps = {}): InstallTargetPaths {
    const homedir = deps.homedir ?? realHomedir;
    const cwd = deps.cwd ?? process.cwd;
    return {
      claudeSkillsDir: join(homedir(), ".claude", "skills"),
      codexAgentsFile: join(homedir(), ".codex", "AGENTS.md"),
      cursorRulesDir: join(cwd(), ".cursor", "rules"),
      genericAgentsFile: join(cwd(), "AGENTS.md"),
      genericSkillsDir: join(cwd(), ".agent", "skills"),
    };
  }
  ```
- [ ] `pnpm exec vitest run packages/cli/src/init-skills.test.ts` (part 1 tests only at this point).

### Task 8: Install planning (the shared idempotency/conflict decision) + whole-file targets
- [ ] `packages/cli/src/init-skills.test.ts` (part 2 — `planFileInstall`, whole-file targets, using `mkdtempSync` for a real temp dir since this exercises real file reads):
  - Target file doesn't exist → `"create"`.
  - Target file exists, its content's sha256 matches the recorded `lastInstalledHash`, and the new content differs from current content → `"update"`.
  - Target file exists, hash matches recorded hash, new content is identical to current content → `"unchanged"`.
  - Target file exists, its content's sha256 does **not** match the recorded `lastInstalledHash` (or no hash was ever recorded for this path) → `"skip-user-modified"`.
  - `"skip-user-modified"` with `force: true` → `"update"` (force overrides the skip, still reported as an override, not silently).
- [ ] `packages/cli/src/init-skills.ts` (part 2):
  ```ts
  import { createHash } from "node:crypto";
  import { readFile, mkdir, writeFile } from "node:fs/promises";
  import { dirname } from "node:path";

  export type InstallAction = "create" | "update" | "unchanged" | "skip-user-modified" | "force-update";

  function sha256(s: string): string {
    return createHash("sha256").update(s, "utf8").digest("hex");
  }

  export async function planFileInstall(
    targetPath: string,
    newContent: string,
    lastInstalledHash: string | undefined,
    opts: { force?: boolean } = {},
  ): Promise<InstallAction> {
    let current: string | undefined;
    try {
      current = await readFile(targetPath, "utf8");
    } catch {
      return "create"; // ENOENT (or any read failure) — treat as absent, fail toward creating fresh
    }
    const currentHash = sha256(current);
    const userModified = lastInstalledHash === undefined || currentHash !== lastInstalledHash;
    if (userModified && !opts.force) return "skip-user-modified";
    if (userModified && opts.force) return "force-update";
    return currentHash === sha256(newContent) ? "unchanged" : "update";
  }

  export async function applyFileInstall(targetPath: string, content: string, action: InstallAction): Promise<void> {
    if (action === "unchanged" || action === "skip-user-modified") return;
    await mkdir(dirname(targetPath), { recursive: true });
    await writeFile(targetPath, content, "utf8");
  }
  ```
- [ ] `pnpm exec vitest run packages/cli/src/init-skills.test.ts` (part 2 tests).

### Task 9: Marked-block targets (Codex + generic `AGENTS.md`)
- [ ] `packages/cli/src/init-skills.test.ts` (part 3 — block extraction/merge, pure string functions, no I/O):
  - `renderSkillsBlock(skills)` produces a block wrapped in `<!-- BEGIN JEVITATE SKILLS v1 -->`/`<!-- END JEVITATE SKILLS v1 -->` markers, one entry per skill (name + description + either an inline body or a path reference, per a `mode: "inline" | "reference"` param).
  - `mergeBlock(existingFileContent, newBlock)` — file with no existing markers → block appended at the end (with a leading blank line if the file is non-empty and doesn't already end in one). File with existing markers → only the text between them is replaced; everything before the opening marker and after the closing marker is returned byte-identical (this is Guardrail 3's direct test — assert the "before"/"after" text outside the markers via string equality, not just "no error thrown").
  - `mergeBlock` run twice in a row with the same `newBlock` is idempotent (second run's output equals the first run's output).
  - `extractBlockHash(fileContent)` returns the sha256 of just the current block's inner text (or `undefined` if no block present) — this is what `planFileInstall`'s block-target counterpart hashes, so a user's edits *outside* the block never register as "modified" and edits *inside* the block do.
- [ ] `packages/cli/src/init-skills.ts` (part 3): `renderSkillsBlock`, `mergeBlock`, `extractBlockHash`, and a `planBlockInstall`/`applyBlockInstall` pair mirroring Task 8's file-level pair but operating on `extractBlockHash` instead of a whole-file hash, and on `mergeBlock`'s output instead of a raw overwrite.
- [ ] `pnpm exec vitest run packages/cli/src/init-skills.test.ts` (part 3 tests).

### Task 10: `installSkills` orchestrator + persisted state
- [ ] `packages/cli/src/init-skills.test.ts` (part 4 — integration, `mkdtempSync` for home/cwd/state):
  - First run with `detectRuntimes` returning `["claude-code", "generic"]` and 2 fake skills: writes `~/.claude/skills/<id>/SKILL.md` for each (byte-identical to source), writes/creates `<cwd>/AGENTS.md` with the marked block, writes `<cwd>/.agent/skills/<id>/SKILL.md` for each; returns a report listing every (target, skill) pair's action (`"create"` for all, this being a first run).
  - Second run, nothing changed on disk or in the skill set: every pair reports `"unchanged"`, and (assert via spies) no `writeFile` call happens at all.
  - Between runs, hand-edit one installed `~/.claude/skills/<id>/SKILL.md` file: next run reports `"skip-user-modified"` for that one pair only, leaves the file untouched, and every other pair still updates/stays unchanged normally.
  - Same hand-edit scenario with `{ force: true }`: reports `"force-update"` and the file is overwritten to match the current source.
  - The state file (`skills-install-state.json`, at an injected path) is updated after every non-`"skip-user-modified"` write with that write's new content hash, and is itself never the source of truth for *whether to write generic targets always-on* — only for conflict detection.
- [ ] `packages/cli/src/init-skills.ts` (part 4): `installSkills(runtimes: RuntimeId[], skills: ResolvedSkill[], paths: InstallTargetPaths, statePath: string, opts: { force?: boolean; dryRun?: boolean }): Promise<InstallReport[]>` — loads/parses `statePath` (missing file → empty state, matching `ai-cli.ts`'s `realSecureIO().persist`'s "no existing file yet" fallback pattern), computes every (detected runtime × skill) pair's plan via Task 8/9's functions, applies each (unless `dryRun`), rewrites `statePath` with the updated hash map, and returns `InstallReport[]` (`{ target: RuntimeId; skillId: string; path: string; action: InstallAction }`).
- [ ] `pnpm exec vitest run packages/cli/src/init-skills.test.ts` (full file).
- [ ] `git add packages/cli/package.json packages/cli/src/ai-cli.ts packages/cli/src/init-keys.ts packages/cli/src/init-keys.test.ts packages/cli/src/init-skills.ts packages/cli/src/init-skills.test.ts` (explicit paths; add `"@jevitate/skills": "workspace:*"` to `packages/cli/package.json`'s `dependencies` in this same change); commit: `feat(cli): add init-keys + init-skills — detect/plan/install mechanics for jevitate init`.

### Task 11: Wire `jevitate init`
- [ ] `packages/cli/src/program.test.ts`: extend with cases exercising the real `init` command end-to-end against injected `CliDeps` (a fake `ai` store/io per `ai-cli.test.ts`'s existing pattern, and injected `detectRuntimes`/`resolveInstallTargetPaths`/a temp `statePath` per `init-skills.test.ts`'s pattern):
  - Bare `jevitate init --json` with both keys already present and a clean skill install (first run): envelope's `data` includes `{ initialized: true, keys: {...}, skills: [...] }`.
  - `jevitate init --skip-keys --json`: `data.keys` is omitted or `null`; skill install still runs.
  - `jevitate init --skip-skills --json`: `data.skills` is omitted or `null`; key collection still runs.
  - `jevitate init --targets cursor --skip-keys --json` on a fixture with no `.cursor` dir present: Cursor is still installed to (explicit `--targets` overrides detection, per Decision 3), while Codex/Claude Code are not (neither detected nor named).
  - `jevitate init --dry-run --skip-keys --json`: reports the same planned actions as a real run but performs no writes (assert via spy).
- [ ] `packages/cli/src/program.ts`: extend the existing `init` command:
  ```ts
  program
    .command("init")
    .option("--json", "emit a JSON envelope")
    .option("--skip-keys", "skip credential collection")
    .option("--skip-skills", "skip skill installation")
    .option("--targets <ids>", "comma-separated runtime ids to force-install to, overriding detection")
    .option("--force", "overwrite a user-modified installed skill file/block")
    .option("--dry-run", "report planned skill-install actions without writing")
    .action(async function (this: Command) {
      const { json, skipKeys, skipSkills, targets, force, dryRun } = this.opts<{
        json?: boolean; skipKeys?: boolean; skipSkills?: boolean;
        targets?: string; force?: boolean; dryRun?: boolean;
      }>();
      try {
        const data: Record<string, unknown> = { initialized: true };
        if (!skipKeys) {
          const store = buildAiStore(deps.ai); // same store construction `ai-cli.ts` uses
          const io = deps.ai?.secureIO ?? realSecureIO();
          data.keys = await collectAllMissingKeys(store, io);
        }
        if (!skipSkills) {
          const runtimes = targets
            ? (targets.split(",") as RuntimeId[])
            : detectRuntimes(deps.init?.detection);
          const paths = resolveInstallTargetPaths(deps.init?.detection);
          const statePath = deps.init?.statePath ?? resolveDataDir(["skills-install-state.json"]);
          const skills = loadManifest();
          data.skills = await installSkills(runtimes, skills, paths, statePath, { force, dryRun });
        }
        const envelope = ok(data);
        if (json) {
          emitJson(program, envelope);
        } else {
          const out = program.configureOutput().writeOut;
          out?.("jevitate initialized\n");
          if (data.keys) out?.(`keys: ${JSON.stringify(data.keys)}\n`);
          if (data.skills) out?.(`skills: ${(data.skills as unknown[]).length} target/skill pairs processed\n`);
          process.exitCode = 0;
        }
      } catch (err) {
        emitJson(program, fail("E_INIT", String(err instanceof Error ? err.message : err)));
      }
    });
  ```
  (`CliDeps` gains an optional `init?: { detection?: DetectionDeps; statePath?: string }` field, additive and test-only-in-practice, mirroring the existing `ai?: AiCliDeps` optional-injection convention; production `buildProgram` calls that omit `init` get the real `existsSync`/`homedir`/`cwd` and the real `~/.jevitate/skills-install-state.json` path.)
- [ ] `pnpm exec vitest run packages/cli/src/program.test.ts`.

### Task 12: Full-suite regression + exit gate
- [ ] `pnpm exec vitest run` (whole repo).
- [ ] `node scripts/check-no-permissive-fallback.mjs` — confirms `planFileInstall`'s `"skip-user-modified"` path isn't flagged as a silent-success-on-error pattern (it isn't: it's a reported, non-error branch, not a caught error turned into a fake `ok`) and that no init/skill-install code path swallows an error into a fake success.
- [ ] `tsc --build` at the root — confirms both new project references compile.
- [ ] `git add packages/cli/src/program.ts packages/cli/src/program.test.ts` (explicit paths); commit: `feat(cli): wire jevitate init to credential preflight + skill-set install`.

**Acceptance:** `jevitate init` (a) collects any missing `OPENROUTER_API_KEY`/`TYPESAFE_API_KEY` exactly as `ai setup` already does (same masked prompt, same `0o600` local persistence, key never echoed/logged/sent to a model); (b) detects Claude Code (`~/.claude`), Codex (`~/.codex`), and Cursor (`.cursor` in cwd), always additionally targeting the generic project-local fallback; (c) installs all six `@jevitate/skills` skills into every detected/`--targets`-named runtime, idempotently (a clean re-run performs zero writes); (d) never overwrites a user-hand-edited installed file or block without `--force` or interactive confirmation, and reports every skip explicitly; (e) `--dry-run` previews with zero writes.

## Out of scope (explicitly deferred)

- **Interactive confirm-per-conflict prompt.** Task 11 wires `--force` as the non-interactive override; an interactive `y/N` prompt per `"skip-user-modified"` pair (for a human running `init` at a real terminal without `--force`/`--json`) is a small additive follow-up using the same `@clack/prompts` dependency `program.ts` already has for `recording postdoc` — omitted here to keep this plan's scope to the mechanics ticket #9/the parent task actually require; today, a real-terminal run without `--force` simply reports the skip (safe default) rather than blocking on a prompt.
- **A `jevitate skills list/uninstall` command.** Useful, not required for this ticket's acceptance criteria.
- **Auto-updating an installed skill when `@jevitate/skills`'s content changes via `pnpm update`.** `init` must be re-run manually to pick up new skill content — there's no watch/auto-sync mechanism, which is appropriate for a CLI-driven installer.

## Risks / open decisions

- **Codex's actual `AGENTS.md` convention is inferred, not verified against Codex's own docs in this session.** If Codex's real global-instructions path or format differs from `~/.codex/AGENTS.md`, Task 9's implementation is still structurally sound (marked-block merge into *some* file) but the path constant in `resolveInstallTargetPaths` would need correcting — flagged explicitly so a reviewer checks this against current Codex documentation before merging, rather than trusting it silently.
- **Cursor `.mdc` frontmatter fields** (`description`/`globs`/`alwaysApply`) are asserted from general knowledge of Cursor Rules, not verified in this session — same caveat as above; the install *mechanics* (idempotent per-file write) don't depend on getting the frontmatter shape exactly right, but the installed rule's *effectiveness* in Cursor does.
- **Six skills is a lot of prose to keep accurate as the CLI surface grows.** Every "Known gaps" section above is a maintenance liability — when `jevitate explore`/`queue_exploration`/a Journey-publish command/a sources CLI ship, their skill's "Known gaps" section must be edited down (not just added to). Recommend a lint-style follow-up: `manifest.test.ts` (or a new test) that fails if a skill's body still says a command "does not exist" once that command's own package/CLI test suite proves it does — not built in this plan (would require cross-package test coupling), flagged as a real drift risk instead.
- **`planFileInstall`'s `ENOENT`-or-any-read-failure → `"create"` collapse** (Task 8) means a permissions error reading an existing file is indistinguishable from "file doesn't exist," and the subsequent `writeFile` would then surface the real permissions error at write time instead of at plan time. Acceptable (the error still surfaces, just one step later, and `applyFileInstall`'s `writeFile` failure is not caught/swallowed anywhere in this plan), but worth a reviewer's eye given the "fail-closed" bar the rest of the repo holds itself to.
