// adjudicate.ts — INDEPENDENT code adjudication of a model's finding specifics.
//
// Jev and the specifics generator are advisory. Nothing becomes a finding unless code verifies
// that every control it cites exists on the observed screen-state and every quote actually
// appears in that screen's text or a control label. A specifics item that cites no evidence at
// all is not a finding (ungrounded); one that cites evidence which is not there is rejected.
import type { RedactedEvidence } from "./redact.js";
import type { EvidenceRef, SuppressionReason } from "./types.js";
import type { UxSpecificsItem } from "./specifics.js";
import { GROUNDING_UNNAMED } from "./confidence.js";

export type Adjudication =
  | {
      readonly kind: "accepted";
      readonly evidenceRefs: readonly EvidenceRef[];
      /** Human-readable identities of the implicated controls, e.g. `button "Accept"`. */
      readonly controls: readonly string[];
      /** Stable identity keys for dedupe (role + name, never a per-screen index). */
      readonly controlKeys: readonly string[];
      readonly quotes: readonly string[];
      readonly grounding: number;
      readonly observation: string;
      readonly userImpact: string;
      readonly recommendation: string;
    }
  | { readonly kind: "suppressed"; readonly reason: Exclude<SuppressionReason, "below-min-confidence">; readonly detail: string };

/** Case- and whitespace-insensitive normal form for text matching. */
export function normalizeText(s: string): string {
  return s
    .toLowerCase()
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/\s+/g, " ")
    .trim();
}

/** Strips wrapping quotes/ellipses a model commonly adds around an excerpt. */
function cleanQuote(q: string): string {
  return q.trim().replace(/^["'“‘]+|["'”’]+$/g, "").replace(/^(\.\.\.|…)|(\.\.\.|…)$/g, "").trim();
}

const MIN_QUOTE_CHARS = 3;
const MIN_NAME_CHARS = 2;

/** Stable, per-screen-index-free identity of a control (for dedupe and agreement). */
export function controlKey(c: { role: string; name: string }): string {
  return normalizeText(`${c.role}|${c.name}`);
}

function controlLabel(c: { role: string; name: string }): string {
  const role = c.role.trim().length > 0 ? c.role : "control";
  return c.name.trim().length > 0 ? `${role} "${c.name}"` : `${role} (unnamed)`;
}

export function adjudicate(item: UxSpecificsItem, evidence: RedactedEvidence): Adjudication {
  if (!item.violated) {
    return { kind: "suppressed", reason: "not-confirmed", detail: "specifics step found no concrete violation" };
  }

  // 1. Every cited control must exist on this screen-state.
  const byIndex = new Map(evidence.controls.map((c) => [c.index, c] as const));
  const indexes = [...new Set(item.implicatedControls)];
  const missing = indexes.filter((i) => !byIndex.has(i));
  if (missing.length > 0) {
    return {
      kind: "suppressed",
      reason: "rejected-evidence",
      detail: `cites control(s) ${missing.map((i) => `control:${i}`).join(", ")} absent from the observed screen`,
    };
  }
  const cited = indexes.map((i) => byIndex.get(i)).filter((c): c is NonNullable<typeof c> => c !== undefined);

  // 2. Every quote must appear verbatim (normalized) in the page text or a control label.
  const haystacks = [evidence.visibleText, ...evidence.controls.map((c) => `${c.name} ${c.summary}`)].map(normalizeText);
  const quotes = [...new Set(item.quotes.map(cleanQuote).filter((q) => q.length > 0))];
  const tooShort = quotes.filter((q) => q.length < MIN_QUOTE_CHARS);
  const absent = quotes.filter((q) => q.length >= MIN_QUOTE_CHARS && !haystacks.some((h) => h.includes(normalizeText(q))));
  if (absent.length > 0) {
    return {
      kind: "suppressed",
      reason: "rejected-evidence",
      detail: `quotes text absent from the observed screen: ${absent.map((q) => JSON.stringify(q.slice(0, 80))).join(", ")}`,
    };
  }
  const verifiedQuotes = quotes.filter((q) => !tooShort.includes(q));

  // 3. No verified evidence at all → not a finding.
  if (cited.length === 0 && verifiedQuotes.length === 0) {
    return { kind: "suppressed", reason: "ungrounded", detail: "names no control and quotes no on-screen text" };
  }
  const observation = item.observation.trim();
  const userImpact = item.userImpact.trim();
  const recommendation = item.recommendation.trim();
  if (observation.length === 0 || recommendation.length === 0 || userImpact.length === 0) {
    return { kind: "suppressed", reason: "ungrounded", detail: "missing observation, user impact or recommendation" };
  }

  // 4. Grounded specificity: does the prose actually name the evidence it cites?
  const obs = normalizeText(`${observation} ${recommendation}`);
  const named =
    cited.some((c) => c.name.trim().length >= MIN_NAME_CHARS && obs.includes(normalizeText(c.name))) ||
    verifiedQuotes.some((q) => obs.includes(normalizeText(q)));

  const refs: EvidenceRef[] = cited.map((c) => ({ id: `control:${c.index}` }));
  if (verifiedQuotes.length > 0 && evidence.refs.has("visibleText")) refs.push({ id: "visibleText" });
  if (refs.length === 0) {
    // Quotes matched only control labels on a screen with no page text: anchor on those controls.
    for (const c of evidence.controls) {
      if (verifiedQuotes.some((q) => normalizeText(`${c.name} ${c.summary}`).includes(normalizeText(q)))) {
        refs.push({ id: `control:${c.index}` });
      }
    }
  }
  if (refs.length === 0) {
    return { kind: "suppressed", reason: "ungrounded", detail: "cited evidence does not resolve to a screen ref" };
  }

  return {
    kind: "accepted",
    evidenceRefs: refs,
    controls: cited.map(controlLabel),
    controlKeys: cited.map(controlKey).sort(),
    quotes: verifiedQuotes,
    grounding: named ? 1 : GROUNDING_UNNAMED,
    observation,
    userImpact,
    recommendation,
  };
}
