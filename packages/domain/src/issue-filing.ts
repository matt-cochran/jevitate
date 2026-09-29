import type { Attribution } from "./crash-attribution.js";

/**
 * Issue filing — the PORT and the one filing rule, both solution-agnostic. Adapters (GitHub via
 * `gh` or REST) live in the outer CLI package; nothing here knows about any tracker or app.
 *
 * Routing: an engine (jevitate) finding goes to jevitate's own repo; a system-under-test finding
 * goes to the repo configured FOR THAT TARGET; an `uncertain` crash goes to BOTH. Filing is OFF
 * unless it is enabled AND the destination repo is configured — otherwise only the draft is kept.
 *
 * Dedup: every draft body carries a fingerprint marker. Before creating, the filer searches the
 * destination for an OPEN issue carrying that marker; if one exists the new occurrence is added as
 * a comment instead of a new issue.
 */

/** Where a finding is routed. */
export type IssueTarget = "jevitate" | "system-under-test";

export interface IssueDraft {
  readonly fingerprint: string;
  readonly title: string;
  /** Markdown body, already redacted; ends with the fingerprint marker. */
  readonly body: string;
  readonly labels: readonly string[];
  readonly attribution: Attribution;
  /** The destinations this draft is routed to (both, for `uncertain`). */
  readonly targets: readonly IssueTarget[];
}

export interface IssueRef {
  readonly number: number;
  readonly url: string;
}

export interface NewIssue {
  readonly title: string;
  readonly body: string;
  readonly labels: readonly string[];
}

/** The filing port. `repo` is `owner/name`. */
export interface IssueFilerPort {
  /** An OPEN issue in `repo` whose body contains `marker`, or null. */
  findOpenByMarker(repo: string, marker: string): Promise<IssueRef | null>;
  create(repo: string, issue: NewIssue): Promise<IssueRef>;
  /** Adds a comment to issue `number`; returns the issue's ref. */
  comment(repo: string, number: number, body: string): Promise<IssueRef>;
}

export interface FilingConfig {
  /** Master switch (CLI `--file-issues` or filing config). Default off. */
  readonly enabled: boolean;
  /** jevitate's own repo for engine findings. */
  readonly jevitateRepo: string;
  /** The repo for the system under test — configured per target; absent ⇒ never filed. */
  readonly targetRepo?: string;
}

export const DEFAULT_JEVITATE_REPO = "matt-cochran/jevitate";

/** The machine-readable marker a filed issue carries, used for dedup. */
export function fingerprintMarker(fingerprint: string): string {
  return `<!-- jevitate-fingerprint: ${fingerprint} -->`;
}

/** Which destinations an attribution routes to. */
export function targetsFor(attribution: Attribution): IssueTarget[] {
  switch (attribution) {
    case "jevitate":
      return ["jevitate"];
    case "system-under-test":
      return ["system-under-test"];
    case "uncertain":
      return ["jevitate", "system-under-test"];
  }
}

export type FilingOutcome =
  | { readonly target: IssueTarget; readonly status: "draft-only"; readonly reason: string }
  | {
      readonly target: IssueTarget;
      readonly status: "filed";
      readonly repo: string;
      readonly action: "created" | "commented";
      readonly issue: IssueRef;
    }
  | { readonly target: IssueTarget; readonly status: "failed"; readonly repo: string; readonly reason: string };

/** The occurrence comment added to an existing issue with the same fingerprint. */
export function occurrenceComment(draft: IssueDraft, occurredAtIso: string): string {
  return `Seen again by jevitate at ${occurredAtIso}.\n\n${draft.body}`;
}

/**
 * Files one draft to each of its targets. Never throws: a filer failure is a `failed` outcome
 * with its reason (the draft on disk is the durable record either way).
 */
export async function fileDraft(
  filer: IssueFilerPort,
  draft: IssueDraft,
  config: FilingConfig,
  occurredAtIso: string,
): Promise<FilingOutcome[]> {
  const out: FilingOutcome[] = [];
  for (const target of draft.targets) {
    if (!config.enabled) {
      out.push({ target, status: "draft-only", reason: "filing is disabled" });
      continue;
    }
    const repo = target === "jevitate" ? config.jevitateRepo : config.targetRepo;
    if (repo === undefined || repo === "") {
      out.push({ target, status: "draft-only", reason: "no repo is configured for the system under test" });
      continue;
    }
    try {
      const existing = await filer.findOpenByMarker(repo, fingerprintMarker(draft.fingerprint));
      if (existing !== null) {
        const issue = await filer.comment(repo, existing.number, occurrenceComment(draft, occurredAtIso));
        out.push({ target, status: "filed", repo, action: "commented", issue });
      } else {
        const issue = await filer.create(repo, { title: draft.title, body: draft.body, labels: draft.labels });
        out.push({ target, status: "filed", repo, action: "created", issue });
      }
    } catch (e) {
      out.push({ target, status: "failed", repo, reason: e instanceof Error ? e.message : String(e) });
    }
  }
  return out;
}
