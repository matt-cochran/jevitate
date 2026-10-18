import type { Assertion, AssertionOperand, ColumnClass, PostdocDecision, RecordedStep, Recording, Step, TargetDescriptor } from "@jevitate/recording";
import {
  alignTraces,
  applyPostdoc,
  AuthoringTakeSchema,
  CONFIDENT_VARIABLE_THRESHOLD,
  diffTakes,
  RecordingSchema,
  strictSignature,
} from "@jevitate/recording";
import type { Journey } from "@jevitate/journey";
import { JourneySchema } from "@jevitate/journey";
import { isSecretField } from "@jevitate/recorder";

/**
 * #566 — a reviewable authoring proposal built from two or more takes of the same flow (`jevitate
 * record` take files). Pure and deterministic: no model, no I/O, no clock, no randomness.
 *
 * It combines what the takes already carry — the aligned steps (`diffTakes`), each take's captured
 * non-secret fill/select values, the steps' own recorded expectations (text, attribute and value
 * observations) and the navigate URLs — to propose:
 *
 * - `params` — user-supplied inputs: fill/select columns whose value varies across takes, and
 *   navigate path segments that vary (which thread, which record).
 * - `constants` — fill/select columns equal across takes (never a credential).
 * - `handbacks` — credential columns: a recorded `handback`, a field that looks like a credential
 *   (password, one-time code, token, PIN, …), or a username/email field on the same page as one.
 *   Never a value, never a constant, never a parameter.
 * - `outputs` — identifiers the page shows BEFORE the first write that differ across takes and are
 *   tied to exactly one parameter (each take's observed value equals, or for a text observation
 *   contains, that take's parameter value). Each is proposed as an `extract` output read from the
 *   step that observed it.
 * - `checks` — `{var}` assertions: a `pre-write` identity check for each output (the page must show
 *   the supplied identifier, so a changed source context fails closed before anything is filled),
 *   a `pre-write` `urlIncludes` identity check on a navigate whose expected URL is its own templated
 *   URL (`/threads/${thread}` — a redirect to another record fails closed),
 *   and a `post-write` `valueEquals {var}` on each filled/selected parameter (the exact supplied text).
 * - `stopBefore` — the first submit-like click (send/submit/post/publish) after the first write, else
 *   the last click after the last write: the draft replay ends before it.
 * - `ambiguities` — everything the evidence cannot decide (identical parameter columns, an observation
 *   that varies but is tied to no parameter or to several, an identity seen only after a write, a
 *   value that could not be classified, …). Never auto-resolved; left for human review.
 * - `draft` — a Journey draft with the proposal applied (via `applyPostdoc` decisions, `{var}`
 *   checks and inserted `extract` steps), truncated before `stopBefore`. Never promoted, no approvals:
 *   accepting the proposal does not promote a Journey or approve sending; strict review and mutation
 *   verification remain required.
 *
 * Evidence is redacted: a value appears only as a `ValueHint` (length, shape, word count). A short
 * sample (at most `PROPOSAL_SAMPLE_MAX` chars) is shown only for app-defined values — a select
 * option, a URL segment, text the page displayed — never for typed text and never for a credential.
 * No credential column contributes evidence of any kind, and no full page text is carried.
 */

/** The longest value shown verbatim as `ValueHint.sample` (app-defined values only — see module doc). */
export const PROPOSAL_SAMPLE_MAX = 32;

/** One take as `jevitate record` writes it: a Recording and its captured non-secret values. */
export interface AuthoringTake {
  recording: Recording;
  /** Keyed by a step's `stepId`, or `"<page>:<step>"` (the recorder's convention). */
  values: Readonly<Record<string, string>>;
}

/** Redacted evidence for one take's value. */
export interface ValueHint {
  length: number;
  shape: "text" | "email" | "number" | "id-like";
  words: number;
  /** Present only for a short app-defined value (select option, URL segment, displayed text). */
  sample?: string;
}

export type ProposedParamKind = "text" | "select" | "url";

