<!-- Thanks for contributing to Jevitate! Keep PRs focused. Target the `dev` branch. -->

## What & why

<!-- What does this change and why? Link any issue: Closes #NNN -->

## Checklist

- [ ] Tests added/updated (TDD — a failing test first)
- [ ] `pnpm -r build`, `pnpm exec vitest run`, and `pnpm lint` pass locally
- [ ] Change is **additive** (existing command/API behavior unchanged)
- [ ] No permissive fallbacks — fails fast with actionable errors
- [ ] Security invariants preserved (secrets never to a model; authorized-origin-only; bounded; model judgments advisory) — see SECURITY.md
- [ ] Targets `dev`
