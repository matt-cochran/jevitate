/**
 * #453 change-aware self-heal: what a code change says about the UI. A `ChangeScope` is built from a
 * git range and/or human change notes (packages/cli change-context.ts → `extractChangeEvidence`), and
 * the runner heals a broken step only when the scope explains the break. Pure types: no IO here.
 * Raw diff hunks never leave the CLI — only these `{kind, before, after}` facts reach the healer.
 */

/** What kind of UI fact a change altered. `inserted-ui` is reported, never healed (0.9.0). */
export type ChangeEvidenceKind = "test-id" | "accessible-name" | "label" | "copy" | "route" | "redirect" | "inserted-ui" | "note";

/** One fact a change altered: `before` → `after` (either may be absent for a pure add/remove). */
export interface ChangeEvidence {
  /** Stable within one scope (e.g. `e1`, `e2`, …), cited by heal attempts and proposals. */
  readonly id: string;
  readonly kind: ChangeEvidenceKind;
  readonly before?: string;
  readonly after?: string;
  /** Repo-relative path the fact came from (absent for a note). */
  readonly file?: string;
  /** 1-based line of the `after` side (or `before` side for a removal). */
  readonly line?: number;
  /** The hunk header only (`@@ -a,b +c,d @@ …`), never the hunk body. */
  readonly hunk?: string;
  /** The change note's text, for `kind: "note"`. */
  readonly note?: string;
}

/** The change context of one run. */
export interface ChangeScope {
  /** The range as given (`HEAD~1..HEAD`), when a git range was read. */
  readonly range?: string;
  readonly baseSha?: string;
  readonly headSha?: string;
  readonly evidence: readonly ChangeEvidence[];
  /** What was scanned: counts, and repo-relative paths skipped (secrets, lockfiles, binaries, size caps). */
  readonly scanned: { readonly files: number; readonly hunks: number; readonly skipped: readonly string[] };
}

/** The empty scope (no range, no notes). */
export const EMPTY_CHANGE_SCOPE: ChangeScope = { evidence: [], scanned: { files: 0, hunks: 0, skipped: [] } };
