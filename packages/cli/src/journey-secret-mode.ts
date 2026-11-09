import type { Page } from "playwright";
import type { SecretMode } from "@jevitate/domain";
import { parseSecretField, SecretFieldSpecError, type SecretField } from "@jevitate/explore";
import { flatJourneySteps, type Journey, type SecretRef } from "@jevitate/journey";
import { navigateUrlParams, type RecordedStep, type TargetDescriptor } from "@jevitate/recording";
import type { HandbackHandler } from "@jevitate/runtime";
import { Secret, SecretOriginMismatchError, SecretUnresolvableError, type SecretManagerPort } from "@jevitate/runtime";
import { currentMcpInvocation, inMcpInvocation, noteMcpRefusal } from "./approval-provenance.js";
import type { ResolvedJourneyEnvironment } from "./environments.js";
import { takeApprovedHandback } from "./journey-hold.js";
import { hasRunHooks, holdRunAt, inProof, ProofHoldRefusedError, RunHeldError, type RunHookContext, type RunHoldRequest } from "./journey-run-hooks.js";
import { approvalAuthorisesAutomation, E_HUMAN_STEP_IN_TEST_MODE, E_SECRET_MODE_UNAVAILABLE, E_SECRET_ORIGIN_REFUSED, resolveRunTarget, RunModeRefusedError, type RunTarget } from "./journey-run-mode-gate.js";
import type { RunMode } from "./run-mode.js";
import { fieldMatchesTarget, missingSecretParams, secretParamTargets, withSecretParamsFor, type BoundSecretParams } from "./secret-params.js";
import { canonicalOrigin, loadTargetsFile, type TargetConfig } from "./target-config.js";

/**
 * 0.30.0 §5.3 (#798, #809): how a run meets a step only a person, or the operator's vault, can do: a
 * recorded `handback` step, or (over MCP) a secret parameter nobody supplied. Chosen per run, before any
 * browser opens, from human-written configuration only:
 *
 *  - a test-mode target (`trust: test | harness`) never waits for a person: `E_HUMAN_STEP_IN_TEST_MODE`;
 *  - an automation-mode target whose `~/.jevitate/targets.json` entry binds a `secretFields` spec to the
 *    step's field: `vault-autofill`, code types it on that origin only (a value the model never sees);
 *  - a binding for the field on another origin only: `E_SECRET_ORIGIN_REFUSED` (never typed elsewhere);
 *  - otherwise `visible-handback`: the run holds there durably (a hold of kind `handback` or `secret`,
 *    journey-hold.ts), and `jevitate inbox resume <id>` at a terminal opens it headed for the person.
 *
 * `E_SECRET_PARAM_OVER_MCP` for a value passed in a tool's arguments is unchanged (secret-params.ts):
 * nothing here reads an argument. A run nobody started on a surface (a proof's replay) is left as it was.
 */

export const SECRET_MODE_OWNER = "secret-mode";

/** `--secret-mode`: `auto` chooses as above; the others narrow it (a mode the target cannot give refuses). */
export const SECRET_MODE_FLAGS = ["auto", "fail-closed", "vault-autofill", "visible-handback"] as const;
export type SecretModeFlag = (typeof SECRET_MODE_FLAGS)[number];

export interface SecretRunRequest {
  /** The Journey as stored (its id, its approval). */
  readonly stored: Journey;
  /** The Journey that runs (environment applied; a prefix when anchored). */
  readonly journey: Journey;
  /** The run's parameters as given (secret ones a binding supplied included). */
  readonly params: Readonly<Record<string, string>>;
  /** Already bound by the surface (`run_journey`, `journey run --secret-field`). */
  readonly bound?: BoundSecretParams | undefined;
  readonly origin: string;
  readonly environment?: ResolvedJourneyEnvironment | undefined;
  readonly targetsFile?: string | undefined;
  /** The mode the run-mode gate decided (else resolved here, from the same files). */
  readonly mode: RunMode | undefined;
  /** The run is part of an MCP tool call: a missing secret parameter holds instead of failing validation. */
  readonly mcp: boolean;
  /** A run a surface started (CLI, MCP, queue) or a hold's resume. Anything else keeps its policy. */
  readonly surface: boolean;
  readonly flag?: SecretModeFlag | undefined;
  /** Where a `secretFields` `env:` source is read (the server's environment). */
  readonly env: Readonly<Record<string, string | undefined>>;
  /** A resumed secret hold: the parameters the person types. */
  readonly heldSecretParams?: readonly string[] | undefined;
}

