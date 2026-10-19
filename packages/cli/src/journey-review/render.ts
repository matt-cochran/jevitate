import type { ApprovalProvenance, JourneyReview } from "@jevitate/journey";
import { describeProvenance } from "../approval-provenance.js";
import { renderFindings } from "../catalog-review.js";
import type { RenderOptions } from "../journey-review.js";

/**
 * #499 — the review sheet's rendering primitives and one renderer per section. `renderSheet` (in
 * `journey-review.ts`) creates a `SheetWriter` and calls these in the same order as before; this
 * file is a move-only split of that function.
 */

/** #467: the label of a change that only added step ids; re-approving it takes the warn path of the anchor rules. */
const STEP_ID_ONLY_LABEL = "ids added only (warn path)";

export type Style = "markdown" | "text";

const DEFAULT_WIDTH = 100;
const NB = "\u00a0";
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** `2026-10-11T08:33:26.979Z` as `11 Oct 2026 08:33 UTC` — parsed, not locale-formatted, so it is deterministic. */
export function humanTime(iso: string): string {
  const m = /^(\d{4})-(\d\d)-(\d\d)T(\d\d):(\d\d)/.exec(iso);
  if (m === null) return iso;
  return `${Number(m[3])} ${MONTHS[Number(m[2]) - 1] ?? m[2]} ${m[1]} ${m[4]}:${m[5]} UTC`;
}

/** Spaces inside a command or hash must not become line breaks. */
const nb = (s: string): string => s.replace(/ /g, NB);

/** Wraps `text` after `prefix`; continuation lines are indented `hang` columns. Words (and nb-joined commands) are never cut. */
function wrapText(prefix: string, text: string, width: number, hang = prefix.length): string[] {
  const words = text.split(" ").filter((w) => w !== "");
  const lines: string[] = [];
  let cur = prefix;
  let empty = true;
  for (const w of words) {
    if (!empty && cur.length + 1 + w.length > width) {
      lines.push(cur);
      cur = " ".repeat(hang);
      empty = true;
    }
    cur += `${empty ? "" : " "}${w}`;
    empty = false;
  }
  lines.push(cur);
  return lines.map((l) => l.replaceAll(NB, " ").trimEnd());
}

const HEADERS = ["NEEDS YOUR ATTENTION", "WHAT IT DOES", "STEPS", "PROVES AT THE END", "WRITES", "CLEAR", "APPROVE", "INPUTS", "PROPOSED REVISION (SELF-HEAL)", "DETAIL", "Review"];

function paint(line: string, color: boolean): string {
  if (!color) return line;
  const header = HEADERS.find((h) => line.startsWith(h) && (line.length === h.length || line[h.length] === " "));
  const body = line.replaceAll("⚠", "\u001b[33m⚠\u001b[0m").replaceAll("✓", "\u001b[32m✓\u001b[0m");
  return header === undefined ? body : `\u001b[1m${header}\u001b[0m${body.slice(header.length)}`;
}

/** Step numbers as ranges: 1, 2, 3, 5 becomes `1–3, 5`. */
export function stepRanges(numbers: readonly number[]): string {
  const sorted = [...new Set(numbers)].sort((a, b) => a - b);
  const parts: string[] = [];
  for (let i = 0; i < sorted.length; ) {
    let j = i;
    while (j + 1 < sorted.length && sorted[j + 1] === sorted[j]! + 1) j++;
    parts.push(j === i ? `${sorted[i]}` : `${sorted[i]}–${sorted[j]}`);
    i = j + 1;
  }
  return parts.join(", ");
}

/** `1 step` / `2 steps`. */
export const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

/** #469: the verified pull request behind a pr-review approval, one line (empty for any other channel). */
function prLines(p: ApprovalProvenance | undefined): string[] {
  const pr = p?.pr;
  if (pr === undefined) return [];
  const parts = [
    `PR #${pr.number}${pr.url === undefined ? "" : ` (${pr.url})`}`,
    `reviewer ${pr.reviewer}`,
    ...(pr.author === undefined ? [] : [`author ${pr.author}`]),
    `merged ${pr.mergedSha.slice(0, 12)}`,
    ...(pr.codeOwner === undefined ? [] : [pr.codeOwner ? "reviewer is a code owner" : "reviewer is NOT a code owner"]),
  ];
  return [`Pull-request approval: ${parts.join(" · ")}`];
}

