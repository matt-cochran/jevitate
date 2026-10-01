#!/usr/bin/env bash
#
# Post-release back-merge: prepares a branch that merges `main` back into `dev`.
#
# Why: `dev` is squash-merged while `staging`/`main` use merge commits, so after a
# release git sees no common history for the version-bump commits and the next
# `dev -> staging` PR conflicts on the version lines. Merging `main` into `dev`
# with a real merge commit records that ancestry (and brings the version bump,
# consumed changesets and CHANGELOG date into `dev`).
#
# This script never pushes to a protected branch: it creates a local branch off
# origin/dev, merges origin/main into it, and prints the push + `gh pr create`
# commands. Merge that PR with "Create a merge commit" (NOT squash), or the
# ancestry is lost again.
#
# Usage:  bash scripts/sync-release-branches.sh [--ours] [--remote origin] [--branch <name>]
#   --ours    record main as merged WITHOUT taking its content (`-s ours`); only
#             when dev already holds everything main has (e.g. #265).
set -euo pipefail
cd "$(dirname "$0")/.."

remote=origin
strategy=()
branch=""
while [ $# -gt 0 ]; do
  case "$1" in
    --ours) strategy=(-s ours) ;;
    --remote) remote="$2"; shift ;;
    --branch) branch="$2"; shift ;;
    -h|--help) sed -n '2,20p' "$0"; exit 0 ;;
    *) echo "✗ unknown argument: $1" >&2; exit 64 ;;
  esac
  shift
done

if [ -n "$(git status --porcelain --untracked-files=no)" ]; then
  echo "✗ the working tree has uncommitted changes; commit them first." >&2
  exit 1
fi

git fetch --quiet "$remote" main staging dev
version=$(git show "$remote/main:packages/cli/package.json" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).version))')
branch=${branch:-release/sync-${version}-back-merge}

if git merge-base --is-ancestor "$remote/main" "$remote/dev"; then
  echo "✓ $remote/main is already merged into $remote/dev; nothing to do."
  exit 0
fi
if git show-ref --verify --quiet "refs/heads/$branch"; then
  echo "✗ local branch $branch already exists; delete it or pass --branch <name>." >&2
  exit 1
fi

git switch --quiet -c "$branch" "$remote/dev"
msg="Merge main (${version}) back into dev after the release"
[ ${#strategy[@]} -gt 0 ] && msg="Record main (${version}) as merged into dev (content unchanged)"
conflict=0
if ! git merge --no-ff --no-edit --no-stat "${strategy[@]}" -m "$msg" "$remote/main"; then
  conflict=1
  echo "✗ the merge conflicts. Resolve it on $branch (usually: keep main's versions and CHANGELOG), commit, then run the commands below." >&2
fi

if ! git merge-base --is-ancestor "$remote/staging" HEAD; then
  echo "! $remote/staging is not contained in $remote/main; promote staging -> main first, or merge it too." >&2
fi

cat <<EOF

Branch $branch is ready (base: $remote/dev). Next, by hand:

  git push -u $remote $branch
  gh pr create --base dev --head $branch --title "$msg" --body "Post-release back-merge (see RELEASING.md). Merge with a merge commit, not squash."

Merge that PR with "Create a merge commit". Squashing it loses the ancestry this records.
EOF
exit "$conflict"
