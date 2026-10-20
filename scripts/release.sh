#!/usr/bin/env bash
set -euo pipefail
echo "The source-building publisher is retired. Use the retained Release workflow after staging acceptance; do not rebuild or retest on main." >&2
exit 1