/** The mutable rendering state and closures `renderSheet` used to define inline. */
export class SheetWriter {
  readonly out: string[] = [];
  readonly md: boolean;
  readonly width: number;
  readonly full: boolean;
  readonly color: boolean;
  readonly bullet: string;

  constructor(style: Style, opts: RenderOptions = {}) {
    this.md = style === "markdown";
    this.width = Math.max(40, opts.width ?? DEFAULT_WIDTH);
    this.full = opts.full === true;
    this.color = opts.color === true && !this.md;
    this.bullet = this.md ? "- " : "  ";
  }

  /** One item: wrapped and hanging in text, a single line in Markdown. */
  put(prefix: string, text: string, hang?: number): void {
    if (this.md) this.out.push(`${prefix}${text}`.replaceAll(NB, " "));
    else this.out.push(...wrapText(prefix, text, this.width, hang));
  }

  gap(): void {
    this.out.push("");
  }

  /** A section header: caps in text, a heading in Markdown. */
  head(label: string, title: string = label.charAt(0) + label.slice(1).toLowerCase()): void {
    if (!this.md) this.out.push(label);
    else this.out.push(`## ${title}`, "");
  }

  /** A level-3 heading in the full detail. */
  h3(t: string): void {
    this.out.push(this.md ? `### ${t}` : `${t}:`);
  }

  code(s: string): string {
    return this.md ? `\`${s.replace(/`/g, "'")}\`` : s;
  }

  em(s: string): string {
    return this.md ? `_${s}_` : s;
  }

  cmd(c: string): string {
    return this.md ? this.code(c) : nb(c);
  }
}

export function createSheetWriter(style: Style, opts: RenderOptions = {}): SheetWriter {
  return new SheetWriter(style, opts);
}

/** Paints a finished sheet, then collapses blank-line runs and trims the tail. */
export function finishSheet(w: SheetWriter): string {
  return `${w.out.map((l) => paint(l, w.color)).join("\n").replace(/\n{3,}/g, "\n\n").trimEnd()}\n`;
}

// ── Sections ───────────────────────────────────────────────────────────────────────────────────

export function renderHeader(r: JourneyReview, w: SheetWriter, opts: RenderOptions): void {
  void opts;
  // ── Header
  const prov = r.approval?.provenance;
  const c = r.changeSinceApproval;
  const changed = (c.kind === "diff" || c.kind === "snapshot-missing") && c.changed;
  const plainApproval = prov !== undefined && prov.channel === "tty" && prov.agentSignals.filter((x) => !/not.?tty/i.test(x)).length === 0;
  const approvedBy = prov?.user === undefined ? "" : ` by ${prov.user}`;
  const status = !r.promoted
    ? "not promoted"
    : r.approval === undefined
      ? "promoted (no approval recorded)"
      : `approved ${humanTime(r.approval.at)}${plainApproval ? `${approvedBy} (terminal)` : ` — ${describeProvenance(prov)}`} · ${nb(changed ? "CHANGED since approval" : "unchanged since approval")}`;
  if (w.md) w.out.push(`# Review: ${r.name}`, "", `**${r.id}** · ${status}`);
  else {
    w.put("Review  ", r.name);
    w.put("        ", `${r.id} · ${status}`);
  }
  for (const l of prLines(prov)) w.put(w.md ? "" : "        ", l);
  w.gap();
}

export function renderAttention(r: JourneyReview, w: SheetWriter, opts: RenderOptions): void {
  void opts;
  // ── Needs your attention
  const attention = r.attention ?? [];
  if (attention.length === 0) {
    if (w.md) w.out.push("## Needs your attention", "", "Nothing — every gate is clear.");
    else w.out.push("NEEDS YOUR ATTENTION  nothing — every gate is clear");
  } else {
    w.head("NEEDS YOUR ATTENTION", "Needs your attention");
    for (const a of attention) {
      const icon = a.severity === "warn" ? "⚠" : "○";
      const hint = a.hint === undefined ? "" : ` → ${/^(jevitate|--)/.test(a.hint) ? w.cmd(a.hint) : a.hint}`;
      w.put(`${w.bullet}${icon} `, `${a.text}${hint}`, w.bullet.length + 2);
    }
  }
  w.gap();
}

