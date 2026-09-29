import { describe, expect, it } from "vitest";
import { UX_PROMPTS, applyRubricDescriptions, PromptAssetError } from "./prompts.js";
import { V1_RUBRIC } from "./rubric/v1/index.js";

/**
 * GENERALIZATION GUARDRAIL: the prompt + rubric assets must stay app-agnostic. Tuning happens on
 * one app (the tuning corpus); these nouns — product names, routes and domain terms of the apps
 * used for tuning/holdout — must never leak into the shipped wording, or the review overfits.
 */
const APP_SPECIFIC = [
  // product / company names (tuning + holdout apps)
  /\bpreveti\b/i, /\bsimuli\b/i, /\bjevitate\b/i, /\ballumata\b/i, /\bresoniche\b/i, /\bpraxec\b/i,
  // tuning-app domain terms
  /\binquir(y|ies)\b/i, /\bbets?\b/i, /\bframing\b/i, /\belicitation\b/i, /\bdesign partner\b/i, /\bcredits?\b/i,
  /\bprobe\b/i, /\bannealing\b/i, /\bcohort\b/i, /\barchetypes?\b/i, /\bledger\b/i, /\bproposals?\b/i,
  // holdout-app domain terms
  /\binbox\b/i, /\bthreads?\b/i, /\bjourneys?\b/i,
  // concrete routes (a slash-path such as /settings or /e/:token)
  /(^|[\s"'(])\/[a-z][\w-]*(\/|\b)/i,
];

function strings(v: unknown, out: string[] = []): string[] {
  if (typeof v === "string") out.push(v);
  else if (Array.isArray(v)) for (const x of v) strings(x, out);
  else if (v && typeof v === "object") for (const x of Object.values(v)) strings(x, out);
  return out;
}

describe("ux prompt assets", () => {
  it("contain no app-specific nouns (product names, routes, tuning/holdout domain terms)", () => {
    const hits: string[] = [];
    for (const s of strings({ ...UX_PROMPTS, notes: "" })) {
      for (const re of APP_SPECIFIC) if (re.test(s)) hits.push(`${re} in: ${s.slice(0, 120)}`);
    }
    expect(hits).toEqual([]);
  });

  it("describe every semantic rubric question (no silent fallback to inline text)", () => {
    const applied = applyRubricDescriptions(V1_RUBRIC);
    for (const e of applied.filter((x) => x.tier !== "objective-a11y")) {
      expect(UX_PROMPTS.rubric[e.id]?.principle).toBe(e.principle);
      for (const q of e.questions) expect(UX_PROMPTS.rubric[e.id]?.questions[q.id]?.instruction).toBe(q.instruction);
    }
  });

  it("a rubric item missing from the asset throws", () => {
    const rogue = { ...V1_RUBRIC[0]!, id: "not-in-asset" };
    expect(() => applyRubricDescriptions([rogue])).toThrow(PromptAssetError);
  });

  it("is versioned", () => {
    expect(UX_PROMPTS.version).toMatch(/^ux-prompts@\d+$/);
  });
});
