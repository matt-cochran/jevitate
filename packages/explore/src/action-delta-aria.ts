import type { Locator } from "playwright";
import {
  REDACTION_MASK,
  redactCredentialShapes,
  redactText,
  type JudgmentPort,
} from "@jevitate/ai-core";
import type { Control } from "./snapshot.js";

/** What the loop expected the action to change, stated BEFORE acting (by code, from the op). */
export interface ExpectedChange {
  readonly kind: "navigation" | "value" | "appears" | "state" | "change";
  /** The text that should show (`value` / `appears`). */
  readonly text?: string;
}

/** Field names whose value is a credential: their value is masked in every capture. */
export const CREDENTIAL_NAME =
  /pass(?:word|code|phrase)|secret|token|api[\s_-]?key|one[\s-]?time|\botp\b|\bpin\b|\bcvc\b|\bcvv\b|\b(?:verification|authentication|auth|security|access|2fa|mfa|sms|login)\s+code\b/i;
export const VALUE_ROLES = new Set(["textbox", "searchbox", "combobox", "spinbutton"]);
/** Bound (chars) on one change line. */
export const DELTA_LINE_MAX = 160;

/** One node of a (redacted) accessibility snapshot. */
export interface AriaLine {
  /** The line as the snapshot prints it, without its indent and `- ` (redacted). */
  readonly content: string;
  readonly role: string;
  readonly name: string | null;
  /** The ancestors' role+name, digit-masked — stable when a container's counter changes. */
  readonly path: string;
  /** The ancestors' roles (for live-region / dialog locality). */
  readonly ancestorRoles: readonly string[];
}

export interface AriaCapture {
  readonly ok: boolean;
  readonly reason?: string;
  readonly lines: readonly AriaLine[];
  /** Redacted URL and title. */
  readonly url: string;
  readonly title: string;
  /** Page-level partial-capture reasons (a canvas filling the page). */
  readonly partial: readonly string[];
  readonly at: number;
  readonly ms: number;
}

export function digitMask(s: string): string {
  return s.replace(/\b(?=[0-9a-f]*\d)[0-9a-f]{6,}\b/gi, "#").replace(/\d+/g, "#");
}