export function renderWhatItDoes(r: JourneyReview, w: SheetWriter, opts: RenderOptions): void {
  const full = opts.full === true;
  // ── What it does
  const s = r.summary;
  const wid: string[] = [];
  const primary = s.goal ?? s.intent ?? s.description;
  w.head("WHAT IT DOES", "What it does");
  if (primary !== undefined) w.put(w.bullet, primary);
  if (s.goal !== undefined && s.intent !== undefined && s.intent !== s.goal && full) w.put(w.bullet, s.intent);
  if (s.description !== undefined && s.description !== primary && full) w.put(w.bullet, s.description);
  for (const cr of s.successCriteria) w.put(w.bullet, `Success: ${cr.description}${cr.check === undefined || !full ? "" : ` (checked by ${w.code(cr.check)})`}`);
  for (const pc of s.preconditions) w.put(w.bullet, `Needs: ${pc}`);
  if (s.persona !== undefined) wid.push(`persona ${s.persona}`);
  if (s.role !== undefined) wid.push(`runs as ${s.role}`);
  if (s.requiresAuth) wid.push("Signed in");
  wid.push(...r.sideEffects.origins.slice(0, 1));
  const files = r.steps.flatMap((st) => (st.file === undefined ? [] : [st.file]));
  if (wid.length > 0) w.put(w.bullet, wid.join(" · "));
  if (files.length > 0) w.put(w.bullet, `Uploads ${files.map(nb).join(", ")}`);
  w.gap();
}

export function renderInputs(r: JourneyReview, w: SheetWriter, opts: RenderOptions): void {
  void opts;
  // ── Inputs (only when present)
  if (r.inputs.params.length > 0 || r.inputs.secrets.length > 0) {
    w.head("INPUTS", "Inputs");
    if (r.inputs.params.length > 0) w.put(w.bullet, `Parameters: ${r.inputs.params.map((p) => `${w.code(p.name)}${p.secret ? " (secret)" : ""}${p.description === undefined ? "" : ` — ${p.description}`}`).join("; ")}`);
    for (const x of r.inputs.secrets) w.put(w.bullet, `Secret ${w.code(x.field)} from ${x.manager} on ${x.origin}`);
    w.gap();
  }
}

export function renderSteps(r: JourneyReview, w: SheetWriter, opts: RenderOptions): void {
  const full = opts.full === true;
  // ── Steps
  if (r.steps.length > 0) {
    w.head("STEPS", "Steps");
    const numW = String(r.steps.length).length;
    for (const st of r.steps) {
      const anchors = (st.anchors ?? []).map((a) => `⚓ ${a}`).join(" ");
      const target = full && st.target !== undefined ? ` — target: ${[st.target.role, st.target.name === undefined ? undefined : `"${st.target.name}"`].filter((x) => x !== undefined).join(" ")}` : "";
      const lead = w.md ? `${st.number}. ` : `  ${String(st.number).padStart(numW)}  `;
      const prefixLen = lead.length;
      // M4: a labelled step's exact locator follows its label, so a spoofed label cannot hide it.
      const locator = st.locator === undefined ? "" : `${w.md ? " " : "  "}‹${w.code(st.locator)}›`;
      w.put(lead, `${w.md ? `**${st.action}**` : st.action}${locator}${target}${anchors === "" ? "" : `  ${anchors}`}`, w.md ? 0 : prefixLen);
      const sub = w.md ? "   - " : " ".repeat(prefixLen);
      const subHang = sub.length + 2;
      if (st.checks !== undefined) {
        const joined = st.checks.map((k) => (k.weak ? `⚠ ${k.text} (proves nothing)` : `✓ ${k.text}`));
        if (w.md) for (const j of joined) w.put(sub, j);
        else if (sub.length + joined.join(" · ").length <= w.width) w.put(sub, joined.join(" · "), subHang);
        else for (const j of joined) w.put(sub, j, subHang);
      }
      const writes = [...new Set(r.sideEffects.writeRequests.filter((wr) => wr.step === st.number && wr.source !== "end-state").map((wr) => `${wr.method} ${wr.endpoint}`))];
      if (writes.length > 0) w.put(sub, `writes ${writes.join(" · ")}`, subHang);
      if (full) {
        if (st.objective !== undefined) w.put(sub, `Objective: ${st.objective}`, subHang);
        if (st.expectedResult !== undefined) w.put(sub, `Expected result: ${st.expectedResult}`, subHang);
        if (st.file !== undefined) w.put(sub, `File: ${w.code(st.file)}`, subHang);
        if (st.params.length > 0) w.put(sub, `Params: ${st.params.map((p) => w.code(p)).join(", ")}`, subHang);
      }
    }
    w.gap();
  }
}

