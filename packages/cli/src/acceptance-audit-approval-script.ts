import { createHash } from "node:crypto";

export interface ApprovalInput { readonly path: string; readonly content: string; }

/** #686 — emits a reviewable shell proposal only; it never executes approval, network, or promotion. */
export function renderHashBoundApprovalScript(inputs: readonly ApprovalInput[]): string {
  const rows = inputs.map(({ path, content }) => ({ path, hash: createHash("sha256").update(content).digest("hex") }));
  return [
    "#!/usr/bin/env sh",
    "set -eu",
    "# Generated approval proposal. Default mode only prints the bound evidence.",
    'if [ "${1:-}" != "--apply" ]; then',
    '  echo "dry run: inspect hashes; rerun with --apply to recheck them locally"',
    ...rows.map((r) => `  echo '${r.hash}  ${r.path}'`),
    "  exit 0",
    "fi",
    "# Apply mode rechecks every file and stops at the first mismatch; it performs no approval or promotion.",
    ...rows.map((r) => `[ "$(sha256sum '${r.path}' | awk '{print $1}')" = '${r.hash}' ] || { echo 'hash mismatch: ${r.path}' >&2; exit 1; }`),
    "echo 'all hashes match; human approval remains an external explicit action'",
    "",
  ].join("\n");
}
