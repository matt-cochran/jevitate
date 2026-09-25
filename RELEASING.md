# Releasing

Jevitate publishes two public packages to npm:

- **`@jevitate/cli`**: the CLI. All internal `@jevitate/*` packages are bundled in; native deps stay external.
- **`jevitate`**: a thin bare-name alias so `npm install -g jevitate` works. It depends on `@jevitate/cli`.

All other `packages/*` are `private` and never published.

## How a release happens (0.2.0 onward)

Releases go through [changesets](https://github.com/changesets/changesets) and
`.github/workflows/release.yml`, which runs on every push to `main` and publishes with npm OIDC
Trusted Publishing (no stored token, with provenance).

1. **Changesets land with the work.** Each user-facing PR adds a `.changeset/*.md` bumping
   `@jevitate/cli` and `jevitate` (`pnpm changeset`) and a line in `CHANGELOG.md`.
2. **Promote to `main`** through the usual `dev → staging → main` PRs (squash merge).
3. **The release workflow opens a "chore: version packages" PR** on `main`. It runs
   `pnpm version-packages` (`changeset version`), which bumps both `package.json` versions and
   consumes the changesets. Changesets also writes a per-package `CHANGELOG.md`; the curated root
   `CHANGELOG.md` is the one to read. Before merging, move its `## [x.y.z] – unreleased` heading to
   the release date.
4. **Merge the version PR.** The next workflow run builds, bundles and runs `changeset publish`,
   which publishes only the bumped versions (`@jevitate/cli` and its alias `jevitate`). A push to
   `main` with no new version is a no-op.
5. **Tags and GitHub release.** `changeset publish` tags each published package
   (`@jevitate/cli@x.y.z`, `jevitate@x.y.z`). `changesets/action` pushes those tags and, by default
   (`createGithubReleases`), creates one GitHub release per package from the changeset text.
   Replace the `@jevitate/cli@x.y.z` release body with the curated notes from the root
   `CHANGELOG.md` (titled `Jevitate vX.Y.Z`), or turn `createGithubReleases` off and publish a
   `vX.Y.Z` release yourself.
6. **Verify:** `npm view @jevitate/cli version`, then `npm install -g @jevitate/cli@x.y.z &&
   jevitate --version`, and one no-key run (`jevitate explore --strategy adversarial --url
   <a local app> --fake-ai`).

You can also run the workflow by hand (**Actions → Release → Run workflow**).

### Trusted Publishing prerequisite

On npmjs.com, **each** package (`@jevitate/cli` and `jevitate`) needs a Trusted Publisher under
**Settings → Trusted Publishers**, pointing at repo `matt-cochran/jevitate` and workflow
`release.yml`. Delete any leftover `NPM_TOKEN` repository secret: OIDC makes it unnecessary.
Without the Trusted Publisher, the publish step fails on auth.

## First release (historical: 0.1.0)

The first publish was done by hand, because a Trusted Publisher can only be configured for a
package that already exists. `bash scripts/release.sh` builds, bundles and publishes
`@jevitate/cli` and then `jevitate`, prompting for your npm 2FA one-time password at each step.
You only need it again if the automated path is unavailable.

## Versioning

Changesets is configured with the internal packages in its `ignore` list. Pre-1.0, a minor bump
(0.x.0) may include behaviour changes, and every one is listed under "Behaviour changes" and
"Upgrade notes" in `CHANGELOG.md`.
