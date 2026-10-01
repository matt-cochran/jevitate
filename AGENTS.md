# Project Context & Archetype

- pnpm@9 monorepo, Node>=20, TS/ESM. Workspaces: `packages/*`, `apps/*`. vitest, esbuild, changesets.
- Only `@jevitate/cli` (+ bare `jevitate` alias) is published; every other `packages/*` is private and bundled INTO the cli by esbuild — native deps (playwright, better-sqlite3) stay external. Product noun = "Journey" (intentional, never "fix").
- Build: `pnpm -r build`. Lint: `pnpm lint`. Bundle: `pnpm --filter @jevitate/cli run bundle`. Safety gate: `pnpm check:no-fallback`.
- TEST (WSL-critical), always from repo root with explicit paths:
  - A package or folder: `pnpm exec vitest run packages/<pkg>/src`. This is the default for suites. vitest.workspace.ts runs `unit` files fully parallel and caps real-Chromium `browser` files at 2. You may run two packages at once when the load average is under ~20.
  - One file: `pnpm exec vitest run packages/<pkg>/src/<file>.test.ts`. Use it for a focused change, or to retry a failure alone (load can time out browser tests).
  - During integration, run the changed and dependent tests first (`vitest run --changed <ref>` on package paths, or graft callers), and the full package pass at the end.
  - NEVER bare `pnpm exec vitest run` (the whole-repo run hangs on WSL) and NEVER `pnpm --filter <pkg> exec vitest ...` (breaks the root include globs). Don't loop file-by-file over a whole package; it throws away parallelism.
- Invariants: the allowlist/forbidden tool boundary in `@jevitate/mcp-facade` is sacred — served MCP tools must equal `ALLOWED_TOOLS`. Credentials never reach the model; secrets never persist at rest. Jev = advisory-only judgment; independent code adjudicates.
- Gitflow: feature branch → PR → dev → staging → main. Branch-protected: no direct commits/force-push; PR + review required.
- WSL: repo on `/mnt/c` drvfs → each parallel git-worktree `pnpm install` copies node_modules onto C: (disk spike). Avoid parallel worktree installs.

# Agent Routing Rules

- Main agent: simple/local edits; no worker overhead.
- ECONOMY (Haiku-class): search, inventory, extraction, log/test-output triage, docs.
- BALANCED (Sonnet-class): routine implement/refactor/debug/test authoring.
- FRONTIER (Opus-class): cross-package architecture, auth/security, the MCP/secret boundary, schema/data migration, hard root-cause after a cheaper tier fails.
- Model unavailable → inherit/default; never fabricate an ID.
- Parallelize independent read-only investigations only; never tightly-coupled writes. Worker returns ≤10 lines / ≤300 tokens.

# Sub-Workspace Routing

- `packages/cli` — CLI + MCP/UI servers; bundles all internal pkgs. Test path-scoped.
- `packages/mcp-facade` — the tool allowlist/forbidden boundary; changes are security-sensitive.
- Other `packages/*` — private libs the cli consumes. Stay in the active scope; cross a boundary only on dependency evidence; a shared-pkg change inspects direct dependents only.

# Context Management

- Narrow search before broad; no repo-wide reads by default. Noisy exploration → isolate in a cheap worker.
- 60% ctx: stop bulk reads, summarize. 75%: isolate new investigation. 85%: checkpoint + fresh session. Prefer a fresh session over repeated compaction. Worker result ≤300 tokens.

# Zero-Prose Output Directives

- No greeting/preamble/outro/apology/restatement. Direct technical answer only.
- Edits via tools; don't echo changed files. Patch on request: unified diff, U=3, touched hunks only. No full-file dumps unless asked.
- Normal final ≤10 lines: changed paths + validation result.
