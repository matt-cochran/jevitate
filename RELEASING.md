# Releasing

Jevitate publishes two public packages to npm:

- **`@jevitate/cli`**: the CLI. All internal `@jevitate/*` packages are bundled in; native deps stay external.
- **`jevitate`**: a thin bare-name alias so `npm install -g jevitate` works. It depends on `@jevitate/cli`.

All other `packages/*` are `private` and never published.

## Production promotion contract (owner policy, 2026-10-19)

Refs https://github.com/matt-cochran/execution-policy/issues/9.
Main reports the canonical **Build gate** from exact-tree reuse. Missing, expired,
failed or mismatched evidence fails closed. No main CI test/pack fallback and no
main/tag release build fallback are allowed. Version changes go through dev and
staging. Native OS tests are unchanged before main; supported Linux jobs retain
the CI_RUNNER_MODE GitHub/Blacksmith switch. Dev PRs require a real issue;
promotions carry the original traceability and need no new ticket.

Never run a source-building manual release on main. Repair staging publication
or validate a new candidate before production. Main only promotes the exact
retained tarballs already published and accepted on staging.

## How a release happens

Build and test once, then promote the same bytes (#534). Versioning goes through
[changesets](https://github.com/changesets/changesets); publishing goes through
`.github/workflows/release.yml` with npm OIDC **Trusted Publishing** (no `NPM_TOKEN`, by decision).

| Branch | What CI/Release does | npm |
| --- | --- | --- |
| `dev` (push) | full suite + 3-OS pool, then packs both packages into the artifact `jevitate-<tree hash>` | the **release candidate** (not published) |
| `staging` (merge) | promotion PR passes by reuse; Release publishes the tree's tarballs | `next` |
| `main` (merge) | promotion PR passes by reuse; Release reports "ready: push the tag" | (none) |
| `vX.Y.Z` tag on `main` | Release moves the dist-tag, tags, GitHub release | `latest` |

A dev squash commit and the staging/main merge commits that promote it have different SHAs but the
same **git tree**, so the tree hash names the build everywhere: the artifact is
`jevitate-<git rev-parse dev^{tree}>`, and `jevitate --version` prints it
(`0.15.0 (commit abc1234, tree def5678, built …)`; compare `git rev-parse --short main^{tree}`).

1. **Changesets land with the work.** Each user-facing PR adds a `.changeset/*.md` bumping
   `@jevitate/cli` and `jevitate` (`pnpm changeset`) and a line under `## [x.y.z] – unreleased`
   in the root `CHANGELOG.md`.
2. **Version on dev.** Run `changeset version` on a release branch into `dev` and date the root
   `CHANGELOG.md`'s `## [x.y.z]` heading. Changesets writes per-package `CHANGELOG.md`s; the curated
   root one is the one to read. The push of that squash to `dev` runs the full suite and uploads
   the release candidate `jevitate-<tree>` (two `.tgz`, `manifest.json` with
   `{tree, commit, versions, files, runId}`, `SHA256SUMS`; kept 90 days).
3. **Promote `dev → staging`.** The PR's `test` and `cross-platform-pool` checks look up the tree of
   the PR's merge commit (exactly what will land). If a green dev push built that tree they pass in
   seconds, else they run in full (staging holding something dev lacks makes the merge tree differ:
   back-merge first, see below). On the merge, Release downloads the tree's artifact, verifies
   `SHA256SUMS`, the tree and both versions, and runs `npm publish <tgz> --provenance --access public
   --tag next` for `@jevitate/cli`, then `jevitate`.
4. **Dogfood the candidate:** `npm install -g @jevitate/cli@next && jevitate --version` (check the
   tree), then one no-key run (`jevitate explore --strategy adversarial --url <a local app> --fake-ai`).
   A bug found here needs a new patch version: a version on npm can't be replaced.
5. **Promote `staging → main`, then tag to release.** The merge only reports "ready: push the
   tag": prod is an explicit act. Push the tag on `main`:

   ```bash
   git fetch origin && git tag -a vX.Y.Z -m vX.Y.Z origin/main && git push origin vX.Y.Z
   ```

   The tag is validated (`v` + both packages' version, on `main`, no pending changesets). Release
   checks both versions are on npm and runs `npm dist-tag add <pkg>@x.y.z latest` for both: no
   rebuild, no republish. Then it pushes `@jevitate/cli@x.y.z` and `jevitate@x.y.z` and creates the
   **Jevitate vx.y.z** GitHub release from the root `CHANGELOG.md` section. Re-pushing is a no-op.
6. **Verify:** `npm view @jevitate/cli dist-tags` shows `latest: x.y.z`; `npm install -g
   @jevitate/cli && jevitate --version`.
7. **Back-merge `main` into `dev`** (next section).

## Retry and missing artifacts

Production requires a successful staging Release/npm run for the complete source
tree. Build gate and the release plan verify that provenance and compare npm's
SHA-512 integrity with the retained tarballs. Missing/expired artifacts, a failed
staging publication, or different registry bytes stop promotion. Main never
first-publishes a missing version, rebuilds, or repeats the application suite.

Repair/retry staging first, preserving its verified artifact. Version changes go
through an issue-backed PR into dev; use a fresh version when the package bytes
change. npm versions cannot be replaced. Retry the failed workflow jobs rather
than rebuilding on main. The source-building `scripts/release.sh` publisher is
retired; use the retained Release workflow and its OIDC publisher.

Build/test Linux jobs keep CI_RUNNER_MODE. npm OIDC publication stays on a
GitHub-hosted runner because npm does not support self-hosted trusted publishers.
Publish lifecycle scripts are disabled; staging already produced and tested the
tarballs. Do not add NPM_TOKEN or a manual source-publishing fallback.

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

## The workflows

**`.github/workflows/ci.yml`** runs on PRs into `dev`, `staging` and `main`, and on pushes to
`dev` only (a staging/main merge commit carries a tree `dev` already tested).

| Job | When | What |
| --- | --- | --- |
| `reuse` | PRs into `staging`/`main` | resolves the merge commit's tree; `scripts/ci/find-tree-artifact.mjs` looks for a non-expired `jevitate-<tree>` artifact from a successful dev push run of `ci.yml` (or a Release run) whose head commit really has that tree |
| `test`, `cross-platform-pool` | full checks before main; reuse only on main | the full suite / 3-OS pool, or, after a `reuse` hit, one step naming the run it reused. Same job names either way, so branch protection is unaffected |
| `package` | pushes to `dev`, and staging recovery only | build + bundle, `scripts/ci/pack-release.sh` (packs from each package dir: pnpm 9 can't `--filter … pack`), upload `jevitate-<tree>` |

**`.github/workflows/release.yml`** runs on pushes to `staging` and `main`, on pushed `v*` tags and
on manual dispatch. `plan` (`scripts/ci/release-plan.mjs`) picks one mode:

| Mode | When | What runs |
| --- | --- | --- |
| `next` | `staging`, no pending changesets, a package's version isn't on npm | download + verify the tree's artifact (or `build` it), `npm publish --tag next` |
| `latest` | a `vX.Y.Z` tag, or a manual run with `publish` on `main`, no pending changesets | `npm dist-tag add … latest` (only after matching successful staging publication and registry integrity proof), then tags and GitHub release |
| `version` | source versioning belongs on `dev` | main rejects this mode; version on dev and promote normally |
| `none` | otherwise (incl. a manual run without `publish`) | nothing |

npm provenance on a published version points at the Release run on the `staging` merge commit; the
manifest inside the artifact names the dev commit and CI run that built and tested the bytes.

Every action is pinned to a commit SHA, with the version in a trailing comment. To bump one, resolve
the new tag's SHA with `gh api repos/<owner>/<repo>/commits/<tag> -q .sha`. npm is pinned to 11:
OIDC needs npm ≥ 11.5.1. npm, not pnpm, publishes: pnpm 9's publish never completed npm's OIDC
token exchange (#541); pnpm only packs, which rewrites `jevitate`'s `workspace:*` dependency to
the exact version (the verify step checks this).

### npm Trusted Publishers

On npmjs.com, **each** package (`@jevitate/cli` and `jevitate`) has a Trusted Publisher under
**Settings → Trusted Publishers**: GitHub Actions, `matt-cochran` / `jevitate`, workflow
`release.yml`, no environment, publish allowed, **and dist-tag management allowed**: the merge to
The tag run moves `latest` with `npm dist-tag add` over the same OIDC exchange. Without that permission
the `npm` job fails with "Could not move latest"; move it by hand (above) until it is enabled. A new
trusted publisher stays "pending validation" until its first OIDC publish. Don't add an
`NPM_TOKEN` secret: OIDC makes it unnecessary.

## First release (historical: 0.1.0)

The first publish was done by hand, because a Trusted Publisher can only be configured for a
package that already exists. 0.2.0 was also published by hand, after the OIDC publish failed
(#262, #267).

## Versioning

Changesets is configured with the internal packages in its `ignore` list. Pre-1.0, a minor bump
(0.x.0) may include behaviour changes, and every one is listed under "Behaviour changes" and
"Upgrade notes" in `CHANGELOG.md`.
