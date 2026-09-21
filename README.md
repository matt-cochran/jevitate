# Jevitate

Jevitate is a local browser-automation platform: it records real browser
sessions into reusable, typed **Journeys** (Screenplay-pattern actions on top
of Playwright), then replays, loads-tests, and orchestrates them from a
single CLI or an MCP-compatible facade.

## Install

```bash
npm i -g @jevitate/cli
# or, equivalently, the bare-name alias:
npm i -g jevitate
```

Both give you the `jevitate` command:

```bash
jevitate --help
```

`@jevitate/cli` is a single bundled package — all internal `@jevitate/*`
workspace code is compiled into its `dist/bin.js` via esbuild. Only a small
set of native/heavy dependencies (`playwright`, `better-sqlite3`, and a few
others that can't or shouldn't be bundled) install alongside it as real npm
dependencies. `jevitate` (the bare name) is a thin wrapper that re-execs the
same `@jevitate/cli` binary.

## Repository layout

This is a pnpm workspace (`packages/*`, `apps/*`, `site-integrations/*`).
Every package except `@jevitate/cli` and `jevitate` is `"private": true` —
internal, dev-time modules that get bundled into the published CLI rather
than published on their own.

## Development

```bash
pnpm install
pnpm -r build
pnpm exec vitest run
pnpm lint
```

## Branching (gitflow)

Work happens on feature branches off `dev`, merges through
`dev -> staging -> main`. CI runs on pushes/PRs targeting `dev`, `staging`,
and `main` (`.github/workflows/ci.yml`). A push to `main` triggers the
release workflow (`.github/workflows/release.yml`), which uses
[changesets](https://github.com/changesets/changesets) to version and
publish `@jevitate/cli` and `jevitate` to npm — a no-op until the `NPM_TOKEN`
repository secret is configured.

## License

MIT — see [LICENSE](./LICENSE).
