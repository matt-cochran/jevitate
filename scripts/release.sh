#!/usr/bin/env bash
#
# Manual release — publishes the two public packages to npm:
#   1. @jevitate/cli   (the real CLI; dist + bundled skills)
#   2. jevitate        (the bare-name alias; depends on @jevitate/cli)
#
# Why manual: npm prompts for your 2FA one-time password interactively, so this
# needs NO long-lived automation token (which would expire and need rotating).
# For automated releases later, move to npm OIDC Trusted Publishing (no token,
# no expiry) — see RELEASING.md.
#
# Prerequisites:
#   - `npm login` as a publisher in the @jevitate org who also owns `jevitate`
#   - run from a clean, up-to-date `main` (or pass --no-git-checks is already set)
#   - your authenticator app for the OTP prompts
#
# Usage:  bash scripts/release.sh
set -euo pipefail
cd "$(dirname "$0")/.."

if ! npm whoami >/dev/null 2>&1; then
  echo "✗ not logged in to npm — run 'npm login' first." >&2
  exit 1
fi
echo "→ npm user: $(npm whoami)"

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

echo "✓ published:"
echo -n "  @jevitate/cli "; npm view @jevitate/cli version
echo -n "  jevitate "; npm view jevitate version
echo "Verify: npm install -g @jevitate/cli && jevitate --version"
