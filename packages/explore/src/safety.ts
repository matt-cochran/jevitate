import type { Control } from "./snapshot.js";

/**
 * The shared safety policy (#116): which controls a mission may click. ONE policy for every mission
 * — coverage/exploratory (induction), feature, adversarial and goal/usability — decided by
 * independent code on the control's accessible name, never by a model.
 *
 * Dogfood evidence (Preveti round 2, 2026-09-24): coverage clicked "Rotate", "Revoke" and then
 * "Sign out" (the session was lost); the feature mission clicked "Send interview" and "Run simulated
 * interview" (a paid LLM operation). Nothing let the operator say "never click these".
 *
 * By default no mission clicks a control that
 *  - ends the session ("Sign out", "Log out") — the run loses its authentication;
 *  - is destructive ("Delete", "Remove", "Revoke", "Rotate key", "Close account"…);
 *  - costs money or reaches real people ("Buy", "Upgrade", "Run simulation", "Generate…",
 *    "Send invite"…);
 *  - matches an operator `--deny` pattern.
 * `--allow-destructive` lifts the built-in categories (a `--deny` pattern always holds). On a goal
 * run, a built-in category is lifted for ONE control when the goal itself asks for it: the goal text
 * contains the control's risky verb ("delete the draft" allows "Delete"; "simulate how customers
 * respond" allows "Run the simulation"); a feature mission's named capability counts as its goal
 * ("buy a pack" allows "Buy pack 1"). A false positive only costs coverage of that control.
 *
 * #168 (Preveti round 3 dogfood): on a chat/question-card UI the controls ARE the assistant's
 * questions and answer options — a long question button ("How many qualified PM teams sign up but
 * never start a trial today…") or a radio answer ("No — every user must pay today, so there is no
 * free cohort") merely CONTAINS a risky word; it is not a verb-led action label. The categories below
 * apply only to a short, button/link-shaped label — capped at `MAX_LABEL_LEN` — and skip choice
 * controls (`radio`/`checkbox`/`option`, an answer, never an action) unless the label itself
 * explicitly names a charge (a price, or "(paid)").
 */

/** Ending the session would end the run's authentication. */
export const SESSION_END = /\b(?:log ?out|sign ?out|log ?off|sign ?off)\b/i;
/** Irreversible actions on a real account. */
export const DESTRUCTIVE =
  /\b(?:delete|remove|destroy|erase|purge|wipe|drop|deactivate|terminate|revoke|rotate|regenerate|unsubscribe|close (?:my |your |the )?account|cancel (?:my |your |the )?(?:subscription|plan|membership|order))\b/i;
/** Actions that cost money (a paid job, a purchase) or send something to real people. */
export const PAID =
  /\b(?:buy|purchase|pay(?: now)?|checkout|check out|place (?:the |my |your |an? )?order|upgrade|subscribe|start (?:a |my |your |the )?(?:subscription|trial|plan)|simulat\w*|generate|send (?:an? |the )?(?:invites?|invitations?|interviews?|emails?|sms|texts?|campaigns?|newsletters?|reminders?))\b/i;

/**
 * A verb-led action label ("Pay now", "Upgrade to Pro") stays short; a chat question or answer runs
 * much longer (#168's repros are 58-96 chars). Longer than this, a name is not a button verb.
 */
const MAX_LABEL_LEN = 40;
/** Roles that are an ANSWER, never an action — a radio/checkbox/option is chosen, not clicked-to-run. */
const CHOICE_ROLES = new Set(["radio", "checkbox", "option"]);
/** A choice control that explicitly names a charge (a price, or an explicit "(paid)" marker). */
const EXPLICIT_CHARGE = /\$\s?\d|\b\d+(?:\.\d+)?\s?(?:usd|dollars?|eur|gbp)\b|\(paid\)/i;

export type ControlRisk = "session-end" | "destructive" | "paid" | "denied";

