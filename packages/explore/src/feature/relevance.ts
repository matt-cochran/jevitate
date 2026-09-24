import type { Control } from "../snapshot.js";

/**
 * Candidate-action ranking for the feature mission (ticket #78). Two
 * deterministic, model-free signals:
 *
 *  - `lexicalScore` — word overlap between the `--feature` text and a
 *    control's name/label/testId/role. This is the PRIMARY signal: it is what
 *    tells "Buy pack" apart from "Home" for `--feature "buy a pack"`.
 *  - `ChromeTracker` — flags "global chrome": a control whose (role, name)
 *    signature recurs identically across 2+ DISTINCT pathnames visited so far
 *    in the run. Header/nav landmarks, theme toggles, account menus and
 *    command palettes all share this property (same control regardless of
 *    which in-scope page you're on); a capability-specific control does not.
 *
 * Both are deterministic and lexical/structural — no model call is required
 * to rank. A JudgmentPort tie-breaker is an optional future extension (the
 * issue calls it out as advisory-only); `runFeatureMission` stays model-free
 * per its own documented ruling (ticket #2), so it is deliberately NOT wired
 * here — `relevanceScore` is the single seam a caller would extend.
 */

const STOPWORDS = new Set([
  "a", "an", "the", "and", "or", "to", "of", "in", "on", "for", "with",
  "your", "my", "this", "that", "is", "are", "be", "it", "at", "by", "into",
  "up", "out", "as", "from",
]);

/** Lowercased, stopword-filtered words extracted from the `--feature` text. */
export function featureWords(feature: string): string[] {
  return feature
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 1 && !STOPWORDS.has(w));
}

function controlHaystack(control: Control): string {
  const d = control.descriptor;
  return [control.name, d.label, d.testId, d.text, control.role]
    .filter((s): s is string => typeof s === "string" && s.length > 0)
    .join(" ")
    .toLowerCase();
}

/** How many distinct feature words appear in the control's name/label/testId/role. */
export function lexicalScore(control: Control, words: readonly string[]): number {
  if (words.length === 0) return 0;
  const hay = controlHaystack(control);
  let score = 0;
  for (const w of words) if (hay.includes(w)) score += 1;
  return score;
}

function controlSignature(control: Control): string {
  return `${control.role}\u0001${control.name}`;
}

/**
 * Tracks which control signatures have been observed on which distinct
 * pathnames during a single mission run. A signature seen on 2+ distinct
 * pathnames is "global chrome" — present identically no matter which in-scope
 * page you're on, so it is never evidence of the named capability.
 */
export class ChromeTracker {
  private readonly pathnamesBySignature = new Map<string, Set<string>>();

  observe(pathname: string, controls: readonly Control[]): void {
    for (const c of controls) {
      const sig = controlSignature(c);
      let set = this.pathnamesBySignature.get(sig);
      if (!set) {
        set = new Set();
        this.pathnamesBySignature.set(sig, set);
      }
      set.add(pathname);
    }
  }

  isChrome(control: Control): boolean {
    const set = this.pathnamesBySignature.get(controlSignature(control));
    return (set?.size ?? 0) >= 2;
  }
}

/** Large enough to sink any chrome candidate below every non-chrome one. */
const CHROME_PENALTY = 1000;

/**
 * Composite ranking score: higher tries first. Chrome is heavily
 * de-prioritised, never excluded — it still gets tried (and so still yields
 * boundary-edge evidence), just last.
 */
export function relevanceScore(control: Control, words: readonly string[], chrome: ChromeTracker): number {
  return lexicalScore(control, words) - (chrome.isChrome(control) ? CHROME_PENALTY : 0);
}
