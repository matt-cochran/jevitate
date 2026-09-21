# Contributing to Jevitate

Thanks for your interest in Jevitate. This guide covers the setup, workflow, and
the few conventions that keep the project consistent.

## Development setup

Jevitate is a pnpm workspace (Node ≥ 20).

```bash
pnpm install
pnpm -r build          # tsc project references
pnpm exec vitest run   # the test suite
pnpm lint              # eslint
```

Run a single package's tests with `pnpm exec vitest run packages/<name>` (avoid
`pnpm --filter <pkg> test` — packages have no `test` script, so it is a silent
no-op).

## Branching

Work on a feature branch off `dev` and open a pull request into `dev`
(`dev → staging → main`). CI runs on `dev`, `staging`, and `main`.

## Conventions

- **Test-driven.** Add a failing test first, then the minimal code to pass it.
  Prefer small, declarative assertions.
- **Additive changes.** Extend existing commands/APIs rather than changing their
  behavior; keep new work behind new surfaces.
- **Fail fast, no silent fallbacks.** Refuse with an actionable error rather than
  papering over a problem. `scripts/check-no-permissive-fallback.mjs` runs in CI
  and must stay clean.
- **Security invariants are load-bearing** (see [SECURITY.md](./SECURITY.md)):
  credentials/secrets never reach a model; browsing is restricted to authorized
  origins; exploration is bounded; model judgments are advisory and never
  unilaterally gate an action. Every guardrail has an "asserts-it-refuses" test —
  keep it that way.

## Pull requests

Keep PRs focused, include tests, and make sure `pnpm -r build`,
`pnpm exec vitest run`, and `pnpm lint` pass. The CI workflow enforces all three
plus the no-permissive-fallback gate.

## Releases

Publishing is maintainer-only — see [RELEASING.md](./RELEASING.md).
