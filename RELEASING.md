# Releasing

Jevitate publishes two public packages to npm:

- **`@jevitate/cli`**: the CLI. All internal `@jevitate/*` packages are bundled in; native deps stay external.
- **`jevitate`**: a thin bare-name alias so `npm install -g jevitate` works. It depends on `@jevitate/cli`.

All other `packages/*` are `private` and never published.

## How a release happens today (manual publish)

Publishing is done **by hand** with `scripts/release.sh`. npm doesn't yet accept this repo's
GitHub OIDC tokens (npm/cli#9969, see below), and no long-lived `NPM_TOKEN` is stored, by decision.
Versioning still goes through [changesets](https://github.com/changesets/changesets) and
`.github/workflows/release.yml`.

1. **Changesets land with the work.** Each user-facing PR adds a `.changeset/*.md` bumping
   `@jevitate/cli` and `jevitate` (`pnpm changeset`) and a line under `## [x.y.z] – unreleased`
   in the root `CHANGELOG.md`.
2. **Promote to `main`** through the usual `dev → staging → main` PRs.
3. **Open the version PR by hand.** On the push to `main`, the Release workflow sees pending
   changesets, runs `pnpm version-packages` (`changeset version`) and pushes the
   `changeset-release/main` branch. Actions isn't allowed to open PRs in this repo (that setting is
   off on purpose), so the run's summary prints the compare URL and this command instead:

   ```bash
   gh pr create --head changeset-release/main --base main --title "chore: version packages" --fill
   ```

   The PR bumps both `package.json` versions and consumes the changesets. Changesets also writes a
   per-package `CHANGELOG.md`; the curated root `CHANGELOG.md` is the one to read. Before merging,
   change its `## [x.y.z] – unreleased` heading to the release date (push to the
   `changeset-release/main` branch).
4. **Merge the version PR.** The next Release run sees that `main`'s version isn't on npm yet and
   posts a notice ("ready to publish"). A push to `main` never publishes and never fails for that
   reason.
5. **Publish** from an up-to-date, clean `main`:

   ```bash
   git switch main && git pull --ff-only
   npm login            # once; a publisher in the @jevitate org who also owns `jevitate`
   bash scripts/release.sh
   ```

   It installs, builds, bundles, then publishes `@jevitate/cli` and then `jevitate`, prompting for
   your npm 2FA one-time password at each step. It then polls `npm view <pkg>@<version> version`
   until the registry serves both new versions (default up to 180 s, `JEVITATE_RELEASE_WAIT_SECS`
   to change), so a stale `latest` is never reported as published. It exits non-zero if either
   version isn't live by then.
6. **Tags and the GitHub release.** `release.sh` creates three annotated tags locally on `HEAD`
   (`@jevitate/cli@x.y.z`, `jevitate@x.y.z`, `vx.y.z`; `--no-tags` skips this) and prints the
   commands. It never pushes:

   ```bash
   git push origin "@jevitate/cli@x.y.z" "jevitate@x.y.z" "vx.y.z"
   gh release create "vx.y.z" --verify-tag --title "Jevitate vx.y.z" --notes-file <(awk '/^## \[x.y.z\]/{p=1;next} /^## \[/{if(p)exit} p' CHANGELOG.md)
   ```

   The release notes are the curated `## [x.y.z]` section of the root `CHANGELOG.md`.
7. **Verify:** `npm install -g @jevitate/cli@x.y.z && jevitate --version`, then one no-key run
   (`jevitate explore --strategy adversarial --url <a local app> --fake-ai`).
8. **Back-merge `main` into `dev`** (next section).

## After every release: back-merge `main` → `dev`

`dev` is squash-merged, while `staging` and `main` use merge commits. After a release, git finds
no shared history for the version-bump commit, falls back to an old merge base, and the next
`dev → staging` PR conflicts on the version lines. Recording the merge once fixes that:

```bash
bash scripts/sync-release-branches.sh
```

The script fetches `origin`, creates `release/sync-<version>-back-merge` from `origin/dev`, merges
`origin/main` into it (bringing the version bump, the consumed changesets and the dated
CHANGELOG heading into `dev`), and prints the `git push` and `gh pr create --base dev` commands.
It never pushes to a protected branch. If the merge conflicts, resolve it on that branch (keep
`main`'s versions and CHANGELOG) and commit. With `--ours` it only records `main` as merged,
without taking its content (`-s ours`). Use that when `dev` already has everything `main` has
(as in #265).

**Merge that PR with "Create a merge commit", not squash.** A squash loses the ancestry it
records, and the next promotion conflicts again.

## The Release workflow

`.github/workflows/release.yml` runs on every push to `main` and on manual dispatch. A `plan` job
picks one mode in plain shell:

| Mode | When | What runs |
| --- | --- | --- |
| `version` | `.changeset/*.md` files are pending | `changeset version`, push `changeset-release/main`, print how to open the PR |
| `publish` | no changesets, and `main`'s `@jevitate/cli` version isn't on npm | a notice to publish by hand; publishes only on a manual run with `publish: true` |
| `none` | no changesets, and the version is already on npm | nothing |

Every action is pinned to a commit SHA, with the version in a trailing comment. To bump one, resolve
the new tag's SHA with `gh api repos/<owner>/<repo>/commits/<tag> -q .sha`. npm is pinned to 11:
OIDC needs npm ≥ 11.5.1, and npm 12 rejects the `--git-checks` flag that pnpm 9's publish passes
through (#262). Upgrading pnpm to 10.x would lift that pin.

## Automated publishing (pending npm/cli#9969)

The OIDC Trusted Publishing path is kept ready but is not used yet:

- **Why it fails today.** This repo was created after 2026-07-15, so GitHub issues its OIDC tokens
  with immutable subject claims (`repo:matt-cochran@4958633/jevitate@1377321026:…`), which can't be
  turned off. npm's token exchange doesn't accept them yet, so the publish PUT fails with
  `E404 Not Found - PUT https://registry.npmjs.org/@jevitate%2fcli`
  ([npm/cli#9969](https://github.com/npm/cli/issues/9969); same symptom as npm/cli#8976).
- **What's already in place.** The `publish` job has `id-token: write`, installs npm 11, sets
  `NPM_CONFIG_PROVENANCE`, and runs `pnpm release` (build, bundle, `changeset publish`) through
  `changesets/action/publish`, which pushes the tags and creates the GitHub releases. On npmjs.com,
  **each** package (`@jevitate/cli` and `jevitate`) has a Trusted Publisher under **Settings →
  Trusted Publishers** pointing at repo `matt-cochran/jevitate` and workflow `release.yml`.
- **When npm fixes #9969.** After step 4 above, run **Actions → Release → Run workflow** on
  `main` with `publish` checked, instead of `scripts/release.sh`. If that works, the push trigger
  can publish too: drop the `workflow_dispatch`/`inputs.publish` condition on the `publish` job and
  update this file. Don't add an `NPM_TOKEN` secret: OIDC makes it unnecessary.

## First release (historical: 0.1.0)

The first publish was done by hand, because a Trusted Publisher can only be configured for a
package that already exists. 0.2.0 was also published by hand, after the OIDC publish failed
(#262, #267).

## Versioning

Changesets is configured with the internal packages in its `ignore` list. Pre-1.0, a minor bump
(0.x.0) may include behaviour changes, and every one is listed under "Behaviour changes" and
"Upgrade notes" in `CHANGELOG.md`.