export interface SafetyConfig {
  /**
   * Controls never clicked (repeatable CLI `--deny`): `/regex/flags` or a plain regex source over the
   * accessible name (case-insensitive), or a descriptor `role=button;name=Delete` (every given key
   * must match: role, name, label, testId, text; `name`/`text` are case-insensitive substrings).
   */
  readonly deny?: readonly string[];
  /**
   * The app's own paid controls (`--paid`, repeatable; `safety.paid` in targets.json, #181): same
   * pattern syntax as `deny`. A match is in the `paid` category like the built-in vocabulary — the
   * budget guard sees it, a hang replay withholds it, and it is clickable when the goal asks for it.
   */
  readonly paid?: readonly string[];
  /** Lift the built-in session-end / destructive / paid categories (`--deny` still holds). */
  readonly allowDestructive?: boolean;
  /** Extra read-request patterns for the write classifier (`--read-rpc`, #110). */
  readonly readRequests?: readonly string[];
  /**
   * Let a find-out goal (no success check, ended by `report`) write (`--allow-writes`, #158). By
   * default such a goal is read-only unless its text asks for a change (see `read-only.ts`).
   */
  readonly allowWrites?: boolean;
  /**
   * Write-request path globs a read-only run never blocks, beyond the built-in auth-refresh ones
   * (`--allow-write`, repeatable; `safety.allowWrites: [globs]` in targets.json). `**` spans segments.
   */
  readonly allowWriteRequests?: readonly string[];
  /**
   * Let hang replays (and verify-fix replays of a hang) re-send a paid/destructive write the original
   * run sent (`--hang-replay-writes`, #153). Off by default: such a hang is reported inconclusive.
   */
  readonly hangReplayWrites?: boolean;
}

/**
 * The built-in category a control's NAME falls into, with the words that matched, or null (#168).
 * `role` (when known) lets the check skip choice controls (radio/checkbox/option — an answer, never
 * an action) and is honored only when the label doesn't itself explicitly name a charge. A name
 * longer than `MAX_LABEL_LEN` is a question/description, not a button verb, and never matches.
 */
export function controlRisk(
  name: string,
  role?: string,
): { readonly risk: Exclude<ControlRisk, "denied">; readonly matched: string } | null {
  const trimmed = name.replace(/\s+/g, " ").trim();
  if (trimmed === "" || trimmed.length > MAX_LABEL_LEN) return null;
  if (role !== undefined && CHOICE_ROLES.has(role.toLowerCase()) && !EXPLICIT_CHARGE.test(trimmed)) return null;
  for (const [risk, re] of [
    ["session-end", SESSION_END],
    ["destructive", DESTRUCTIVE],
    ["paid", PAID],
  ] as const) {
    const m = re.exec(trimmed);
    if (m !== null) return { risk, matched: m[0] };
  }
  return null;
}

const squash = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, "");

/** The stem of a risky word: "simulation"/"simulating" → "simulat", "deleting" → "delet". */
function stem(word: string): string {
  const w = squash(word);
  const cut = w.replace(/(?:ations?|ation|ions?|ing|ed|es|e|s)$/, "");
  return cut.length >= 4 ? cut : w;
}

/** Does the goal ask for this risky action? (its matched words, stemmed, appear in the goal) */
export function goalAsksFor(goal: string, matched: string): boolean {
  const g = squash(goal);
  if (g === "") return false;
  // "sign out" / "log out" are matched as one squashed phrase; other words each by their stem
  // ("Send invite" needs both "send" and "invit" in the goal).
  if (SESSION_END.test(matched)) return g.includes(squash(matched));
  const words = matched.split(/\s+/).filter((w) => !/^(?:a|an|the|my|your)$/i.test(w));
  return words.length > 0 && words.map(stem).every((s) => s.length >= 3 && g.includes(s));
}

type DenyMatcher = (c: Pick<Control, "name" | "role" | "descriptor">) => boolean;

const DESCRIPTOR_KEYS = new Set(["role", "name", "label", "testid", "text"]);