export function renderProvesAtTheEnd(r: JourneyReview, w: SheetWriter, opts: RenderOptions): void {
  void opts;
  // ── Proves at the end
  const endState = r.proof.endStateText ?? r.proof.endState;
  const plans = r.proof.targetedProofs ?? [];
  if (endState.length > 0 || plans.length > 0) {
    w.head("PROVES AT THE END", "Proves at the end");
    for (const e of endState) w.put(`${w.bullet}✓ `, e, w.bullet.length + 2);
    // #616: each declared plan names the mutation it answers and the earlier checks a human reviewed.
    for (const p of plans) w.put(`${w.bullet}↺ `, `declared targeted proof: ${p.check} against ${p.mustFailWhen} may relax ${p.relax.join(", ")}`, w.bullet.length + 2);
    w.gap();
  }
}

export function renderWrites(r: JourneyReview, w: SheetWriter, opts: RenderOptions): void {
  void opts;
  // ── Writes
  const fx = r.sideEffects;
  const byEndpoint = new Map<string, { steps: number[]; end: boolean }>();
  for (const wr of fx.writeRequests) {
    const key = `${wr.method} ${wr.endpoint}`;
    const e = byEndpoint.get(key) ?? { steps: [], end: false };
    if (wr.step !== undefined) e.steps.push(wr.step);
    if (wr.source === "end-state") e.end = true;
    byEndpoint.set(key, e);
  }
  if (byEndpoint.size > 0 || fx.riskyControls.length > 0 || fx.origins.length > 1) {
    w.head("WRITES", "Writes");
    for (const [key, e] of byEndpoint) {
      const where = [...(e.steps.length === 0 ? [] : [`${e.steps.length > 1 ? "steps" : "step"} ${stepRanges(e.steps)}`]), ...(e.end ? ["end state"] : [])];
      w.put(w.bullet, `${w.code(key)}${where.length === 0 ? "" : ` (${where.join(", ")})`}`);
    }
    for (const x of fx.riskyControls) {
      w.put(w.bullet, `Risky control, step ${x.step}: ${x.role === undefined ? "" : `${x.role} `}"${x.control}" — ${x.risk} [${w.code(x.ruleId)}]${x.waivedBy === undefined ? "" : ` (exempted by allowControl ${w.code(x.waivedBy)})`}`);
    }
    if (fx.origins.length > 1) w.put(w.bullet, `Origins: ${fx.origins.map((o) => w.code(o)).join(", ")}`);
    w.gap();
  }
}

export function renderClear(r: JourneyReview, w: SheetWriter, opts: RenderOptions): void {
  const full = opts.full === true;
  // ── Clear
  const clear: string[] = [];
  const lint = r.proof.lint;
  if (lint.errors === 0 && lint.warnings === 0) clear.push("lint ✓");
  if (r.locatorHealth !== undefined && r.locatorHealth.brittle === 0) clear.push(`locators ${r.locatorHealth.stable}/${r.locatorHealth.stable} stable ✓`);
  if (r.catalog !== undefined && !r.catalog.linked) clear.push("not linked to a job/persona (info)");
  else if (r.catalog !== undefined && r.catalog.unvetted.length === 0 && r.catalog.needsReReview.length === 0) clear.push("catalog links ✓");
  const related = new Set((r.findings ?? []).filter((f) => f.analyzer === "catalog-analysis" && f.code.startsWith("pair:")).flatMap((f) => (f.items ?? []).filter((i) => i !== `journey:${r.id}`)));
  const relatedCount = related.size > 0 ? related.size : (r.findings ?? []).filter((f) => f.analyzer === "catalog-analysis" && f.code.startsWith("pair:")).length;
  if (relatedCount > 0) clear.push(`${plural(relatedCount, "related Journey", "related Journeys")} share writes${full ? "" : " (--full for detail)"}`);
  const v = r.proof.verify;
  if (v.status === "recorded" && !v.stale && v.verdict !== "insensitive") clear.push(`mutation proof ${v.verdict} ✓`);
  if (clear.length > 0) {
    if (w.md) w.out.push("## Clear", "", clear.join(" · "));
    else w.put("CLEAR    ", clear.join(" · "), 9);
    w.gap();
  }
}