export interface SecretRunPlan {
  /** The runtime's `RunPolicy.secret.secretMode`; undefined: keep the caller's policy. */
  readonly secretMode: SecretMode | undefined;
  /** Secret parameters that become handback steps (held for a person). */
  readonly heldSecretParams: readonly string[];
  /** Further secret parameters an operator's binding supplied (values; never reported). */
  readonly params: Readonly<Record<string, string>>;
  readonly bound?: BoundSecretParams;
  readonly secretRefs?: readonly SecretRef[];
  readonly secretManager?: SecretManagerPort;
  /** Every value the plan resolved: masked from evidence, screenshots and the result. */
  readonly values: readonly string[];
  /** 0-based flat index → the hold kind of a step that waits for a person. */
  readonly holdKinds: ReadonlyMap<number, RunHoldRequest["kind"]>;
  /** The target's trust, as resolved for the plan (`unknown` when nothing needed resolving). */
  readonly trust: RunTarget["trust"];
}

const NO_PLAN: SecretRunPlan = Object.freeze({ secretMode: undefined, heldSecretParams: [], params: {}, values: [], holdKinds: new Map(), trust: "unknown" as const });

/** A handback step's field, when its `resume` names one (`{ kind: "visible", target }`). */
function handbackField(step: RecordedStep["step"]): TargetDescriptor | undefined {
  if (step.kind !== "handback") return undefined;
  return step.resume.kind === "visible" ? step.resume.target : undefined;
}

function humanStepIndexes(journey: Journey): number[] {
  return flatJourneySteps(journey).flatMap(({ recorded: { step } }, i) => (step.kind === "handback" ? [i] : []));
}

/** Parses an operator's specs, dropping one that does not resolve (unset variable): it supplies nothing. */
function resolvedFields(specs: readonly string[], env: Readonly<Record<string, string | undefined>>): SecretField[] {
  return [...new Set(specs)].flatMap((spec) => {
    if (spec.includes("=cmd:")) return [];
    try {
      return [parseSecretField(spec, "value", env)];
    } catch (err) {
      if (err instanceof SecretFieldSpecError) return [];
      throw err;
    }
  });
}

/** The matchers of another origin's specs: only whether they match, never their values (none is read). */
const ANY_VALUE: Readonly<Record<string, string>> = new Proxy({}, { get: () => "-" });

function otherOriginFields(targetsFile: string | undefined, origin: string): Array<{ readonly origin: string; readonly field: SecretField }> {
  let targets: Readonly<Record<string, TargetConfig>>;
  try {
    targets = targetsFile === undefined ? loadTargetsFile() : loadTargetsFile(targetsFile);
  } catch {
    return [];
  }
  return Object.entries(targets).flatMap(([key, cfg]) => {
    const o = canonicalOrigin(key) ?? key;
    if (o === origin) return [];
    return resolvedFields(cfg.secretFields ?? [], ANY_VALUE).map((field) => ({ origin: o, field }));
  });
}

function originRefused(what: string, on: string, target: RunTarget): RunModeRefusedError {
  return new RunModeRefusedError(
    E_SECRET_ORIGIN_REFUSED,
    `${E_SECRET_ORIGIN_REFUSED}: ${what} is bound in targets.json to ${on}, and this run goes to ${target.origin}; a bound secret is typed on its own origin only, so nothing ran. ` +
      `A person binds it for ${target.origin} in that origin's secretFields, or runs the Journey on ${on}. This is not a failed run to retry.`,
    `targets.json["${target.origin}"].secretFields`,
    target.mode,
    target.trust,
  );
}

function refuse(err: RunModeRefusedError, mcp: boolean): never {
  if (mcp) noteMcpRefusal(err);
  throw err;
}