export interface ProposedParam {
  name: string;
  kind: ProposedParamKind;
  /** The step(s) that take the value (a fill/select, or the navigate whose URL carries it). */
  stepIds: string[];
  /** One hint per take, in take order. */
  evidence: ValueHint[];
}

export interface ProposedConstant {
  stepId: string;
  kind: "fill" | "select";
  evidence: ValueHint;
}

export interface ProposedHandback {
  stepId: string;
  reason: "recorded-handback" | "credential-field" | "credential-context";
}

export interface ProposedOutput {
  /** The `extract` output key (`as`). */
  key: string;
  /** The step whose recorded expectation observed the identifier; the draft extracts right after it. */
  fromStepId: string;
  /** The attribute read, when the identifier was observed in an attribute. */
  attr?: string;
  /** The parameter whose value the identifier matched in every take. */
  tiedTo: string;
  evidence: ValueHint[];
}

export interface ProposedCheck {
  phase: "pre-write" | "post-write";
  /** The step whose expectation the check replaces. */
  stepId: string;
  reason: "identity" | "exact-value";
  param: string;
  assertion: Assertion;
}

export type AmbiguityKind =
  | "identical-param-columns"
  | "untied-observation"
  | "multiply-tied-observation"
  | "identity-after-write"
  | "unclassified-value"
  | "varying-target"
  | "varying-url"
  | "no-submit-step";

export interface ProposalAmbiguity {
  kind: AmbiguityKind;
  stepIds: string[];
  message: string;
  evidence?: ValueHint[];
}

export interface BindingProposal {
  version: 1;
  takes: number;
  params: ProposedParam[];
  constants: ProposedConstant[];
  handbacks: ProposedHandback[];
  outputs: ProposedOutput[];
  checks: ProposedCheck[];
  /** The first write step (pre-write checks all sit before it); absent when the flow writes nothing. */
  firstWriteStepId?: string;
  /** The submit-like step the draft replay ends before; absent when none was found (an ambiguity). */
  stopBefore?: string;
  ambiguities: ProposalAmbiguity[];
  /** The draft Journey (never promoted, no approval); absent when `opts.draft === false`. */
  draft?: Journey;
}

export interface ProposeBindingsOptions {
  /** The draft Journey's id (default `"proposed-draft"`). */
  id?: string;
  /** The draft Journey's name (default: the first take's `intent`, else the id). */
  name?: string;
  /** The draft's `createdAtIso` (default: the first take's `startedAtIso`, else the epoch) — kept pure. */
  createdAtIso?: string;
  /** Build the draft (default true). */
  draft?: boolean;
}

export type BindingProposalErrorCode = "E_PROPOSAL_TOO_FEW_TAKES" | "E_PROPOSAL_INVALID_TAKE" | "E_PROPOSAL_MISALIGNED";

/** A refused input. The message names takes and steps, never a value. */
export class BindingProposalError extends Error {
  constructor(
    readonly code: BindingProposalErrorCode,
    detail: string,
  ) {
    super(`${code}: ${detail}`);
    this.name = "BindingProposalError";
  }
}

// === Heuristics ===

/**
 * A credential-named field or value: the ONE shared pattern, `@jevitate/recorder`'s `isSecretField`
 * (#564), so the recorder (which never captures such a value) and the proposal agree.
 */
const isCredentialText = (text: string): boolean => isSecretField(null, null, text);
const LOGIN_ID_RE = /\b(?:user(?:[-_ ]?name)?|login|e-?mail|sign[-_ ]?in)\b/i;
const SUBMIT_RE = /\b(?:send|submit|post|publish)\b/i;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const ID_LIKE_RE = /^(?=.*\d)[A-Za-z0-9][A-Za-z0-9._:-]*$/;
/** A parameter value shorter than this is never used to tie an observation (too likely to match by chance). */
const MIN_TIE_LENGTH = 3;

const WRITE_KINDS = new Set<Step["kind"]>(["fill", "select", "upload", "editText"]);

