import {
  alignAuthoringTakes,
  BindingProposalError,
  buildDraft,
  buildProposal,
  classifyCredentialHandbacks,
  classifyValueBindings,
  collectObservations,
  collectPostWriteChecks,
  collectUrlBindings,
  detectIdenticalParamColumns,
  detectVaryingTargets,
  PROPOSAL_SAMPLE_MAX,
  resolveWriteWindow,
  valueHint,
  type AmbiguityKind,
  type AuthoringTake,
  type BindingProposal,
  type BindingProposalErrorCode,
  type ProposalAmbiguity,
  type ProposedCheck,
  type ProposedConstant,
  type ProposedHandback,
  type ProposedOutput,
  type ProposedParam,
  type ProposedParamKind,
  type ProposeBindingsOptions,
  type ValueHint,
} from "./binding-proposal-phases.js";

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
 *
 * The engine is decomposed into pure phase helpers in `binding-proposal-phases.ts`; this module
 * keeps the public types and the `proposeBindings` orchestrator, and re-exports the moved symbols.
 */

export { BindingProposalError, PROPOSAL_SAMPLE_MAX, valueHint };
export type {
  AmbiguityKind,
  AuthoringTake,
  BindingProposal,
  BindingProposalErrorCode,
  ProposalAmbiguity,
  ProposedCheck,
  ProposedConstant,
  ProposedHandback,
  ProposedOutput,
  ProposedParam,
  ProposedParamKind,
  ProposeBindingsOptions,
  ValueHint,
};

/**
 * Builds a `BindingProposal` from two or more takes of the same flow. See the module doc.
 *
 * @throws BindingProposalError `E_PROPOSAL_TOO_FEW_TAKES` (fewer than 2), `E_PROPOSAL_INVALID_TAKE`
 *   (a take is not a valid take file), `E_PROPOSAL_MISALIGNED` (the takes do not record the same
 *   steps in the same order — every aligned column must hold a step from every take).
 */
export function proposeBindings(takes: readonly AuthoringTake[], opts: ProposeBindingsOptions = {}): BindingProposal {
  const { authoring, diff, columns } = alignAuthoringTakes(takes);
  const roles = classifyCredentialHandbacks(columns);
  const url = collectUrlBindings(columns, new Set());
  const values = classifyValueBindings(columns, roles, url.usedNames);
  const params = [...url.params, ...values.params];
  const paramValues = new Map([...url.paramValues, ...values.paramValues]);
  const ambiguities: ProposalAmbiguity[] = [...url.ambiguities, ...values.ambiguities, ...detectIdenticalParamColumns(params, paramValues)];

  const window = resolveWriteWindow(columns, values.roles);
  ambiguities.push(...window.ambiguities);
  ambiguities.push(...detectVaryingTargets(columns, values.roles, takes, window.draftEnd));

  const observations = collectObservations({
    columns,
    roles: values.roles,
    draftEnd: window.draftEnd,
    urlTemplates: url.urlTemplates,
    params,
    paramValues,
    firstWriteCol: window.firstWriteCol,
    usedNames: values.usedNames,
  });
  ambiguities.push(...observations.ambiguities);

  const postWrite = collectPostWriteChecks(columns, values.roles, window.draftEnd, observations.replacedAssertion);
  const proposal = buildProposal({
    takesCount: takes.length,
    columns,
    roles: values.roles,
    params,
    constants: values.constants,
    outputs: observations.outputs,
    checks: [...observations.checks, ...postWrite.checks],
    firstWriteCol: window.firstWriteCol,
    stopCol: window.stopCol,
    ambiguities,
  });

  if (opts.draft === false) return proposal;

  const draft = buildDraft({
    columns,
    roles: values.roles,
    authoring,
    diff,
    draftEnd: window.draftEnd,
    urlTemplates: url.urlTemplates,
    replacedAssertion: postWrite.replacedAssertion,
    insertedExtract: observations.insertedExtract,
    params,
    takes,
    opts,
  });
  return { ...proposal, draft };
}
