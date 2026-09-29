import type { Recording, Step } from "@jevitate/recording";
import type { SharedJourneyFile } from "./manifest.js";

export type RiskClass = "read-only" | "risky";

const READ_ONLY_KINDS = new Set<Step["kind"]>(["navigate", "waitFor", "extract", "assert"]);

/**
 * A `click` whose target has ARIA role `link` (#125) — `<a href>`/`<area>` per
 * `ROLE_BY_TAG` in `@jevitate/recorder`'s descriptor builder — is a navigation, not a
 * mutation: following a link reads a page, it does not submit or change anything. Any OTHER
 * click (a button, an unrecognized/absent role, anything that isn't provably a link) stays
 * conservatively `risky` — the classifier never guesses in the permissive direction.
 */
function isReadOnlyClick(step: Extract<Step, { kind: "click" }>): boolean {
  return step.target.role === "link";
}

/** Flattens steps recursively into `forEach.steps` — a write nested inside a
 * loop is still a write; risk is a property of every step that will run,
 * not just top-level ones. `forEach` is a control-flow container, not an
 * action itself, so only its nested (leaf) steps are emitted — never the
 * `forEach` step itself — otherwise every looped read-only Journey would be
 * misclassified `risky` on the container alone. */
export function flattenSteps(steps: Step[]): Step[] {
  const out: Step[] = [];
  for (const step of steps) {
    if (step.kind === "forEach") {
      out.push(...flattenSteps(step.steps));
    } else {
      out.push(step);
    }
  }
  return out;
}

function originOf(url: string): string | null {
  if (!/^https?:\/\//.test(url)) {
    // Relative path — same-origin by construction, nothing to check.
    return null;
  }
  return new URL(url).origin;
}

/**
 * Engine-derived risk classification (spec §6, FMECA #1 & #6): reads
 * `recording.steps` (recursively into `forEach`) and `declaredOrigins` ONLY.
 * The manifest/file can never set or downgrade `riskClass` — there is no
 * "riskClass" field this function reads from the file at all.
 *
 * `read-only` iff EVERY step is one of `navigate`/`waitFor`/`extract`/`assert`/a link `click`
 * (#125: ARIA role `link` — following a link reads a page, it does not mutate anything) AND
 * every absolute `navigate.url` resolves to a declared origin. Anything else (a non-link
 * `click`/`fill`/`select`/`press`/`handback`, or a navigate that could leave `declaredOrigins`)
 * is conservatively `risky`.
 */
export function classifyRisk(file: SharedJourneyFile): RiskClass {
  const declaredOriginSet = new Set(file.declaredOrigins.map((o) => new URL(o).origin));
  const allSteps = flattenSteps(file.recording.pages.flatMap((p) => p.steps.map((rs) => rs.step)));

  for (const step of allSteps) {
    if (!READ_ONLY_KINDS.has(step.kind)) {
      if (step.kind === "click" && isReadOnlyClick(step)) {
        continue;
      }
      return "risky";
    }
    if (step.kind === "navigate") {
      const origin = originOf(step.url);
      if (origin !== null && !declaredOriginSet.has(origin)) {
        return "risky";
      }
    }
  }
  return "read-only";
}

/**
 * Collects the distinct absolute origins visited by `navigate` steps
 * (recursively into `forEach`) in a Recording. Used by `LocalSource` to
 * derive a self-consistent `declaredOrigins` for locally-authored Journeys
 * that don't (yet) carry an explicit `declaredOrigins` field — the local
 * author IS the trust boundary, so "what this Journey actually navigates
 * to" is exactly what it's authorized for.
 */
export function collectNavigateOrigins(recording: Recording): string[] {
  const allSteps = flattenSteps(recording.pages.flatMap((p) => p.steps.map((rs) => rs.step)));
  const origins = new Set<string>();
  for (const step of allSteps) {
    if (step.kind === "navigate") {
      const origin = originOf(step.url);
      if (origin !== null) origins.add(origin);
    }
  }
  return [...origins].sort();
}