/**
 * A redacted hint for one captured value — length, shape and word count, never the text (no
 * sample). For surfaces that must describe a typed value without revealing it (the MCP `recordings`
 * tool's diff results).
 */
export function valueHint(value: string): ValueHint {
  return hint(value, false);
}

function hint(value: string, allowSample: boolean): ValueHint {
  const trimmed = value.trim();
  const shape: ValueHint["shape"] = EMAIL_RE.test(trimmed)
    ? "email"
    : trimmed !== "" && Number.isFinite(Number(trimmed))
      ? "number"
      : ID_LIKE_RE.test(trimmed)
        ? "id-like"
        : "text";
  const words = trimmed === "" ? 0 : trimmed.split(/\s+/).length;
  const out: ValueHint = { length: value.length, shape, words };
  if (allowSample && value.length <= PROPOSAL_SAMPLE_MAX && !isCredentialText(value)) out.sample = value;
  return out;
}

function targetOf(step: Step): TargetDescriptor | undefined {
  return "target" in step ? step.target : undefined;
}

function descriptorWords(step: Step): string {
  const t = targetOf(step);
  return [step.label, t?.label, t?.display?.name, t?.name, t?.text, t?.testId, t?.anchor?.id, t?.anchor?.name, t?.css]
    .filter((s): s is string => typeof s === "string")
    .join(" ");
}

function slug(text: string): string | undefined {
  const s = text
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 40)
    .replace(/_+$/, "");
  if (s === "") return undefined;
  return /^[a-z]/.test(s) ? s : `p_${s}`;
}

function uniqueName(base: string, used: Set<string>): string {
  let name = base;
  for (let n = 2; used.has(name); n++) name = `${base}_${n}`;
  used.add(name);
  return name;
}

function fieldName(step: Step): string | undefined {
  const t = targetOf(step);
  for (const c of [t?.label, t?.display?.name, t?.name, step.label, t?.testId, t?.anchor?.name, t?.anchor?.id]) {
    const s = c === undefined ? undefined : slug(c);
    if (s !== undefined) return s;
  }
  return undefined;
}

function singular(segment: string): string {
  return segment.endsWith("s") && !segment.endsWith("ss") && segment.length > 1 ? segment.slice(0, -1) : segment;
}

/** A step's own assertion (the one a replay checks after it), if it has one. */
function ownAssertion(step: Step): Assertion | undefined {
  if (step.kind === "assert") return step.check;
  if (step.kind === "handback") return step.resume;
  if (step.kind === "waitFor" || step.kind === "forEach") return undefined;
  return step.expect;
}

function withOwnAssertion(step: Step, a: Assertion): Step {
  if (step.kind === "assert") return { ...step, check: a };
  if (step.kind === "handback") return { ...step, resume: a };
  if (step.kind === "waitFor" || step.kind === "forEach") return step;
  return { ...step, expect: a };
}

/** The literal operand an observation compared against, when it is a plain string. */
function observedOperand(a: Assertion): string | undefined {
  const op: AssertionOperand | undefined =
    a.kind === "textIncludes" ? a.text : a.kind === "valueEquals" ? a.value : a.kind === "attr" ? a.value : a.kind === "urlIncludes" ? a.text : undefined;
  return typeof op === "string" ? op : undefined;
}

function withOperand(a: Assertion, op: AssertionOperand): Assertion {
  if (a.kind === "textIncludes") return { ...a, text: op };
  if (a.kind === "valueEquals") return { ...a, value: op };
  if (a.kind === "attr") return { ...a, value: op };
  return a;
}

/** A weaker check that holds in every take: the observed element is visible. */
function relaxed(a: Assertion): Assertion {
  return "target" in a ? { kind: "visible", target: a.target } : a;
}

function commonPrefix(values: readonly string[]): string {
  let p = values[0] ?? "";
  for (const v of values) while (!v.startsWith(p)) p = p.slice(0, -1);
  return p;
}

