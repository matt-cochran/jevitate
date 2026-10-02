#!/usr/bin/env bash
#
# Manual release (the current release path; see RELEASING.md) — publishes the
# two public packages to npm:
#   1. @jevitate/cli   (the real CLI; dist + bundled skills)
#   2. jevitate        (the bare-name alias; depends on @jevitate/cli)
#
# Why manual: npm OIDC Trusted Publishing from GitHub Actions is blocked for this
# repo by npm/cli#9969, and no long-lived NPM_TOKEN is stored (by decision). npm
# prompts for your 2FA one-time password interactively instead.
#
# After publishing it waits (bounded) until the registry serves the new
# versions, creates the release tags LOCALLY (`@jevitate/cli@x.y.z`,
# `jevitate@x.y.z`, `vx.y.z`) and prints the push + `gh release create`
# commands. It never pushes anything itself.
#
# Prerequisites:
#   - `npm login` as a publisher in the @jevitate org who also owns `jevitate`
#   - a clean, up-to-date `main` with the version PR merged
#   - your authenticator app for the OTP prompts
#
# Usage:  bash scripts/release.sh [--no-tags]
#   JEVITATE_RELEASE_WAIT_SECS  how long to wait for npm to serve the versions (default 180)
set -euo pipefail
cd "$(dirname "$0")/.."

make_tags=1
for arg in "$@"; do
  case "$arg" in
    --no-tags) make_tags=0 ;;
    -h|--help) sed -n '2,24p' "$0"; exit 0 ;;
    *) echo "✗ unknown argument: $arg" >&2; exit 64 ;;
  esac
done

pkg_version() { node -p "require('./$1/package.json').version"; }
cli_version=$(pkg_version packages/cli)
alias_version=$(pkg_version packages/jevitate-cli-alias)

if ! npm whoami >/dev/null 2>&1; then
  echo "✗ not logged in to npm — run 'npm login' first." >&2
  exit 1
fi
echo "→ npm user: $(npm whoami)"
echo "→ releasing @jevitate/cli@${cli_version} and jevitate@${alias_version}"

echo "→ install + build + bundle (bundle overwrites dist/bin.js with the esbuild bundle + copies skills)"
pnpm install --frozen-lockfile
pnpm -r build
pnpm --filter @jevitate/cli run bundle

# Order matters: `jevitate` depends on @jevitate/cli via workspace:* (pnpm rewrites
# it to the published version at pack time), so @jevitate/cli must be live first.
echo "→ publishing @jevitate/cli (enter your OTP when prompted)"
pnpm --filter @jevitate/cli publish --access public --no-git-checks

echo "→ publishing jevitate (enter your OTP when prompted)"
pnpm --filter jevitate publish --access public --no-git-checks

# The registry can serve the previous `latest` for a while after a publish, so
# ask for the exact version and poll with a bounded wait instead of trusting the
# first `npm view <pkg> version`.
wait_for() {
  local spec="$1" deadline=$((SECONDS + ${JEVITATE_RELEASE_WAIT_SECS:-180}))
  while [ "$SECONDS" -lt "$deadline" ]; do
    if [ -n "$(npm view "$spec" version 2>/dev/null || true)" ]; then
      echo "  ✓ $spec is live"
      return 0
    fi
    sleep 5
  done
  echo "  ✗ $spec is not served by the registry yet (waited ${JEVITATE_RELEASE_WAIT_SECS:-180}s); check 'npm view $spec version' later" >&2
  return 1
}
echo "→ waiting for the registry"
live=0
wait_for "@jevitate/cli@${cli_version}" || live=1
wait_for "jevitate@${alias_version}" || live=1

if [ "$make_tags" -eq 1 ]; then
  echo "→ tagging locally (not pushed)"
  sha=$(git rev-parse HEAD)
  for tag in "@jevitate/cli@${cli_version}" "jevitate@${alias_version}" "v${cli_version}"; do
    if git rev-parse -q --verify "refs/tags/${tag}" >/dev/null; then
      echo "  = ${tag} already exists"
    else
      git tag -a "${tag}" -m "${tag}" "${sha}"
      echo "  + ${tag} -> ${sha:0:7}"
    fi
  done
  cat <<EOF

Next, by hand:
  git push origin "@jevitate/cli@${cli_version}" "jevitate@${alias_version}" "v${cli_version}"
  gh release create "v${cli_version}" --verify-tag --title "Jevitate v${cli_version}" --notes-file <(awk '/^## \\[${cli_version}\\]/{p=1;next} /^## \\[/{if(p)exit} p' CHANGELOG.md)
EOF
fi

echo
echo "Verify: npm install -g @jevitate/cli@${cli_version} && jevitate --version"
echo "Then back-merge main into dev: bash scripts/sync-release-branches.sh"
exit "$live"
