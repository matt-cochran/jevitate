import { describe, expect, it } from "vitest";
import raw from "./assets/ux-claims.json" with { type: "json" };
import { CLAIM_PROMPTS, ClaimPromptsSchema, ClaimTemplateError, TEMPLATE_KEYS, fillClaimTemplate } from "./claim-prompts.js";

/** Same guardrail as prompts.test.ts: the claim wording must stay app-agnostic. */
const APP_SPECIFIC = [
  /\bpreveti\b/i, /\bsimuli\b/i, /\bjevitate\b/i, /\ballumata\b/i, /\bresoniche\b/i, /\bpraxec\b/i,
  /\binquir(y|ies)\b/i, /\bbets?\b/i, /\bframing\b/i, /\belicitation\b/i, /\bdesign partner\b/i, /\bcredits?\b/i,
  /\bprobe\b/i, /\bannealing\b/i, /\bcohort\b/i, /\barchetypes?\b/i, /\bledger\b/i, /\bproposals?\b/i,
  /\binbox\b/i, /\bthreads?\b/i, /\bjourneys?\b/i,
  /(^|[\s"'(])\/[a-z][\w-]*(\/|\b)/i,
];

function strings(v: unknown, out: string[] = []): string[] {
  if (typeof v === "string") out.push(v);
  else if (Array.isArray(v)) for (const x of v) strings(x, out);
  else if (v && typeof v === "object") for (const x of Object.values(v)) strings(x, out);
  return out;
}

describe("ux claim prompt assets (#198)", () => {
  it("contain no app-specific nouns", () => {
    const hits: string[] = [];
    for (const s of strings({ ...CLAIM_PROMPTS, notes: "" })) for (const re of APP_SPECIFIC) if (re.test(s)) hits.push(`${re} in: ${s.slice(0, 120)}`);
    expect(hits).toEqual([]);
  });

  it("is versioned and has a template for every claim variant", () => {
    expect(CLAIM_PROMPTS.version).toMatch(/^ux-claims@\d+$/);
    expect(Object.keys(CLAIM_PROMPTS.templates).sort()).toEqual([...TEMPLATE_KEYS].sort());
  });

  it("refuses a malformed asset (cutoffs out of order, a missing template)", () => {
    expect(() => ClaimPromptsSchema.parse({ ...raw, cutoffs: { need: 0.3, ship: 0.5, wrong: 0.6 } })).toThrow();
    const { "no-feedback": _drop, ...rest } = raw.templates;
    expect(() => ClaimPromptsSchema.parse({ ...raw, templates: rest })).toThrow();
  });

  it("fills placeholders and refuses one with no value (never a literal {control} in a finding)", () => {
    expect(fillClaimTemplate("{control} on {route}", { control: 'button "X"', route: "/a" })).toBe('button "X" on /a');
    expect(() => fillClaimTemplate("{control}", {})).toThrow(ClaimTemplateError);
  });
});
