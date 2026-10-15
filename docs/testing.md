# Testing

Jevitate's default test run needs no network and no credentials. The suites below are the
exception: they call **paid APIs** and are skipped unless you opt in.

## Everyday test commands

The rules live in [AGENTS.md](../AGENTS.md), under **TEST (WSL-critical)**. In short:

- Always run from the repo root with explicit paths.
- A package or folder: `pnpm exec vitest run packages/<pkg>/src`.
- One file: `pnpm exec vitest run packages/<pkg>/src/<file>.test.ts`.
- Never bare `pnpm exec vitest run` (the whole-repo run hangs on WSL).
- Never `pnpm --filter <pkg> exec vitest ...` (it breaks the root include globs).

See [AGENTS.md](../AGENTS.md) for the full rules (parallelism caps, `--changed`, the clock
rules) rather than duplicating them here.

## Opt-in live suites

Both suites are skipped unless the flag **and** the key are present in the environment. CI never
sets them, so CI skips them by design. Keys come from the environment only; never commit keys.

| Suite file | Enable flags + keys | What it proves | Approximate cost | When it must run |
|---|---|---|---|---|
| `packages/cli/src/ux-quality.integration.test.ts` | `RUN_UX_QUALITY=1` + `TYPESAFE_API_KEY` + `OPENROUTER_API_KEY` | Full UX corpus replay against `packages/cli/scripts/ux-quality/baseline.json`: the actionable+relevant share and run-to-run consistency of shown findings hold per app. | Many model calls — see `packages/cli/scripts/ux-quality/README.md`. | When UX prompts/rubric change, or before a release touching `packages/ux`. |
| `packages/cli/src/ai-live.integration.test.ts` | Two describes: `RUN_OPENROUTER_TESTS=1` + `OPENROUTER_API_KEY`; `RUN_TYPESAFE_TESTS=1` + `TYPESAFE_API_KEY` | The production OpenRouter and Jev clients each complete one real call (a generated form value; a trivially true yes/no answer). | One tiny call each — cents. | On provider SDK bumps (`ai`, `@openrouter/ai-sdk-provider`, `@typesafe-ai/sdk`) or changes to `packages/ai-core` / `packages/cli/src/openrouter-call.ts`. |

### Running them

`pnpm test:live` runs exactly the two files above with explicit paths; the env flags still decide
what actually executes, so with no flags it is a free, fully skipped pass.

```sh
# Cheap smoke: one tiny real call per provider.
RUN_OPENROUTER_TESTS=1 RUN_TYPESAFE_TESTS=1 pnpm test:live

# Full UX quality regression (many model calls).
RUN_UX_QUALITY=1 pnpm test:live
```

CI skips both by design (no keys are available in CI). Keys are read from the environment only and
are never logged or persisted; never commit a key.
