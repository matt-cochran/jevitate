<!-- Thanks for contributing to Jevitate! Keep PRs focused. Target the `dev` branch. -->

## What & why

<!-- What does this change and why? Link any issue: Closes #NNN -->

## Checklist

- [ ] Tests added/updated (TDD — a failing test first)
- [ ] `pnpm -r build`, the path-scoped tests for what I touched (`pnpm exec vitest run packages/<pkg>/src/...`), `pnpm lint` and `pnpm check:no-fallback` pass locally
- [ ] Change is **additive** (existing command/API behavior unchanged)
- [ ] No permissive fallbacks — fails fast with actionable errors
- [ ] Security invariants preserved (secrets never to a model; authorized-origin-only; bounded; model judgments advisory) — see SECURITY.md
- [ ] User-facing change: a changeset (`pnpm changeset`) and a `CHANGELOG.md` line
- [ ] Docs updated (`README.md` / `docs/`), and every command shown exists in `--help`
- [ ] Targets `dev`