export function renderProposal(r: JourneyReview, w: SheetWriter, opts: RenderOptions): void {
  void opts;
  // ── Self-heal proposal
  if (r.proposal !== undefined) {
    const pr = r.proposal;
    w.head("PROPOSED REVISION (SELF-HEAL)", "Proposed revision (self-heal)");
    w.put(w.bullet, `${w.code(pr.proposalId)} from ${humanTime(pr.createdAt)}: accepting it makes the content hash ${nb(w.code(pr.proposedHash))} (made against ${nb(w.code(pr.baseHash))})`);
    const scope = pr.changes.range ?? (pr.changes.notes.length > 0 ? "change notes" : "no change context");
    w.put(w.bullet, `Change context: ${scope}${pr.changes.baseSha === undefined ? "" : ` (${pr.changes.baseSha.slice(0, 8)}..${(pr.changes.headSha ?? "").slice(0, 8)})`} · heal attempts ${pr.attempts.total} (${pr.attempts.rejected} rejected)`);
    for (const n of pr.changes.notes) w.put(w.bullet, `note: ${n}`);
    if (pr.stale) w.put(w.bullet, `STALE — the Journey changed after this proposal was made; it cannot be accepted. Re-run: ${w.cmd(`jevitate journey run ${r.id} --self-heal`)}`);
    if (pr.problem !== undefined && !pr.stale) w.put(w.bullet, `REFUSED — ${pr.problem}`);
    for (const st of pr.steps) {
      w.put(w.bullet, `Step ${st.number}: ${st.hypothesis}`);
      w.put(`${w.bullet}  `, `before: ${w.code(st.before)}`);
      w.put(`${w.bullet}  `, `after:  ${w.code(st.after)}`);
      for (const e of st.evidence) w.put(`${w.bullet}  `, `evidence: ${e}`);
      for (const sh of st.screenshots) w.put(`${w.bullet}  `, `screenshot: ${sh}`);
    }
    if (pr.stale || pr.problem !== undefined) w.put(w.bullet, w.em("not acceptable as it stands"));
    else w.put(w.bullet, `Accept exactly this revision: ${w.cmd(pr.acceptCommand)}`);
    w.put(w.bullet, `Reject it: ${w.cmd(`jevitate journey promote ${r.id} --reject-proposal ${pr.proposalId} --reason "<why>"`)}`);
    w.gap();
  }
}

