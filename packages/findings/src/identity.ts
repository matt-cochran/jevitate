import { contentHash } from "@jevitate/domain";
import { normalizeRoute } from "@jevitate/explore";

/**
 * One finding identity model shared by the consolidated report (#139), the baseline diff (#138)
 * and the CI gate (#137). A finding seen by two modes, in two runs or on two builds has ONE key,
 * so it is listed once, matched across runs, and gated once.
 *
 * The key is built from what the engine already computes, never from when or where in a run the
 * finding was seen:
 *
 *  - When the finding carries an engine fingerprint (a hard-signal defect, a hang, a declared
 *    invariant, a 4xx advisory), that fingerprint IS its identity. It already folds in the signal
 *    kind, the templated route or endpoint and the message class (`defect-fingerprint.ts`,
 *    `hangFingerprint`), and it is what `verify-fix` replays. A route is deliberately NOT added:
 *    a `ui-no-progress` hang is keyed by its element across every route it appears on (#87).
 *  - Otherwise (a UX rubric finding, an advisory Jev flag, a failed Journey step, a failed goal
 *    check) the key is the signal, the templated route, the control and the request.
 */

/** The run mode that produced a result. `coverage` includes `--strategy exploratory` (same runner). */
export type RunMode = "goal" | "coverage" | "adversarial" | "feature" | "usability" | "verify-fix" | "journey";

export const RUN_MODES: readonly RunMode[] = ["goal", "coverage", "adversarial", "feature", "usability", "verify-fix", "journey"];

/**
 * What kind of finding it is. `defect`, `hang`, `invariant`, `journey-assertion` and `goal-check`
 * are hard (independent code decided them); `advisory` (a 4xx-correlated console error, a Jev
 * flag) and `ux` (a usability rubric or signal finding) are advisory.
 */
export type FindingCategory = "defect" | "hang" | "invariant" | "journey-assertion" | "goal-check" | "advisory" | "ux";

export type Severity = "hard" | "advisory";

const HARD: ReadonlySet<FindingCategory> = new Set(["defect", "hang", "invariant", "journey-assertion", "goal-check"]);

export function severityOf(category: FindingCategory): Severity {
  return HARD.has(category) ? "hard" : "advisory";
}

export interface FindingIdentity {
  readonly category: FindingCategory;
  /** What fired: the signal kind, the rubric item, the invariant id, the Journey or the check. */
  readonly signal: string;
  /** Route template (ids replaced by `:id`, no query/host), when the finding has one. */
  readonly route?: string;
  /** The implicated control (e.g. `button "Save"`), when known. */
  readonly control?: string;
  /** The implicated request (`<status|kind> <endpoint template>`), when known. */
  readonly request?: string;
  /** The engine's stable fingerprint, when the finding has one — it is then the identity. */
  readonly fingerprint?: string;
}

/** The identity's hashed basis — exposed so a report can show WHY two findings matched. */
export function identityBasis(id: FindingIdentity): string {
  if (id.fingerprint !== undefined) return `fp|${id.category}|${id.fingerprint}`;
  return ["id", id.category, id.signal, id.route ?? "", id.control ?? "", id.request ?? ""].join("|");
}

/** The stable finding key: `<category>:<12 hex>`. Same identity ⇒ same key, across runs and builds. */
export function findingKey(id: FindingIdentity): string {
  return `${id.category}:${contentHash(identityBasis(id)).slice(0, 12)}`;
}

/** A URL or path as a route template (`/items/42?x=1` → `/items/:id`); `undefined` stays `undefined`. */
export function routeTemplate(urlOrPath: string | undefined): string | undefined {
  if (urlOrPath === undefined || urlOrPath === "") return undefined;
  return normalizeRoute(urlOrPath);
}

/** A request's identity part: `<status or kind> <endpoint template>`. */
export function requestIdentity(kindOrStatus: string | number, url: string): string {
  return `${String(kindOrStatus)} ${normalizeRoute(url)}`;
}
