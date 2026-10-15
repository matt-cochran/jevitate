# Releasing

Jevitate publishes two public packages to npm:

- **`@jevitate/cli`**: the CLI. All internal `@jevitate/*` packages are bundled in; native deps stay external.
- **`jevitate`**: a thin bare-name alias so `npm install -g jevitate` works. It depends on `@jevitate/cli`.

All other `packages/*` are `private` and never published.

## How a release happens

Versioning goes through [changesets](https://github.com/changesets/changesets); publishing goes
through `.github/workflows/release.yml` with npm OIDC **Trusted Publishing** (no `NPM_TOKEN`, by
decision). Pushing a `vX.Y.Z` tag on `main` publishes.

1. **Changesets land with the work.** Each user-facing PR adds a `.changeset/*.md` bumping
   `@jevitate/cli` and `jevitate` (`pnpm changeset`) and a line under `## [x.y.z] – unreleased`
   in the root `CHANGELOG.md`.
2. **Version.** Either run `changeset version` on a release branch into `dev` (the usual way: the
   version commit then rides the promotion), or let the Release workflow do it on the push to
   `main`: it sees pending changesets, runs `pnpm version-packages` and pushes
   `changeset-release/main`. Actions may not open PRs here (setting off on purpose), so open it:

   ```bash
   gh pr create --head changeset-release/main --base main --title "chore: version packages" --fill
   ```

   Changesets writes per-package `CHANGELOG.md`s; the curated root `CHANGELOG.md` is the one to
   read. Date its `## [x.y.z]` heading before the version lands on `main`.
3. **Promote to `main`** through the usual `dev → staging → main` PRs. The Release run on that
   push posts "ready to publish" when `main`'s version isn't on npm. A push to `main` never publishes.
4. **Tag to publish:**

   ```bash
   git fetch origin && git tag -a vX.Y.Z -m vX.Y.Z origin/main && git push origin vX.Y.Z
   ```

   The Release workflow refuses a tag that isn't `v` + both packages' version, isn't on `main`, or
   has changesets pending. Then it installs, runs `pnpm -r build` and the cli bundle, publishes
   `@jevitate/cli` and then `jevitate` over OIDC with provenance (a version already on npm is
   skipped, so a rerun is safe), pushes `@jevitate/cli@x.y.z` and `jevitate@x.y.z`, and creates the
   **Jevitate vX.Y.Z** GitHub release from the root `CHANGELOG.md` section. To retry without a new
   tag: **Actions → Release → Run workflow** on `main` with `publish` checked.
5. **Verify:** `npm install -g @jevitate/cli@x.y.z && jevitate --version`, then one no-key run
   (`jevitate explore --strategy adversarial --url <a local app> --fake-ai`).
6. **Back-merge `main` into `dev`** (next section).

### Fallback: publish by hand

If the workflow's publish fails (for example npm/cli#9969: OIDC tokens with immutable subject
claims get `E404 Not Found - PUT https://registry.npmjs.org/@jevitate%2fcli`), nothing is
published; publish from a clean, up-to-date `main`:

```bash
npm login            # once; a publisher in the @jevitate org who also owns `jevitate`
bash scripts/release.sh
```

It installs, builds, bundles, publishes both packages (prompting for your 2FA OTP each time),
waits until the registry serves both versions (`JEVITATE_RELEASE_WAIT_SECS`, default 180), and
creates the three tags locally. It never pushes; it prints:

```bash
git push origin "@jevitate/cli@x.y.z" "jevitate@x.y.z" "vx.y.z"
gh release create "vx.y.z" --verify-tag --title "Jevitate vx.y.z" --notes-file <(awk '/^## \[x.y.z\]/{p=1;next} /^## \[/{if(p)exit} p' CHANGELOG.md)
```

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

`.github/workflows/release.yml` runs on every push to `main`, on every pushed `v*` tag, and on
manual dispatch. A `plan` job picks one mode in plain shell:

| Mode | When | What runs |
| --- | --- | --- |
| `version` | `.changeset/*.md` files are pending | `changeset version`, push `changeset-release/main`, print how to open the PR |
| `publish` | no changesets, and a package's version isn't on npm | on a `vX.Y.Z` tag or a manual run with `publish: true`: publish, tags, GitHub release; on a push to `main`: a "push the tag" notice |
| `none` | no changesets, and both versions are on npm | nothing |

Every action is pinned to a commit SHA, with the version in a trailing comment. To bump one, resolve
the new tag's SHA with `gh api repos/<owner>/<repo>/commits/<tag> -q .sha`. npm is pinned to 11:
OIDC needs npm ≥ 11.5.1, and npm 12 rejects the `--git-checks` flag that pnpm 9's publish passes
through (#262). Upgrading pnpm to 10.x would lift that pin.

On npmjs.com, **each** package (`@jevitate/cli` and `jevitate`) has a Trusted Publisher under
**Settings → Trusted Publishers**: GitHub Actions, `matt-cochran` / `jevitate`, workflow
`release.yml`, no environment, publish allowed. A new trusted publisher stays "pending validation"
until its first OIDC publish. Don't add an `NPM_TOKEN` secret: OIDC makes it unnecessary.

## First release (historical: 0.1.0)

The first publish was done by hand, because a Trusted Publisher can only be configured for a
package that already exists. 0.2.0 was also published by hand, after the OIDC publish failed
(#262, #267).

## Versioning

Changesets is configured with the internal packages in its `ignore` list. Pre-1.0, a minor bump
(0.x.0) may include behaviour changes, and every one is listed under "Behaviour changes" and
"Upgrade notes" in `CHANGELOG.md`.
