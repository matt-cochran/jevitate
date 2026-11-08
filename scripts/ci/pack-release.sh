#!/usr/bin/env bash
# Packs the release candidate (#534) into <out-dir>: both public packages as `pnpm pack`
# tarballs, plus manifest.json and SHA256SUMS (scripts/ci/release-artifact.mjs). Run after
# `pnpm -r build`, from the repo root.
#
# This script alone makes a release build (#784): it bundles the CLI with the release signal, so
# only these tarballs report a bare x.y.z; every other build reports x.y.z-source-<commit>. It
# refuses modified tracked files, whose bytes the manifest's tree would misname, proves the packed
# --version against the manifest, and puts the working dist back to a source build on the way out.
#
# That proof is the only one: it runs the tarball's bin on the frozen lockfile's dependencies, here,
# with no id-token. The publish job checks these bytes against SHA256SUMS and runs no package code.
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

if [ -n "$(git status --porcelain --untracked-files=no)" ]; then
  echo "pack-release: tracked files are modified; a release is packed from a committed tree" >&2
  git status --short --untracked-files=no >&2
  exit 1
fi

restore_source_build() {
  status=$?
  pnpm --filter @jevitate/cli run bundle || status=1
  exit "$status"
}
trap restore_source_build EXIT

JEVITATE_RELEASE_PACK_TREE=$(git rev-parse 'HEAD^{tree}') pnpm --filter @jevitate/cli run bundle

for dir in packages/cli packages/jevitate-cli-alias; do
  (cd "$dir" && pnpm pack --pack-destination "$out")
done
node scripts/ci/release-artifact.mjs write "$out"
node scripts/ci/release-artifact.mjs identity "$out"
