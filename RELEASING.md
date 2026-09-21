# Releasing

Jevitate publishes two public packages to npm:

- **`@jevitate/cli`** — the CLI (all internal `@jevitate/*` packages are bundled in; native deps stay external).
- **`jevitate`** — a thin bare-name alias so `npm install -g jevitate` works; it depends on `@jevitate/cli`.

All other `packages/*` are `private` and never published.

## First release — manual (no token)

The first publish is done by hand. npm prompts for your 2FA one-time password interactively, so no long-lived automation token is stored (nothing to expire or leak).

Prerequisites:

- `npm login` as a publisher in the `@jevitate` org who also owns the `jevitate` name.
- A clean, up-to-date `main`.
- Your authenticator app.

```bash
bash scripts/release.sh
```

It builds, bundles `@jevitate/cli`, then publishes `@jevitate/cli` first and `jevitate` second (order matters — the alias resolves its `workspace:*` dependency to the just-published version), prompting for your OTP at each step. Verify:

```bash
npm install -g @jevitate/cli && jevitate --version
```

## Subsequent releases — OIDC Trusted Publishing (recommended)

Once both packages exist on npm, releases run via npm **OIDC Trusted Publishing** — GitHub Actions authenticates to npm over OIDC, so there is **no token to store, rotate, or expire**, and every release is published with provenance.

`.github/workflows/release.yml` is already configured for this (`id-token: write`, `NPM_CONFIG_PROVENANCE`, no `NPM_TOKEN`, npm upgraded to an OIDC-capable version, publish on push to `main`). The only remaining step is on npm's side:

1. On npmjs.com, for **each** package (`@jevitate/cli` and `jevitate`) → the package's **Settings → Trusted Publishers** → add a GitHub Actions publisher pointing at repo `matt-cochran/jevitate` and workflow `release.yml`.
2. Delete any leftover `NPM_TOKEN` repository secret — OIDC makes it unnecessary.

After that, a push to `main` publishes automatically. You can also trigger a run manually (**Actions → Release → Run workflow**) to test the OIDC path. Until the Trusted Publisher is configured, the publish step will fail (auth) — expected.

## Versioning

Changesets is configured (internal packages are in the `ignore` list). To cut a version bump, add a changeset (`pnpm changeset`), which updates `@jevitate/cli` + `jevitate`; then release.
