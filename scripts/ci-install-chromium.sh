#!/usr/bin/env bash
# Installs Playwright's Chromium for CI (#417). A stalled package mirror or browser download
# used to hang the job for GitHub's 6 h default; each attempt is now bounded (where `timeout`
# exists — Linux runners, where `--with-deps` runs apt) and retried once, and the calling step
# carries its own `timeout-minutes` as the outer bound on every OS.
set -uo pipefail

args=(install chromium)
[ "${RUNNER_OS:-Linux}" = "Linux" ] && args=(install --with-deps chromium)

bounded() {
  if command -v timeout >/dev/null 2>&1; then timeout 300 "$@"; else "$@"; fi
}

# A timed-out attempt kills pnpm, but the apt-get that `--with-deps` started as root can outlive it
# and keep holding the dpkg lock, so the retry failed at once with "Could not get lock
# /var/lib/dpkg/lock-frontend". Make apt wait for the lock instead (Linux runners only).
if [ "${RUNNER_OS:-Linux}" = "Linux" ] && command -v sudo >/dev/null 2>&1; then
  echo 'DPkg::Lock::Timeout "300";' | sudo tee /etc/apt/apt.conf.d/99-dpkg-lock-timeout >/dev/null || true
fi

for attempt in 1 2; do
  if bounded pnpm --filter @jevitate/cli exec playwright "${args[@]}"; then exit 0; fi
  echo "playwright install attempt ${attempt} failed or timed out" >&2
done
exit 1