/** A `SecretManagerPort` over the operator's resolved `secretFields`: keyed by descriptor, never cached elsewhere. */
class BoundFieldSecrets implements SecretManagerPort {
  readonly #values: ReadonlyMap<string, string>;
  constructor(values: ReadonlyMap<string, string>) {
    this.#values = values;
  }
  async assertResolvable(ref: SecretRef): Promise<void> {
    if ((this.#values.get(ref.key) ?? "") === "") throw new SecretUnresolvableError(`targets.json secretFields ${ref.key}: its environment variable is not set`);
  }
  async fetch(ref: SecretRef): Promise<Secret> {
    await this.assertResolvable(ref);
    return new Secret(this.#values.get(ref.key)!);
  }
}

/**
 * The plan for this run's human steps and missing secrets. PURE apart from reading `targets.json` and
 * `environments.json`; throws a `RunModeRefusedError` (`E_HUMAN_STEP_IN_TEST_MODE`,
 * `E_SECRET_ORIGIN_REFUSED`, `E_SECRET_MODE_UNAVAILABLE`) before any browser opens.
 */
export function planSecretRun(req: SecretRunRequest): SecretRunPlan {
  const human = humanStepIndexes(req.journey);
  const given = { ...req.params };
  const missing = req.heldSecretParams !== undefined ? [...req.heldSecretParams] : req.mcp ? missingSecretParams(req.journey, given).filter((n) => req.bound?.[n] === undefined) : [];
  if (!req.surface || (human.length === 0 && missing.length === 0)) return NO_PLAN;
  if (req.flag === "fail-closed") return NO_PLAN;
  // One tool call, one hold: a later replay in the same MCP call (a proof's next replay) never waits again.
  if (currentMcpInvocation()?.refusal instanceof RunHeldError) return NO_PLAN;
  const target = resolveRunTarget({ origin: req.origin, environment: req.environment, targetsFile: req.targetsFile });
  const mode = req.mode ?? target.mode;
  const id = req.stored.metadata.id;
  const testStepRefusal = (what: string): RunModeRefusedError =>
    new RunModeRefusedError(
      E_HUMAN_STEP_IN_TEST_MODE,
      `${E_HUMAN_STEP_IN_TEST_MODE}: journey '${id}' has ${what}, and ${target.origin} is a test-mode target (trust "${target.trust}"), where a run never waits for a person; nothing ran. ` +
        `Run it on an automation-mode target, or give the test target the secretFields it needs (targets.json["${target.origin}"].secretFields). This is not a failed run to retry.`,
      `targets.json["${target.origin}"].secretFields`,
      mode,
      target.trust,
    );
  if (mode === "test") {
    if (human.length > 0) refuse(testStepRefusal(`a human step (a handback, step ${human[0]! + 1})`), req.mcp);
    // §5.3: a test target's own secretFields (test credentials a person wrote) supply what the request left out.
    return testModeSecrets(req, target, missing, (names) => testStepRefusal(`secret parameter${names.length === 1 ? "" : "s"} ${names.join(", ")} nobody supplied`));
  }
  // Owner decision 6 holds only with decision 5: over MCP, only a Journey a person approved reads targets.json or holds
  // (the run-mode gate refuses the rest first; this keeps it so without the gate).
  if (req.mcp && !approvalAuthorisesAutomation(req.stored)) return NO_PLAN;
  const fields = resolvedFields(target.targetConfig?.secretFields ?? [], req.env);
  const others = otherOriginFields(req.targetsFile, target.origin);
  const values = new Set<string>();

  // Missing secret parameters: bound on this origin (code types them there), else another origin refuses, else a person.
  let params: Record<string, string> = {};
  let bound: Record<string, readonly string[] | "allowlist"> | undefined;
  let held = missing;
  if (missing.length > 0 && req.heldSecretParams === undefined && req.flag !== "visible-handback") {
    const supplied = withSecretParamsFor(req.journey, { id, params: given, flags: [], targetFields: fields.length === 0 ? undefined : target.targetConfig?.secretFields, targetOrigin: target.origin, env: req.env });
    params = Object.fromEntries(missing.filter((n) => n in supplied.params).map((n) => [n, supplied.params[n]!] as const));
    if (Object.keys(params).length > 0) bound = Object.fromEntries(Object.keys(params).map((n) => [n, supplied.bound?.[n] ?? [target.origin]] as const));
    for (const v of Object.values(params)) values.add(v);
    held = missing.filter((n) => !(n in params));
    const targets = secretParamTargets(req.journey);
    for (const name of held) {
      const elsewhere = others.find(({ field }) => boundByField(field, name, targets));
      if (elsewhere !== undefined) refuse(originRefused(`secret parameter ${name}`, elsewhere.origin, target), req.mcp);
    }
  }
  // #819: a secret no field types (a token in a navigate URL) can't be handed to a person in the browser.
  const untypable = held.filter((n) => urlSecret(req.journey, n));
  if (untypable.length > 0) {
    refuse(
      new RunModeRefusedError(
        E_SECRET_MODE_UNAVAILABLE,
        `${E_SECRET_MODE_UNAVAILABLE}: secret parameter${untypable.length === 1 ? "" : "s"} ${untypable.join(", ")} of journey '${id}' ${untypable.length === 1 ? "goes" : "go"} in a navigate URL, not a field, so a person can't type ${untypable.length === 1 ? "it" : "them"} at a hold, and nobody supplied ${untypable.length === 1 ? "it" : "them"}; nothing ran. ` +
          `A person binds ${untypable.length === 1 ? "it" : "each"} for ${target.origin} in targets.json["${target.origin}"].secretFields (${untypable.map((n) => `'param=${n}=env:<VAR>'`).join(", ")}; the value comes from the server's environment and is sent to that origin only), ` +
          `or runs the Journey on the CLI: jevitate journey run ${id} ${untypable.map((n) => `--secret-field 'param=${n}=env:<VAR>'`).join(" ")}. This is not a failed run to retry.`,
        `targets.json["${target.origin}"].secretFields`,
        mode,
        target.trust,
      ),
      req.mcp,
    );
  }

  // Recorded handback steps: one operator binding for their field on this origin is vault-autofill.
  const holdKinds = new Map<number, RunHoldRequest["kind"]>(human.map((i) => [i, "handback"] as const));
  const flat = flatJourneySteps(req.journey);
  let vault: { refs: SecretRef[]; values: Map<string, string> } | undefined;
  if (human.length > 0 && req.flag !== "visible-handback") {
    const matched = human.map((i) => {
      const field = handbackField(flat[i]!.recorded.step);
      return field === undefined ? [] : fields.filter((f) => fieldMatchesTarget(f, field));
    });
    for (const [n, i] of human.entries()) {
      const field = handbackField(flat[i]!.recorded.step);
      if (field === undefined || matched[n]!.length > 0) continue;
      const elsewhere = others.find((o) => fieldMatchesTarget(o.field, field));
      if (elsewhere !== undefined) refuse(originRefused(`the field of step ${i + 1} (a handback)`, elsewhere.origin, target), req.mcp);
    }
    const distinct = [...new Set(matched.flat())];
    if (matched.every((m) => m.length > 0) && distinct.length === 1 && held.length === 0) {
      const f = distinct[0]!;
      vault = { refs: [{ manager: "targets.json", key: f.descriptor, origin: target.origin, field: f.descriptor }], values: new Map([[f.descriptor, f.secret]]) };
      values.add(f.secret);
    }
  }
  for (const name of held) for (const i of secretFillIndexes(req.journey, name)) holdKinds.set(i, "secret");

  if (req.flag === "vault-autofill" && (vault === undefined && human.length > 0 || held.length > 0)) {
    refuse(
      new RunModeRefusedError(
        E_SECRET_MODE_UNAVAILABLE,
        `${E_SECRET_MODE_UNAVAILABLE}: --secret-mode vault-autofill, and ${target.origin} has no targets.json secretFields binding for every step of journey '${id}' that needs a secret (one binding, on this origin, for each field); nothing ran. ` +
          `A person adds it to targets.json["${target.origin}"].secretFields, or runs with --secret-mode auto to be asked in the browser.`,
        `targets.json["${target.origin}"].secretFields`,
        mode,
        target.trust,
      ),
      req.mcp,
    );
  }
  // Nobody can be waited for without a durable hold (a run started where holds are not wired): fail closed, as before.
  const canHold = hasRunHooks("onHold");
  const common = { params, ...(bound === undefined ? {} : { bound }), values: [...values], trust: target.trust };
  if (vault !== undefined) {
    return { ...common, secretMode: "vault-autofill", heldSecretParams: [], secretRefs: vault.refs, secretManager: new BoundFieldSecrets(vault.values), holdKinds: new Map() };
  }
  if (!canHold || (human.length === 0 && held.length === 0)) return { ...NO_PLAN, ...common };
  // §5.4: a proof's replay never holds. It is refused here, before any browser, at the first step that would.
  if (inProof()) {
    const first = Math.min(...holdKinds.keys());
    const err = new ProofHoldRefusedError(holdKinds.get(first) ?? "handback", first + 1);
    if (req.mcp) noteMcpRefusal(err);
    throw err;
  }
  return { ...common, secretMode: "visible-handback", heldSecretParams: held, holdKinds };
}

/**
 * 0.30.0 §5.3, test mode: the secret parameters a run needs and nobody supplied come from the test
 * target's own `targets.json` `secretFields` (test credentials a person wrote), through the same binding
 * vault-autofill uses: typed by code into the field the spec names, on that origin only, never put in the
 * model, the result or the evidence. A run never waits in test mode, so one the bindings do not cover is
 * refused `E_HUMAN_STEP_IN_TEST_MODE` before any browser opens; one bound on another origin only is
 * refused `E_SECRET_ORIGIN_REFUSED`. Over MCP only a promoted Journey reads the file (an MCP promotion
 * authorises test-mode runs, owner decision 5; a draft never does). A value in the arguments was refused
 * before this (`E_SECRET_PARAM_OVER_MCP`).
 */
function testModeSecrets(req: SecretRunRequest, target: RunTarget, missing: readonly string[], refusal: (names: readonly string[]) => RunModeRefusedError): SecretRunPlan {
  if (missing.length === 0) return { ...NO_PLAN, trust: target.trust };
  if (req.flag === "visible-handback" || (req.mcp && req.stored.metadata.promoted !== true)) refuse(refusal(missing), req.mcp);
  const fields = resolvedFields(target.targetConfig?.secretFields ?? [], req.env);
  const id = req.stored.metadata.id;
  const supplied = fields.length === 0 ? { params: {} as Record<string, string>, bound: undefined } : withSecretParamsFor(req.journey, { id, params: { ...req.params }, flags: [], targetFields: target.targetConfig?.secretFields, targetOrigin: target.origin, env: req.env });
  const params = Object.fromEntries(missing.filter((n) => n in supplied.params).map((n) => [n, supplied.params[n]!] as const));
  const left = missing.filter((n) => !(n in params));
  if (left.length > 0) {
    const others = otherOriginFields(req.targetsFile, target.origin);
    const targets = secretParamTargets(req.journey);
    for (const name of left) {
      const elsewhere = others.find(({ field }) => boundByField(field, name, targets));
      if (elsewhere !== undefined) refuse(originRefused(`secret parameter ${name}`, elsewhere.origin, target), req.mcp);
    }
    refuse(refusal(left), req.mcp);
  }
  const bound = Object.fromEntries(Object.keys(params).map((n) => [n, supplied.bound?.[n] ?? [target.origin]] as const));
  return { ...NO_PLAN, params, bound, values: Object.values(params), trust: target.trust };
}

/** Does an operator's binding name this secret parameter: its field's target, or (#819) `param=<name>`? */
function boundByField(field: SecretField, name: string, targets: ReadonlyArray<{ readonly name: string; readonly target: TargetDescriptor }>): boolean {
  if (field.matcher.key === "param") return field.matcher.value === name;
  return targets.some((t) => t.name === name && fieldMatchesTarget(field, t.target));
}

/** #819: a secret parameter a navigate URL carries, or that no fill/select step types: no person can type it at a hold. */
function urlSecret(journey: Journey, name: string): boolean {
  const inUrl = flatJourneySteps(journey).some(({ recorded: { step } }) => step.kind === "navigate" && navigateUrlParams(step.url).includes(name));
  return inUrl || secretFillIndexes(journey, name).length === 0;
}

/** The 0-based flat indexes of the fill/select steps that type `name`. */
function secretFillIndexes(journey: Journey, name: string): number[] {
  return flatJourneySteps(journey).flatMap(({ recorded: { step } }, i) => ((step.kind === "fill" || step.kind === "select") && "var" in step.value && step.value.var === name ? [i] : []));
}

/**
 * The Journey with each fill/select step that types one of `names` made a handback step in place (one
 * for one, so step numbers stay): the person types the value in the browser, never the model. The step's
 * own expectation, else the field being visible, is its resume check. Undefined `names`: unchanged.
 */
export function withSecretHandbacks(journey: Journey, names: readonly string[]): Journey {
  if (names.length === 0) return journey;
  const held = new Set(names);
  const pages = journey.recording.pages.map((page) => ({
    ...page,
    steps: page.steps.map((recorded) => {
      const step = recorded.step;
      if ((step.kind !== "fill" && step.kind !== "select") || !("var" in step.value) || !held.has(step.value.var)) return recorded;
      const resume = "expect" in step && step.expect !== undefined ? step.expect : { kind: "visible" as const, target: step.target };
      return {
        ...recorded,
        step: { kind: "handback" as const, ...(step.label === undefined ? {} : { label: step.label }), prompt: `Type the secret parameter ${step.value.var} into the field yourself`, resume },
      } as RecordedStep;
    }),
  }));
  return { ...journey, recording: { ...journey.recording, pages } };
}

/**
 * The run's handback handler: on a resume of this step's hold, the person completes it (the resume's
 * presenter); anywhere else the run holds there durably, for a person to resume at a terminal.
 */
export function secretHandbackHandler(a: { readonly ctx: () => RunHookContext; readonly page: Page; readonly holdKinds: ReadonlyMap<number, RunHoldRequest["kind"]> }): HandbackHandler {
  return {
    present: async (_prompt, at) => {
      const index = at?.index ?? -1;
      const step = index + 1;
      const base = a.ctx();
      const presenter = takeApprovedHandback({ journey: base.journey, step });
      if (presenter !== undefined) {
        await presenter(_prompt, a.page);
        return;
      }
      const kind = a.holdKinds.get(index) ?? "handback";
      const reason =
        kind === "secret"
          ? `step ${step} needs a secret nobody supplied: a person types it in the browser that \`jevitate inbox resume\` opens at a terminal`
          : `step ${step} is a handback: a person completes it in the browser that \`jevitate inbox resume\` opens at a terminal`;
      try {
        await holdRunAt(SECRET_MODE_OWNER, { ...base, step, kind: "handback", locator: a.page.locator(":root") }, { kind, reason });
      } catch (err) {
        // The tool call's answer is the hold (or a proof's refusal to hold), whatever the command made of the error (mcp-cli-tools.ts).
        if ((err instanceof RunHeldError || err instanceof ProofHoldRefusedError) && inMcpInvocation()) noteMcpRefusal(err);
        throw err;
      }
    },
  };
}

/** A vault-autofill fill refused because the page left the binding's origin: `E_SECRET_ORIGIN_REFUSED`, typed. */
export function secretOriginRefusalOf(err: unknown, origin: string, mode: RunMode, trust: RunTarget["trust"]): RunModeRefusedError | undefined {
  if (!(err instanceof SecretOriginMismatchError)) return undefined;
  return new RunModeRefusedError(
    E_SECRET_ORIGIN_REFUSED,
    `${E_SECRET_ORIGIN_REFUSED}: the secret bound to ${origin} was not typed: ${err.message.replace(/^vault-autofill: /, "")}. Nothing was typed; find out why the page left ${origin}. This is not a failed run to retry.`,
    `targets.json["${origin}"].secretFields`,
    mode,
    trust,
  );
}