/** `role "name" [attrs]: value` — the role and quoted name of a snapshot line. */
function parseHead(content: string): { role: string; name: string | null } {
  const role = /^[A-Za-z/][\w/-]*/.exec(content)?.[0] ?? "";
  const rest = content.slice(role.length);
  const m = /^ "((?:[^"\\]|\\.)*)"/.exec(rest);
  return { role, name: m === null ? null : m[1]!.replace(/\\"/g, '"') };
}

/** The value part of a snapshot line (`textbox "Name": bob` → `bob`), unquoted, or null. */
export function valueOf(content: string): string | null {
  const i = content.indexOf(": ");
  if (i < 0) return null;
  let v = content.slice(i + 2).trim();
  if (v.startsWith('"') && v.endsWith('"') && v.length >= 2) v = v.slice(1, -1).replace(/\\"/g, '"');
  return v;
}

/**
 * Redacts one snapshot line FIRST, before it is parsed or kept: a credential-named or secret-valued
 * field's value is masked, then every registered / learned secret and every credential shape.
 */
export function redactAriaLine(
  content: string,
  secrets: readonly string[],
  learned: ReadonlySet<string>,
  secretNames: ReadonlySet<string> = new Set(),
): string {
  let out = content;
  const { role, name } = parseHead(out);
  if (VALUE_ROLES.has(role)) {
    const v = valueOf(out);
    if (v !== null && v !== "" && ((name !== null && (CREDENTIAL_NAME.test(name) || secretNames.has(name))) || learned.has(v.trim()))) {
      out = `${out.slice(0, out.indexOf(": "))}: ${REDACTION_MASK}`;
    }
  }
  const more = [...learned].filter((s) => s.length >= 4);
  out = redactText(out, [...secrets, ...more]);
  return redactCredentialShapes(out);
}

/** Parses a (raw) ariaSnapshot YAML into redacted lines with their ancestry. */
export function parseAria(raw: string, secrets: readonly string[], learned: ReadonlySet<string>, secretNames: ReadonlySet<string> = new Set()): AriaLine[] {
  const out: AriaLine[] = [];
  const stack: Array<{ depth: number; key: string; role: string }> = [];
  for (const line of raw.split("\n")) {
    const m = /^(\s*)- (.*)$/.exec(line);
    if (m === null) continue; // a continuation line of a block scalar: its node is already listed
    const depth = m[1]!.length;
    const content = redactAriaLine(m[2]!.replace(/:$/, ""), secrets, learned, secretNames);
    while (stack.length > 0 && stack[stack.length - 1]!.depth >= depth) stack.pop();
    const { role, name } = parseHead(content);
    out.push({
      content,
      role,
      name,
      path: stack.map((s) => s.key).join(" > "),
      ancestorRoles: stack.map((s) => s.role),
    });
    stack.push({ depth, key: digitMask(name === null ? role : `${role} "${name}"`), role });
  }
  return out;
}

/** One raw change between two snapshots. */
export interface RawChange {
  readonly kind: "added" | "removed" | "changed";
  readonly line: AriaLine;
  /** For `changed`: the line before. */
  readonly before?: AriaLine;
  /** The node's identity, stable across a text change: ancestry + role + digit-masked name. */
  readonly anchor: string;
}

export function anchorOf(l: AriaLine): string {
  return `${l.path} | ${l.role}${l.name === null ? "" : ` "${digitMask(l.name)}"`}`;
}

export function clip(s: string, n = DELTA_LINE_MAX): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length <= n ? t : `${t.slice(0, n - 1)}…`;
}

export interface TargetContext {
  readonly name: string;
  readonly role: string;
  /** The target's form / dialog / region lines (before and after the action), redacted. */
  readonly scoped: ReadonlySet<string>;
}

/** What code expects an action to change, stated before acting (from its op and target). */
export function expectedChange(op: string, control: Control | null, value?: string): ExpectedChange {
  if (op === "type" || op === "select" || op === "edit_text") return value === undefined || value === "" ? { kind: "change" } : { kind: "value", text: value };
  if (op === "send") return value === undefined || value === "" ? { kind: "change" } : { kind: "appears", text: value };
  if (op === "click" && control !== null) {
    const toggles = ["checkbox", "switch", "radio", "tab", "menuitemcheckbox", "menuitemradio"].includes(control.role) || control.inputType === "checkbox" || control.inputType === "radio";
    if (toggles) return { kind: "state" };
    if (control.role === "link" && typeof control.href === "string" && control.href !== "" && !control.href.startsWith("#")) return { kind: "navigation" };
  }
  return { kind: "change" };
}

export interface Pending {
  readonly route: string;
  readonly op: string;
  readonly control: Control | null;
  readonly at: number;
  readonly before: AriaCapture;
  readonly scope: Locator | null;
  readonly scopedBefore: readonly AriaLine[];
  readonly partial: readonly string[];
  readonly ms: number;
  acted: { label: string; recordIndex: number; step: number; value?: string } | null;
}

export interface ActionDeltaStats {
  readonly actions: number;
  readonly noChange: number;
  readonly relevantChange: number;
  readonly inconclusive: number;
  /** Per-action overhead (ms): median, max and total. */
  readonly overheadMs: { readonly p50: number; readonly max: number; readonly total: number };
  readonly jevCalls: number;
  /** One-time volatility-baseline waits (ms, all routes): the gap a route's first visit needed. */
  readonly baselineWaitMs: number;
  /**
   * Write steps whose lasting changes were gone after a reload (the persistence check: saved but not
   * stored) — evidence for a defect, never a finding on its own. Absent when none.
   */
  readonly notPersisted?: ReadonlyArray<{ readonly step: number; readonly action: string; readonly why: string }>;
}

export interface ActionDeltasOptions {
  readonly secrets: readonly string[];
  readonly goal: string;
  /** The advisory relevance labeller (Jev); null/absent: code only. */
  readonly judge?: JudgmentPort | null;
  readonly volatilityGapMs?: number;
  readonly snapshotTimeoutMs?: number;
  /** Classifies a request as a write (#110's classifier); default: any method but GET/HEAD/OPTIONS. */
  readonly isWrite?: (r: { readonly method: string; readonly path: string; readonly contentType: string | null }) => boolean;
  /** Endpoints the run's own earlier actions wrote to — never the page's background polling (#241). */
  readonly ownWrites?: () => ReadonlySet<string>;
  /** A request a target marks as background (`--settle-ignore`): never an action's effect. */
  readonly ignoreRequest?: (url: string) => boolean;
}
