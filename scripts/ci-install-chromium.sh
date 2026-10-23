#!/usr/bin/env bash
# Installs Playwright's Chromium for CI (#417). A stalled package mirror or browser download
# used to hang the job for GitHub's 6 h default; each attempt is now bounded (where `timeout`
# exists — Linux runners) and retried once, and the calling step carries its own
# `timeout-minutes` as the outer bound on every OS.
#
# Consistency (2026-10-23): the browser is downloaded once and restored from the actions/cache
# step that precedes this script (a cache hit downloads nothing). The system libraries are
# installed with apt only when the browser is actually missing one (`ldd` reports "not found"):
# GitHub's Ubuntu images already ship nearly all of them, and `apt-get update` against a stalled
# mirror was what timed out both attempts. apt now gives up on a dead mirror in seconds and
# retries, instead of hanging until the attempt's bound.
set -uo pipefail

bounded() {
  if command -v timeout >/dev/null 2>&1; then timeout 240 "$@"; else "$@"; fi
}

# `timeout` runs a command, not a shell function: keep the invocation as an array.
playwright=(pnpm --filter @jevitate/cli exec playwright)

linux=false
[ "${RUNNER_OS:-Linux}" = "Linux" ] && linux=true

# A timed-out attempt kills pnpm, but an apt-get started as root can outlive it and keep holding
# the dpkg lock, so the retry failed at once with "Could not get lock /var/lib/dpkg/lock-frontend".
# Make apt wait for the lock, and fail fast and retry on a mirror that stops answering (Linux CI
# runners only: never touches a developer's machine).
if $linux && [ "${CI:-}" = "true" ] && command -v sudo >/dev/null 2>&1; then
  sudo tee /etc/apt/apt.conf.d/99-ci-network >/dev/null <<'APT' || true
DPkg::Lock::Timeout "300";
Acquire::http::Timeout "20";
Acquire::https::Timeout "20";
Acquire::Retries "3";
APT
fi

# The installed Chromium executables (full browser and headless shell) that ldd can inspect.
chromium_binaries() {
  local root="${PLAYWRIGHT_BROWSERS_PATH:-$HOME/.cache/ms-playwright}"
  find "$root" -maxdepth 3 -type f \( -name chrome -o -name chrome-headless-shell -o -name headless_shell \) -perm -u+x 2>/dev/null
}

# True when an installed Chromium binary cannot find one of its shared libraries, or none is found.
missing_libraries() {
  local bin
  local found=false
  while IFS= read -r bin; do
    found=true
    if ldd "$bin" 2>/dev/null | grep -q "not found"; then
      echo "missing libraries for ${bin}:" >&2
      ldd "$bin" | grep "not found" >&2
      return 0
    fi
  done < <(chromium_binaries)
  ! $found
}

for attempt in 1 2; do
  if bounded "${playwright[@]}" install chromium; then
    if ! $linux || ! missing_libraries; then exit 0; fi
    echo "installing Chromium's system libraries (attempt ${attempt})" >&2
    if bounded "${playwright[@]}" install-deps chromium; then exit 0; fi
  fi
  echo "playwright install attempt ${attempt} failed or timed out" >&2
done
exit 1