interface ParsedUrl {
  head: string; // origin (or "" for a relative URL)
  segments: string[];
  tail: string; // ?query#hash
}

function parseUrl(url: string): ParsedUrl {
  const m = /^(https?:\/\/[^/?#]*)?([^?#]*)(.*)$/i.exec(url);
  const head = m?.[1] ?? "";
  const path = m?.[2] ?? "";
  return { head, segments: path.split("/"), tail: m?.[3] ?? "" };
}

// === The engine ===

interface Column {
  index: number;
  cells: RecordedStep[]; // one per take, never null (misaligned takes are refused)
  pageIndex: number; // take 0's page
  stepInPage: number; // take 0's step within that page
  stepId: string;
  cls: ColumnClass;
}

type Role =
  | { kind: "handback"; reason: ProposedHandback["reason"] }
  | { kind: "param"; name: string }
  | { kind: "constant" }
  | { kind: "unclassified" }
  | { kind: "none" };

/**
 * Builds a `BindingProposal` from two or more takes of the same flow. See the module doc.
 *
 * @throws BindingProposalError `E_PROPOSAL_TOO_FEW_TAKES` (fewer than 2), `E_PROPOSAL_INVALID_TAKE`
 *   (a take is not a valid take file), `E_PROPOSAL_MISALIGNED` (the takes do not record the same
 *   steps in the same order — every aligned column must hold a step from every take).
 */
export function proposeBindings(takes: readonly AuthoringTake[], opts: ProposeBindingsOptions = {}): BindingProposal {
  if (takes.length < 2) {
    throw new BindingProposalError("E_PROPOSAL_TOO_FEW_TAKES", `a proposal needs at least 2 takes of the same flow (got ${takes.length})`);
  }
  takes.forEach((t, i) => {
    const parsed = AuthoringTakeSchema.safeParse(t);
    if (!parsed.success) throw new BindingProposalError("E_PROPOSAL_INVALID_TAKE", `take ${i + 1} is not a valid take file`);
  });

  const recordings = takes.map((t) => t.recording);
  const aligned = alignTraces(recordings);
  const gap = aligned.findIndex((c) => c.cells.some((cell) => cell === null));
  if (gap !== -1) {
    throw new BindingProposalError(
      "E_PROPOSAL_MISALIGNED",
      `the takes do not record the same steps (aligned step ${gap + 1} is missing from some take) — record each take along the same path`,
    );
  }
  const authoring = takes.map((t) => ({ recording: t.recording, values: new Map(Object.entries(t.values)) }));
  const diff = diffTakes(authoring);

  // Take 0's page/step refs and step ids, by flat index (= column index: the takes are fully aligned).
  const refs: { page: number; step: number; stepId: string }[] = [];
  takes[0].recording.pages.forEach((p, pi) =>
    p.steps.forEach((rs, si) => refs.push({ page: pi, step: si, stepId: rs.stepId ?? `@${pi}:${si}` })),
  );
  const columns: Column[] = aligned.map((c, i) => ({
    index: i,
    cells: c.cells as RecordedStep[],
    pageIndex: refs[i].page,
    stepInPage: refs[i].step,
    stepId: refs[i].stepId,
    cls: diff.columns[i],
  }));

  const ambiguities: ProposalAmbiguity[] = [];
  const usedNames = new Set<string>();

  // --- Credentials first: a credential column is a handback, whatever its values look like.
  const roles: Role[] = columns.map(() => ({ kind: "none" }));
  const credentialPages = new Set<number>();
  for (const col of columns) {
    const step = col.cells[0].step;
    if (col.cells.some((c) => c.step.kind === "handback")) {
      roles[col.index] = { kind: "handback", reason: "recorded-handback" };
      credentialPages.add(col.pageIndex);
    } else if (WRITE_KINDS.has(step.kind) && col.cells.some((c) => isCredentialText(descriptorWords(c.step)))) {
      roles[col.index] = { kind: "handback", reason: "credential-field" };
      credentialPages.add(col.pageIndex);
    }
  }
  for (const col of columns) {
    const step = col.cells[0].step;
    if (roles[col.index].kind !== "none") continue;
    if ((step.kind === "fill" || step.kind === "select") && credentialPages.has(col.pageIndex) && LOGIN_ID_RE.test(descriptorWords(step))) {
      roles[col.index] = { kind: "handback", reason: "credential-context" };
    }
  }

  // --- Navigate URL parameters (which thread / record): varying path segments.
  const params: ProposedParam[] = [];
  const paramValues = new Map<string, string[]>(); // name -> per-take value (never a credential)
  const urlTemplates = new Map<number, { url: string; prefix: string }>(); // column -> templated URL
  for (const col of columns) {
    if (col.cells[0].step.kind !== "navigate") continue;
    const urls = col.cells.map((c) => (c.step as Extract<Step, { kind: "navigate" }>).url);
    if (new Set(urls).size === 1) continue;
    const parsed = urls.map(parseUrl);
    const sameShape =
      parsed.every((p) => p.head === parsed[0].head && p.tail === parsed[0].tail && p.segments.length === parsed[0].segments.length);
    if (!sameShape) {
      ambiguities.push({
        kind: "varying-url",
        stepIds: [col.stepId],
        message: "the navigate URL differs across takes beyond its path segments (origin, query or depth) — decide what to parameterize",
      });
      continue;
    }
    const segments = [...parsed[0].segments];
    let prefixEnd = -1;
    for (let s = 0; s < segments.length; s++) {
      const perTake = parsed.map((p) => p.segments[s]);
      if (new Set(perTake).size === 1) continue;
      const base = slug(singular(segments[s - 1] ?? "")) ?? "path_segment";
      const name = uniqueName(base, usedNames);
      params.push({ name, kind: "url", stepIds: [col.stepId], evidence: perTake.map((v) => hint(v, true)) });
      paramValues.set(name, perTake);
      segments[s] = `\${${name}}`;
      if (prefixEnd === -1) prefixEnd = s;
    }
    const url = parsed[0].head + segments.join("/") + parsed[0].tail;
    const prefix = parsed[0].head + parsed[0].segments.slice(0, prefixEnd).join("/") + "/";
    urlTemplates.set(col.index, { url, prefix });
  }

  // --- Fill/select columns: parameters, constants, or unclassified.
  const constants: ProposedConstant[] = [];
  for (const col of columns) {
    const step = col.cells[0].step;
    if (step.kind !== "fill" && step.kind !== "select") continue;
    if (roles[col.index].kind === "handback") continue;
    const values = col.cls.values;
    if (values.some((v) => v === null)) {
      roles[col.index] = { kind: "unclassified" };
      ambiguities.push({ kind: "unclassified-value", stepIds: [col.stepId], message: "no captured value in every take for this field — it stays a handback until a human decides" });
      continue;
    }
    const present = values as string[];
    if (col.cls.kind === "variable" && col.cls.confidence >= CONFIDENT_VARIABLE_THRESHOLD) {
      const name = uniqueName(fieldName(step) ?? (step.kind === "fill" ? "text" : "choice"), usedNames);
      roles[col.index] = { kind: "param", name };
      params.push({ name, kind: step.kind === "fill" ? "text" : "select", stepIds: [col.stepId], evidence: present.map((v) => hint(v, step.kind === "select")) });
      paramValues.set(name, present);
    } else if (col.cls.kind === "constant") {
      roles[col.index] = { kind: "constant" };
      constants.push({ stepId: col.stepId, kind: step.kind, evidence: hint(present[0], step.kind === "select") });
    } else {
      roles[col.index] = { kind: "unclassified" };
      ambiguities.push({
        kind: "unclassified-value",
        stepIds: [col.stepId],
        message: `this field's value could not be classified (${col.cls.kind}, confidence ${col.cls.confidence.toFixed(2)}) — it stays a handback until a human decides`,
        evidence: present.map((v) => hint(v, false)),
      });
    }
  }

  // --- Two parameters that took the same value in every take: the same input, or two? A human decides.
  const valueParams = params.filter((p) => p.kind !== "url");
  for (let a = 0; a < valueParams.length; a++) {
    for (let b = a + 1; b < valueParams.length; b++) {
      const va = paramValues.get(valueParams[a].name) ?? [];
      const vb = paramValues.get(valueParams[b].name) ?? [];
      if (va.every((v, i) => v === vb[i])) {
        ambiguities.push({
          kind: "identical-param-columns",
          stepIds: [...valueParams[a].stepIds, ...valueParams[b].stepIds],
          message: `parameters ${valueParams[a].name} and ${valueParams[b].name} took the same value in every take — one input or two?`,
        });
      }
    }
  }

  // --- The first write and the submit step.
  const isContentWrite = (col: Column): boolean => WRITE_KINDS.has(col.cells[0].step.kind) && roles[col.index].kind !== "handback";
  const firstValueWrite = columns.find(isContentWrite)?.index;
  const isClick = (col: Column): boolean => col.cells[0].step.kind === "click";
  let stopCol = columns.find((c) => isClick(c) && (firstValueWrite === undefined || c.index > firstValueWrite) && SUBMIT_RE.test(descriptorWords(c.cells[0].step)))?.index;
  if (stopCol === undefined && firstValueWrite !== undefined) {
    const lastWrite = [...columns].reverse().find(isContentWrite)?.index ?? firstValueWrite;
    stopCol = [...columns].reverse().find((c) => isClick(c) && c.index > lastWrite)?.index;
  }
  if (stopCol === undefined) {
    ambiguities.push({ kind: "no-submit-step", stepIds: [], message: "no submit-like step (send/submit/post/publish, or a click after the last write) was found — the draft replays every step; mark where it must stop" });
  }
  const firstWriteCol = [firstValueWrite, stopCol].filter((n): n is number => n !== undefined).reduce<number | undefined>((m, n) => (m === undefined || n < m ? n : m), undefined);
  const draftEnd = stopCol ?? columns.length; // columns [0, draftEnd) are replayed

  // --- A step whose target differs across takes (another name, text or ordinal) is not reusable as recorded.
  for (const col of columns.slice(0, draftEnd)) {
    const pageUrls = col.cells.map((_, k) => urlOfCell(takes[k].recording, col.index));
    const sigs = col.cells.map((c, k) => strictSignature(c.step, pageUrls[k]));
    if (roles[col.index].kind !== "handback" && new Set(sigs).size > 1 && col.cells[0].step.kind !== "navigate") {
      ambiguities.push({ kind: "varying-target", stepIds: [col.stepId], message: "this step acted on a differently named element in each take — the draft keeps the first take's; confirm or choose a stable target" });
    }
  }

  // --- Observations: each replayed step's own recorded expectation, compared across takes.
  const outputs: ProposedOutput[] = [];
  const checks: ProposedCheck[] = [];
  const replacedAssertion = new Map<number, Assertion>();
  const insertedExtract = new Map<number, Step>();
  for (const col of columns.slice(0, draftEnd)) {
    const role = roles[col.index];
    if (role.kind === "handback") continue;
    const assertions = col.cells.map((c) => ownAssertion(c.step));
    const a0 = assertions[0];
    if (a0 === undefined || assertions.some((a) => a?.kind !== a0.kind)) continue;
    const observed = assertions.map((a) => (a === undefined ? undefined : observedOperand(a)));
    if (observed.some((o) => o === undefined)) continue;
    const obs = observed as string[];
    if (new Set(obs).size === 1) continue;

    // A filled/selected parameter: its own post-write check replaces the recorded one (below).
    if (role.kind === "param" || role.kind === "constant" || role.kind === "unclassified") continue;

    if (a0.kind === "urlIncludes") {
      const t = urlTemplates.get(col.index);
      // A navigate whose expected URL is the URL it went to, templated by URL parameters: the page
      // must still be at the supplied context (`/threads/${thread}`) — a redirect to another record
      // fails closed before anything is written. Every other varying URL keeps only the shared prefix.
      const navUrls = col.cells.map((c) => (c.step.kind === "navigate" ? c.step.url : undefined));
      const urlParams = params.filter((p) => p.kind === "url" && p.stepIds.includes(col.stepId)).map((p) => p.name);
      if (t !== undefined && urlParams.length > 0 && navUrls.every((u, k) => u === obs[k]) && (firstWriteCol === undefined || col.index < firstWriteCol)) {
        const check: Assertion = { kind: "urlIncludes", text: t.url };
        replacedAssertion.set(col.index, check);
        for (const param of urlParams) checks.push({ phase: "pre-write", stepId: col.stepId, reason: "identity", param, assertion: check });
        continue;
      }
      replacedAssertion.set(col.index, { kind: "urlIncludes", text: t?.prefix ?? commonPrefix(obs) });
      if (t === undefined) {
        ambiguities.push({ kind: "untied-observation", stepIds: [col.stepId], message: "the URL this step expects differs across takes and is tied to no parameter — the draft keeps only the shared prefix" });
      }
      continue;
    }

    const tied = [...paramValues.entries()].filter(([, pv]) => {
      if (pv.some((v) => v.length < MIN_TIE_LENGTH) || new Set(pv).size !== pv.length) return false;
      return a0.kind === "textIncludes" ? obs.every((o, k) => o.includes(pv[k])) : obs.every((o, k) => o === pv[k]);
    });
    const evidence = obs.map((o) => hint(o, true));
    if (tied.length !== 1) {
      replacedAssertion.set(col.index, relaxed(a0));
      ambiguities.push({
        kind: tied.length === 0 ? "untied-observation" : "multiply-tied-observation",
        stepIds: [col.stepId],
        message:
          tied.length === 0
            ? "the page showed something different in each take here, tied to no parameter — the draft checks only that it is visible; decide whether it is an output"
            : `the page showed a value here that matches several parameters (${tied.map(([n]) => n).join(", ")}) — choose which one identifies the context`,
        evidence,
      });
      continue;
    }
    const [param] = tied[0];
    if (firstWriteCol !== undefined && col.index >= firstWriteCol) {
      replacedAssertion.set(col.index, relaxed(a0));
      ambiguities.push({
        kind: "identity-after-write",
        stepIds: [col.stepId],
        message: `the page shows ${param} here only after the first write — it cannot fail closed before filling; move the check earlier or confirm`,
        evidence,
      });
      continue;
    }
    const check = withOperand(a0, { var: param });
    replacedAssertion.set(col.index, check);
    checks.push({ phase: "pre-write", stepId: col.stepId, reason: "identity", param, assertion: check });
    if ("target" in a0) {
      const attr = a0.kind === "attr" ? a0.name : undefined;
      const base = slug((attr ?? "").replace(/^(?:data|aria)-/i, "")) ?? slug(a0.target.testId ?? a0.target.label ?? a0.target.name ?? "") ?? `${param}_context`;
      const key = uniqueName(base, usedNames);
      outputs.push({ key, fromStepId: col.stepId, ...(attr === undefined ? {} : { attr }), tiedTo: param, evidence });
      insertedExtract.set(col.index, { kind: "extract", target: a0.target, as: key, ...(attr === undefined ? {} : { attr }), expect: { kind: "visible", target: a0.target } });
    }
  }

  // --- Post-write checks: each filled/selected parameter must hold exactly the supplied value.
  for (const col of columns.slice(0, draftEnd)) {
    const role = roles[col.index];
    const step = col.cells[0].step;
    if (role.kind !== "param" || (step.kind !== "fill" && step.kind !== "select")) continue;
    const check: Assertion = { kind: "valueEquals", target: step.target, value: { var: role.name } };
    replacedAssertion.set(col.index, check);
    checks.push({ phase: "post-write", stepId: col.stepId, reason: "exact-value", param: role.name, assertion: check });
  }

  const handbacks: ProposedHandback[] = columns.flatMap((col) => {
    const r = roles[col.index];
    return r.kind === "handback" ? [{ stepId: col.stepId, reason: r.reason }] : [];
  });

  const proposal: BindingProposal = {
    version: 1,
    takes: takes.length,
    params,
    constants,
    handbacks,
    outputs,
    checks,
    ...(firstWriteCol === undefined ? {} : { firstWriteStepId: columns[firstWriteCol].stepId }),
    ...(stopCol === undefined ? {} : { stopBefore: columns[stopCol].stepId }),
    ambiguities,
  };

  if (opts.draft === false) return proposal;

  // === The draft: applyPostdoc decisions on take 0, then the checks, outputs and URL templates.
  const decisions: PostdocDecision[] = [];
  for (const col of columns) {
    const step = col.cells[0].step;
    if (step.kind !== "fill" && step.kind !== "select") continue;
    const ref = { page: col.pageIndex, step: col.stepInPage };
    const role = roles[col.index];
    if (role.kind === "param") decisions.push({ step: ref, classify: "variable", name: role.name });
    else if (role.kind === "constant") decisions.push({ step: ref, classify: "constant" });
    else if (role.kind === "handback") decisions.push({ step: ref, classify: "handback", prompt: "Enter this credential yourself — jevitate never stores it." });
    else decisions.push({ step: ref, classify: "handback", prompt: "Provide this value yourself — the takes did not show what it should be." });
  }
  const applied = applyPostdoc(authoring[0], diff, decisions);

  const usedIds = new Set(columns.map((c) => c.stepId));
  const pages: Recording["pages"] = applied.pages.map((p) => ({ ...p, steps: [] }));
  let flat = 0;
  applied.pages.forEach((p, pi) =>
    p.steps.forEach((rs) => {
      const i = flat++;
      if (i >= draftEnd) return;
      let step = rs.step;
      const role = roles[i];
      if (role.kind === "handback" || role.kind === "unclassified") {
        // A handback's resume never carries a recorded value: the field being visible is enough.
        const target = targetOf(columns[i].cells[0].step);
        if (step.kind === "handback" && target !== undefined) step = { ...step, resume: { kind: "visible", target } };
      }
      const tpl = urlTemplates.get(i);
      if (tpl !== undefined && step.kind === "navigate") step = { ...step, url: tpl.url };
      const replaced = replacedAssertion.get(i);
      if (replaced !== undefined) step = withOwnAssertion(step, replaced);
      pages[pi].steps.push({ ...rs, step });
      const extract = insertedExtract.get(i);
      if (extract !== undefined) {
        const id = rs.stepId === undefined ? undefined : uniqueName(`${rs.stepId}.out`.slice(0, 64), usedIds);
        pages[pi].steps.push({ step: extract, ...(id === undefined ? {} : { stepId: id }) });
      }
    }),
  );
  const recording = RecordingSchema.parse({ ...applied, pages: pages.filter((p) => p.steps.length > 0) });
  const id = opts.id ?? "proposed-draft";
  const draft = JourneySchema.parse({
    metadata: {
      id,
      name: opts.name ?? takes[0].recording.intent ?? id,
      description: "Draft proposed from multiple takes (#566) — review it; it is not promoted and nothing here approves sending.",
      promoted: false,
      params: params.map((p) => p.name),
      parameters: params.map((p) => ({ name: p.name, description: `${p.kind} input taken by ${p.stepIds.join(", ")}` })),
      authoredBy: "human-demonstration",
      createdAtIso: opts.createdAtIso ?? takes[0].recording.startedAtIso ?? "1970-01-01T00:00:00.000Z",
    },
    recording,
  });
  return { ...proposal, draft };
}

/** The page URL that holds flat step `index` of `rec`. */
function urlOfCell(rec: Recording, index: number): string {
  let i = index;
  for (const p of rec.pages) {
    if (i < p.steps.length) return p.url;
    i -= p.steps.length;
  }
  return "";
}