function compileDeny(pattern: string): DenyMatcher {
  const p = pattern.trim();
  const slashed = /^\/(.*)\/([a-z]*)$/s.exec(p);
  if (slashed !== null) {
    const re = new RegExp(slashed[1]!, slashed[2]!.includes("i") ? slashed[2] : `${slashed[2]}i`);
    return (c) => re.test(c.name);
  }
  const parts = p.split(";").map((kv) => kv.split("="));
  if (parts.length > 0 && parts.every((kv) => kv.length >= 2 && DESCRIPTOR_KEYS.has(kv[0]!.trim().toLowerCase()))) {
    const want = parts.map(([k, ...v]) => [k!.trim().toLowerCase(), v.join("=").trim()] as const);
    return (c) =>
      want.every(([k, v]) => {
        const d = c.descriptor as unknown as Record<string, unknown>;
        switch (k) {
          case "role":
            return c.role.toLowerCase() === v.toLowerCase();
          case "name":
          case "text":
            return c.name.toLowerCase().includes(v.toLowerCase());
          case "label":
            return typeof d.label === "string" && d.label.toLowerCase() === v.toLowerCase();
          case "testid":
            return d.testId === v;
          default:
            return false;
        }
      });
  }
  let re: RegExp;
  try {
    re = new RegExp(p, "i");
  } catch {
    const lit = p.toLowerCase();
    return (c) => c.name.toLowerCase().includes(lit);
  }
  return (c) => re.test(c.name);
}

/** Throws a message naming the bad pattern (CLI validation before any browser opens). */
export function validateDenyPatterns(patterns: readonly string[], flag = "--deny"): void {
  for (const p of patterns) {
    const slashed = /^\/(.*)\/([a-z]*)$/s.exec(p.trim());
    if (slashed !== null) {
      try {
        new RegExp(slashed[1]!, slashed[2]);
      } catch (e) {
        throw new Error(`${flag} ${JSON.stringify(p)}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    if (p.trim() === "") throw new Error(`${flag} needs a non-empty pattern`);
  }
}

export interface SafetyVerdict {
  readonly risk: ControlRisk;
  /** The transcript/history reason. */
  readonly reason: string;
}

export class SafetyPolicy {
  readonly #deny: Array<{ readonly pattern: string; readonly match: DenyMatcher }>;
  readonly #paid: DenyMatcher[];
  readonly #allowDestructive: boolean;
  readonly #goal: string | null;

  constructor(cfg: SafetyConfig = {}, opts: { readonly goal?: string } = {}) {
    this.#deny = (cfg.deny ?? []).map((pattern) => ({ pattern, match: compileDeny(pattern) }));
    this.#paid = (cfg.paid ?? []).map(compileDeny);
    this.#allowDestructive = cfg.allowDestructive === true;
    this.#goal = opts.goal ?? null;
  }

  /** The built-in category, else `paid` when an operator `--paid` pattern matches (#181). */
  #risk(c: Pick<Control, "name" | "role" | "descriptor">): { readonly risk: Exclude<ControlRisk, "denied">; readonly matched: string } | null {
    const r = controlRisk(c.name, c.role);
    if (r !== null) return r;
    const name = c.name.replace(/\s+/g, " ").trim();
    return name !== "" && this.#paid.some((m) => m(c)) ? { risk: "paid", matched: name } : null;
  }

  /** The risk category of a control's name (for marking the side effects a click fired). */
  riskOf(c: Pick<Control, "name" | "role"> & { readonly descriptor?: Control["descriptor"] }): Exclude<ControlRisk, "denied"> | null {
    return this.#risk({ ...c, descriptor: c.descriptor ?? {} })?.risk ?? null;
  }

  /** Why this control may not be clicked, or null when it may. */
  refuses(c: Pick<Control, "name" | "role" | "descriptor">): SafetyVerdict | null {
    const name = c.name.replace(/\s+/g, " ").trim();
    for (const d of this.#deny) {
      if (d.match(c)) return { risk: "denied", reason: `refused by the safety policy: "${name}" matches --deny ${JSON.stringify(d.pattern)}` };
    }
    if (this.#allowDestructive) return null;
    const r = this.#risk(c);
    if (r === null) return null;
    if (this.#goal !== null && goalAsksFor(this.#goal, r.matched)) return null;
    const what = r.risk === "session-end" ? "ends the session" : r.risk === "destructive" ? "is destructive" : "may cost money or contact real people";
    return {
      risk: r.risk,
      reason: `refused by the safety policy: "${name}" ${what} (${r.risk}); pass --allow-destructive to permit it`,
    };
  }
}
