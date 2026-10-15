#!/usr/bin/env bash
# Packs the release candidate (#534) into <out-dir>: both public packages as `pnpm pack`
# tarballs, plus manifest.json and SHA256SUMS (scripts/ci/release-artifact.mjs). Run after
# `pnpm -r build` and `pnpm --filter @jevitate/cli run bundle`, from the repo root.
#
# Each package is packed from its own directory: pnpm 9 can't `--filter … pack`. `pnpm pack`
# rewrites the alias's `workspace:*` dependency on @jevitate/cli to the exact version.
#
# Usage: bash scripts/ci/pack-release.sh <out-dir>
set -euo pipefail
cd "$(dirname "$0")/../.."

out=${1:?usage: pack-release.sh <out-dir>}
mkdir -p "$out"
out=$(cd "$out" && pwd)
if [ -n "$(ls -A "$out")" ]; then
  echo "pack-release: $out is not empty" >&2
  exit 1
fi

for dir in packages/cli packages/jevitate-cli-alias; do
  (cd "$dir" && pnpm pack --pack-destination "$out")
done
node scripts/ci/release-artifact.mjs write "$out"