export function renderFullDetail(r: JourneyReview, w: SheetWriter, opts: RenderOptions): void {
  void opts;
  // ── Full detail
  w.head("DETAIL", "Detail");
  const lint = r.proof.lint;
  const c = r.changeSinceApproval;
  w.h3(`Lint: ${lint.errors} error(s), ${lint.warnings} warning(s)`);
  if (lint.findings.length === 0) w.put(w.bullet, w.em("no findings"));
  for (const f of lint.findings) w.put(w.bullet, `${f.level} ${f.rule}${f.step === undefined ? "" : ` (step ${f.step})`}: ${f.message}`);
  if (r.proof.acceptedWeak !== undefined) w.put(w.bullet, `Accepted weak: "${r.proof.acceptedWeak.reason}" (waived: ${r.proof.acceptedWeak.rules.join(", ")})`);
  const v = r.proof.verify;
  const verify = v.status === "not-verified" ? `not verified — ${v.hint}` : `${v.verdict} (${humanTime(v.at)})${v.stale ? " — STALE: the Journey changed after this proof ran" : ""}${v.reason === undefined ? "" : ` — ${v.reason}`}: ${Object.entries(v.summary).map(([k, n]) => `${n} ${k}`).join(", ")}`;
  w.put("", `Mutation proof: ${verify}`);
  w.gap();

  w.h3("Change since last approval");
  if (c.kind === "first-approval") w.put(w.bullet, w.em("first approval — nothing approved before"));
  else if (c.kind === "no-record") w.put(w.bullet, w.em("promoted before approvals were recorded — no approved version to compare with"));
  else {
    w.put(w.bullet, `Approved${c.approvedAt === undefined ? "" : ` ${humanTime(c.approvedAt)}`} as ${nb(w.code(c.approvedHash))}${c.kind === "snapshot-missing" ? "; its snapshot is missing" : ""} — ${c.changed ? "CHANGED since" : "unchanged since"}`);
    if (c.stepIdOnly === true) w.put(w.bullet, STEP_ID_ONLY_LABEL);
    if (c.kind === "diff") {
      for (const [label, d] of [["Steps", c.steps], ["Assertions", c.assertions], ["Side effects", c.sideEffects]] as const) {
        if (d.added.length === 0 && d.removed.length === 0) continue;
        w.put(w.bullet, `${label}:`);
        for (const l of d.removed) w.put(`${w.bullet}  `, `− ${l}`, w.bullet.length + 4);
        for (const l of d.added) w.put(`${w.bullet}  `, `+ ${l}`, w.bullet.length + 4);
      }
    }
  }
  w.gap();

  if (r.anchorWarnings !== undefined && r.anchorWarnings.length > 0) {
    w.h3("Anchor rules");
    for (const warn of r.anchorWarnings) w.put(w.bullet, `${warn.severity} ${warn.path}${warn.step === undefined ? "" : ` (step ${warn.step})`}: ${warn.message}${warn.fix === undefined ? "" : ` — fix: ${warn.fix}`}`);
    w.gap();
  }
  if (r.locatorHealth !== undefined) {
    const lh = r.locatorHealth;
    w.h3("Locator health (advisory)");
    w.put("", lh.line);
    if (lh.brittleSteps.length === 0) w.put(w.bullet, w.em("no brittle steps"));
    for (const b of lh.brittleSteps) w.put(w.bullet, `step ${b.index + 1}${b.stepId === undefined ? "" : ` [${b.stepId}]`} ${b.kind} ${w.code(b.locator)}${b.route === undefined ? "" : ` on ${b.route}`} — ${b.reasons.join("; ")} — fix: ${b.fix}`);
    w.gap();
  }
  if (r.catalog !== undefined) {
    const k = r.catalog;
    const st = (x: string): string => (x === "stale" ? "STALE — needs re-review" : x === "unknown" ? "UNKNOWN — not declared in the catalog" : x);
    w.h3("Catalog");
    if (!k.linked) w.put(w.bullet, w.em("not linked to a job/persona"));
    else {
      w.put(w.bullet, k.job === undefined ? "Job: none" : `Job: ${w.code(k.job.id)} (${st(k.job.status)})${k.job.story === undefined ? "" : ` — ${k.job.story}`}`);
      w.put(w.bullet, k.persona === undefined ? "Persona: none" : `Persona: ${w.code(k.persona.id)} (${st(k.persona.status)})`);
    }
    w.gap();
  }
  if (r.findings !== undefined) {
    for (const l of renderFindings(r.findings, w.md ? "markdown" : "text")) {
      if (w.md || l === "" || !/^\s*- /.test(l)) w.out.push(l);
      else {
        const lead = /^(\s*- )/.exec(l)![1]!;
        w.put(lead, l.slice(lead.length), lead.length + 2);
      }
    }
  }
  if (r.approval !== undefined) {
    w.h3("Approval record");
    w.put(w.bullet, describeProvenance(r.approval.provenance));
    for (const waive of r.approval.waivers ?? []) w.put(w.bullet, `waived (${waive.kind}): "${waive.reason}" — ${waive.items.join(", ")}`);
    if (r.approval.acceptedFindings !== undefined) w.put(w.bullet, `acknowledged findings: "${r.approval.acceptedFindings.reason}" — ${r.approval.acceptedFindings.findings.join(", ")}`);
    w.gap();
  }
}

export function renderApprove(r: JourneyReview, w: SheetWriter, opts: RenderOptions): void {
  void opts;
  // ── Approve (the one place the content hash appears)
  const c = r.changeSinceApproval;
  const changed = (c.kind === "diff" || c.kind === "snapshot-missing") && c.changed;
  const approved = r.promoted && !changed && (c.kind === "diff" || c.kind === "snapshot-missing" || c.kind === "no-record");
  w.head("APPROVE", "Approve");
  const approveCmd = w.cmd(`jevitate journey promote ${r.id} --reviewed-hash ${r.contentHash}`);
  w.put(w.bullet, `${approved ? "(already approved) " : ""}${approveCmd}`);
  if (w.md) w.out.push("", `Content hash: ${w.code(r.contentHash)}`);
  else w.out.push(`Content hash: ${r.contentHash}`);
}
